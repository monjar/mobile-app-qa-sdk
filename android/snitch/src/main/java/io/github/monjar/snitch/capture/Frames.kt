/*
 * Captured frames and the thread-safe store around the pure FrameRing.
 *
 * A Frame is a JPEG still plus what the composer needs to draw touch trails on
 * it: `pxPerDp` (frame pixels per dp of touch-log coordinates) and the window
 * origin inside the frame (0,0 for snapshot frames; the window's position on
 * the display for system-capture frames). Limits (spec §5.1): 6 MB in snapshot
 * mode, 10 MB in system mode, `videoMaxSeconds` of history. Memory only.
 */
package io.github.monjar.snitch.capture

import io.github.monjar.snitch.logic.FrameRing
import io.github.monjar.snitch.logic.RingFrame

internal class Frame(
    override val t: Long,
    val jpeg: ByteArray,
    val width: Int,
    val height: Int,
    override val checksum: String,
    val pxPerDp: Float,
    val originX: Float = 0f,
    val originY: Float = 0f,
) : RingFrame {
    override val size: Int get() = jpeg.size
}

internal class FrameStore {
    private var ring = FrameRing<Frame>(SNAPSHOT_MAX_BYTES, 30_000)

    @Synchronized
    fun configure(maxBytes: Long, maxAgeMs: Long) {
        if (ring.maxBytes == maxBytes && ring.maxAgeMs == maxAgeMs) return
        val old = ring.frames.toList()
        ring = FrameRing(maxBytes, maxAgeMs)
        old.forEach { ring.push(it) }
    }

    @Synchronized
    fun push(frame: Frame): Boolean = ring.push(frame)

    @Synchronized
    fun trimHalf() = ring.trimHalf()

    @Synchronized
    fun clear() = ring.clear()

    @Synchronized
    fun totalBytes(): Long = ring.totalBytes

    @Synchronized
    fun bufferedMs(endT: Long): Long = ring.bufferedMs(endT)

    @Synchronized
    fun isEmpty(): Boolean = ring.frames.isEmpty()

    @Synchronized
    fun newestChecksum(): String? = ring.frames.lastOrNull()?.checksum

    /** An immutable snapshot of the frames needed for [endT - durationMs, endT]. */
    @Synchronized
    fun select(endT: Long, durationMs: Long): List<Frame> = ring.select(endT, durationMs)

    companion object {
        const val SNAPSHOT_MAX_BYTES = 6L * 1024 * 1024
        const val SYSTEM_MAX_BYTES = 10L * 1024 * 1024
    }
}
