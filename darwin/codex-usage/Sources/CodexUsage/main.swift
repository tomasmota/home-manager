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

struct OkPayload {
    var limits: RateLimits
    var credits: Int?
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
    private var hasFetchedSuccessfully = false
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
        if !hasFetchedSuccessfully {
            state = .loading
            render()
        }
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            let outcome: AppState
            do {
                let client = try CodexClient()
                let (limits, credits) = try client.fetch()
                let payload = OkPayload(limits: limits, credits: credits)
                outcome = .ok(payload, fetchedAt: Date())
            } catch {
                outcome = .failed(error.localizedDescription, fetchedAt: nil)
            }
            DispatchQueue.main.async { self.apply(outcome) }
        }
    }

    private func apply(_ newState: AppState) {
        if case .ok(let payload, _) = newState {
            hasFetchedSuccessfully = true
            // Codex limit notifications
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
        }

        // Controls
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
        let (limits, _) = try client.fetch()

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
