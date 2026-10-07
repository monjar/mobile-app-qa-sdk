/*
 * Crash-loop sentinel (spec §5.2, simplified for Android).
 *
 * While snapshot capture runs in the foreground, `captureSession` is set in
 * the `snitch` SharedPreferences; going to the background clears it. If it is
 * still set at the next launch, the previous foreground session ended abruptly
 * (crash, ANR kill) and `crashLoopCount` goes up. At 2 the SDK turns video off
 * for this app build (PixelCopy has no cheaper fallback renderer), reports
 * `health=crashloop` on the next config fetch and counts the downgrade in
 * stats. A foreground session longer than 60 s resets the count.
 *
 * It can't tell our crash from the app's, so it errs towards turning capture
 * off — the cheapest safe default for a QA tool. Disabled for `debug` builds,
 * where stopping the app from the IDE looks exactly like a crash.
 */
package io.github.monjar.snitch.health

import android.content.SharedPreferences

internal class CrashLoopSentinel(
    private val prefs: SharedPreferences,
    private val appBuild: String,
    /** False for debug builds (see SnitchRuntime): never counts, never downgrades. */
    private val enabled: Boolean = true,
) {
    /** Video stays off for this app build. */
    @Volatile
    var downgraded = false
        private set

    /** health=crashloop should go out with the next config fetch. */
    @Volatile
    var healthPending = false
        private set

    val downgrades: Long get() = prefs.getLong(K_DOWNGRADES, 0)

    private var sessionActive = false

    /** Call once at start, off the main thread (reads SharedPreferences). */
    fun checkPreviousSession() {
        if (!enabled) return
        val e = prefs.edit()
        if (prefs.contains(K_SESSION)) {
            val count = prefs.getInt(K_COUNT, 0) + 1
            e.remove(K_SESSION).putInt(K_COUNT, count)
            if (count >= THRESHOLD && prefs.getString(K_BUILD, null) != appBuild) {
                e.putString(K_BUILD, appBuild).putLong(K_DOWNGRADES, prefs.getLong(K_DOWNGRADES, 0) + 1).putInt(K_COUNT, 0)
                healthPending = true
            }
        }
        e.apply()
        downgraded = prefs.getString(K_BUILD, null) == appBuild
    }

    fun onCaptureSessionStarted() {
        if (!enabled || sessionActive) return
        sessionActive = true
        prefs.edit().putString(K_SESSION, "pixelCopy").apply()
    }

    fun onCaptureSessionEnded() {
        if (!sessionActive) return
        sessionActive = false
        prefs.edit().remove(K_SESSION).apply()
    }

    /** The foreground session lasted > 60 s: capture is evidently not crashing the app. */
    fun onHealthySession() {
        if (!enabled) return
        prefs.edit().putInt(K_COUNT, 0).apply()
    }

    fun onHealthReported() {
        healthPending = false
    }

    companion object {
        const val HEALTHY_SESSION_MS = 60_000L
        private const val THRESHOLD = 2
        private const val K_SESSION = "captureSession"
        private const val K_COUNT = "crashLoopCount"
        private const val K_BUILD = "crashLoopBuild"
        private const val K_DOWNGRADES = "crashLoopDowngrades"
    }
}
