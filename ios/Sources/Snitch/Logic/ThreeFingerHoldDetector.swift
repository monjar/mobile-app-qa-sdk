// Twin of contract/src/logic/detector.ts: a still, three-finger hold.
//
// Line-for-line with the TypeScript reference and the Kotlin twin, tested
// against contract/vectors/gesture.json. Keep it pure: no clocks, no UIKit.
// Times are milliseconds on a monotonic clock, coordinates are points.
//
// Rules, with the defaults:
// - exactly `pointers` (3) touches, every one landing within `landingWindowMs` (250) of the first
// - none moving more than `slop` (10 pt) from where it landed
// - fires once `holdMs` (250) has passed since the last finger landed
// - any lift, a fourth finger, or too much movement fails the sequence until every finger is up
// - one fire per sequence, and none within `cooldownMs` (1000) of the previous fire

import Foundation

struct DetectorConfig: Equatable {
    var pointers: Int = 3
    var landingWindowMs: Double = 250
    var holdMs: Double = 250
    var slop: Double = 10
    var cooldownMs: Double = 1000
    var enabled: Bool = true
}

enum DetectorEvent: Equatable {
    case down(t: Double, id: Int, x: Double, y: Double)
    case move(t: Double, id: Int, x: Double, y: Double)
    case up(t: Double, id: Int, x: Double, y: Double)
    case cancel(t: Double, id: Int, x: Double, y: Double)
    case tick(t: Double)

    var t: Double {
        switch self {
        case let .down(t, _, _, _), let .move(t, _, _, _), let .up(t, _, _, _), let .cancel(t, _, _, _):
            return t
        case let .tick(t):
            return t
        }
    }
}

final class ThreeFingerHoldDetector {
    /// Mutable so the SDK can flip `enabled` (VoiceOver, sheet visible, remote off) without losing sequence state.
    var config: DetectorConfig
    private var origins: [Int: (x: Double, y: Double)] = [:]
    private var firstDownT: Double = 0
    private var armedAt: Double?
    private var failed = false
    private var fired = false
    private var lastFireT: Double = -Double.infinity

    init(config: DetectorConfig = DetectorConfig()) {
        self.config = config
    }

    /// Feed one event; returns true exactly when the gesture fires.
    func handle(_ e: DetectorEvent) -> Bool {
        switch e {
        case let .down(t, id, x, y):
            if origins.isEmpty { resetSequence(t) }
            origins[id] = (x: x, y: y)
            let n = origins.count
            if n > config.pointers {
                failed = true
            } else if n == config.pointers {
                if t - firstDownT > config.landingWindowMs {
                    failed = true
                } else {
                    armedAt = t
                }
            }
        case let .move(_, id, x, y):
            if let o = origins[id] {
                let dx = x - o.x
                let dy = y - o.y
                if dx * dx + dy * dy > config.slop * config.slop { failed = true }
            }
        case let .up(t, id, _, _), let .cancel(t, id, _, _):
            if origins.removeValue(forKey: id) != nil {
                if !fired { failed = true }
                if origins.isEmpty { resetSequence(t) }
            }
            return false
        case .tick:
            break
        }
        return check(e.t)
    }

    /// True while a sequence that has already fired still has fingers down.
    var isConsumingSequence: Bool {
        fired && !origins.isEmpty
    }

    var activeTouches: Int {
        origins.count
    }

    /// Time of the first finger down of the current (or last) sequence. Not in the TS
    /// reference; the SDK needs it to freeze the frame ring where the gesture started.
    var sequenceStartT: Double {
        firstDownT
    }

    /// When the current sequence will be eligible to fire, if it is armed. Lets the SDK
    /// schedule a single tick instead of polling every display frame.
    var fireDueAt: Double? {
        guard let a = armedAt, !failed, !fired else { return nil }
        return a + config.holdMs
    }

    private func check(_ t: Double) -> Bool {
        let c = config
        guard c.enabled, !failed, !fired, let armedAt = armedAt else { return false }
        if origins.count != c.pointers { return false }
        if t - armedAt < c.holdMs { return false }
        if t - lastFireT < c.cooldownMs {
            failed = true
            return false
        }
        fired = true
        lastFireT = t
        return true
    }

    private func resetSequence(_ t: Double) {
        firstDownT = t
        armedAt = nil
        failed = false
        fired = false
    }
}
