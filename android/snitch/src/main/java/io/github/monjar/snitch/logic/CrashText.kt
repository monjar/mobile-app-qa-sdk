/*
 * The text of a crash follow-up's `crash` attachment (spec §11.8).
 *
 * - Uncaught Java/Kotlin exceptions: a short header (thread, time, pid) and the
 *   stack trace with its causes and suppressed exceptions, at most 256 KB.
 * - Exits the system recorded (API 30+ ApplicationExitInfo): a header with the
 *   reason and description, then the first 512 KB of the trace. ANR traces are
 *   text; native-crash tombstones are a protobuf on Android 12+, which is useless
 *   as text/plain, so for binary traces only the printable strings are kept (the
 *   abort message, signal, backtrace symbols and file names survive that).
 *
 * Pure Kotlin.
 */
package io.github.monjar.snitch.logic

object CrashText {
    const val JAVA_MAX_BYTES = 256 * 1024
    const val TRACE_MAX_BYTES = 512 * 1024

    /** Header + stack trace of an uncaught exception, at most [JAVA_MAX_BYTES]. */
    @JvmStatic
    fun forThrowable(threadName: String, threadId: Long, time: String, pid: Int, error: Throwable): String {
        val trace = try {
            error.stackTraceToString()
        } catch (e: Throwable) {
            // A broken toString() or a stack overflow while printing: keep what we can.
            "${error.javaClass.name} (stack trace unavailable: ${e.javaClass.name})"
        }
        val text = "Uncaught exception in thread \"$threadName\" (id $threadId)\nTime: $time\nPid: $pid\n\n$trace"
        return capUtf8(text, JAVA_MAX_BYTES)
    }

    /** Header + trace of a recorded process exit; [trace] is at most [TRACE_MAX_BYTES] of the raw stream. */
    @JvmStatic
    fun forExit(kind: String, time: String, pid: Int, processName: String?, description: String?, trace: ByteArray?): String {
        val sb = StringBuilder()
        sb.append(if (kind == "anr") "Application not responding (ANR)" else "Native crash").append('\n')
        sb.append("Time: ").append(time).append('\n')
        sb.append("Pid: ").append(pid).append('\n')
        if (!processName.isNullOrBlank()) sb.append("Process: ").append(processName).append('\n')
        if (!description.isNullOrBlank()) sb.append("Description: ").append(description.trim()).append('\n')
        if (trace != null && trace.isNotEmpty()) {
            sb.append('\n')
            if (looksLikeText(trace)) {
                sb.append(String(trace, Charsets.UTF_8))
            } else {
                sb.append("(binary trace; printable strings follow)\n")
                sb.append(printableStrings(trace))
            }
        }
        return sb.toString()
    }

    /** No NUL bytes and almost no control characters other than tab, CR and LF. */
    @JvmStatic
    fun looksLikeText(bytes: ByteArray): Boolean {
        var control = 0
        for (b in bytes) {
            val v = b.toInt() and 0xFF
            if (v == 0) return false
            if (v < 0x20 && v != 0x09 && v != 0x0A && v != 0x0D) control++
        }
        return control * 100 <= bytes.size
    }

    /** Runs of at least [minLength] printable ASCII characters, one per line (like `strings`). */
    @JvmStatic
    fun printableStrings(bytes: ByteArray, minLength: Int = 4): String {
        val out = StringBuilder()
        val run = StringBuilder()
        fun endRun() {
            if (run.length >= minLength) out.append(run).append('\n')
            run.setLength(0)
        }
        for (b in bytes) {
            val v = b.toInt() and 0xFF
            if (v in 0x20..0x7E || v == 0x09) run.append(v.toChar()) else endRun()
        }
        endRun()
        return out.toString()
    }

    /** [text] cut so its UTF-8 form is at most [maxBytes], never inside a character, ending with a note when cut. */
    @JvmStatic
    fun capUtf8(text: String, maxBytes: Int): String {
        if (TimelineNdjson.utf8Length(text) <= maxBytes) return text
        val note = "\n… (cut at ${maxBytes / 1024} KB)\n"
        val budget = maxBytes - TimelineNdjson.utf8Length(note)
        var bytes = 0
        var i = 0
        while (i < text.length) {
            val c = text[i]
            val pair = c.isHighSurrogate() && i + 1 < text.length && text[i + 1].isLowSurrogate()
            val n = when {
                c.code < 0x80 -> 1
                c.code < 0x800 -> 2
                pair -> 4
                else -> 3
            }
            if (bytes + n > budget) break
            bytes += n
            i += if (pair) 2 else 1
        }
        return text.substring(0, i) + note
    }
}
