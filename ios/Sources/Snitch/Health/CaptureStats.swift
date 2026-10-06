// Capture health measured on the device (contract CaptureStats), so the real
// cost of the SDK is visible in the dashboard: p50/p95 of the last 100 capture
// costs, effective fps over the last 30 s, skipped frames and so on.
// Thread-safe: costs are recorded on main, frames on the encode queue.

import Foundation

final class CaptureStats {
    private let lock = NSLock()
    private var costs: [Double] = []
    private var frameTimes: [Double] = []
    private var skipped = 0
    private let startedAt = Clock.nowMs()

    static let costWindow = 100
    static let fpsWindowMs: Double = 30_000

    func recordCost(_ ms: Double) {
        lock.lock()
        costs.append(ms)
        if costs.count > CaptureStats.costWindow { costs.removeFirst(costs.count - CaptureStats.costWindow) }
        lock.unlock()
    }

    /// A frame reached the ring (or was recognised as a repeat of the previous one).
    func recordFrame(at t: Double) {
        lock.lock()
        frameTimes.append(t)
        let cutoff = t - CaptureStats.fpsWindowMs
        if let firstKept = frameTimes.firstIndex(where: { $0 > cutoff }), firstKept > 0 {
            frameTimes.removeFirst(firstKept)
        }
        lock.unlock()
    }

    func recordSkipped() {
        lock.lock()
        skipped += 1
        lock.unlock()
    }

    func reset() {
        lock.lock()
        costs = []
        frameTimes = []
        lock.unlock()
    }

    struct Snapshot {
        var p50: Double?
        var p95: Double?
        var effectiveFps: Double?
        var framesSkipped: Int
        var uptimeSec: Double
    }

    func snapshot(now: Double = Clock.nowMs()) -> Snapshot {
        lock.lock()
        let c = costs
        let frames = frameTimes.filter { $0 > now - CaptureStats.fpsWindowMs }
        let s = skipped
        lock.unlock()
        var fps: Double?
        if let first = frames.first {
            let span = max(1000, min(CaptureStats.fpsWindowMs, now - first))
            fps = round1(Double(frames.count) / (span / 1000))
        }
        return Snapshot(
            p50: CaptureStats.percentile(c, 0.50).map(round1),
            p95: CaptureStats.percentile(c, 0.95).map(round1),
            effectiveFps: fps,
            framesSkipped: s,
            uptimeSec: ((now - startedAt) / 1000).rounded()
        )
    }

    /// Nearest-rank percentile.
    static func percentile(_ values: [Double], _ p: Double) -> Double? {
        guard !values.isEmpty else { return nil }
        let sorted = values.sorted()
        let rank = Int((p * Double(sorted.count)).rounded(.up))
        return sorted[min(max(rank - 1, 0), sorted.count - 1)]
    }
}

func round1(_ v: Double) -> Double {
    (v * 10).rounded() / 10
}
