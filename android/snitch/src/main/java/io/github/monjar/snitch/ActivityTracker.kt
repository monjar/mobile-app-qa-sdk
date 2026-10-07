/*
 * Remembers the resumed activity from process start, so a Snitch started late
 * (from React Native's JS, or from code after the first screen is up) can attach
 * to the screen that is already showing instead of waiting for the next resume.
 *
 * Installed by SnitchInitProvider before Application.onCreate in every app that
 * merges the library manifest, configured or not. It only keeps a weak
 * reference; nothing else happens until Snitch starts.
 */
package io.github.monjar.snitch

import android.app.Activity
import android.app.Application
import android.os.Bundle
import java.lang.ref.WeakReference

internal object ActivityTracker : Application.ActivityLifecycleCallbacks {
    @Volatile
    private var installed = false

    @Volatile
    private var resumed: WeakReference<Activity>? = null

    val resumedActivity: Activity?
        get() = resumed?.get()?.takeUnless { it.isFinishing }

    fun install(app: Application) {
        if (installed) return
        synchronized(this) {
            if (installed) return
            installed = true
        }
        app.registerActivityLifecycleCallbacks(this)
    }

    /** For apps without the init provider: tell the tracker which activity is on screen. */
    fun note(activity: Activity) {
        resumed = WeakReference(activity)
    }

    override fun onActivityResumed(activity: Activity) {
        resumed = WeakReference(activity)
    }

    override fun onActivityPaused(activity: Activity) {
        if (resumed?.get() === activity) resumed = null
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit

    override fun onActivityStarted(activity: Activity) = Unit

    override fun onActivityStopped(activity: Activity) = Unit

    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit

    override fun onActivityDestroyed(activity: Activity) = Unit
}
