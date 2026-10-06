// Twin of contract/src/logic/governor.ts: how long to wait before the next
// snapshot frame. Vectors: contract/vectors/governor.json.
//
// - idle → idleFps; within activeWindowMs of the last touch → activeFps
// - never more often than the main-thread budget allows: delay ≥ cost / budget
// - low-power mode halves the idle rate and drops the interaction boost
// - thermal serious/critical, or an explicit pause, stops capture (nil)

import Foundation

enum GovernorThermalState: String {
    case nominal, fair, serious, critical
}

struct GovernorConfig: Equatable {
    var idleFps: Double = 1
    var activeFps: Double = 4
    var budgetPct: Double = 3
    var activeWindowMs: Double = 1500
}

struct GovernorInput {
    var now: Double
    var lastTouchAt: Double?
    var avgCostMs: Double
    var lowPower: Bool
    var thermal: GovernorThermalState
    var paused: Bool
}

enum CaptureGovernor {
    /// Milliseconds until the next capture, rounded to the nearest ms; nil means paused.
    static func nextCaptureDelayMs(_ config: GovernorConfig, _ input: GovernorInput) -> Double? {
        if input.paused || input.thermal == .serious || input.thermal == .critical { return nil }
        var active = false
        if !input.lowPower, let last = input.lastTouchAt, input.now - last <= config.activeWindowMs {
            active = true
        }
        let fps = active ? config.activeFps : (input.lowPower ? config.idleFps / 2 : config.idleFps)
        let base = 1000 / fps
        let budgetFloor = input.avgCostMs / (config.budgetPct / 100)
        // JS Math.round rounds .5 up; for the positive values here `.rounded()` agrees.
        return max(base, budgetFloor).rounded()
    }

    /// Exponentially weighted moving average of capture cost (α = 0.2).
    static func updateAverageCost(_ avg: Double?, _ sampleMs: Double) -> Double {
        guard let avg = avg else { return sampleMs }
        return avg * 0.8 + sampleMs * 0.2
    }
}
