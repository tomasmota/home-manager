const ignoredSessions = new Set()
const MAX_IGNORED_SESSIONS = 256

export function registerIgnoredSession(sessionID) {
  if (typeof sessionID !== "string" || !sessionID) return
  ignoredSessions.add(sessionID)
  while (ignoredSessions.size > MAX_IGNORED_SESSIONS) {
    ignoredSessions.delete(ignoredSessions.values().next().value)
  }
}

export function isIgnoredSession(sessionID) {
  return typeof sessionID === "string" && ignoredSessions.has(sessionID)
}
