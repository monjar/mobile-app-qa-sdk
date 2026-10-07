/*
 * Logging seam for the pure (JVM-testable) parts of the SDK: report/, config/
 * parsing and the uploader. On device it is SnitchLog (logcat); tests pass a
 * recording implementation.
 */
package io.github.monjar.snitch.report

internal interface SnitchLogger {
    fun debug(message: String)

    fun info(message: String)

    fun warn(message: String, error: Throwable? = null)
}
