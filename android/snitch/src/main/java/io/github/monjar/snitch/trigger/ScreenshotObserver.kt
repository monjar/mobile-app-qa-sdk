/*
 * "Report this screen?" after a system screenshot (spec §4.3). Android 14+
 * only, through Activity.registerScreenCaptureCallback, which requires the
 * DETECT_SCREEN_CAPTURE permission. The library does not declare it; apps opt
 * in by adding it to their manifest, and without it this observer is a no-op.
 * Registered while each activity is started.
 */
package io.github.monjar.snitch.trigger

import android.annotation.TargetApi
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import java.lang.ref.WeakReference
import java.util.WeakHashMap

internal class ScreenshotObserver(private val onScreenshot: (Activity) -> Unit) {
    private val callbacks = WeakHashMap<Activity, Any>()

    fun isSupported(activity: Activity): Boolean =
        Build.VERSION.SDK_INT >= 34 && activity.checkSelfPermission(PERMISSION) == PackageManager.PERMISSION_GRANTED

    fun register(activity: Activity) {
        if (!isSupported(activity) || callbacks.containsKey(activity)) return
        register34(activity)
    }

    fun unregister(activity: Activity) {
        val cb = callbacks.remove(activity) ?: return
        if (Build.VERSION.SDK_INT >= 34) unregister34(activity, cb)
    }

    @TargetApi(34)
    private fun register34(activity: Activity) {
        // The map's value must not hold the activity strongly (it is the WeakHashMap key).
        val ref = WeakReference(activity)
        val cb = Activity.ScreenCaptureCallback { ref.get()?.let(onScreenshot) }
        try {
            activity.registerScreenCaptureCallback(activity.mainExecutor, cb)
            callbacks[activity] = cb
        } catch (_: SecurityException) {
        }
    }

    @TargetApi(34)
    private fun unregister34(activity: Activity, cb: Any) {
        try {
            activity.unregisterScreenCaptureCallback(cb as Activity.ScreenCaptureCallback)
        } catch (_: Exception) {
        }
    }

    companion object {
        const val PERMISSION = "android.permission.DETECT_SCREEN_CAPTURE"
    }
}
