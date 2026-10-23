import AppKit

private let panelWidth: CGFloat = 370

private func relativeReset(_ date: Date?, now: Date = Date()) -> String {
    guard let date else { return "Reset unknown" }
    let seconds = max(0, Int(date.timeIntervalSince(now)))
    if seconds == 0 { return "Resetting now" }
    if seconds < 60 { return "in <1m" }
    if seconds < 3600 { return "in \(seconds / 60)m" }
    if seconds < 86400 { return "in \(seconds / 3600)h \((seconds % 3600) / 60)m" }
    return "in \(seconds / 86400)d \((seconds % 86400) / 3600)h"
}

private func notify(_ accounts: [Account], using notifier: Notifier) {
    for account in accounts {
        for limit in account.report.limits {
            let name = [account.product, account.plan].compactMap { $0 }.joined(separator: " ")
            notifier.update(key: "\(account.key)|\(limit.id)", label: "\(name) · \(limit.label)", remaining: remainingPercent(limit), resetsIn: relativeReset(resetDate(limit)))
        }
    }
}

private func ink(_ percent: Int) -> NSColor {
    if percent < 10 { return .systemRed }
    if percent < 20 { return .systemOrange }
    return .secondaryLabelColor
}

private final class UsageStore {
    var accounts: [Account] = []
    var hasLoaded = false
    var refreshing = false
    var error: String?
    var lastAttempt: Date?
    var armed: [String: Date] = [:]
    var resetting: Set<String> = []
    var resetErrors: [String: String] = [:]
    var stats: UsageStats?
    var statsError: String?
    var changed: (() -> Void)?
    private var refreshAgain = false
    private let notifier = Notifier()

    func refresh() {
        guard !refreshing else { refreshAgain = true; return }
        refreshing = true
        lastAttempt = Date()
        changed?()
        DispatchQueue.global(qos: .utility).async {
            let result = Result { try OmpClient().accounts() }
            let stats = Result { try loadUsageStats() }
            DispatchQueue.main.async {
                self.refreshing = false
                switch result {
                case .success(let accounts):
                    self.accounts = accounts
                    self.hasLoaded = true
                    self.error = nil
                    notify(accounts, using: self.notifier)
                case .failure(let error): self.error = error.localizedDescription
                }
                switch stats {
                case .success(let stats):
                    self.stats = stats
                    self.statsError = nil
                case .failure(let error): self.statsError = error.localizedDescription
                }
                self.changed?()
                if self.refreshAgain {
                    self.refreshAgain = false
                    self.refresh()
                }
            }
        }
    }

    func useReset(_ account: Account) {
        guard let target = account.resetTarget, !resetting.contains(account.key) else { return }
        let key = account.key
        guard let expiry = armed[key], expiry > Date() else {
            let expiry = Date().addingTimeInterval(10)
            armed[key] = expiry
            resetErrors[key] = nil
            changed?()
            DispatchQueue.main.asyncAfter(deadline: .now() + 10) {
                if self.armed[key] == expiry {
                    self.armed[key] = nil
                    self.changed?()
                }
            }
            return
        }
        armed[key] = nil
        resetting.insert(key)
        resetErrors[key] = nil
        changed?()
        DispatchQueue.global(qos: .utility).async {
            let result = Result { try OmpClient().spendReset(target: target) }
            DispatchQueue.main.async {
                self.resetting.remove(key)
                switch result {
                case .success: self.refresh()
                case .failure(let error): self.resetErrors[key] = error.localizedDescription
                }
                self.changed?()
            }
        }
    }
}

private final class ActionButton: NSButton {
    private var actionHandler: (() -> Void)?
    convenience init(_ title: String, action: @escaping () -> Void) {
        self.init(frame: .zero)
        self.title = title
        actionHandler = action
        target = self
        self.action = #selector(invoke)
        bezelStyle = .recessed
        isBordered = false
        setButtonType(.momentaryPushIn)
        controlSize = .small
        font = .systemFont(ofSize: 11)
        setContentHuggingPriority(.required, for: .horizontal)
    }
    @objc private func invoke() { actionHandler?() }
}

private final class UsageBar: NSView {
    let percent: Int
    let tint: NSColor
    init(percent: Int, tint: NSColor) {
        self.percent = percent
        self.tint = tint
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([widthAnchor.constraint(equalToConstant: 68), heightAnchor.constraint(equalToConstant: 4)])
        setAccessibilityElement(true)
        setAccessibilityRole(.progressIndicator)
        setAccessibilityValue("\(percent)% left")
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.quaternaryLabelColor.setFill()
        NSBezierPath(roundedRect: bounds, xRadius: 2, yRadius: 2).fill()
        if percent > 0 {
            (percent < 20 ? ink(percent) : tint).setFill()
            NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: max(4, bounds.width * CGFloat(percent) / 100), height: bounds.height), xRadius: 2, yRadius: 2).fill()
        }
    }
}

private func label(_ text: String, size: CGFloat = 11, weight: NSFont.Weight = .regular, color: NSColor = .labelColor) -> NSTextField {
    let field = NSTextField(labelWithString: text)
    field.font = .systemFont(ofSize: size, weight: weight)
    field.textColor = color
    field.lineBreakMode = .byTruncatingTail
    field.maximumNumberOfLines = 1
    return field
}

private func row(_ views: [NSView], spacing: CGFloat = 6) -> NSStackView {
    let stack = NSStackView(views: views)
    stack.orientation = .horizontal
    stack.alignment = .centerY
    stack.spacing = spacing
    return stack
}

private func spacer() -> NSView {
    let view = NSView()
    view.setContentHuggingPriority(.defaultLow, for: .horizontal)
    return view
}

private func separator() -> NSView {
    let line = NSBox()
    line.boxType = .separator
    return line
}

/// Hover details for the panel. AppKit tool tips only appear while the app is active,
/// which opening a menu bar popover does not guarantee, so this tracks the mouse itself.
private final class HoverTip {
    static let shared = HoverTip()
    private let popover = NSPopover()
    private let field = NSTextField(wrappingLabelWithString: "")
    private weak var anchor: NSView?
    private var pending: DispatchWorkItem?

    private init() {
        field.font = .systemFont(ofSize: 11)
        let controller = NSViewController()
        controller.view = NSView()
        controller.view.addSubview(field)
        popover.contentViewController = controller
        popover.behavior = .applicationDefined
        popover.animates = false
    }

    func show(_ text: String, from view: NSView) {
        guard anchor !== view else { return }
        hide()
        anchor = view
        let work = DispatchWorkItem { [weak self, weak view] in
            guard let self, let view, view.window != nil else { return }
            self.field.stringValue = text
            let fit = self.field.cell!.cellSize(forBounds: NSRect(x: 0, y: 0, width: 300, height: 1000))
            let size = NSSize(width: ceil(fit.width), height: ceil(fit.height))
            self.field.frame = NSRect(origin: NSPoint(x: 10, y: 7), size: size)
            self.popover.contentSize = NSSize(width: size.width + 20, height: size.height + 14)
            self.popover.show(relativeTo: view.bounds, of: view, preferredEdge: .minY)
        }
        pending = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: work)
    }

    /// Hides the tip; with `view`, only when the tip belongs to it.
    func hide(from view: NSView? = nil) {
        if let view, view !== anchor { return }
        pending?.cancel()
        pending = nil
        anchor = nil
        if popover.isShown { popover.close() }
    }
}

private final class HoverTracker: NSResponder {
    let text: String
    weak var view: NSView?
    init(text: String, view: NSView) {
        self.text = text
        self.view = view
        super.init()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func mouseEntered(with event: NSEvent) { if let view { HoverTip.shared.show(text, from: view) } }
    // Also catches a pointer already resting where a rebuilt panel placed a new view.
    override func mouseMoved(with event: NSEvent) { mouseEntered(with: event) }
    override func mouseExited(with event: NSEvent) { if let view { HoverTip.shared.hide(from: view) } }
}

private var hoverTrackerKey: UInt8 = 0

/// Shows `text` in a tip while the pointer rests on `view`, even when the app is inactive.
private func hover(_ view: NSView, _ text: String) {
    let tracker = HoverTracker(text: text, view: view)
    objc_setAssociatedObject(view, &hoverTrackerKey, tracker, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
    view.addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .mouseMoved, .activeAlways, .inVisibleRect], owner: tracker, userInfo: nil))
    view.setAccessibilityHelp(text)
}

private let shortDateTime = Date.FormatStyle().weekday(.abbreviated).day().month(.abbreviated).hour().minute()

private func resetCreditsTip(_ account: Account) -> String {
    let expiries = account.resetCredits.map { credit in
        credit.expiry.map { "\($0.formatted(shortDateTime)) (\(relativeReset($0)))" } ?? "No expiry reported"
    }
    let header = expiries.isEmpty ? "\(account.resetsLeft) saved resets" : "Saved resets expire:"
    return ([header] + expiries + ["Click, then confirm, to spend one."]).joined(separator: "\n")
}

private func accountSection(_ account: Account, store: UsageStore) -> NSView {
    let claude = account.report.provider == "anthropic"
    let tint: NSColor = claude ? .systemOrange : .systemTeal
    let image = NSImageView(image: NSImage(systemSymbolName: claude ? "sparkle" : "terminal", accessibilityDescription: account.product)!)
    image.contentTintColor = tint
    image.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([image.widthAnchor.constraint(equalToConstant: 16), image.heightAnchor.constraint(equalToConstant: 16)])
    let title = label(account.product, size: 12, weight: .semibold)
    let plan = label([account.plan, account.isWork ? "Work" : nil].compactMap { $0 }.joined(separator: " · "), color: .secondaryLabelColor)
    var headingViews: [NSView] = [image, title, plan, spacer()]
    if store.resetting.contains(account.key) {
        headingViews.append(label("Using reset…", size: 10, color: .secondaryLabelColor))
    } else if account.resetTarget != nil {
        let isArmed = (store.armed[account.key] ?? .distantPast) > Date()
        let button = ActionButton(isArmed ? "Confirm reset?" : "Use reset (\(account.resetsLeft))") { store.useReset(account) }
        button.contentTintColor = isArmed ? .systemRed : .secondaryLabelColor
        hover(button, isArmed ? "Click again within 10 seconds to spend one saved reset." : resetCreditsTip(account))
        headingViews.append(button)
    }
    let heading = row(headingViews)
    let stack = NSStackView()
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 5
    stack.addArrangedSubview(heading)
    for limit in account.report.limits {
        let percent = remainingPercent(limit)
        let duration = limit.window?.durationMs ?? 0
        let name = duration >= 6 * 86400000 ? "7 days" : (duration > 0 && duration <= 5 * 3600000 ? "5 hours" : limit.label.replacingOccurrences(of: "Claude ", with: ""))
        let window = label(name, color: .secondaryLabelColor)
        window.widthAnchor.constraint(equalToConstant: 45).isActive = true
        let remaining = label("\(percent)% left", size: 11, weight: .medium, color: ink(percent))
        remaining.font = .monospacedDigitSystemFont(ofSize: 11, weight: .medium)
        remaining.alignment = .right
        remaining.widthAnchor.constraint(equalToConstant: 57).isActive = true
        let date = resetDate(limit)
        var reset = relativeReset(date)
        if duration >= 6 * 86400000, let date, date.timeIntervalSinceNow >= 86400 {
            let formatter = DateFormatter()
            formatter.dateFormat = "EEE"
            reset += " · \(formatter.string(from: date))"
        }
        let resetLabel = label(reset, size: 10, color: .secondaryLabelColor)
        resetLabel.alignment = .right
        if let date { hover(resetLabel, "Resets \(date.formatted(shortDateTime))") }
        resetLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let usage = row([window, remaining, UsageBar(percent: percent, tint: tint), spacer(), resetLabel], spacing: 7)
        stack.addArrangedSubview(usage)
        usage.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        usage.heightAnchor.constraint(equalToConstant: 18).isActive = true
    }
    if let error = store.resetErrors[account.key] {
        let message = label("Reset failed: \(error)", size: 10, color: .systemRed)
        hover(message, error)
        stack.addArrangedSubview(message)
        message.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    }
    heading.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    return stack
}

private func money(_ value: Double) -> String { String(format: "$%.2f", value) }

private func otherSpendBreakdown(_ stats: UsageStats) -> String {
    guard !stats.otherSpend.isEmpty else { return "No pay-per-token providers used" }
    return stats.otherSpend.map { "\(productName($0.provider)) \(money($0.cost))" }.joined(separator: "\n")
}

private func speedLine(_ speed: ProviderSpeed) -> String {
    let ttft = speed.ttftMs.map { String(format: "%.1fs", $0 / 1000) } ?? "—"
    let tps = speed.tokensPerSecond.map { "\(Int($0.rounded())) tok/s" } ?? "— tok/s"
    return "\(productName(speed.provider)): TTFT \(ttft) · \(tps)"
}

private func metric(_ value: String, _ caption: String, tip: String) -> NSView {
    let valueLabel = label(value, size: 13, weight: .semibold)
    valueLabel.font = .monospacedDigitSystemFont(ofSize: 13, weight: .semibold)
    let captionLabel = label(caption, size: 10, color: .secondaryLabelColor)
    let stack = NSStackView(views: [valueLabel, captionLabel])
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 1
    hover(stack, tip)
    return stack
}

private func statsSection(_ store: UsageStore) -> NSView {
    let stack = NSStackView()
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 6
    var headingViews: [NSView] = [label("LAST \(UsageStats.windowDays) DAYS", size: 9, weight: .medium, color: .tertiaryLabelColor), spacer()]
    if let speeds = store.stats?.speeds, !speeds.isEmpty {
        let tip = "Average per provider\n" + speeds.map(speedLine).joined(separator: "\n")
        let icon = NSImageView(image: NSImage(systemSymbolName: "speedometer", accessibilityDescription: "Speed")!)
        icon.contentTintColor = .secondaryLabelColor
        let text = label("Speed", size: 10, color: .secondaryLabelColor)
        let speed = row([icon, text], spacing: 3)
        hover(speed, tip)
        headingViews.append(speed)
    }
    let heading = row(headingViews)
    stack.addArrangedSubview(heading)
    heading.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    if let stats = store.stats {
        let metrics = row([
            metric(money(stats.otherSpendTotal), "Other API spend", tip: otherSpendBreakdown(stats)),
            metric(stats.cacheRate.map { "\(Int(($0 * 100).rounded()))%" } ?? "—", "Cache hits", tip: "Cache reads ÷ (input + cache reads), all providers"),
            metric("\(stats.sessions)", "Sessions", tip: "\(stats.sessions) sessions · \(stats.subagentSessions) subagent runs"),
        ])
        metrics.distribution = .fillEqually
        stack.addArrangedSubview(metrics)
        metrics.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    }
    if let error = store.statsError {
        let message = label("\(store.stats == nil ? "Stats unavailable" : "Stats refresh failed") · \(error)", size: 10, color: .secondaryLabelColor)
        hover(message, error)
        stack.addArrangedSubview(message)
        message.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    }
    return stack
}

private final class PanelBackgroundView: NSView {
    override var isOpaque: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.windowBackgroundColor.setFill()
        bounds.fill()
    }
}

private func makePanel(store: UsageStore, quit: @escaping () -> Void) -> NSView {
    let panel = PanelBackgroundView()
    let stack = NSStackView()
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.spacing = 11
    stack.translatesAutoresizingMaskIntoConstraints = false
    panel.addSubview(stack)
    NSLayoutConstraint.activate([
        panel.widthAnchor.constraint(equalToConstant: panelWidth),
        stack.leadingAnchor.constraint(equalTo: panel.leadingAnchor, constant: 14),
        stack.trailingAnchor.constraint(equalTo: panel.trailingAnchor, constant: -14),
        stack.topAnchor.constraint(equalTo: panel.topAnchor, constant: 13),
        stack.bottomAnchor.constraint(equalTo: panel.bottomAnchor, constant: -11)
    ])
    func append(_ view: NSView) {
        stack.addArrangedSubview(view)
        view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
    }
    append(row([label("Usage", size: 13, weight: .semibold), spacer(), label("REMAINING", size: 9, weight: .medium, color: .tertiaryLabelColor)]))
    if store.accounts.isEmpty {
        let message = label(store.error == nil ? (store.refreshing ? "Fetching your accounts…" : "No accounts found") : "Unable to fetch usage", color: .secondaryLabelColor)
        append(message)
    }
    for (index, account) in store.accounts.enumerated() {
        if index > 0 { append(separator()) }
        append(accountSection(account, store: store))
    }
    if store.stats != nil || store.statsError != nil {
        append(separator())
        append(statsSection(store))
    }
    if let error = store.error {
        let message = label("\(store.hasLoaded ? "Refresh failed · " : "")\(error)", size: 10, color: .secondaryLabelColor)
        hover(message, error)
        append(message)
    }
    append(separator())
    let refresh = ActionButton(store.refreshing ? "Refreshing…" : "Refresh") { store.refresh() }
    refresh.isEnabled = !store.refreshing
    refresh.keyEquivalent = "r"
    refresh.keyEquivalentModifierMask = .command
    let quitButton = ActionButton("Quit") { quit() }
    quitButton.keyEquivalent = "q"
    quitButton.keyEquivalentModifierMask = .command
    append(row([refresh, label("⌘R", size: 10, color: .tertiaryLabelColor), spacer(), quitButton]))
    return panel
}

private final class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    private let store = UsageStore()
    private var statusItem: NSStatusItem!
    private let popover = NSPopover()
    private var timer: Timer?
    private var keyMonitor: Any?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.target = self
        statusItem.button?.action = #selector(togglePanel)
        statusItem.button?.font = .monospacedDigitSystemFont(ofSize: 11, weight: .medium)
        popover.behavior = .transient
        popover.animates = false
        popover.delegate = self
        store.changed = { [weak self] in self?.update() }
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self, self.popover.isShown, event.modifierFlags.contains(.command) else { return event }
            if event.charactersIgnoringModifiers == "r" { self.store.refresh(); return nil }
            if event.charactersIgnoringModifiers == "q" { NSApp.terminate(nil); return nil }
            return event
        }
        let override = ProcessInfo.processInfo.environment["AGENT_USAGE_INTERVAL"].flatMap(Double.init)
        let interval = override.flatMap { $0.isFinite && $0 >= 15 ? $0 : nil } ?? 180
        timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in self?.store.refresh() }
        store.refresh()
    }

    private func update() {
        guard let button = statusItem.button else { return }
        button.contentTintColor = nil
        if let work = store.accounts.first(where: \.isWork), let weekly = work.limit(codexWeeklyId), let hourly = work.limit(codexFiveHourId) {
            let week = remainingPercent(weekly)
            let hour = remainingPercent(hourly)
            button.title = week == 0 ? "⌛ 0%" : (hour == 0 ? "\(week) · 0⌛" : "\(week) · \(hour)")
            let drained = week == 0 || hour == 0
            button.attributedTitle = NSAttributedString(string: button.title, attributes: [
                .font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .medium),
                .foregroundColor: drained ? NSColor.systemRed : NSColor.labelColor
            ])
            button.toolTip = "Work Codex · \(week)% weekly left · \(hour)% 5-hour left"
        } else {
            button.title = store.error != nil ? "— !" : "— · —"
            button.toolTip = store.error ?? (store.refreshing ? "Loading usage…" : "No work Codex account")
        }
        if popover.isShown { rebuildPanel() }
    }

    func popoverDidClose(_ notification: Notification) { HoverTip.shared.hide() }

    private func rebuildPanel() {
        HoverTip.shared.hide()
        let controller = NSViewController()
        controller.view = makePanel(store: store) { NSApp.terminate(nil) }
        let size = controller.view.fittingSize
        controller.view.setFrameSize(size)
        popover.contentViewController = controller
        popover.contentSize = size
    }

    @objc private func togglePanel() {
        if popover.isShown { popover.performClose(nil); return }
        guard let button = statusItem.button else { return }
        rebuildPanel()
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        NSApp.activate(ignoringOtherApps: true)
        if Date().timeIntervalSince(store.lastAttempt ?? .distantPast) > 30 { store.refresh() }
    }
}

private func renderSnapshot(accounts: [Account], stats: UsageStats?, path: String) throws {
    let store = UsageStore()
    store.accounts = accounts.sorted { $0.isWork && !$1.isWork }
    store.stats = stats
    store.hasLoaded = true
    let appearanceName = ProcessInfo.processInfo.environment["AGENT_USAGE_APPEARANCE"]
    let appearance = NSAppearance(named: appearanceName == "dark" ? .darkAqua : .aqua)!
    NSApp.appearance = appearance
    let view = makePanel(store: store) {}
    view.appearance = appearance
    let size = view.fittingSize
    let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: .borderless, backing: .buffered, defer: false)
    window.backgroundColor = .windowBackgroundColor
    window.appearance = appearance
    window.contentView = view
    view.setFrameSize(size)
    view.layoutSubtreeIfNeeded()
    guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
        throw NSError(domain: "Snapshot", code: 1, userInfo: [NSLocalizedDescriptionKey: "Could not allocate snapshot"])
    }
    view.cacheDisplay(in: view.bounds, to: bitmap)
    guard let data = bitmap.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "Snapshot", code: 2, userInfo: [NSLocalizedDescriptionKey: "Could not encode PNG"])
    }
    try data.write(to: URL(fileURLWithPath: path))
    print("\(path): \(bitmap.pixelsWide) × \(bitmap.pixelsHigh) pixels")
}

let arguments = Array(CommandLine.arguments.dropFirst())
if arguments.contains("--once") || arguments.contains("--snap") {
    do {
        let accounts = try OmpClient().accounts()
        let stats = Result { try loadUsageStats() }
        notify(accounts, using: Notifier())
        if let index = arguments.firstIndex(of: "--snap") {
            guard arguments.indices.contains(index + 1) else {
                throw NSError(domain: "CLI", code: 1, userInfo: [NSLocalizedDescriptionKey: "--snap requires an output path"])
            }
            _ = NSApplication.shared
            try renderSnapshot(accounts: accounts, stats: try? stats.get(), path: arguments[index + 1])
        } else {
            for account in accounts {
                print("\(account.product)\(account.plan.map { " \($0)" } ?? "")\(account.isWork ? " · Work" : "")")
                for limit in account.report.limits {
                    let absolute = resetDate(limit).map { $0.formatted(date: .abbreviated, time: .shortened) } ?? "unknown"
                    print("  \(limit.label): \(remainingPercent(limit))% left · resets \(relativeReset(resetDate(limit))) (\(absolute))")
                }
                if account.resetTarget != nil {
                    let expiries = account.resetCredits.map { $0.expiry.map { $0.formatted(shortDateTime) } ?? "no expiry" }
                    print("  Saved resets: \(account.resetsLeft)\(expiries.isEmpty ? "" : " (expire \(expiries.joined(separator: "; ")))")")
                }
            }
            switch stats {
            case .success(let stats):
                print("Last \(UsageStats.windowDays) days · \(stats.sessions) sessions (+\(stats.subagentSessions) subagent runs) · cache hits \(stats.cacheRate.map { "\(Int(($0 * 100).rounded()))%" } ?? "—")")
                print("  Other API spend: \(money(stats.otherSpendTotal))\(stats.otherSpend.isEmpty ? "" : " (\(otherSpendBreakdown(stats).replacingOccurrences(of: "\n", with: ", ")))")")
                for speed in stats.speeds { print("  \(speedLine(speed))") }
            case .failure(let error):
                print("Stats unavailable: \(error.localizedDescription)")
            }
        }
        exit(0)
    } catch {
        FileHandle.standardError.write(Data("error: \(error.localizedDescription)\n".utf8))
        exit(1)
    }
}

let application = NSApplication.shared
let currentPID = ProcessInfo.processInfo.processIdentifier
if NSRunningApplication.runningApplications(withBundleIdentifier: "dev.tomas.agent-usage").contains(where: { $0.processIdentifier != currentPID }) {
    exit(0)
}
private let delegate = AppDelegate()
application.delegate = delegate
application.run()
