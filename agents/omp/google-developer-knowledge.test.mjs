import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const bridge = fileURLToPath(new URL("./google-developer-knowledge.mjs", import.meta.url));
const captureRefresh = `
import { writeFileSync } from "node:fs";
globalThis.fetch = async (url, options) => {
  if (url !== "https://oauth2.googleapis.com/token") throw new Error("Unexpected network request");
  writeFileSync(process.env.TEST_OAUTH_REQUEST, options.body.toString());
  return new Response(null, { status: 401 });
};
`;

for (const variable of ["GOOGLE_APPLICATION_CREDENTIALS", "CLOUDSDK_CONFIG"]) {
  test(`documentation credentials ignore workspace ${variable}`, t => {
    const home = mkdtempSync(join(tmpdir(), "google-knowledge-test-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const googleConfig = join(home, ".config", "gcloud");
    const workspaceConfig = join(home, "workspace-cloud");
    const agent = join(home, ".omp", "agent");
    for (const directory of [googleConfig, workspaceConfig, agent]) mkdirSync(directory, { recursive: true });
    const credentials = {
      type: "authorized_user",
      client_id: "docs-client",
      client_secret: "docs-secret",
      refresh_token: "docs-refresh-token",
    };
    writeFileSync(join(googleConfig, "application_default_credentials.json"), JSON.stringify(credentials));
    const workspaceAdc = join(workspaceConfig, "application_default_credentials.json");
    writeFileSync(workspaceAdc, JSON.stringify({
      type: "external_account_authorized_user",
      client_id: "workspace-client",
      client_secret: "workspace-secret",
      refresh_token: "workspace-refresh-token",
    }));
    writeFileSync(join(agent, "google-developer-knowledge-project"), "docs-project\n");
    const capture = join(home, "refresh-request");
    const env = { ...process.env, HOME: home, TEST_OAUTH_REQUEST: capture };
    delete env.GOOGLE_APPLICATION_CREDENTIALS;
    delete env.CLOUDSDK_CONFIG;
    env[variable] = variable === "GOOGLE_APPLICATION_CREDENTIALS" ? workspaceAdc : workspaceConfig;

    const result = spawnSync(process.execPath,
      ["--import", `data:text/javascript,${encodeURIComponent(captureRefresh)}`, bridge], {
        env,
        input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`,
        encoding: "utf8",
        timeout: 10000,
      });
    assert.equal(result.status, 0, result.stderr);
    const refresh = Object.fromEntries(new URLSearchParams(readFileSync(capture, "utf8")));
    assert.equal(refresh.refresh_token, credentials.refresh_token);
    assert.equal(refresh.client_id, credentials.client_id);
  });
}
