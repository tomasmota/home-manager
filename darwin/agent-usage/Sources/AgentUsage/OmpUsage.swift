// Data layer: omp usage models, omp CLI client and limit notifications. UI lives elsewhere.
import Foundation
import UserNotifications

// MARK: - Models (`omp usage --json`, `omp usage reset --json`)

struct UsageAmount: Decodable {
    let used: Double?
}

struct UsageWindow: Decodable {
    let durationMs: Double?
    /// Epoch milliseconds.
    let resetsAt: Double?
}

struct UsageLimit: Decodable {
    let id: String
    let label: String
    let window: UsageWindow?
    let amount: UsageAmount
}

struct ReportMetadata: Decodable {
    let planType: String?
    let accountId: String?
}

struct ResetSummary: Decodable {
    let availableCount: Int?
}

struct UsageReport: Decodable {
    let provider: String
    let limits: [UsageLimit]
    let metadata: ReportMetadata?
    let resetCredits: ResetSummary?
}

struct UsageSnapshot: Decodable {
    let reports: [UsageReport]
}

struct ResetCredit: Decodable {
    let status: String?
    /// ISO 8601 with fractional seconds.
    let expiresAt: String?

    var expiry: Date? {
        expiresAt.flatMap { try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse($0) }
    }
}

struct ResetAccount: Decodable {
    let provider: String
    let credentialId: Int
    let accountId: String?
    let redeemableCount: Int?
    let credits: [ResetCredit]?
}

struct ResetList: Decodable {
    let accounts: [ResetAccount]
}

/// "Codex", "Claude", or the raw provider id.
func productName(_ provider: String) -> String {
    switch provider {
    case "openai-codex": return "Codex"
    case "anthropic": return "Claude"
    default: return provider
    }
}

/// ChatGPT workspace plans; the first Codex account on one drives the menu bar title.
let workPlanTypes: Set<String> = ["team", "business", "enterprise", "edu", "education"]
let codexWeeklyId = "openai-codex:secondary"
let codexFiveHourId = "openai-codex:primary"

struct Account {
    let report: UsageReport
    /// `<provider>/<credential id>` for `omp usage reset`, when a reset is redeemable now.
    var resetTarget: String?
    var resetsLeft = 0
    /// Available saved resets, soonest expiry first.
    var resetCredits: [ResetCredit] = []

    var key: String { "\(report.provider)|\(report.metadata?.accountId ?? "")" }

    var isWork: Bool {
        report.provider == "openai-codex" && workPlanTypes.contains(report.metadata?.planType ?? "")
    }

    var product: String { productName(report.provider) }

    /// Capitalized plan type ("Team", "Plus"), when omp reports one.
    var plan: String? {
        guard let plan = report.metadata?.planType, !plan.isEmpty else { return nil }
        return "\(plan.prefix(1).uppercased())\(plan.dropFirst())"
    }

    func limit(_ id: String) -> UsageLimit? { report.limits.first { $0.id == id } }
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

    /// Notifies when a window crosses into a worse alert band (<20 / <10 / drained).
    func update(key: String, label: String, remaining: Int, resetsIn: String?) {
        guard let center else { return }
        let band = remaining <= 0 ? 3 : (remaining < 10 ? 2 : (remaining < 20 ? 1 : 0))
        let storeKey = "notify.band.\(key)"
        let defaults = UserDefaults.standard
        let previous = defaults.object(forKey: storeKey) as? Int
        defaults.set(band, forKey: storeKey)
        guard let previous, band > previous else { return }

        let content = UNMutableNotificationContent()
        content.title = "Agent Usage"
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

// MARK: - omp client

final class OmpClient {
    enum ClientError: LocalizedError {
        case ompNotFound
        case timeout
        case failed(String)

        var errorDescription: String? {
            switch self {
            case .ompNotFound:
                return "omp binary not found (set OMP_BIN or add it to PATH)"
            case .timeout:
                return "omp timed out"
            case .failed(let message):
                return message
            }
        }
    }

    private let ompURL: URL

    init() throws {
        let env = ProcessInfo.processInfo.environment
        let candidates = [env["OMP_BIN"]].compactMap { $0 }
            + (env["PATH"] ?? "").split(separator: ":").map { "\($0)/omp" }
        guard let path = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            throw ClientError.ompNotFound
        }
        ompURL = URL(fileURLWithPath: path)
    }

    /// Runs omp and returns stdout; a non-zero exit throws its stderr. Blocks the calling thread.
    private func run(_ arguments: [String], timeout: TimeInterval = 30) throws -> Data {
        let proc = Process()
        proc.executableURL = ompURL
        proc.arguments = arguments
        var env = ProcessInfo.processInfo.environment
        env["NO_COLOR"] = "1"
        proc.environment = env
        let stdout = Pipe()
        let stderr = Pipe()
        proc.standardInput = FileHandle.nullDevice
        proc.standardOutput = stdout
        proc.standardError = stderr
        let exited = DispatchSemaphore(value: 0)
        proc.terminationHandler = { _ in exited.signal() }
        try proc.run()

        // Drain both pipes concurrently so large JSON cannot fill a pipe and stall omp.
        let readers = DispatchGroup()
        let out = LockedBox(Data())
        let err = LockedBox(Data())
        DispatchQueue.global().async(group: readers) { out.set(stdout.fileHandleForReading.readDataToEndOfFile()) }
        DispatchQueue.global().async(group: readers) { err.set(stderr.fileHandleForReading.readDataToEndOfFile()) }

        guard exited.wait(timeout: .now() + timeout) == .success else {
            proc.terminate()
            throw ClientError.timeout
        }
        _ = readers.wait(timeout: .now() + 5)
        guard proc.terminationStatus == 0 else {
            let message = String(decoding: err.get(), as: UTF8.self)
                .replacingOccurrences(of: "\u{1B}\\[[0-9;]*m", with: "", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            throw ClientError.failed(message.isEmpty ? "omp exited with status \(proc.terminationStatus)" : message)
        }
        return out.get()
    }

    /// Every authenticated account omp reports, work Codex first. Blocks the calling thread.
    func accounts() throws -> [Account] {
        let snapshot = try JSONDecoder().decode(UsageSnapshot.self, from: run(["usage", "--json"]))
        var accounts = snapshot.reports.map { Account(report: $0) }

        // Credential ids for spending resets come only from the reset listing.
        if snapshot.reports.contains(where: { ($0.resetCredits?.availableCount ?? 0) > 0 }),
           let data = try? run(["usage", "reset", "--json"]),
           let list = try? JSONDecoder().decode(ResetList.self, from: data) {
            for entry in list.accounts {
                guard let count = entry.redeemableCount, count > 0,
                      let index = accounts.firstIndex(where: {
                          $0.report.provider == entry.provider && $0.report.metadata?.accountId == entry.accountId
                      })
                else { continue }
                accounts[index].resetTarget = "\(entry.provider)/\(entry.credentialId)"
                accounts[index].resetsLeft = count
                accounts[index].resetCredits = (entry.credits ?? [])
                    .filter { $0.status == "available" }
                    .sorted { ($0.expiry ?? .distantFuture) < ($1.expiry ?? .distantFuture) }
            }
        }

        func rank(_ account: Account) -> Int {
            account.isWork ? 0 : (account.report.provider == "openai-codex" ? 1 : 2)
        }
        return accounts.enumerated()
            .sorted { (rank($0.element), $0.offset) < (rank($1.element), $1.offset) }
            .map(\.element)
    }

    /// Spends one saved reset on `target` (`<provider>/<credential id>`), then drops
    /// omp's cached report so the next read shows the cleared windows.
    func spendReset(target: String) throws {
        _ = try run(["usage", "reset", target])
        let provider = String(target.prefix { $0 != "/" })
        _ = try? run(["usage", "invalidate", "--provider", provider])
    }

    /// Ingests new session files into omp's stats database (`omp stats` reads lazily).
    func syncStats() throws {
        _ = try run(["stats", "--summary"], timeout: 120)
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

// MARK: - Helpers

func remainingPercent(_ limit: UsageLimit) -> Int {
    100 - min(100, max(0, Int((limit.amount.used ?? 0).rounded())))
}

func resetDate(_ limit: UsageLimit) -> Date? {
    limit.window?.resetsAt.map { Date(timeIntervalSince1970: $0 / 1000) }
}
