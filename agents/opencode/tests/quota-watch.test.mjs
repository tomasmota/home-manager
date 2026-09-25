import assert from "node:assert/strict"
import { test } from "node:test"

const { parseCodexQuota } = await import(
  "../tui-plugins/quota-watch/src/openaiQuota.ts"
)

// Recorded from a live `codex app-server` account/rateLimits/read response.
const codexResult = {
  rateLimitsByLimitId: {
    codex: {
      primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1790361267 },
      secondary: { usedPercent: 54, windowDurationMins: 10080, resetsAt: 1790432215 },
    },
  },
}

const NOW = 1790343170000

test("parses weekly and hourly windows from codex rate limits", () => {
  const quota = parseCodexQuota(codexResult, NOW)
  assert.equal(quota.percentLeft, 46)
  assert.equal(quota.daysLeft, 2)
  assert.equal(quota.hourly.percentLeft, 100)
  assert.equal(quota.hourly.resetLabel, "6h")
})

test("returns undefined when rate limits are missing", () => {
  assert.equal(parseCodexQuota({}, NOW), undefined)
  assert.equal(parseCodexQuota(undefined, NOW), undefined)
  assert.equal(
    parseCodexQuota({ rateLimitsByLimitId: { codex: {} } }, NOW),
    undefined,
  )
})

test("clamps over-consumed quotas to zero", () => {
  const over = {
    rateLimitsByLimitId: {
      codex: {
        secondary: { usedPercent: 130, windowDurationMins: 10080, resetsAt: 1790432215 },
      },
    },
  }
  const quota = parseCodexQuota(over, NOW)
  assert.equal(quota.percentLeft, 0)
})
