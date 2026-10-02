const ERROR_BACKOFF_MS = 5 * 60_000
const shared = (globalThis[Symbol.for("tomas.agent-routes.quota")] ??= { inflight: new Map(), backoffUntil: new Map() })

// Cache readings, never credentials. Platform adapters supply the fetchers.
export async function fetchQuotaShared(provider, fetchQuota, { cached, maxAgeMs, now = Date.now() }) {
  if (cached && now - cached.checkedAt < maxAgeMs) return cached
  if ((shared.backoffUntil.get(provider) ?? 0) > now) return cached
  if (!shared.inflight.has(provider)) {
    const request = Promise.resolve().then(fetchQuota).catch((error) => {
      shared.backoffUntil.set(provider, Date.now() + (error?.retryAfterMs ?? ERROR_BACKOFF_MS))
      throw error
    }).finally(() => shared.inflight.delete(provider))
    shared.inflight.set(provider, request)
  }
  return (await shared.inflight.get(provider)) ?? cached
}

export function resetSharedQuota() {
  shared.inflight.clear()
  shared.backoffUntil.clear()
}
