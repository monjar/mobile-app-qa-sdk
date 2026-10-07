// Touch log (spec §5.4): recent touch samples, only used to draw touch trails
// into the composed clip. At most 60 Hz per pointer for moves (downs and ups are
// always kept), retained for maxAgeMs + 1 s. Fed by the window recognizers on the
// main thread; a copy is frozen with the frame ring at trigger time.

import Foundation

struct TouchSample: Equatable {
    enum Phase: String {
        case down, move, up
    }

    var t: Double
    var id: Int
    /// Screen points (window coordinates offset by the window's origin).
    var x: Double
    var y: Double
    var phase: Phase
}

final class TouchLog {
    private(set) var samples: [TouchSample] = []
    private var lastMoveT: [Int: Double] = [:]
    var maxAgeMs: Double

    static let minMoveIntervalMs = 1000.0 / 60.0

    init(maxAgeMs: Double) {
        self.maxAgeMs = maxAgeMs
    }

    func add(_ sample: TouchSample) {
        if sample.phase == .move {
            if let last = lastMoveT[sample.id], sample.t - last < TouchLog.minMoveIntervalMs { return }
            lastMoveT[sample.id] = sample.t
        } else if sample.phase == .up {
            lastMoveT.removeValue(forKey: sample.id)
        }
        samples.append(sample)
        let cutoff = sample.t - maxAgeMs - 1000
        if let first = samples.first, first.t < cutoff {
            let keepFrom = samples.firstIndex { $0.t >= cutoff } ?? samples.count
            samples.removeFirst(keepFrom)
        }
    }

    func clear() {
        samples = []
        lastMoveT = [:]
    }

    /// Samples with start < t ≤ end.
    func window(start: Double, end: Double) -> [TouchSample] {
        samples.filter { $0.t > start && $0.t <= end }
    }
}
