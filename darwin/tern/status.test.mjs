import assert from "node:assert/strict";
import test from "node:test";
import {classifyDaemon, diffMcp, parseLaunchctl, webAssets} from "./status.mjs";

test("launchctl parsing ignores nested state lines and keeps the job arguments", () => {
  const job = parseLaunchctl(
    [
      "gui/501/org.nixos.example = {",
      "\tactive count = 1",
      "\tstate = running",
      "",
      "\targuments = {",
      "\t\t/bin/sh",
      "\t\t-c",
      "\t\t/bin/wait4path /nix/store && exec /nix/store/aaa-example",
      "\t}",
      "\tpid = 123",
      "\tevent triggers = {",
      "\t\tstate = active",
      "\t}",
      "}",
    ].join("\n"),
  );
  assert.equal(job.state, "running");
  assert.equal(job.pid, 123);
  assert.equal(job.args.length, 3);
});

test("a live managed job that does not hold the socket is not the daemon owner", () => {
  assert.equal(classifyDaemon(12, [34]), "external");
  assert.equal(classifyDaemon(12, [12]), "managed");
  assert.equal(classifyDaemon(null, [34]), "external");
  assert.equal(classifyDaemon(12, []), "none");
});

test("web asset directory comes from the --assets argument only", () => {
  assert.equal(webAssets("tern web serve --token /t --assets /a/0.9.2 --allow-origin http://x"), "/a/0.9.2");
  assert.equal(webAssets("tern web serve"), null);
});

test("MCP comparison ignores key order but reports changed servers by name", () => {
  const expected = {a: {command: "x", args: ["1"]}, b: {url: "u"}, c: {url: "c"}};
  const installed = {a: {args: ["1"], command: "x"}, b: {url: "other"}, d: {url: "d"}};
  assert.deepEqual(diffMcp(expected, installed), {missing: ["c"], extra: ["d"], changed: ["b"]});
});
