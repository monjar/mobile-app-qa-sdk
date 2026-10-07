/*
 * The frame schedule used when composing a clip.
 *
 * Twin of clipSchedule in contract/src/logic/ring.ts (and the Swift
 * ClipSchedule), tested against contract/vectors/compose.json by
 * android/logic-jvm.
 *
 * For a clip of [start, end) at `fps`, output frame k is at start + k·(1000/fps);
 * it shows the newest source frame at or before that time, or the first source
 * frame if none is that early.
 */
package io.github.monjar.snitch.logic

import kotlin.math.max
import kotlin.math.roundToInt

object ClipSchedule {
    /** Indexes into [frameTimes] (ascending, non-empty) for each output frame. */
    @JvmStatic
    fun clipSchedule(frameTimes: LongArray, start: Long, end: Long, fps: Double): IntArray {
        if (frameTimes.isEmpty() || end <= start) return IntArray(0)
        val step = 1000.0 / fps
        val count = max(1, ((end - start) / step).roundToInt())
        val out = IntArray(count)
        var src = 0
        for (k in 0 until count) {
            val t = start + k * step
            while (src + 1 < frameTimes.size && frameTimes[src + 1] <= t) src++
            out[k] = src
        }
        return out
    }
}
