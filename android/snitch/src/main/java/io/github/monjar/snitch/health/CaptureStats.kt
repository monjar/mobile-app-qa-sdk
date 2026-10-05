/*
 * Capture health measured on the device and sent as the report's `stats`
 * (contract CaptureStats): p50/p95 of the last 100 main-thread capture costs,
 * effective frames per second over the last 30 s, frames skipped (a capture
 * was due while the previous one was still in flight) and the compose time of
 * the last clip. Thread-safe; pure Kotlin.
 */
package io.github.monjar.snitch.health

import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

internal class CaptureStats {
    private val costs = DoubleArray(WINDOW)
    private var costCount = 0
    private var costNext = 0
    private val frameTimes = ArrayDeque<Long>()
    private var firstFrameAt: Long? = null

    @Volatile
    var framesSkipped = 0L
        private set

    @Volatile
    var lastComposeMs: Double? = null

    @Synchronized
    fun recordCost(ms: Double) {
        costs[costNext] = ms
        costNext = (costNext + 1) % WINDOW
        if (costCount < WINDOW) costCount++
    }

    @Synchronized
    fun recordFrame(uptimeMs: Long) {
        if (firstFrameAt == null) firstFrameAt = uptimeMs
        frameTimes.addLast(uptimeMs)
        while (frameTimes.isNotEmpty() && frameTimes.first() <= uptimeMs - FPS_WINDOW_MS) frameTimes.removeFirst()
    }

    @Synchronized
    fun recordSkip() {
        framesSkipped++
    }

    @Synchronized
    fun percentile(q: Double): Double? {
        if (costCount == 0) return null
        val sorted = costs.copyOf(costCount).also { it.sort() }
        val rank = ceil(q * costCount).toInt().coerceIn(1, costCount)
        return sorted[rank - 1]
    }

    /** Frames captured per second over the last 30 s (or since capture began, if sooner). */
    @Synchronized
    fun effectiveFps(nowUptimeMs: Long): Double {
        val first = firstFrameAt ?: return 0.0
        while (frameTimes.isNotEmpty() && frameTimes.first() <= nowUptimeMs - FPS_WINDOW_MS) frameTimes.removeFirst()
        val windowMs = min(FPS_WINDOW_MS, max(1L, nowUptimeMs - first))
        return frameTimes.size * 1000.0 / windowMs
    }

    companion object {
        private const val WINDOW = 100
        private const val FPS_WINDOW_MS = 30_000L
    }
}
