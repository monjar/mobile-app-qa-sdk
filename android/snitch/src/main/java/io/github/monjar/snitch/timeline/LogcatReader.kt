/*
 * Reads this app's recent logcat lines at send time (spec §11.4):
 * `logcat -d -v epoch -t 500 --pid=<pid>`. Apps may read their own UID's logs
 * without any permission (Android 4.1+); `--pid` needs Android 7, the SDK's
 * minimum.
 *
 * Budget: 2 s. The output is read on a short-lived thread while the caller (the
 * SDK's I/O thread) waits; if logcat hasn't finished by then the process is
 * destroyed and whatever arrived is used. Never throws: no logcat binary, a
 * policy that blocks it, or an OEM quirk just yields fewer (or no) lines.
 */
package io.github.monjar.snitch.timeline

import java.io.IOException

internal object LogcatReader {
    const val TIMEOUT_MS = 2_000L
    private const val TAIL_LINES = 500
    private const val MAX_LINES = 5_000

    fun command(pid: Int): List<String> = listOf("logcat", "-d", "-v", "epoch", "-t", TAIL_LINES.toString(), "--pid=$pid")

    /** The raw output lines of [command], within [timeoutMs]. */
    fun read(command: List<String>, timeoutMs: Long = TIMEOUT_MS): List<String> {
        val lines = ArrayList<String>()
        val process = try {
            ProcessBuilder(command).redirectErrorStream(true).start()
        } catch (e: IOException) {
            return emptyList()
        } catch (e: SecurityException) {
            return emptyList()
        }
        val reader = Thread({
            try {
                process.inputStream.bufferedReader().useLines { seq ->
                    for (line in seq) {
                        synchronized(lines) { if (lines.size < MAX_LINES) lines.add(line) }
                    }
                }
            } catch (_: IOException) {
                // Destroyed after the budget ran out.
            }
        }, "snitch-logcat")
        reader.isDaemon = true
        reader.start()
        try {
            reader.join(timeoutMs)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
        process.destroy()
        return synchronized(lines) { ArrayList(lines) }
    }
}
