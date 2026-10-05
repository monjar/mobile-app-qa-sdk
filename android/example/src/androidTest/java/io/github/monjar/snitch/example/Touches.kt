/*
 * Multi-pointer touch injection for instrumented tests: builds real
 * touchscreen MotionEvents (DOWN, POINTER_DOWN…, MOVE, POINTER_UP…, UP) and
 * injects them through UiAutomation, so they travel the same path as a finger:
 * InputDispatcher → the activity window → Window.Callback (Snitch's wrapper).
 */
package io.github.monjar.snitch.example

import android.app.Activity
import android.app.UiAutomation
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import android.view.View
import androidx.test.platform.app.InstrumentationRegistry

object Touches {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val automation: UiAutomation get() = instrumentation.uiAutomation

    /** Screen coordinates of [view]'s centre, offset by ([dx], 0). */
    fun centerOf(view: View, dx: Float = 0f): Pair<Float, Float> {
        var out = 0f to 0f
        instrumentation.runOnMainSync {
            val loc = IntArray(2)
            view.getLocationOnScreen(loc)
            out = (loc[0] + view.width / 2f + dx) to (loc[1] + view.height / 2f)
        }
        return out
    }

    /**
     * Puts one finger per point down, [landingGapMs] apart, holds them still for
     * [holdMs] (sending MOVE samples every 50 ms, like a real touchscreen), then lifts them.
     */
    fun hold(points: List<Pair<Float, Float>>, landingGapMs: Long = 20, holdMs: Long = 800) {
        val downTime = SystemClock.uptimeMillis()
        for (n in 1..points.size) {
            val action = if (n == 1) MotionEvent.ACTION_DOWN else MotionEvent.ACTION_POINTER_DOWN or ((n - 1) shl MotionEvent.ACTION_POINTER_INDEX_SHIFT)
            inject(downTime, action, points.take(n))
            if (n < points.size) SystemClock.sleep(landingGapMs)
        }
        val until = SystemClock.uptimeMillis() + holdMs
        while (SystemClock.uptimeMillis() < until) {
            SystemClock.sleep(50)
            inject(downTime, MotionEvent.ACTION_MOVE, points)
        }
        for (n in points.size downTo 1) {
            val action = if (n == 1) MotionEvent.ACTION_UP else MotionEvent.ACTION_POINTER_UP or ((n - 1) shl MotionEvent.ACTION_POINTER_INDEX_SHIFT)
            inject(downTime, action, points.take(n))
        }
    }

    fun tap(point: Pair<Float, Float>, pressMs: Long = 80) {
        val downTime = SystemClock.uptimeMillis()
        inject(downTime, MotionEvent.ACTION_DOWN, listOf(point))
        SystemClock.sleep(pressMs)
        inject(downTime, MotionEvent.ACTION_UP, listOf(point))
    }

    private fun inject(downTime: Long, action: Int, points: List<Pair<Float, Float>>) {
        val props = Array(points.size) { i ->
            MotionEvent.PointerProperties().apply {
                id = i
                toolType = MotionEvent.TOOL_TYPE_FINGER
            }
        }
        val coords = Array(points.size) { i ->
            MotionEvent.PointerCoords().apply {
                x = points[i].first
                y = points[i].second
                pressure = 1f
                size = 1f
            }
        }
        val event = MotionEvent.obtain(
            downTime,
            SystemClock.uptimeMillis(),
            action,
            points.size,
            props,
            coords,
            0,
            0,
            1f,
            1f,
            0,
            0,
            InputDevice.SOURCE_TOUCHSCREEN,
            0,
        )
        try {
            check(automation.injectInputEvent(event, true)) { "injectInputEvent failed for action $action" }
        } finally {
            event.recycle()
        }
    }

    fun <T : Activity> onMain(activity: T, block: (T) -> Unit) {
        instrumentation.runOnMainSync { block(activity) }
    }
}
