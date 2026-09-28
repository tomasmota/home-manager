import AppKit
import Foundation
import UserNotifications

// MARK: - Models

struct WindowLimit: Decodable {
    let usedPercent: Int
    let windowDurationMins: Int?
    let resetsAt: Double?
}

struct RateLimits: Decodable {
    let primary: WindowLimit?
    let secondary: WindowLimit?
    let planType: String?
}

struct ResetCredits: Decodable {
    let availableCount: Int?
}

struct RateLimitsEnvelope: Decodable {
    let rateLimits: RateLimits?
    let rateLimitResetCredits: ResetCredits?
}

struct ConsumeOutcome: Decodable {
    let outcome: String
}

// MARK: - z.ai (GLM coding plan) quota

struct ZaiQuota {
    let weekly: WindowLimit
    let fiveHour: WindowLimit?
}

struct ZaiLimit: Decodable, Equatable {
    let type: String
    let unit: Int?
    let number: Int?
    let percentage: Double
    let nextResetTime: Double?
}

struct ZaiEnvelope: Decodable {
    struct Payload: Decodable {
        let limits: [ZaiLimit]?
    }

    let data: Payload?
}

final class ZaiClient {
    static let quotaURL = URL(string: "https://api.z.ai/api/monitor/usage/quota/limit")!

    /// Key comes from opencode's auth store (same source as the quota-watch
    /// TUI plugin); no separate credential to manage.
    static func apiKey() -> String? {
        let path = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".local/share/opencode/auth.json")
        guard let data = try? Data(contentsOf: path),
              let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let entry = root["zai-coding-plan"] as? [String: Any],
              let key = entry["key"] as? String, !key.isEmpty
        else { return nil }
        return key
    }

    static func fetch() throws -> ZaiQuota {
        guard let key = apiKey() else {
            throw CodexClient.ClientError.rpc("z.ai key not found in opencode auth")
        }
        let (data, response) = try HTTP.get(quotaURL, headers: ["Authorization": "Bearer \(key)"])
        guard response.statusCode == 200 else {
            throw CodexClient.ClientError.rpc("z.ai API returned HTTP \(response.statusCode)")
        }
        let envelope = try JSONDecoder().decode(ZaiEnvelope.self, from: data)
        let limits = (envelope.data?.limits ?? []).filter {
            $0.type == "CREDIT_LIMIT" && $0.nextResetTime != nil
        }
        func toWindowLimit(_ limit: ZaiLimit, minutes: Int) -> WindowLimit {
            WindowLimit(
                usedPercent: min(100, max(0, Int(limit.percentage.rounded()))),
                windowDurationMins: minutes,
                resetsAt: limit.nextResetTime.map { $0 / 1000 }
            )
        }
        guard let weekly = limits.first(where: { $0.unit == 6 && $0.number == 1 }) else {
            throw CodexClient.ClientError.rpc("z.ai API returned no weekly limit")
        }
        let hourly = limits
            .filter { $0 != weekly }
            .min { ($0.nextResetTime ?? 0) < ($1.nextResetTime ?? 0) }
        return ZaiQuota(
            weekly: toWindowLimit(weekly, minutes: 10080),
            fiveHour: hourly.map { toWindowLimit($0, minutes: 300) }
        )
    }
}

// MARK: - Shell helpers

enum Shell {
    static func resolve(_ name: String, extraCandidates: [String] = []) -> URL? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        var candidates = extraCandidates + [
            "/usr/bin/\(name)",
            "/opt/homebrew/bin/\(name)",
            "/etc/profiles/per-user/tomas/bin/\(name)",
            "/run/current-system/sw/bin/\(name)",
            "\(home)/.local/bin/\(name)",
        ]
        candidates += (ProcessInfo.processInfo.environment["PATH"] ?? "")
            .split(separator: ":")
            .map { "\($0)/\(name)" }
        for candidate in candidates
        where FileManager.default.isExecutableFile(atPath: candidate) {
            return URL(fileURLWithPath: candidate)
        }
        return nil
    }

    static func run(_ executable: URL, _ arguments: [String]) throws -> String {
        let proc = Process()
        proc.executableURL = executable
        proc.arguments = arguments
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = Pipe()
        try proc.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        proc.waitUntilExit()
        guard proc.terminationStatus == 0 else {
            throw CodexClient.ClientError.rpc(
                "\(executable.lastPathComponent) exited with \(proc.terminationStatus)"
            )
        }
        return String(data: data, encoding: .utf8) ?? ""
    }
}

// MARK: - OpenCode local stats (opencode.db)

func formatTokens(_ tokens: Int) -> String {
    let value = Double(tokens)
    if value >= 1_000_000 { return String(format: "%.1fM", value / 1_000_000) }
    if value >= 1_000 { return String(format: "%.0fK", value / 1_000) }
    return "\(tokens)"
}

func shortenDirectory(_ path: String) -> String {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    return path.hasPrefix(home) ? "~" + path.dropFirst(home.count) : path
}

struct OpenCodeStats {
    struct Day {
        let day: String
        let tokens: Int
    }

    struct Provider {
        let name: String
        let tokens: Int
        let cost: Double
    }

    struct Project {
        let directory: String
        let sessions: Int
    }

    struct RecentModel {
        let provider: String
        let id: String
        let variant: String?
        let sessions: Int

        var value: String { "\(provider)/\(id)" }
        var label: String {
            variant.map { "\(provider)/\(id) · \($0)" } ?? "\(provider)/\(id)"
        }
    }

    let todaySessions: Int
    let todayTokens: Int
    let weekSessions: Int
    let weekTokens: Int
    let days: [Day]
    let providers: [Provider]
    let topProjects: [Project]
    let recentModels: [RecentModel]
    /// Inco spend in USD over 7 days, priced from tokens (see incoPricing).
    let incoSpend: Double?

    /// Inco per-model prices in $/M tokens (input, output). Cache reads are
    /// billed at 10% of the input rate. opencode's own cost estimate uses the
    /// models.dev catalog, which lists glm-5.3-flash:fast at half Inco's real
    /// rate and ignores cache reads — calibrated against the Inco dashboard
    /// 2026-09-25 (30.1M tokens = $2.22, flash = $1.99).
    static let incoPricing: [String: (input: Double, output: Double)] = [
        "glm-5.3-flash:fast": (0.30, 1.00),
        "glm-5.3:fast": (2.8, 8.8),
        "glm-5.3": (1.4, 4.4),
        "deepseek-v4.1-flash:fast": (0.6, 2.4),
        "kimi-k3:fast": (6, 30),
        "minimax-m3": (0.3, 1.2),
        "minimax-m3:fast": (0.6, 2.4),
    ]

    static func priceIncoUsage(
        model: String, input: Int, output: Int, cacheRead: Int
    ) -> Double {
        let rates = incoPricing[model] ?? (0.30, 1.00)
        let total = Double(input) * rates.input
            + Double(output) * rates.output
            + Double(cacheRead) * rates.input * 0.1
        return total / 1_000_000
    }

    static func providerDisplayName(_ name: String) -> String {
        switch name {
        case "zai-coding-plan": return "zai"
        case "openai": return "oai"
        default: return name
        }
    }

    static func providerColor(_ name: String) -> NSColor {
        switch name {
        case "zai-coding-plan": return .systemPurple
        case "openai": return .systemGreen
        case "inco": return .systemOrange
        case "opencode": return .systemTeal
        case "google": return .systemBlue
        default: return .systemGray
        }
    }
}

final class OpenCodeDB {
    static func databasePath() -> URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".local/share/opencode/opencode.db")
    }

    static func exists() -> Bool {
        FileManager.default.fileExists(atPath: databasePath().path)
    }

    private static func query(_ sql: String) throws -> [[String: Any]] {
        guard let sqlite = Shell.resolve("sqlite3") else {
            throw CodexClient.ClientError.rpc("sqlite3 binary not found")
        }
        let output = try Shell.run(sqlite, [
            "-readonly", "-json", databasePath().path, sql,
        ])
        let trimmed = output.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let data = trimmed.data(using: .utf8),
              let rows = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]]
        else { return [] }
        return rows
    }

    private static func int(_ any: Any?) -> Int {
        (any as? NSNumber)?.intValue ?? (any as? String).flatMap(Int.init) ?? 0
    }

    private static func dbl(_ any: Any?) -> Double {
        (any as? NSNumber)?.doubleValue ?? (any as? String).flatMap(Double.init) ?? 0
    }

    static func fetch() throws -> OpenCodeStats {
        // Per-day, per-provider usage for the last 14 days (session_v2 only,
        // per user preference — legacy v1 sessions are ignored).
        let usageRows = try query("""
            SELECT date(time_created/1000,'unixepoch','localtime') d,
                   json_extract(model,'$.providerID') p,
                   COUNT(*) n,
                   COALESCE(SUM(tokens_input+tokens_output+tokens_reasoning),0) t,
                   COALESCE(SUM(cost),0) c
            FROM session_v2
            WHERE time_created > ((strftime('%s','now')-1209600)*1000)
            GROUP BY d, p;
            """)
        var byDayProvider: [String: [String: (n: Int, t: Int, c: Double)]] = [:]
        for row in usageRows {
            guard let day = row["d"] as? String else { continue }
            let provider = (row["p"] as? String) ?? "unknown"
            let entry = (n: int(row["n"]), t: int(row["t"]), c: dbl(row["c"]))
            if let existing = byDayProvider[day]?[provider] {
                byDayProvider[day]![provider] = (
                    existing.n + entry.n, existing.t + entry.t, existing.c + entry.c
                )
            } else {
                byDayProvider[day, default: [:]][provider] = entry
            }
        }

        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        let calendar = Calendar.current
        let dayKeys = (0..<14).reversed().compactMap {
            calendar.date(byAdding: .day, value: -$0, to: Date()).map { formatter.string(from: $0) }
        }
        let weekKeys = Set(dayKeys.suffix(7))

        var days: [OpenCodeStats.Day] = []
        var weekSessions = 0, weekTokens = 0
        var providerTotals: [String: (t: Int, c: Double)] = [:]
        for day in dayKeys {
            let perProvider = byDayProvider[day] ?? [:]
            let tokens = perProvider.values.reduce(0) { $0 + $1.t }
            days.append(.init(day: day, tokens: tokens))
            if weekKeys.contains(day) {
                weekSessions += perProvider.values.reduce(0) { $0 + $1.n }
                weekTokens += tokens
                for (provider, value) in perProvider {
                    providerTotals[provider, default: (0, 0)].t += value.t
                    providerTotals[provider]!.c += value.c
                }
            }
        }
        let todayPerProvider = byDayProvider[dayKeys.last ?? ""] ?? [:]

        // Top projects over the last 7 days.
        let projectRows = try query("""
            SELECT directory dir, COUNT(*) n
            FROM session_v2
            WHERE time_created > ((strftime('%s','now')-604800)*1000)
            GROUP BY dir ORDER BY SUM(tokens_input+tokens_output+tokens_reasoning) DESC LIMIT 3;
            """)
        let projects = projectRows.compactMap { row -> OpenCodeStats.Project? in
            guard let dir = row["dir"] as? String else { return nil }
            return .init(directory: shortenDirectory(dir), sessions: int(row["n"]))
        }

        // Recently used models (all time, by latest activity).
        let modelRows = try query("""
            SELECT model m, COUNT(*) n
            FROM session_v2
            WHERE model IS NOT NULL
            GROUP BY model ORDER BY MAX(time_updated) DESC LIMIT 8;
            """)
        var models: [OpenCodeStats.RecentModel] = []
        for row in modelRows {
            guard let raw = row["m"] as? String,
                  let data = raw.data(using: .utf8),
                  let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let id = object["id"] as? String,
                  let provider = object["providerID"] as? String
            else { continue }
            models.append(.init(
                provider: provider, id: id,
                variant: object["variant"] as? String,
                sessions: int(row["n"])
            ))
        }

        var providers = providerTotals
            .map { OpenCodeStats.Provider(name: $0.key, tokens: $0.value.t, cost: $0.value.c) }
            .sorted { $0.tokens > $1.tokens }
        // Inco spend priced from real token counts (opencode's cost estimate
        // undercounts Inco; see incoPricing).
        let incoRows = try query("""
            SELECT json_extract(model,'$.id') mid,
                   SUM(tokens_input) i,
                   SUM(tokens_output+tokens_reasoning) o,
                   SUM(tokens_cache_read) cr
            FROM session_v2
            WHERE json_extract(model,'$.providerID')='inco'
              AND time_created > ((strftime('%s','now')-604800)*1000)
            GROUP BY mid;
            """)
        var incoSpend: Double?
        if !incoRows.isEmpty {
            incoSpend = incoRows.reduce(0.0) { sum, row in
                sum + OpenCodeStats.priceIncoUsage(
                    model: (row["mid"] as? String) ?? "",
                    input: int(row["i"]),
                    output: int(row["o"]),
                    cacheRead: int(row["cr"])
                )
            }
        }
        if let incoSpend {
            if let index = providers.firstIndex(where: { $0.name == "inco" }) {
                providers[index] = OpenCodeStats.Provider(
                    name: "inco", tokens: providers[index].tokens, cost: incoSpend
                )
            }
        }

        return OpenCodeStats(
            todaySessions: todayPerProvider.values.reduce(0) { $0 + $1.n },
            todayTokens: todayPerProvider.values.reduce(0) { $0 + $1.t },
            weekSessions: weekSessions,
            weekTokens: weekTokens,
            days: days,
            providers: providers,
            topProjects: projects,
            recentModels: models,
            incoSpend: incoSpend
        )
    }
}

// MARK: - Default model switcher (edits the repo file behind the symlink chain)

enum ModelSwitcher {
    static func configPath() -> URL {
        let live = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config/opencode/opencode.json")
        return URL(fileURLWithPath: (live.path as NSString).resolvingSymlinksInPath)
    }

    static func currentDefault() -> String? {
        guard let data = try? Data(contentsOf: configPath()),
              let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { return nil }
        return root["model"] as? String
    }

    static func setDefault(_ value: String) throws {
        let path = configPath()
        guard let original = try? String(contentsOf: path, encoding: .utf8) else {
            throw CodexClient.ClientError.rpc("could not read opencode config")
        }
        // Surgical replace of the single top-level "model" key; keeps the
        // hand-formatted layout of the git-tracked file untouched.
        guard let range = original.range(of: #""model"\s*:\s*"[^"]*""#, options: .regularExpression)
        else {
            throw CodexClient.ClientError.rpc("no \"model\" key found in opencode config")
        }
        let updated = original.replacingCharacters(
            in: range, with: #""model": "\#(value)""#
        )
        // Sanity: must still be valid JSON before writing.
        guard let data = updated.data(using: .utf8),
              (try? JSONSerialization.jsonObject(with: data)) != nil
        else {
            throw CodexClient.ClientError.rpc("edited config failed JSON validation; not written")
        }
        try data.write(to: path, options: .atomic)
    }
}

// MARK: - Limit notifications

final class Notifier {
    /// Nil when running unbundled (e.g. `--once` from a build dir), where
    /// UNUserNotificationCenter would crash.
    private var center: UNUserNotificationCenter? {
        guard Bundle.main.bundleIdentifier != nil else { return nil }
        return UNUserNotificationCenter.current()
    }

    init() {
        center?.requestAuthorization(options: [.alert]) { _, _ in }
    }

    /// Notifies when a window crosses into a worse alert band (>=20 / >=10 / drained).
    func update(key: String, label: String, remaining: Int, resetsIn: String?) {
        guard let center else { return }
        let band = remaining <= 0 ? 3 : (remaining < 10 ? 2 : (remaining < 20 ? 1 : 0))
        let storeKey = "notify.band.\(key)"
        let defaults = UserDefaults.standard
        let previous = defaults.object(forKey: storeKey) as? Int
        defaults.set(band, forKey: storeKey)
        guard let previous, band > previous else { return }

        let content = UNMutableNotificationContent()
        content.title = "Codex Usage"
        let resetSuffix = resetsIn.map { " · resets \($0)" } ?? ""
        switch band {
        case 3:
            content.body = "\(label) drained\(resetSuffix)"
            content.sound = .default
        default:
            content.body = "\(label): \(remaining)% left\(resetSuffix)"
        }
        center.add(UNNotificationRequest(identifier: key, content: content, trigger: nil))
    }
}

// MARK: - HTTP helper

enum HTTP {
    static func get(
        _ url: URL, headers: [String: String], timeout: TimeInterval = 15
    ) throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: url, timeoutInterval: timeout)
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        let box = LockedBox<Result<(Data, HTTPURLResponse), Error>?>(nil)
        let done = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error {
                box.set(.failure(error))
            } else if let response = response as? HTTPURLResponse, let data {
                box.set(.success((data, response)))
            } else {
                box.set(.failure(CodexClient.ClientError.rpc("invalid HTTP response")))
            }
            done.signal()
        }.resume()
        guard done.wait(timeout: .now() + timeout + 5) == .success,
              let result = box.get()
        else { throw CodexClient.ClientError.timeout }
        return try result.get()
    }
}

// MARK: - Codex client

final class CodexClient {
    enum ClientError: LocalizedError {
        case codexNotFound
        case timeout
        case rpc(String)

        var errorDescription: String? {
            switch self {
            case .codexNotFound:
                return "codex binary not found (looked in PATH and common locations)"
            case .timeout:
                return "codex app-server timed out"
            case .rpc(let message):
                return message
            }
        }
    }

    private let codexURL: URL

    init() throws {
        self.codexURL = try Self.resolveCodexBinary()
    }

    static func resolveCodexBinary() throws -> URL {
        var candidates: [String] = []
        let env = ProcessInfo.processInfo.environment
        if let override = env["CODEX_BIN"] { candidates.append(override) }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        candidates += [
            "\(home)/.local/bin/codex",
            "/opt/homebrew/bin/codex",
            "/usr/local/bin/codex",
        ]
        candidates += (env["PATH"] ?? "")
            .split(separator: ":")
            .map { "\($0)/codex" }
        for candidate in candidates where FileManager.default.isExecutableFile(atPath: candidate) {
            return URL(fileURLWithPath: candidate)
        }
        throw ClientError.codexNotFound
    }

    /// Spawns `codex app-server`, does the JSON-RPC handshake, calls one
    /// method and returns its raw response object. Blocks the calling thread.
    private func rpc(
        _ method: String, params: [String: Any]?, timeout: TimeInterval = 25
    ) throws -> [String: Any] {
        let proc = Process()
        proc.executableURL = codexURL
        proc.arguments = ["app-server"]
        let stdinPipe = Pipe()
        let stdoutPipe = Pipe()
        proc.standardInput = stdinPipe
        proc.standardOutput = stdoutPipe
        proc.standardError = Pipe()
        try proc.run()
        defer {
            if proc.isRunning { proc.terminate() }
            proc.waitUntilExit()
        }

        func send(_ object: [String: Any]) throws {
            let data = try JSONSerialization.data(withJSONObject: object)
            try stdinPipe.fileHandleForWriting.write(contentsOf: data + Data([0x0A]))
        }

        var request: [String: Any] = ["jsonrpc": "2.0", "id": 2, "method": method]
        if let params { request["params"] = params }
        try send([
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": ["clientInfo": ["name": "codex-usage", "title": "Codex Usage", "version": "1.0.0"]],
        ])
        try send(["jsonrpc": "2.0", "method": "initialized"])
        try send(request)

        let lineBuffer = LineBuffer()
        let box = LockedBox<[String: Any]?>(nil)
        let done = DispatchSemaphore(value: 0)

        stdoutPipe.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else {
                handle.readabilityHandler = nil
                done.signal()
                return
            }
            lineBuffer.append(chunk)
            while let line = lineBuffer.nextLine() {
                guard let data = line.data(using: .utf8),
                      let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                      object["id"] as? Int == 2
                else { continue }
                box.set(object)
                done.signal()
            }
        }

        defer { stdoutPipe.fileHandleForReading.readabilityHandler = nil }
        guard done.wait(timeout: .now() + timeout) == .success else {
            throw ClientError.timeout
        }
        guard let response = box.get() else {
            throw ClientError.rpc("no response from codex app-server")
        }
        if let error = response["error"] as? [String: Any],
           let message = error["message"] as? String {
            throw ClientError.rpc(message)
        }
        return response
    }

    /// Reads account rate limits. Blocks the calling thread.
    func fetch(timeout: TimeInterval = 25) throws -> (limits: RateLimits, credits: Int?) {
        let response = try rpc("account/rateLimits/read", params: nil, timeout: timeout)
        let envelope = try Self.decode(RateLimitsEnvelope.self, from: response["result"] ?? [:])
        guard let limits = envelope.rateLimits else {
            throw ClientError.rpc("response contained no rate limits")
        }
        return (limits, envelope.rateLimitResetCredits?.availableCount)
    }

    /// Redeems one rate-limit reset credit. The backend picks the credit when
    /// no id is given. Returns the outcome string, e.g. "reset".
    func consumeResetCredit() throws -> String {
        let response = try rpc(
            "account/rateLimitResetCredit/consume",
            params: ["idempotencyKey": UUID().uuidString]
        )
        let outcome = try Self.decode(ConsumeOutcome.self, from: response["result"] ?? [:])
        return outcome.outcome
    }

    private static func decode<T: Decodable>(_ type: T.Type, from object: Any) throws -> T {
        let data = try JSONSerialization.data(withJSONObject: object)
        return try JSONDecoder().decode(type, from: data)
    }
}

final class LineBuffer {
    private var data = Data()

    func append(_ chunk: Data) { data.append(chunk) }

    func nextLine() -> String? {
        guard let idx = data.firstIndex(where: { $0 == 0x0A }) else { return nil }
        let line = String(data: data[..<idx], encoding: .utf8)
        data = data[data.index(after: idx)...]
        return line
    }
}

final class LockedBox<T> {
    private var value: T
    private let lock = NSLock()

    init(_ value: T) { self.value = value }

    func set(_ value: T) {
        lock.lock()
        self.value = value
        lock.unlock()
    }

    func get() -> T {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
}

// MARK: - Formatting

func remainingPercent(_ limit: WindowLimit) -> Int {
    max(0, 100 - limit.usedPercent)
}

func shortReset(_ limit: WindowLimit) -> String? {
    guard let epoch = limit.resetsAt else { return nil }
    let formatter = RelativeDateTimeFormatter()
    formatter.unitsStyle = .abbreviated
    return formatter.localizedString(
        for: Date(timeIntervalSince1970: epoch), relativeTo: Date()
    )
}

func resetCaption(_ limit: WindowLimit) -> String {
    guard let epoch = limit.resetsAt else { return "" }
    let date = Date(timeIntervalSince1970: epoch)
    let absolute: String
    if limit.windowDurationMins == 300 {
        absolute = date.formatted(.dateTime.hour().minute())
    } else {
        absolute = date.formatted(
            .dateTime.weekday(.wide).day().month(.abbreviated).hour().minute()
        )
    }
    let formatter = RelativeDateTimeFormatter()
    formatter.unitsStyle = .abbreviated
    let relative = formatter.localizedString(for: date, relativeTo: Date())
    return "resets \(absolute) · \(relative)"
}

// MARK: - App state

enum SectionData<T> {
    case ok(T)
    case failed(String)

    static func okOr(_ fetch: () throws -> T) -> SectionData<T> {
        do { return .ok(try fetch()) } catch { return .failed(error.localizedDescription) }
    }
}

struct OkPayload {
    var limits: RateLimits
    var credits: Int?
    var zai: SectionData<ZaiQuota>?
    var stats: SectionData<OpenCodeStats>?
}

enum AppState {
    case loading
    case ok(OkPayload, fetchedAt: Date)
    case failed(String, fetchedAt: Date?)
}

// MARK: - Menu bar app

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let menu = NSMenu()
    private var state: AppState = .loading
    private var lastGood: (payload: OkPayload, fetchedAt: Date)?
    private var lastFetchAttempt: Date?
    private var pollInterval: TimeInterval = 180
    private var refreshTimer: Timer?
    private var pendingResetConfirm = false
    private var transientNotice: String?
    private let notifier = Notifier()

    func applicationDidFinishLaunching(_ notification: Notification) {
        let env = ProcessInfo.processInfo.environment
        if let raw = env["CODEX_USAGE_INTERVAL"], let value = Double(raw), value >= 15 {
            pollInterval = value
        }
        menu.delegate = self
        menu.autoenablesItems = false
        statusItem.menu = menu
        render()
        refresh()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: pollInterval, repeats: true) { [weak self] _ in
            self?.refresh()
        }
    }

    // MARK: Refresh

    @objc private func refreshNow() { refresh() }

    private func refresh() {
        lastFetchAttempt = Date()
        if lastGood == nil {
            state = .loading
            render()
        }
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            let outcome: AppState
            do {
                let client = try CodexClient()
                let (limits, credits) = try client.fetch()
                var payload = OkPayload(limits: limits, credits: credits)
                if ZaiClient.apiKey() != nil {
                    payload.zai = SectionData.okOr { try ZaiClient.fetch() }
                }
                if OpenCodeDB.exists() {
                    payload.stats = SectionData.okOr { try OpenCodeDB.fetch() }
                }
                outcome = .ok(payload, fetchedAt: Date())
            } catch {
                outcome = .failed(error.localizedDescription, fetchedAt: nil)
            }
            DispatchQueue.main.async { self.apply(outcome) }
        }
    }

    private func apply(_ newState: AppState) {
        if case .ok(let payload, let fetchedAt) = newState {
            lastGood = (payload, fetchedAt)
            // Limit notifications (codex + z.ai windows)
            if let weekly = payload.limits.secondary {
                notifier.update(
                    key: "codex.weekly", label: "Codex weekly",
                    remaining: remainingPercent(weekly), resetsIn: shortReset(weekly)
                )
            }
            if let fiveHour = payload.limits.primary {
                notifier.update(
                    key: "codex.5h", label: "Codex 5-hour",
                    remaining: remainingPercent(fiveHour), resetsIn: shortReset(fiveHour)
                )
            }
            if case .ok(let zai)? = payload.zai {
                notifier.update(
                    key: "zai.weekly", label: "z.ai weekly",
                    remaining: remainingPercent(zai.weekly), resetsIn: shortReset(zai.weekly)
                )
                if let fiveHour = zai.fiveHour {
                    notifier.update(
                        key: "zai.5h", label: "z.ai 5-hour",
                        remaining: remainingPercent(fiveHour), resetsIn: shortReset(fiveHour)
                    )
                }
            }
        }
        state = newState
        render()
    }

    func menuWillOpen(_ menu: NSMenu) {
        if let last = lastFetchAttempt, Date().timeIntervalSince(last) > 30 {
            refresh()
        }
    }

    // MARK: Rendering

    private func render() {
        guard let button = statusItem.button else { return }
        switch state {
        case .loading:
            button.image = symbol("bolt")
            button.title = "…"
        case .failed:
            button.image = symbol("exclamationmark.triangle")
            button.title = "?"
        case .ok(let payload, _):
            let limits = payload.limits
            let weekly = limits.secondary.map(remainingPercent) ?? 0
            let capped = weekly <= 0
            button.image = symbol(capped ? "hourglass" : "bolt.fill")
            var text = "\(weekly)%"
            if !capped, let fiveHour = limits.primary.map(remainingPercent) {
                text += " · \(fiveHour)%"
            }
            button.attributedTitle = attributedTitle(text, capped: capped)
        }
        rebuildMenu()
    }

    private func attributedTitle(_ text: String, capped: Bool) -> NSAttributedString {
        NSAttributedString(string: text, attributes: [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .regular),
            .foregroundColor: capped ? NSColor.systemRed : NSColor.labelColor,
        ])
    }

    private func symbol(_ name: String) -> NSImage? {
        let config = NSImage.SymbolConfiguration(pointSize: 13, weight: .medium)
        guard let image = NSImage(systemSymbolName: name, accessibilityDescription: "Codex usage") else {
            return nil
        }
        return image.withSymbolConfiguration(config)
    }

    // MARK: Menu

    private func rebuildMenu() {
        menu.removeAllItems()

        switch state {
        case .loading:
            addViewItem(MenuViews.header(subtitle: "Loading…"))
        case .failed(let message, let fetchedAt):
            var subtitle = message
            if let fetchedAt {
                subtitle += " · updated \(fetchedAt.formatted(.dateTime.hour().minute().second()))"
            }
            addViewItem(MenuViews.header(subtitle: subtitle, subtitleColor: .systemRed))
        case .ok(let payload, let fetchedAt):
            let plan = payload.limits.planType.map { "\($0.prefix(1).uppercased())\($0.dropFirst()) plan" } ?? "Codex"
            var subtitle = "\(plan) · updated \(fetchedAt.formatted(.dateTime.hour().minute().second()))"
            if let notice = transientNotice {
                subtitle += " · \(notice)"
            }
            addViewItem(MenuViews.header(subtitle: subtitle))
            if let weekly = payload.limits.secondary {
                addViewItem(MenuViews.limitRow(title: "Weekly", limit: weekly))
            }
            let capped = (payload.limits.secondary.map(remainingPercent) ?? 0) <= 0
            if let fiveHour = payload.limits.primary, !capped {
                addViewItem(MenuViews.limitRow(title: "5-hour window", limit: fiveHour))
            }
            if let credits = payload.credits, credits > 0 {
                let title = pendingResetConfirm
                    ? "⚠︎ Confirm: use reset credit now"
                    : "Use Reset Credit (\(credits) left)"
                let item = NSMenuItem(title: title, action: #selector(useResetCredit), keyEquivalent: "")
                item.target = self
                menu.addItem(item)
            }
            if let zai = payload.zai {
                menu.addItem(.separator())
                addViewItem(MenuViews.sectionLabel("z.ai · glm coding plan"))
                switch zai {
                case .ok(let quota):
                    addViewItem(MenuViews.limitRow(title: "Weekly", limit: quota.weekly))
                    if let fiveHour = quota.fiveHour {
                        addViewItem(MenuViews.limitRow(title: "5-hour window", limit: fiveHour))
                    }
                case .failed(let message):
                    addViewItem(MenuViews.footnote(message))
                }
            }
            if let stats = payload.stats {
                menu.addItem(.separator())
                addViewItem(MenuViews.sectionLabel("opencode · last 7 days"))
                switch stats {
                case .ok(let value):
                    addViewItem(MenuViews.valueRow(
                        title: "7 days", value: "\(value.weekSessions) sessions · \(formatTokens(value.weekTokens)) tok"
                    ))
                    addViewItem(MenuViews.valueRow(
                        title: "Today", value: "\(value.todaySessions) sessions · \(formatTokens(value.todayTokens)) tok"
                    ))
                    let legend = value.providers.prefix(4)
                        .map { "\(OpenCodeStats.providerDisplayName($0.name)) \(formatTokens($0.tokens))" }
                        .joined(separator: " · ")
                    if !legend.isEmpty {
                        addViewItem(MenuViews.providerBar(segments: value.providers.prefix(4).map {
                            (Double($0.tokens), OpenCodeStats.providerColor($0.name))
                        }))
                        addViewItem(MenuViews.footnote(legend))
                    }
                    if let peak = value.days.map(\.tokens).max(), peak > 0 {
                        addViewItem(MenuViews.sparkline(values: value.days.map(\.tokens)))
                        let first = value.days.first?.day.prefix(5) ?? ""
                        addViewItem(MenuViews.footnote(
                            "\(first) → today · peak \(formatTokens(peak)) tok / day"
                        ))
                    }
                    if !value.topProjects.isEmpty {
                        let projects = value.topProjects
                            .map { "\($0.directory) (\($0.sessions))" }
                            .joined(separator: " · ")
                        addViewItem(MenuViews.footnote(projects))
                    }
                case .failed(let message):
                    addViewItem(MenuViews.footnote("opencode stats: \(message)"))
                }
            }
            if case .ok(let stats)? = payload.stats, let spend = stats.incoSpend {
                menu.addItem(.separator())
                addViewItem(MenuViews.sectionLabel("inco · via opencode"))
                addViewItem(MenuViews.valueRow(
                    title: "Spent · last 7 days", value: String(format: "$%.2f", spend)
                ))
            }
        }

        // Controls
        menu.addItem(.separator())
        let chamber = NSMenuItem(
            title: "Open OpenChamber ↗", action: #selector(openOpenChamber), keyEquivalent: ""
        )
        chamber.target = self
        menu.addItem(chamber)

        if let stats = currentStats(), !stats.recentModels.isEmpty {
            let current = ModelSwitcher.currentDefault()
            let item = NSMenuItem(
                title: "Default Model", action: nil, keyEquivalent: ""
            )
            let submenu = NSMenu()
            for model in stats.recentModels {
                let entry = NSMenuItem(
                    title: "\(model.label) (\(model.sessions))",
                    action: #selector(pickModel(_:)),
                    keyEquivalent: ""
                )
                entry.target = self
                entry.representedObject = model.value
                if model.value == current { entry.state = .on }
                submenu.addItem(entry)
            }
            item.submenu = submenu
            menu.addItem(item)
        }

        menu.addItem(.separator())

        let refreshItem = NSMenuItem(
            title: "Refresh Now", action: #selector(refreshNow), keyEquivalent: "r"
        )
        refreshItem.target = self
        menu.addItem(refreshItem)

        let quitItem = NSMenuItem(
            title: "Quit Codex Usage", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"
        )
        menu.addItem(quitItem)
    }

    private func addViewItem(_ view: NSView) {
        let item = NSMenuItem()
        item.view = view
        item.isEnabled = false
        menu.addItem(item)
    }

    private func currentStats() -> OpenCodeStats? {
        if case .ok(let payload, _) = state, case .ok(let stats)? = payload.stats {
            return stats
        }
        if let good = lastGood, case .ok(let stats)? = good.payload.stats {
            return stats
        }
        return nil
    }

    // MARK: Controls

    @objc private func openOpenChamber() {
        NSWorkspace.shared.open(URL(string: "http://localhost:3001")!)
    }

    @objc private func pickModel(_ sender: NSMenuItem) {
        guard let value = sender.representedObject as? String else { return }
        transientNotice = "default model → \(value)…"
        rebuildMenu()
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            do {
                try ModelSwitcher.setDefault(value)
                DispatchQueue.main.async {
                    self?.transientNotice = "default model → \(value)"
                    self?.rebuildMenu()
                }
            } catch {
                DispatchQueue.main.async {
                    self?.transientNotice = "model switch failed: \(error.localizedDescription)"
                    self?.rebuildMenu()
                }
            }
        }
    }

    // MARK: Reset credit action

    @objc private func useResetCredit() {
        if !pendingResetConfirm {
            // Two-step confirm: first click arms, the click after re-opening
            // the menu executes. Arming expires so it can't fire accidentally.
            pendingResetConfirm = true
            rebuildMenu()
            DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
                guard let self, self.pendingResetConfirm else { return }
                self.pendingResetConfirm = false
                self.rebuildMenu()
            }
            return
        }
        pendingResetConfirm = false
        transientNotice = "redeeming credit…"
        rebuildMenu()
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let result: String
            do {
                result = try CodexClient().consumeResetCredit()
            } catch {
                result = "failed: \(error.localizedDescription)"
            }
            DispatchQueue.main.async {
                guard let self else { return }
                if result == "reset" {
                    self.transientNotice = nil
                    self.refresh()
                } else {
                    self.transientNotice = "credit: \(result)"
                    self.rebuildMenu()
                }
            }
        }
    }
}

// MARK: - Menu dropdown views (manual layout: NSMenuItem.view needs explicit frames)

enum MenuViews {
    static let width: CGFloat = 264
    static let margin: CGFloat = 12

    static func header(subtitle: String, subtitleColor: NSColor = .secondaryLabelColor) -> NSView {
        let container = NSView(frame: NSRect(x: 0, y: 0, width: width, height: 46))
        let title = NSTextField(labelWithString: "Codex Usage")
        title.font = .systemFont(ofSize: 13, weight: .bold)
        title.sizeToFit()
        title.frame.origin = NSPoint(x: margin, y: 26)
        let detail = NSTextField(labelWithString: subtitle)
        detail.font = .systemFont(ofSize: 10)
        detail.textColor = subtitleColor
        detail.lineBreakMode = .byTruncatingTail
        detail.frame = NSRect(x: margin, y: 9, width: width - 2 * margin, height: 14)
        container.addSubview(title)
        container.addSubview(detail)
        return container
    }

    static func limitRow(title: String, limit: WindowLimit) -> NSView {
        let remaining = remainingPercent(limit)
        let caption = resetCaption(limit)
        let hasCaption = !caption.isEmpty

        let padTop: CGFloat = 9
        let titleRowHeight: CGFloat = 18
        let gap: CGFloat = 4
        let barHeight: CGFloat = 5
        let captionHeight: CGFloat = 13
        let padBottom: CGFloat = hasCaption ? 8 : 9
        let height = padTop + titleRowHeight + gap + barHeight
            + (hasCaption ? gap + captionHeight : 0) + padBottom

        let container = NSView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        let titleRowY = height - padTop - titleRowHeight

        let titleLabel = NSTextField(labelWithString: title)
        titleLabel.font = .systemFont(ofSize: 12, weight: .semibold)
        titleLabel.sizeToFit()
        titleLabel.frame.origin = NSPoint(x: margin, y: titleRowY + 2)

        let percentLabel = NSTextField(labelWithString: "\(remaining)% left")
        percentLabel.font = .monospacedDigitSystemFont(ofSize: 13, weight: .bold)
        percentLabel.textColor = remaining <= 0 ? .systemRed : .labelColor
        percentLabel.sizeToFit()
        percentLabel.frame.origin = NSPoint(x: width - margin - percentLabel.frame.width, y: titleRowY + 2)

        let bar = PercentageBar(frame: NSRect(
            x: margin, y: titleRowY - gap - barHeight,
            width: width - 2 * margin, height: barHeight
        ))
        bar.fraction = Double(remaining) / 100
        container.addSubview(bar)

        if hasCaption {
            let captionLabel = NSTextField(labelWithString: caption)
            captionLabel.font = .systemFont(ofSize: 10)
            captionLabel.textColor = .secondaryLabelColor
            captionLabel.lineBreakMode = .byTruncatingTail
            captionLabel.frame = NSRect(
                x: margin, y: padBottom, width: width - 2 * margin, height: captionHeight
            )
            container.addSubview(captionLabel)
        }

        container.addSubview(titleLabel)
        container.addSubview(percentLabel)
        return container
    }

    static func footnote(_ text: String) -> NSView {
        let container = NSView(frame: NSRect(x: 0, y: 0, width: width, height: 27))
        let label = NSTextField(labelWithString: text)
        label.font = .systemFont(ofSize: 10)
        label.textColor = .secondaryLabelColor
        label.lineBreakMode = .byTruncatingTail
        label.frame = NSRect(x: margin, y: 6, width: width - 2 * margin, height: 14)
        container.addSubview(label)
        return container
    }

    static func sectionLabel(_ text: String) -> NSView {
        let container = NSView(frame: NSRect(x: 0, y: 0, width: width, height: 26))
        let label = NSTextField(labelWithString: text.uppercased())
        label.font = .systemFont(ofSize: 10, weight: .semibold)
        label.textColor = .tertiaryLabelColor
        label.sizeToFit()
        label.frame.origin = NSPoint(x: margin, y: 7)
        container.addSubview(label)
        return container
    }

    static func spendRow(title: String, amount: String) -> NSView {
        valueRow(title: title, value: amount)
    }

    static func valueRow(title: String, value: String) -> NSView {
        let container = NSView(frame: NSRect(x: 0, y: 0, width: width, height: 32))
        let titleLabel = NSTextField(labelWithString: title)
        titleLabel.font = .systemFont(ofSize: 12, weight: .semibold)
        titleLabel.sizeToFit()
        titleLabel.frame.origin = NSPoint(x: margin, y: 8)
        let valueLabel = NSTextField(labelWithString: value)
        valueLabel.font = .monospacedDigitSystemFont(ofSize: 13, weight: .bold)
        valueLabel.sizeToFit()
        valueLabel.frame.origin = NSPoint(x: width - margin - valueLabel.frame.width, y: 8)
        container.addSubview(titleLabel)
        container.addSubview(valueLabel)
        return container
    }

    static func providerBar(segments: [(Double, NSColor)]) -> NSView {
        let container = NSView(frame: NSRect(x: 0, y: 0, width: width, height: 10))
        let bar = ProviderBar(frame: NSRect(x: margin, y: 2, width: width - 2 * margin, height: 5))
        bar.segments = segments
        container.addSubview(bar)
        return container
    }

    static func sparkline(values: [Int]) -> NSView {
        let container = NSView(frame: NSRect(x: 0, y: 0, width: width, height: 38))
        let chart = Sparkline(
            frame: NSRect(x: margin, y: 4, width: width - 2 * margin, height: 30)
        )
        chart.values = values.map(Double.init)
        container.addSubview(chart)
        return container
    }
}

final class PercentageBar: NSView {
    var fraction: Double = 0 {
        didSet { needsDisplay = true }
    }

    override func draw(_ dirtyRect: NSRect) {
        let radius = bounds.height / 2
        NSColor.quaternaryLabelColor.setFill()
        NSBezierPath(roundedRect: bounds, xRadius: radius, yRadius: radius).fill()

        // fraction is the *remaining* share; a fully drained window shows as a
        // solid red bar so the exhausted state is unmissable.
        let clamped = min(max(fraction, 0), 1)
        let width = clamped <= 0 ? bounds.width : bounds.width * clamped
        guard width >= 2 else { return }
        let color: NSColor = clamped <= 0
            ? .systemRed
            : (clamped <= 0.2 ? .systemOrange : .controlAccentColor)
        color.setFill()
        NSBezierPath(
            roundedRect: NSRect(x: 0, y: 0, width: width, height: bounds.height),
            xRadius: radius, yRadius: radius
        ).fill()
    }
}

final class ProviderBar: NSView {
    var segments: [(Double, NSColor)] = [] {
        didSet { needsDisplay = true }
    }

    override func draw(_ dirtyRect: NSRect) {
        let total = segments.reduce(0) { $0 + $1.0 }
        guard total > 0 else { return }
        var x: CGFloat = 0
        for (fraction, color) in segments {
            let segmentWidth = bounds.width * CGFloat(fraction / total)
            guard segmentWidth > 0.5 else { continue }
            color.setFill()
            NSBezierPath(rect: NSRect(x: x, y: 0, width: segmentWidth, height: bounds.height)).fill()
            x += segmentWidth
        }
    }
}

final class Sparkline: NSView {
    var values: [Double] = [] {
        didSet { needsDisplay = true }
    }

    override func draw(_ dirtyRect: NSRect) {
        guard !values.isEmpty else { return }
        let peak = max(values.max() ?? 1, 1)
        let gap: CGFloat = 2
        let barWidth = (bounds.width - gap * CGFloat(values.count - 1)) / CGFloat(values.count)
        for (index, value) in values.enumerated() {
            let height = bounds.height * CGFloat(value / peak)
            let rect = NSRect(
                x: CGFloat(index) * (barWidth + gap), y: 0,
                width: barWidth, height: max(1.5, height)
            )
            let isLast = index == values.count - 1
            (isLast ? NSColor.controlAccentColor : NSColor.tertiaryLabelColor).setFill()
            rect.fill()
        }
    }
}

// MARK: - Entry point

func runOnce() -> Int32 {
    do {
        let client = try CodexClient()
        let (limits, credits) = try client.fetch()
        print("plan: \(limits.planType ?? "?")")
        if let weekly = limits.secondary {
            print("weekly: \(remainingPercent(weekly))% left (\(resetCaption(weekly)))")
        }
        if let fiveHour = limits.primary {
            print("5h: \(remainingPercent(fiveHour))% left (\(resetCaption(fiveHour)))")
        }
        if let credits {
            print("reset credits: \(credits)")
        }
        if ZaiClient.apiKey() != nil {
            if let quota = try? ZaiClient.fetch() {
                print("zai weekly: \(remainingPercent(quota.weekly))% left (\(resetCaption(quota.weekly)))")
                if let fiveHour = quota.fiveHour {
                    print("zai 5h: \(remainingPercent(fiveHour))% left (\(resetCaption(fiveHour)))")
                }
            } else {
                print("zai: unavailable")
            }
        }
        if OpenCodeDB.exists(), let stats = try? OpenCodeDB.fetch() {
            print("opencode 7d: \(stats.weekSessions) sessions · \(formatTokens(stats.weekTokens)) tok")
            print("opencode today: \(stats.todaySessions) sessions · \(formatTokens(stats.todayTokens)) tok")
            for provider in stats.providers.prefix(5) {
                var line = "  \(provider.name): \(formatTokens(provider.tokens)) tok"
                if provider.cost > 0 { line += String(format: " · $%.2f", provider.cost) }
                print(line)
            }
            for project in stats.topProjects {
                print("  \(project.directory) (\(project.sessions) sessions)")
            }
            if let spend = stats.incoSpend {
                print(String(format: "inco spend (7d): $%.2f", spend))
            }
        }
        return 0
    } catch {
        FileHandle.standardError.write(Data(("error: \(error.localizedDescription)\n").utf8))
        return 1
    }
}

/// Renders the dropdown's custom views to a PNG (debugging aid: `--snap <path>`).
func snapDropdown(to path: String) -> Int32 {
    do {
        let client = try CodexClient()
        let (limits, credits) = try client.fetch()

        var views: [NSView] = []
        let plan = limits.planType.map { "\($0.prefix(1).uppercased())\($0.dropFirst()) plan" } ?? "Codex"
        views.append(MenuViews.header(subtitle: plan))
        if let weekly = limits.secondary {
            views.append(MenuViews.limitRow(title: "Weekly", limit: weekly))
        }
        let capped = (limits.secondary.map(remainingPercent) ?? 0) <= 0
        if let fiveHour = limits.primary, !capped {
            views.append(MenuViews.limitRow(title: "5-hour window", limit: fiveHour))
        }
        if let zai = try? ZaiClient.fetch() {
            views.append(MenuViews.sectionLabel("z.ai · glm coding plan"))
            views.append(MenuViews.limitRow(title: "Weekly", limit: zai.weekly))
            if let fiveHour = zai.fiveHour {
                views.append(MenuViews.limitRow(title: "5-hour window", limit: fiveHour))
            }
        }
        if let stats = try? OpenCodeDB.fetch() {
            views.append(MenuViews.sectionLabel("opencode · last 7 days"))
            views.append(MenuViews.valueRow(
                title: "7 days",
                value: "\(stats.weekSessions) sessions · \(formatTokens(stats.weekTokens)) tok"
            ))
            views.append(MenuViews.valueRow(
                title: "Today",
                value: "\(stats.todaySessions) sessions · \(formatTokens(stats.todayTokens)) tok"
            ))
            if !stats.providers.isEmpty {
                views.append(MenuViews.providerBar(segments: stats.providers.prefix(4).map {
                    (Double($0.tokens), OpenCodeStats.providerColor($0.name))
                }))
                views.append(MenuViews.footnote(
                    stats.providers.prefix(4)
                        .map { "\(OpenCodeStats.providerDisplayName($0.name)) \(formatTokens($0.tokens))" }
                        .joined(separator: " · ")
                ))
            }
            if let peak = stats.days.map(\.tokens).max(), peak > 0 {
                views.append(MenuViews.sparkline(values: stats.days.map(\.tokens)))
            }
            if let spend = stats.incoSpend {
                views.append(MenuViews.sectionLabel("inco · via opencode"))
                views.append(MenuViews.valueRow(
                    title: "Spent · last 7 days", value: String(format: "$%.2f", spend)
                ))
            }
        }

        let totalHeight = views.reduce(CGFloat(0)) { $0 + $1.frame.height }
        let container = NSView(frame: NSRect(x: 0, y: 0, width: MenuViews.width, height: totalHeight))
        var y: CGFloat = 0
        for view in views.reversed() {
            view.frame.origin = NSPoint(x: 0, y: y)
            y += view.frame.height
            container.addSubview(view)
        }
        container.wantsLayer = true
        container.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor

        let rep = container.bitmapImageRepForCachingDisplay(in: container.bounds)!
        container.cacheDisplay(in: container.bounds, to: rep)
        let image = NSImage()
        image.addRepresentation(rep)
        if let tiff = image.tiffRepresentation,
           let bitmap = NSBitmapImageRep(data: tiff),
           let png = bitmap.representation(using: .png, properties: [:]) {
            try png.write(to: URL(fileURLWithPath: path))
            return 0
        }
        return 1
    } catch {
        FileHandle.standardError.write(Data(("error: \(error.localizedDescription)\n").utf8))
        return 1
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)

if CommandLine.arguments.contains("--once") {
    exit(runOnce())
}

if let snapIndex = CommandLine.arguments.firstIndex(of: "--snap"),
   CommandLine.arguments.count > snapIndex + 1 {
    exit(snapDropdown(to: CommandLine.arguments[snapIndex + 1]))
}

// Avoid two status items if launchd and LaunchServices race to start us
// (CLI modes above are exempt).
let alreadyRunning = NSRunningApplication.runningApplications(withBundleIdentifier: "dev.tomas.codex-usage")
if alreadyRunning.count > 1 {
    exit(0)
}

app.run()
