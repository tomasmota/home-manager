// Last-7-days aggregates from omp's stats database. `omp stats --json` only covers
// 24h, so this reads omp's (internal) `messages` table read-only, using omp's own
// formulas for cache rate, TTFT and tokens/s.
import Foundation
import SQLite3

struct ProviderSpeed {
    let provider: String
    let ttftMs: Double?
    let tokensPerSecond: Double?
}

struct UsageStats {
    static let windowDays = 7
    /// Subscription or flat-rate providers; everything else counts as pay-per-token spend.
    static let subscriptionProviders: Set<String> = ["anthropic", "openai-codex", "typesafe"]

    /// API-equivalent spend per pay-per-token provider, highest first.
    let otherSpend: [(provider: String, cost: Double)]
    /// Cache reads ÷ (input + cache reads), across all providers.
    let cacheRate: Double?
    let sessions: Int
    let subagentSessions: Int
    /// Busiest provider first.
    let speeds: [ProviderSpeed]

    var otherSpendTotal: Double { otherSpend.reduce(0) { $0 + $1.cost } }
}

struct StatsError: LocalizedError {
    let errorDescription: String?
}

/// Syncs new session files into omp's stats database, then reads the last 7 days.
/// A failed sync still reads whatever is already recorded. Blocks the calling thread.
func loadUsageStats() throws -> UsageStats {
    try? OmpClient().syncStats()
    return try readUsageStats()
}

func readUsageStats(now: Date = Date()) throws -> UsageStats {
    let path = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".omp/stats.db").path
    var db: OpaquePointer?
    defer { sqlite3_close(db) }
    guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else {
        throw StatsError(errorDescription: "cannot open \(path): \(String(cString: sqlite3_errmsg(db)))")
    }
    sqlite3_busy_timeout(db, 2000)
    let cutoff = Int64(now.timeIntervalSince1970 * 1000) - Int64(UsageStats.windowDays) * 86_400_000

    var otherSpend: [(provider: String, cost: Double)] = []
    var speeds: [ProviderSpeed] = []
    var input = 0.0
    var cacheRead = 0.0
    try query(db, """
        SELECT provider, COUNT(*), TOTAL(cost_total), TOTAL(input_tokens), TOTAL(cache_read_tokens),
               AVG(ttft), AVG(CASE WHEN duration > 0 THEN output_tokens * 1000.0 / duration END)
        FROM messages WHERE timestamp >= ? GROUP BY provider ORDER BY 2 DESC
        """, cutoff) { row in
        let provider = String(cString: sqlite3_column_text(row, 0))
        let cost = sqlite3_column_double(row, 2)
        input += sqlite3_column_double(row, 3)
        cacheRead += sqlite3_column_double(row, 4)
        if !UsageStats.subscriptionProviders.contains(provider) {
            otherSpend.append((provider, cost))
        }
        // Providers without timing (e.g. typesafe judgments) have nothing to show.
        let ttft = optionalDouble(row, 5)
        let tokensPerSecond = optionalDouble(row, 6)
        if ttft != nil || tokensPerSecond != nil {
            speeds.append(ProviderSpeed(provider: provider, ttftMs: ttft, tokensPerSecond: tokensPerSecond))
        }
    }

    var sessions = 0
    var subagentSessions = 0
    try query(db, """
        SELECT COUNT(DISTINCT CASE WHEN agent_type = 'main' THEN session_file END),
               COUNT(DISTINCT CASE WHEN agent_type <> 'main' THEN session_file END)
        FROM messages WHERE timestamp >= ?
        """, cutoff) { row in
        sessions = Int(sqlite3_column_int64(row, 0))
        subagentSessions = Int(sqlite3_column_int64(row, 1))
    }

    return UsageStats(
        otherSpend: otherSpend.sorted { $0.cost > $1.cost },
        cacheRate: input + cacheRead > 0 ? cacheRead / (input + cacheRead) : nil,
        sessions: sessions,
        subagentSessions: subagentSessions,
        speeds: speeds
    )
}

private func query(_ db: OpaquePointer?, _ sql: String, _ cutoff: Int64, row: (OpaquePointer) -> Void) throws {
    var statement: OpaquePointer?
    defer { sqlite3_finalize(statement) }
    guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
        throw StatsError(errorDescription: "stats query failed: \(String(cString: sqlite3_errmsg(db)))")
    }
    sqlite3_bind_int64(statement, 1, cutoff)
    while true {
        switch sqlite3_step(statement) {
        case SQLITE_ROW: row(statement)
        case SQLITE_DONE: return
        default: throw StatsError(errorDescription: "stats query failed: \(String(cString: sqlite3_errmsg(db)))")
        }
    }
}

private func optionalDouble(_ row: OpaquePointer, _ column: Int32) -> Double? {
    sqlite3_column_type(row, column) == SQLITE_NULL ? nil : sqlite3_column_double(row, column)
}
