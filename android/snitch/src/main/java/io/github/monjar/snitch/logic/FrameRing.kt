/*
 * The in-memory frame ring.
 *
 * Twin of FrameRing in contract/src/logic/ring.ts (and the Swift FrameRing),
 * tested against contract/vectors/ring.json by android/logic-jvm.
 *
 * Frames are compressed stills with a timestamp. A frame is on screen from its
 * own timestamp until the next frame's, so to show the start of a window the
 * ring keeps the newest frame at or before that start, even though it is older
 * than the window.
 *
 * Not thread-safe: the capture layer serialises access.
 */
package io.github.monjar.snitch.logic

interface RingFrame {
    /** Monotonic milliseconds. */
    val t: Long

    /** Encoded size in bytes. */
    val size: Int

    /** Cheap content hash; equal checksums mean the screen did not change. */
    val checksum: String
}

class FrameRing<F : RingFrame>(val maxBytes: Long, val maxAgeMs: Long) {
    private val items = ArrayDeque<F>()
    private var total = 0L

    /** Adds a frame; an exact repeat of the newest frame is dropped (the screen didn't change). */
    fun push(frame: F): Boolean {
        val last = items.lastOrNull()
        if (last != null && last.checksum == frame.checksum) return false
        items.addLast(frame)
        total += frame.size
        evict()
        return true
    }

    /** Drops the oldest half (memory warning). */
    fun trimHalf() {
        val drop = items.size / 2
        repeat(drop) { total -= items.removeFirst().size }
    }

    fun clear() {
        items.clear()
        total = 0
    }

    /** Live view, oldest first. Copy it before handing it to another thread. */
    val frames: List<F>
        get() = items

    val totalBytes: Long
        get() = total

    /** How many milliseconds of history are available before `endT`. */
    fun bufferedMs(endT: Long): Long {
        val first = items.firstOrNull() ?: return 0
        return maxOf(0L, endT - first.t)
    }

    /** Frames needed to show [endT - durationMs, endT]: the one on screen at the start, then every later one up to endT. */
    fun select(endT: Long, durationMs: Long): List<F> = selectFrom(items, endT, durationMs)

    private fun evict() {
        while (items.size > 1 && total > maxBytes) {
            total -= items.removeFirst().size
        }
        val newest = items.lastOrNull() ?: return
        val cutoff = newest.t - maxAgeMs
        while (items.size > 1 && items[1].t <= cutoff) {
            total -= items.removeFirst().size
        }
    }

    companion object {
        /** [select] over an ordered snapshot of frames (e.g. the ring frozen at trigger time). */
        @JvmStatic
        fun <F : RingFrame> selectFrom(items: Iterable<F>, endT: Long, durationMs: Long): List<F> {
            val start = endT - durationMs
            var lead: F? = null
            val out = ArrayList<F>()
            for (f in items) {
                if (f.t > endT) break
                if (f.t <= start) lead = f else out.add(f)
            }
            if (lead != null) out.add(0, lead)
            return out
        }
    }
}
