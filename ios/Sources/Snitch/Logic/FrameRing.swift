// Twin of the FrameRing in contract/src/logic/ring.ts. Vectors: contract/vectors/ring.json.
//
// Frames are compressed stills with a timestamp. A frame is on screen from its
// own timestamp until the next frame's, so to show the start of a window the
// ring keeps the newest frame at or before that start, even though it is older
// than the window.
//
// A value type, unlike the TS class: freezing the ring at trigger time is a plain
// copy, and the frame payloads (Data) are shared copy-on-write.

import Foundation

protocol RingFrame {
    var t: Double { get }
    var size: Int { get }
    var checksum: String { get }
}

struct FrameRing<F: RingFrame> {
    let maxBytes: Int
    let maxAgeMs: Double
    private var items: [F] = []
    private var total = 0

    init(maxBytes: Int, maxAgeMs: Double) {
        self.maxBytes = maxBytes
        self.maxAgeMs = maxAgeMs
    }

    /// Adds a frame; an exact repeat of the newest frame is dropped (the screen didn't change).
    @discardableResult
    mutating func push(_ frame: F) -> Bool {
        if let last = items.last, last.checksum == frame.checksum { return false }
        items.append(frame)
        total += frame.size
        evict()
        return true
    }

    /// Drops the oldest half (memory warning).
    mutating func trimHalf() {
        let drop = items.count / 2
        for i in 0..<drop { total -= items[i].size }
        items.removeFirst(drop)
    }

    mutating func clear() {
        items = []
        total = 0
    }

    var frames: [F] {
        items
    }

    var totalBytes: Int {
        total
    }

    /// How many milliseconds of history are available before `endT`.
    func bufferedMs(_ endT: Double) -> Double {
        guard let first = items.first else { return 0 }
        return max(0, endT - first.t)
    }

    /// Frames needed to show [endT - durationMs, endT]: the one on screen at the start, then every later one up to endT.
    func select(_ endT: Double, _ durationMs: Double) -> [F] {
        let start = endT - durationMs
        var lead: F?
        var out: [F] = []
        for f in items {
            if f.t > endT { break }
            if f.t <= start {
                lead = f
            } else {
                out.append(f)
            }
        }
        if let lead = lead { return [lead] + out }
        return out
    }

    private mutating func evict() {
        while items.count > 1 && total > maxBytes {
            total -= items.removeFirst().size
        }
        guard let newest = items.last else { return }
        let cutoff = newest.t - maxAgeMs
        while items.count > 1 && items[1].t <= cutoff {
            total -= items.removeFirst().size
        }
    }
}
