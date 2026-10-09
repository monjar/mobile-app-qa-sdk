// Small shared helpers: the SDK version, the monotonic clock, UserDefaults keys
// and a lock-protected box.

import Foundation
import QuartzCore

enum SnitchVersion {
    static let current = "0.1.2"
    static let sdkName = "snitch-ios"
}

enum Clock {
    /// Milliseconds on the monotonic clock shared by touches, frames and the detector.
    static func nowMs() -> Double {
        CACurrentMediaTime() * 1000
    }
}

enum DefaultsKey {
    static let remoteConfig = "snitch.remoteConfig"
    static let captureSession = "snitch.captureSession"
    static let crashLoopCount = "snitch.crashLoopCount"
    static let rendererDowngrade = "snitch.rendererDowngrade"
    static let crashLoopHealthPending = "snitch.crashLoopHealthPending"
    static let crashLoopDowngrades = "snitch.crashLoopDowngrades"
    static let noticeShown = "snitch.noticeShown"
    static let reporterEmail = "snitch.reporterEmail"
}

/// A value guarded by a lock, readable from any thread.
final class Locked<Value> {
    private let lock = NSLock()
    private var value: Value

    init(_ value: Value) {
        self.value = value
    }

    func get() -> Value {
        lock.lock()
        defer { lock.unlock() }
        return value
    }

    func set(_ newValue: Value) {
        lock.lock()
        value = newValue
        lock.unlock()
    }

    @discardableResult
    func mutate<R>(_ body: (inout Value) -> R) -> R {
        lock.lock()
        defer { lock.unlock() }
        return body(&value)
    }
}

extension Comparable {
    func clamped(_ lower: Self, _ upper: Self) -> Self {
        min(max(self, lower), upper)
    }
}
