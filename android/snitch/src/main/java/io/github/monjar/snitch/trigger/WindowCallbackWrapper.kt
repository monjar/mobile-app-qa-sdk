/*
 * Observes an activity window's touches without swizzling or overlays (spec §4.1):
 * wraps its Window.Callback, feeds every touchscreen pointer change (in dp) to the
 * ThreeFingerHoldDetector and the touch log, then forwards to the original.
 *
 * On fire, in order: take the screenshot (via the host), send a copy of the
 * current event as ACTION_CANCEL to the original callback — so the views lose
 * their touch targets and long-press timers die — swallow every further event
 * until the last pointer is up, and let the host show the sheet.
 *
 * Ticks: a one-shot runnable at (third finger down + holdMs) on the main
 * Handler, using the same uptime clock as MotionEvent.eventTime.
 *
 * Wrapping is idempotent: the runtime retires a wrapper (it becomes a plain
 * pass-through) before re-wrapping a window whose callback someone replaced.
 * All Window.Callback methods delegate; the two with Java default bodies
 * (onProvideKeyboardShortcuts, onPointerCaptureChanged) are forwarded
 * explicitly so the original's overrides still run.
 */
package io.github.monjar.snitch.trigger

import android.annotation.TargetApi
import android.app.Activity
import android.os.Handler
import android.os.SystemClock
import android.view.InputDevice
import android.view.KeyboardShortcutGroup
import android.view.Menu
import android.view.MotionEvent
import android.view.Window
import io.github.monjar.snitch.logic.DetectorEvent
import io.github.monjar.snitch.logic.ThreeFingerHoldDetector
import java.lang.ref.WeakReference

internal interface GestureHost {
    /** Gesture allowed right now (SDK enabled, three-finger mode, no screen reader, sheet hidden). */
    val gestureActive: Boolean

    /** SNITCH_DEBUG_CANCEL_AFTER_MS, when set and honoured. */
    val debugCancelAfterMs: Long?

    /** Every touchscreen event, before the detector (touch log + governor). */
    fun onTouchEvent(event: MotionEvent, density: Float)

    /** Take the screenshot and freeze the ring. Called before the cancel is sent. */
    fun onGestureFired(activity: Activity, firstDownTime: Long, debugDismiss: Boolean)
}

internal class WindowCallbackWrapper(
    activity: Activity,
    private val original: Window.Callback,
    private val host: GestureHost,
    private val handler: Handler,
) : Window.Callback by original {
    private val activityRef = WeakReference(activity)
    private val detector = ThreeFingerHoldDetector()
    private val density = activity.resources.displayMetrics.density.takeIf { it > 0f } ?: 1f

    /** False once retired: the wrapper then only forwards. */
    @Volatile
    var active = true

    private var swallowing = false
    private var sequenceDownTime = 0L

    private val tick = Runnable {
        if (detector.handle(DetectorEvent.tick(SystemClock.uptimeMillis())) && host.gestureActive && !swallowing) {
            fire(null, debugDismiss = false)
        }
    }

    private val debugCancel = Runnable {
        if (detector.activeTouches > 0 && !swallowing) fire(null, debugDismiss = true)
    }

    override fun dispatchTouchEvent(event: MotionEvent?): Boolean {
        if (event == null || !active || !event.isFromSource(InputDevice.SOURCE_TOUCHSCREEN)) {
            return original.dispatchTouchEvent(event)
        }
        val action = event.actionMasked
        if (swallowing) {
            feed(event)
            if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
                swallowing = false
                handler.removeCallbacks(tick)
            }
            return true
        }
        host.onTouchEvent(event, density)
        if (action == MotionEvent.ACTION_DOWN) {
            sequenceDownTime = event.downTime
            handler.removeCallbacks(debugCancel)
            host.debugCancelAfterMs?.let { ms -> handler.postAtTime(debugCancel, event.downTime + ms) }
        }
        val fired = feed(event)
        if (fired && host.gestureActive) {
            fire(event, debugDismiss = false)
            return true
        }
        when (action) {
            MotionEvent.ACTION_DOWN, MotionEvent.ACTION_POINTER_DOWN ->
                if (detector.activeTouches == detector.config.pointers) {
                    handler.removeCallbacks(tick)
                    handler.postAtTime(tick, event.eventTime + detector.config.holdMs)
                }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                handler.removeCallbacks(tick)
                handler.removeCallbacks(debugCancel)
            }
        }
        return original.dispatchTouchEvent(event)
    }

    /** Feeds the pointer change(s) of [ev] to the detector; true when it fired. */
    private fun feed(ev: MotionEvent): Boolean {
        val t = ev.eventTime
        var fired = false
        when (ev.actionMasked) {
            MotionEvent.ACTION_DOWN, MotionEvent.ACTION_POINTER_DOWN -> {
                val i = ev.actionIndex
                fired = detector.handle(DetectorEvent(t, DetectorEvent.Type.DOWN, ev.getPointerId(i), ev.getX(i) / density.toDouble(), ev.getY(i) / density.toDouble()))
            }
            MotionEvent.ACTION_MOVE -> {
                for (i in 0 until ev.pointerCount) {
                    val e = DetectorEvent(t, DetectorEvent.Type.MOVE, ev.getPointerId(i), ev.getX(i) / density.toDouble(), ev.getY(i) / density.toDouble())
                    if (detector.handle(e)) fired = true
                }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_POINTER_UP -> {
                val i = ev.actionIndex
                detector.handle(DetectorEvent(t, DetectorEvent.Type.UP, ev.getPointerId(i), ev.getX(i) / density.toDouble(), ev.getY(i) / density.toDouble()))
            }
            MotionEvent.ACTION_CANCEL -> {
                for (i in 0 until ev.pointerCount) {
                    detector.handle(DetectorEvent(t, DetectorEvent.Type.CANCEL, ev.getPointerId(i), ev.getX(i) / density.toDouble(), ev.getY(i) / density.toDouble()))
                }
            }
        }
        return fired
    }

    private fun fire(current: MotionEvent?, debugDismiss: Boolean) {
        val activity = activityRef.get() ?: return
        handler.removeCallbacks(tick)
        handler.removeCallbacks(debugCancel)
        val downTime = current?.downTime ?: sequenceDownTime
        // 1. Screenshot + ring freeze, before anything on screen changes.
        host.onGestureFired(activity, downTime, debugDismiss)
        // 2. Cancel the views' touch sequence.
        val cancel = if (current != null) {
            MotionEvent.obtain(current)
        } else {
            MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), MotionEvent.ACTION_CANCEL, 0f, 0f, 0).also {
                it.source = InputDevice.SOURCE_TOUCHSCREEN
            }
        }
        cancel.action = MotionEvent.ACTION_CANCEL
        try {
            original.dispatchTouchEvent(cancel)
        } finally {
            cancel.recycle()
        }
        // 3. Swallow the rest of this sequence.
        swallowing = true
    }

    @TargetApi(24)
    override fun onProvideKeyboardShortcuts(data: MutableList<KeyboardShortcutGroup>?, menu: Menu?, deviceId: Int) {
        original.onProvideKeyboardShortcuts(data, menu, deviceId)
    }

    @TargetApi(26)
    override fun onPointerCaptureChanged(hasCapture: Boolean) {
        original.onPointerCaptureChanged(hasCapture)
    }
}
