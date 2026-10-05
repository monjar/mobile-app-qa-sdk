/*
 * The trigger gesture: a still, three-finger hold.
 *
 * Line-for-line twin of contract/src/logic/detector.ts (and of the Swift
 * ThreeFingerHoldDetector), tested against contract/vectors/gesture.json by
 * android/logic-jvm. Keep it pure: no clocks, no android.* imports — the
 * caller feeds times (SystemClock.uptimeMillis / MotionEvent.eventTime) and
 * coordinates in dp.
 *
 * Rules, with the defaults:
 * - exactly `pointers` (3) touches, every one landing within `landingWindowMs` (150) of the first
 * - none moving more than `slop` (10 dp) from where it landed
 * - fires once `holdMs` (250) has passed since the last finger landed, so at most
 *   landingWindowMs + holdMs (400 ms) after the first touch — ahead of the 500 ms
 *   default long-press most apps use
 * - any lift, a fourth finger, or too much movement fails the sequence until every finger is up
 * - one fire per sequence, and none within `cooldownMs` (1000) of the previous fire
 */
package io.github.monjar.snitch.logic

data class DetectorConfig(
    val pointers: Int = 3,
    val landingWindowMs: Long = 150,
    val holdMs: Long = 250,
    val slop: Double = 10.0,
    val cooldownMs: Long = 1000,
    val enabled: Boolean = true,
)

/** One input to the detector: a pointer change, or a clock tick while fingers are down. */
class DetectorEvent(
    val t: Long,
    val type: Type,
    val id: Int = 0,
    val x: Double = 0.0,
    val y: Double = 0.0,
) {
    enum class Type { DOWN, MOVE, UP, CANCEL, TICK }

    companion object {
        @JvmStatic fun tick(t: Long): DetectorEvent = DetectorEvent(t, Type.TICK)
    }
}

class ThreeFingerHoldDetector(val config: DetectorConfig = DetectorConfig()) {
    private class Origin(val x: Double, val y: Double)

    private val origins = HashMap<Int, Origin>()
    private var firstDownT = 0L
    private var armedAt: Long? = null
    private var failed = false
    private var fired = false

    /** TS: Number.NEGATIVE_INFINITY. Null means "never fired". */
    private var lastFireT: Long? = null

    /** Feed one event; returns true exactly when the gesture fires. */
    fun handle(e: DetectorEvent): Boolean {
        when (e.type) {
            DetectorEvent.Type.DOWN -> {
                if (origins.isEmpty()) resetSequence(e.t)
                origins[e.id] = Origin(e.x, e.y)
                val n = origins.size
                if (n > config.pointers) {
                    failed = true
                } else if (n == config.pointers) {
                    if (e.t - firstDownT > config.landingWindowMs) failed = true else armedAt = e.t
                }
            }
            DetectorEvent.Type.MOVE -> {
                val o = origins[e.id]
                if (o != null) {
                    val dx = e.x - o.x
                    val dy = e.y - o.y
                    if (dx * dx + dy * dy > config.slop * config.slop) failed = true
                }
            }
            DetectorEvent.Type.UP, DetectorEvent.Type.CANCEL -> {
                if (origins.remove(e.id) != null) {
                    if (!fired) failed = true
                    if (origins.isEmpty()) resetSequence(e.t)
                }
                return false
            }
            DetectorEvent.Type.TICK -> Unit
        }
        return check(e.t)
    }

    /** True while a sequence that has already fired still has fingers down — the SDK swallows those touches. */
    val isConsumingSequence: Boolean
        get() = fired && origins.isNotEmpty()

    val activeTouches: Int
        get() = origins.size

    private fun check(t: Long): Boolean {
        val c = config
        val armed = armedAt
        if (!c.enabled || failed || fired || armed == null) return false
        if (origins.size != c.pointers) return false
        if (t - armed < c.holdMs) return false
        val last = lastFireT
        if (last != null && t - last < c.cooldownMs) {
            failed = true
            return false
        }
        fired = true
        lastFireT = t
        return true
    }

    private fun resetSequence(t: Long) {
        firstDownT = t
        armedAt = null
        failed = false
        fired = false
    }
}
