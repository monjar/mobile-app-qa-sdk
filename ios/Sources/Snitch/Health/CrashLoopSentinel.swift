// Crash-loop sentinel for snapshot capture (spec §5.2).
//
// drawHierarchy has crashed apps on some iOS releases (26.3.1), and a QA tool must
// never make a build unusable. While a snapshot capture session runs in the
// foreground we keep `snitch.captureSession` set; leaving the foreground clears it.
// If it is still set at the next launch, that session ended abruptly. Two such
// launches downgrade the renderer for this app build: drawHierarchy → layerRender
// → video off. A foreground session longer than 60 s resets the count.
//
// The flag can't tell a capture crash from any other crash; at worst an unrelated
// crash loop costs this build its best renderer, which is the safe direction.
// Sessions that ran under a debugger don't count: Xcode's Stop button kills the
// app the same way a crash does.

import Darwin
import Foundation

final class CrashLoopSentinel {
    static let threshold = 2
    static let healthySessionSeconds: TimeInterval = 60

    private let defaults: UserDefaults
    private let build: String
    private var healthyTimer: Timer?

    init(defaults: UserDefaults = .standard, build: String) {
        self.defaults = defaults
        self.build = build
    }

    /// 0 = drawHierarchy allowed, 1 = layerRender, 2 = video off. Scoped to this app build.
    var downgradeLevel: Int {
        let map = defaults.dictionary(forKey: DefaultsKey.rendererDowngrade) as? [String: Int] ?? [:]
        return map[build] ?? 0
    }

    /// How many downgrades happened on this build (stats.crashLoopDowngrades).
    var downgrades: Int {
        downgradeLevel
    }

    /// True until a config fetch has reported `health=crashloop`.
    var healthPending: Bool {
        defaults.bool(forKey: DefaultsKey.crashLoopHealthPending)
    }

    func healthReported() {
        defaults.removeObject(forKey: DefaultsKey.crashLoopHealthPending)
    }

    /// Call once at launch, before capture starts. Returns true if this launch downgraded the renderer.
    @discardableResult
    func checkAtLaunch() -> Bool {
        guard let previous = defaults.string(forKey: DefaultsKey.captureSession) else { return false }
        defaults.removeObject(forKey: DefaultsKey.captureSession)
        if previous.hasSuffix(CrashLoopSentinel.debuggerSuffix) { return false }
        let count = defaults.integer(forKey: DefaultsKey.crashLoopCount) + 1
        guard count >= CrashLoopSentinel.threshold else {
            defaults.set(count, forKey: DefaultsKey.crashLoopCount)
            return false
        }
        defaults.set(0, forKey: DefaultsKey.crashLoopCount)
        var map = defaults.dictionary(forKey: DefaultsKey.rendererDowngrade) as? [String: Int] ?? [:]
        // Older builds' entries are irrelevant once this build runs.
        let level = min((map[build] ?? 0) + 1, 2)
        map = [build: level]
        defaults.set(map, forKey: DefaultsKey.rendererDowngrade)
        defaults.set(true, forKey: DefaultsKey.crashLoopHealthPending)
        SDKLog.warn("Snapshot capture looked like it ended the app twice; downgrading the renderer (level \(level)) for build \(build)")
        return true
    }

    /// A foreground capture session with `renderer` starts (main thread).
    func sessionStarted(renderer: String) {
        let traced = CrashLoopSentinel.isDebuggerAttached()
        defaults.set(traced ? renderer + CrashLoopSentinel.debuggerSuffix : renderer, forKey: DefaultsKey.captureSession)
        if healthyTimer == nil {
            let timer = Timer(timeInterval: CrashLoopSentinel.healthySessionSeconds, repeats: false) { [weak self] _ in
                self?.healthyTimer = nil
                self?.defaults.set(0, forKey: DefaultsKey.crashLoopCount)
            }
            RunLoop.main.add(timer, forMode: .common)
            healthyTimer = timer
        }
    }

    private static let debuggerSuffix = "|debugger"

    /// Technical Q&A QA1361: P_TRACED is set while a debugger is attached.
    static func isDebuggerAttached() -> Bool {
        var info = kinfo_proc()
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        var size = MemoryLayout<kinfo_proc>.stride
        let rc = sysctl(&mib, UInt32(mib.count), &info, &size, nil, 0)
        return rc == 0 && (info.kp_proc.p_flag & P_TRACED) != 0
    }

    /// The app left the foreground, or capture stopped normally (main thread).
    func sessionEnded() {
        defaults.removeObject(forKey: DefaultsKey.captureSession)
        healthyTimer?.invalidate()
        healthyTimer = nil
    }
}
