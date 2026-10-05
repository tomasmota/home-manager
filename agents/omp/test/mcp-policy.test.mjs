import { test } from "node:test"
import assert from "node:assert/strict"
import mcpPolicy, { blockedReason } from "../mcp-policy.ts"
import { readFileSync } from "node:fs"

test("Confluence gate preserves the workstation allow-list and denies additions", () => {
  const platform = JSON.parse(readFileSync(new URL("../../config/platform.macos.json", import.meta.url)))
  const allowed = platform.permissions.filter(p => p.action.startsWith("confluence_") && p.effect === "allow")
  assert.equal(allowed.length, 9)
  for (const p of allowed) assert.equal(blockedReason(`mcp__${p.action.toLowerCase()}`), undefined)
  for (const name of ["deletepage", "newtool", "getconfluencepage_extra"]) {
    assert.match(blockedReason(`mcp__confluence_${name}`), /allow-list/)
  }
})

test("Chrome profiling tools stay denied, including future performance tools", () => {
  for (const name of ["performance_start_trace", "performance_new_tool", "lighthouse_audit", "take_heapsnapshot"]) {
    assert.match(blockedReason(`mcp__chrome_devtools_${name}`), /disabled/)
  }
  for (const name of ["list_pages", "take_snapshot", "navigate_page"]) {
    assert.equal(blockedReason(`mcp__chrome_devtools_${name}`), undefined)
  }
  assert.equal(blockedReason("read"), undefined)
})

test("extension blocks forbidden calls before tool execution", () => {
  let handler
  mcpPolicy({ on(event, fn) { assert.equal(event, "tool_call"); handler = fn } })
  assert.equal(handler({ toolName: "mcp__confluence_deletepage" }).block, true)
  assert.equal(handler({ toolName: "mcp__confluence_getjiraissue" }), undefined)
})
