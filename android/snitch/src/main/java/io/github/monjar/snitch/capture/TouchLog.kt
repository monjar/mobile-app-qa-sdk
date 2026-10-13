/*
 * Touch log (spec §5.4): a ring of {t, id, x, y, phase} samples in dp, window
 * coordinates, at most 60 Hz per pointer, kept for maxAgeMs + 1 s. Fed by the
 * window-callback wrapper; used to draw touch trails into the composed video
 * and, for touch downs, as the report timeline's `touch` events (spec §11.3),
 * which is why a DOWN sample also carries its position as a fraction of the
 * window and the number of fingers down. Pure Kotlin, thread-safe.
 */
package io.github.monjar.snitch.capture

internal class TouchSample(
    val t: Long,
    val id: Int,
    val x: Float,
    val y: Float,
    val phase: Phase,
    /** DOWN only: position as a fraction of the window (0–1), and fingers down; -1 / 0 otherwise. */
    val fx: Float = -1f,
    val fy: Float = -1f,
    val fingers: Int = 0,
) {
    enum class Phase { DOWN, MOVE, UP }
}

internal class TouchLog(@Volatile var maxAgeMs: Long = 31_000) {
    private val samples = ArrayDeque<TouchSample>()
    private val lastMoveAt = HashMap<Int, Long>()

    @Synchronized
    fun add(sample: TouchSample) {
        if (sample.phase == TouchSample.Phase.MOVE) {
            val last = lastMoveAt[sample.id]
            if (last != null && sample.t - last < MIN_INTERVAL_MS) return
            lastMoveAt[sample.id] = sample.t
        } else if (sample.phase == TouchSample.Phase.UP) {
            lastMoveAt.remove(sample.id)
        }
        samples.addLast(sample)
        val cutoff = sample.t - maxAgeMs - 1000
        while (samples.isNotEmpty() && samples.first().t < cutoff) samples.removeFirst()
    }

    /** Samples with start ≤ t ≤ end, oldest first. */
    @Synchronized
    fun between(start: Long, end: Long): List<TouchSample> = samples.filter { it.t in start..end }

    /** The newest [max] touch-down samples with start ≤ t ≤ end, oldest first. */
    @Synchronized
    fun downsBetween(start: Long, end: Long, max: Int): List<TouchSample> =
        samples.filter { it.phase == TouchSample.Phase.DOWN && it.t in start..end && it.fx >= 0f }.takeLast(max)

    @Synchronized
    fun clear() {
        samples.clear()
        lastMoveAt.clear()
    }

    companion object {
        private const val MIN_INTERVAL_MS = 16L
    }
}
