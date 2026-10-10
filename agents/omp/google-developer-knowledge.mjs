#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const endpoint = "https://developerknowledge.googleapis.com/mcp";
const credentialPath = process.env.GOOGLE_APPLICATION_CREDENTIALS
  ?? join(process.env.CLOUDSDK_CONFIG ?? join(homedir(), ".config", "gcloud"), "application_default_credentials.json");
const credentials = JSON.parse(await readFile(credentialPath, "utf8"));
if (credentials.type !== "authorized_user" || !credentials.refresh_token || !credentials.client_id || !credentials.client_secret) {
  throw new Error("Google Developer Knowledge requires user ADC. Run gcloud auth application-default login.");
}
const project = (await readFile(join(homedir(), ".omp", "agent", "google-developer-knowledge-project"), "utf8")).trim();
if (!project) {
  throw new Error("The Google Developer Knowledge project file is empty.");
}

let accessToken;
let expiresAt = 0;
let refreshInFlight;
let sessionId;
let protocolVersion;
const activeRequests = new Map();

async function token() {
  if (accessToken && Date.now() < expiresAt) return accessToken;
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: credentials.client_id,
          client_secret: credentials.client_secret,
          refresh_token: credentials.refresh_token,
        }),
        signal: AbortSignal.timeout(25000),
      });
      if (!response.ok) {
        throw new Error(`ADC refresh failed (HTTP ${response.status}). Run gcloud auth application-default login.`);
      }
      const refreshed = await response.json();
      if (!refreshed.access_token || !(refreshed.expires_in > 60)) {
        throw new Error("Google returned an invalid ADC access token or lifetime.");
      }
      accessToken = refreshed.access_token;
      expiresAt = Date.now() + (refreshed.expires_in - 60) * 1000;
      return accessToken;
    })().finally(() => { refreshInFlight = undefined; });
  }
  return refreshInFlight;
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function forward(message) {
  if (message.method === "notifications/cancelled") {
    activeRequests.get(message.params?.requestId)?.abort();
    return;
  }
  const hasId = Object.hasOwn(message, "id");
  const controller = new AbortController();
  if (hasId) activeRequests.set(message.id, controller);
  try {
    const headers = {
      Authorization: `Bearer ${await token()}`,
      "X-Goog-User-Project": project,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;
    if (protocolVersion) headers["MCP-Protocol-Version"] = protocolVersion;
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]),
    });
    sessionId = response.headers.get("Mcp-Session-Id") ?? sessionId;
    if (response.status === 202 || response.status === 204) return;
    const result = await response.json();
    if (result.jsonrpc !== "2.0") {
      throw new Error(`Developer Knowledge returned an invalid MCP response (HTTP ${response.status}).`);
    }
    if (message.method === "initialize") protocolVersion = result.result?.protocolVersion;
    if (hasId) send(result);
  } catch (error) {
    if (hasId) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: error.message } });
    }
  } finally {
    if (hasId) activeRequests.delete(message.id);
  }
}

const pending = new Set();
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } });
    continue;
  }
  const request = forward(message);
  pending.add(request);
  void request.finally(() => pending.delete(request));
}
await Promise.all(pending);
