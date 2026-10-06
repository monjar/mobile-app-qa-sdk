// Twin of clipSchedule in contract/src/logic/ring.ts. Vectors: contract/vectors/compose.json.
//
// For a clip of [start, end) at `fps`, which source frame each output frame shows.
// Output frame k is at start + k·(1000/fps); it shows the newest source frame at or
// before that time, or the first source frame if none is that early. Returns
// indexes into `frameTimes` (which must be ascending).

import Foundation

enum ClipSchedule {
    static func clipSchedule(_ frameTimes: [Double], _ start: Double, _ end: Double, _ fps: Double) -> [Int] {
        if frameTimes.isEmpty || end <= start { return [] }
        let step = 1000 / fps
        let count = max(1, Int(((end - start) / step).rounded()))
        var out: [Int] = []
        out.reserveCapacity(count)
        var src = 0
        for k in 0..<count {
            let t = start + Double(k) * step
            while src + 1 < frameTimes.count && frameTimes[src + 1] <= t { src += 1 }
            out.append(src)
        }
        return out
    }
}
