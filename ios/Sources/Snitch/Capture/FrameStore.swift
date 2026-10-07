// The live frame ring, shared between the encode queue (push) and the main
// thread (freeze at trigger time, trim on memory warning). A lock rather than a
// queue hop so freezing never waits behind a JPEG encode: the critical sections
// are an array append or a copy-on-write struct copy.

import Foundation

struct CapturedFrame: RingFrame {
    /// Monotonic ms when the capture started.
    var t: Double
    /// JPEG bytes.
    var data: Data
    var width: Int
    var height: Int
    /// Frame pixels per screen point, to map touch points into the frame.
    var pixelsPerPoint: Double
    var checksum: String

    var size: Int {
        data.count
    }
}

/// What the sheet and the composer get at trigger time: the ring as it was, and the touches.
struct FrozenCapture {
    var endT: Double
    var ring: FrameRing<CapturedFrame>
    var touches: [TouchSample]

    var bufferedSeconds: Double {
        ring.bufferedMs(endT) / 1000
    }

    var hasFrames: Bool {
        !ring.select(endT, 0).isEmpty
    }
}

final class FrameStore {
    static let snapshotMaxBytes = 6 * 1024 * 1024
    static let systemMaxBytes = 10 * 1024 * 1024

    private let lock = NSLock()
    private var ring: FrameRing<CapturedFrame>

    init(maxBytes: Int = FrameStore.snapshotMaxBytes, maxAgeMs: Double = 30_000) {
        ring = FrameRing(maxBytes: maxBytes, maxAgeMs: maxAgeMs)
    }

    /// Rebuilds the ring with new limits, keeping what still fits.
    func setLimits(maxBytes: Int, maxAgeMs: Double) {
        lock.lock()
        defer { lock.unlock() }
        guard ring.maxBytes != maxBytes || ring.maxAgeMs != maxAgeMs else { return }
        var next = FrameRing<CapturedFrame>(maxBytes: maxBytes, maxAgeMs: maxAgeMs)
        for f in ring.frames { next.push(f) }
        ring = next
    }

    @discardableResult
    func push(_ frame: CapturedFrame) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return ring.push(frame)
    }

    func trimHalf() {
        lock.lock()
        ring.trimHalf()
        lock.unlock()
    }

    func clear() {
        lock.lock()
        ring.clear()
        lock.unlock()
    }

    func snapshot() -> FrameRing<CapturedFrame> {
        lock.lock()
        defer { lock.unlock() }
        return ring
    }

    var totalBytes: Int {
        lock.lock()
        defer { lock.unlock() }
        return ring.totalBytes
    }

    /// Checksum of the newest frame, so the encoder can skip JPEG work for an unchanged screen.
    var newestChecksum: String? {
        lock.lock()
        defer { lock.unlock() }
        return ring.frames.last?.checksum
    }

    func bufferedMs(_ endT: Double) -> Double {
        lock.lock()
        defer { lock.unlock() }
        return ring.bufferedMs(endT)
    }
}
