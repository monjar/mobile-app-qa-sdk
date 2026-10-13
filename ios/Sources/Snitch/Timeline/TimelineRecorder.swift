// The report timeline recorder (spec §11.3): one bounded ring per kind
// (TIMELINE_LIMITS: 500 log lines, 100 requests, 50 screens, 300 touch downs,
// 50 app events; nothing older than 5 minutes), in memory only.
//
// - Thread-safe: Snitch.log, the RN console hook and the network protocol call in
//   from any thread; one lock guards everything, and the critical sections are
//   ring appends or copies.
// - Each kind records only while its switch is on, and nothing at all while Snitch
//   is off (the runtime pushes the merged static + remote switches via `configure`).
//   Turning Snitch off clears the rings.
// - Events carry wall-clock epoch ms taken when they happen. Touch downs keep the
//   touch log's monotonic ms and are converted once, at freeze, with
//   wall = mono + (wallNow − monoNow).
// - `freeze()` happens together with the frame-ring freeze when the sheet opens;
//   the snapshot is written as the `timeline` attachment at Send (ReportBuilder),
//   where the unified-log lines are added (ConsoleReader).
// - The app's own screen name (Snitch.setScreen) is remembered even while Snitch
//   is off, so a name set before activation becomes the first screen event.

import Foundation

/// A frozen timeline: everything the report needs to write the attachment at Send.
struct TimelineSnapshot {
    var events: [TimelineEvent]
    /// Events dropped because a ring was full.
    var dropped: Int
    /// Wall-clock ms at freeze (meta.end).
    var end: Int64
    /// wall = mono + monoToWallMs, taken at freeze: maps the clip's monotonic end to wall time.
    var monoToWallMs: Double
    /// Unified-log lines to add at Send (console capture on), else nil.
    var nativeConsole: NativeConsoleRequest?
    /// The current screen's name (the report's `screen`).
    var screen: String?
}

struct NativeConsoleRequest: Equatable {
    /// Wall-clock ms window.
    var from: Int64
    var to: Int64
    /// Skip `com.facebook.react.log` (the RN module already records JS lines as `js`).
    var excludeReactNative: Bool
}

final class TimelineRecorder {
    static let shared = TimelineRecorder()

    struct Switches: Equatable {
        /// Snitch is active and on.
        var on = false
        var console = false
        var network = false
        var screens = false
    }

    private struct TouchDown {
        var mono: Double
        var x: Double
        var y: Double
        var fingers: Int
    }

    /// Clocks, injectable for tests.
    var wallNow: () -> Int64 = { TimelineText.nowMs() }
    var monoNow: () -> Double = { Clock.nowMs() }

    private let lock = NSLock()
    private var switches = Switches()
    private var logs = BoundedRing<TimelineEvent>(capacity: TimelineLimits.logs)
    private var requests = BoundedRing<TimelineEvent>(capacity: TimelineLimits.network)
    private var screens = BoundedRing<TimelineEvent>(capacity: TimelineLimits.screens)
    private var appEvents = BoundedRing<TimelineEvent>(capacity: TimelineLimits.app)
    private var touches = BoundedRing<TouchDown>(capacity: TimelineLimits.touches)
    private var dropped = 0
    private var currentScreen: String?
    private var appScreen: String?
    private var appNamesScreens = false
    private var jsConsoleUsed = false

    // MARK: - Switches

    func configure(_ new: Switches) {
        let t = wallNow()
        lock.lock()
        defer { lock.unlock() }
        let old = switches
        switches = new
        guard new.on else {
            if old.on { clearLocked() }
            return
        }
        if !new.console { logs.removeAll() }
        if !new.network { requests.removeAll() }
        if !new.screens {
            screens.removeAll()
            currentScreen = nil
        }
        if new.screens, !(old.on && old.screens), let name = appScreen {
            appendScreenLocked(name, source: .app, t: t)
        }
    }

    var currentSwitches: Switches {
        lock.lock()
        defer { lock.unlock() }
        return switches
    }

    // MARK: - Recording

    func log(level: TimelineLogLevel, source: TimelineLogSource, message: String, tag: String? = nil) {
        let t = wallNow()
        let msg = TimelineText.truncated(message, maxUTF16: TimelineLimits.msgChars)
        let tag = TimelineText.field(tag, maxUTF16: TimelineLimits.tagChars)
        lock.lock()
        defer { lock.unlock() }
        guard switches.on, switches.console else { return }
        logs.removeLeading { $0.t < t - TimelineLimits.maxAgeMs }
        dropped += logs.append(.log(t: t, level: level, source: source, message: msg, tag: tag))
    }

    /// A finished (or failed) request; `net.t` is when it started.
    func network(_ net: TimelineNet) {
        let now = wallNow()
        lock.lock()
        defer { lock.unlock() }
        guard switches.on, switches.network else { return }
        requests.removeLeading { $0.t < now - TimelineLimits.maxAgeMs }
        dropped += requests.append(.net(net))
    }

    /// Snitch.setScreen: recorded as source `app`, and native inference stops for good.
    func setAppScreen(_ name: String?) {
        let t = wallNow()
        let trimmed = TimelineText.field(name, maxUTF16: TimelineLimits.screenChars)
        lock.lock()
        defer { lock.unlock() }
        appNamesScreens = true
        appScreen = trimmed
        guard let screen = trimmed, switches.on, switches.screens else { return }
        appendScreenLocked(screen, source: .app, t: t)
    }

    /// Whether inferring a screen from view controllers is wanted right now.
    var acceptsInferredScreens: Bool {
        lock.lock()
        defer { lock.unlock() }
        return switches.on && switches.screens && !appNamesScreens
    }

    /// A screen name inferred from the view controller hierarchy; recorded only when it changes.
    func inferredScreen(_ name: String) {
        let t = wallNow()
        guard let screen = TimelineText.field(name, maxUTF16: TimelineLimits.screenChars) else { return }
        lock.lock()
        defer { lock.unlock() }
        guard switches.on, switches.screens, !appNamesScreens else { return }
        appendScreenLocked(screen, source: .native, t: t)
    }

    func appEvent(_ event: TimelineAppEvent) {
        let t = wallNow()
        lock.lock()
        defer { lock.unlock() }
        guard switches.on else { return }
        appEvents.removeLeading { $0.t < t - TimelineLimits.maxAgeMs }
        dropped += appEvents.append(.app(t: t, event: event))
    }

    /// A finger went down at monotonic `mono` ms; `x`/`y` are fractions of the screen.
    func touchDown(mono: Double, x: Double, y: Double, fingers: Int) {
        lock.lock()
        defer { lock.unlock() }
        guard switches.on else { return }
        let cutoff = mono - Double(TimelineLimits.maxAgeMs)
        touches.removeLeading { $0.mono < cutoff }
        let point = TouchDown(
            mono: mono,
            x: (x.clamped(0, 1) * 10_000).rounded() / 10_000,
            y: (y.clamped(0, 1) * 10_000).rounded() / 10_000,
            fingers: max(1, fingers)
        )
        dropped += touches.append(point)
    }

    /// The RN module's console hook delivered a line (SnitchBridge.logJS); from now on the
    /// unified-log copies of JS lines (`com.facebook.react.log`) are skipped.
    func markJSConsoleUsed() {
        lock.lock()
        jsConsoleUsed = true
        lock.unlock()
    }

    // MARK: - Reading

    func freeze() -> TimelineSnapshot {
        let wall = wallNow()
        let mono = monoNow()
        lock.lock()
        defer { lock.unlock() }
        let cutoff = wall - TimelineLimits.maxAgeMs
        let offset = Double(wall) - mono
        var events = logs.items + requests.items + screens.items + appEvents.items
        for touch in touches.items {
            let t = Int64((touch.mono + offset).rounded())
            events.append(.touch(t: t, x: touch.x, y: touch.y, fingers: touch.fingers))
        }
        events = events.filter { $0.t >= cutoff && $0.t <= wall }
        let console = switches.on && switches.console
            ? NativeConsoleRequest(from: cutoff, to: wall, excludeReactNative: jsConsoleUsed)
            : nil
        return TimelineSnapshot(
            events: events,
            dropped: dropped,
            end: wall,
            monoToWallMs: offset,
            nativeConsole: console,
            screen: switches.on && switches.screens ? currentScreen : nil
        )
    }

    /// The newest `limit` log lines, encoded, for the crash follow-up's session log.
    func sessionLogLines(limit: Int) -> [String] {
        lock.lock()
        let recent = logs.items.suffix(max(0, limit))
        lock.unlock()
        return recent.map(TimelineEncoding.line)
    }

    func clear() {
        lock.lock()
        clearLocked()
        lock.unlock()
    }

    /// Back to a fresh process (tests): switches off, app screen and JS hook forgotten.
    func reset() {
        lock.lock()
        clearLocked()
        switches = Switches()
        appScreen = nil
        appNamesScreens = false
        jsConsoleUsed = false
        lock.unlock()
    }

    // MARK: - Private (lock held)

    private func appendScreenLocked(_ name: String, source: TimelineScreenSource, t: Int64) {
        guard name != currentScreen else { return }
        currentScreen = name
        screens.removeLeading { $0.t < t - TimelineLimits.maxAgeMs }
        dropped += screens.append(.screen(t: t, name: name, source: source))
    }

    private func clearLocked() {
        logs.removeAll()
        requests.removeAll()
        screens.removeAll()
        appEvents.removeAll()
        touches.removeAll()
        dropped = 0
        currentScreen = nil
    }
}
