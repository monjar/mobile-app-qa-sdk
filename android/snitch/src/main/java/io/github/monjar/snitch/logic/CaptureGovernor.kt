/*
 * The snapshot-capture governor: how long to wait before the next frame.
 *
 * Twin of contract/src/logic/governor.ts (and the Swift CaptureGovernor),
 * tested against contract/vectors/governor.json by android/logic-jvm.
 *
 * - idle → idleFps; within activeWindowMs of the last touch → activeFps
 * - never more often than the main-thread budget allows: delay ≥ cost / budget
 * - low-power mode halves the idle rate and drops the interaction boost
 * - thermal serious/critical, or an explicit pause, stops capture (null)
 */
package io.github.monjar.snitch.logic

import kotlin.math.max
import kotlin.math.roundToLong

enum class ThermalState { NOMINAL, FAIR, SERIOUS, CRITICAL }

data class GovernorConfig(
    val idleFps: Double = 1.0,
    val activeFps: Double = 4.0,
    val budgetPct: Double = 3.0,
    val activeWindowMs: Long = 1500,
)

data class GovernorInput(
    val now: Long,
    val lastTouchAt: Long?,
    val avgCostMs: Double,
    val lowPower: Boolean,
    val thermal: ThermalState,
    val paused: Boolean,
)

object CaptureGovernor {
    /** Milliseconds until the next capture, or null while capture is paused. */
    @JvmStatic
    fun nextCaptureDelayMs(config: GovernorConfig, input: GovernorInput): Long? {
        if (input.paused || input.thermal == ThermalState.SERIOUS || input.thermal == ThermalState.CRITICAL) return null
        val lastTouchAt = input.lastTouchAt
        val active = !input.lowPower && lastTouchAt != null && input.now - lastTouchAt <= config.activeWindowMs
        val fps = if (active) config.activeFps else if (input.lowPower) config.idleFps / 2 else config.idleFps
        val base = 1000.0 / fps
        val budgetFloor = input.avgCostMs / (config.budgetPct / 100.0)
        return max(base, budgetFloor).roundToLong()
    }

    /** Exponentially weighted moving average of capture cost (α = 0.2). */
    @JvmStatic
    fun updateAverageCost(avg: Double?, sampleMs: Double): Double =
        if (avg == null) sampleMs else avg * 0.8 + sampleMs * 0.2
}
