/*
 * The SDK's own logcat output (tag "Snitch"), with once-only variants so a
 * misconfiguration or a failing server never floods the log. Implements the
 * pure SnitchLogger interface the JVM-testable report/ code depends on.
 */
package io.github.monjar.snitch

import android.util.Log
import io.github.monjar.snitch.report.SnitchLogger
import java.util.concurrent.ConcurrentHashMap

internal object SnitchLog : SnitchLogger {
    private const val TAG = "Snitch"
    private val once = ConcurrentHashMap.newKeySet<String>()

    override fun debug(message: String) {
        if (Log.isLoggable(TAG, Log.DEBUG)) Log.d(TAG, message)
    }

    override fun info(message: String) {
        Log.i(TAG, message)
    }

    override fun warn(message: String, error: Throwable?) {
        if (error != null) Log.w(TAG, message, error) else Log.w(TAG, message)
    }

    fun infoOnce(key: String, message: String) {
        if (once.add(key)) info(message)
    }

    fun warnOnce(key: String, message: String, error: Throwable? = null) {
        if (once.add(key)) warn(message, error)
    }
}
