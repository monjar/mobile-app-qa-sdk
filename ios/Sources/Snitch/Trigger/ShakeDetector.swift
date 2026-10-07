// Optional shake trigger (spec §4.2). `motionEnded(.motionShake)` needs a
// responder subclass in the app, so we read the accelerometer at 20 Hz while
// the app is active instead: a shake is ≥ 3 direction reversals with
// |a| > 2.3 g within 1 s. The rule itself is pure (ShakeRule) for testing.

import CoreMotion
import Foundation

struct ShakeRule {
    static let thresholdG = 2.3
    static let windowMs = 1000.0
    static let reversals = 3
    static let cooldownMs = 1000.0

    private var lastStrong: (axis: Int, sign: Double)?
    private var reversalTimes: [Double] = []
    private var lastFireT = -Double.infinity

    /// Feed one sample (g units); returns true when a shake completes.
    mutating func handle(t: Double, x: Double, y: Double, z: Double) -> Bool {
        let magnitude = (x * x + y * y + z * z).squareRoot()
        guard magnitude > ShakeRule.thresholdG else { return false }
        let components = [x, y, z]
        var axis = 0
        for i in 1..<3 where abs(components[i]) > abs(components[axis]) { axis = i }
        let sign: Double = components[axis] >= 0 ? 1 : -1
        if let last = lastStrong, last.axis == axis, last.sign != sign {
            reversalTimes.append(t)
        }
        lastStrong = (axis: axis, sign: sign)
        reversalTimes.removeAll { t - $0 > ShakeRule.windowMs }
        guard reversalTimes.count >= ShakeRule.reversals, t - lastFireT >= ShakeRule.cooldownMs else { return false }
        reversalTimes.removeAll()
        lastStrong = nil
        lastFireT = t
        return true
    }
}

final class ShakeDetector {
    private let motion = CMMotionManager()
    private let queue: OperationQueue = {
        let q = OperationQueue()
        q.name = "io.github.monjar.snitch.shake"
        q.maxConcurrentOperationCount = 1
        q.qualityOfService = .utility
        return q
    }()
    private var rule = ShakeRule()

    /// Called on the main thread.
    var onShake: (() -> Void)?

    var isRunning: Bool {
        motion.isAccelerometerActive
    }

    func start() {
        guard motion.isAccelerometerAvailable, !motion.isAccelerometerActive else { return }
        motion.accelerometerUpdateInterval = 1.0 / 20.0
        rule = ShakeRule()
        motion.startAccelerometerUpdates(to: queue) { [weak self] data, _ in
            guard let self = self, let a = data?.acceleration else { return }
            if self.rule.handle(t: Clock.nowMs(), x: a.x, y: a.y, z: a.z) {
                DispatchQueue.main.async { self.onShake?() }
            }
        }
    }

    func stop() {
        guard motion.isAccelerometerActive else { return }
        motion.stopAccelerometerUpdates()
    }
}
