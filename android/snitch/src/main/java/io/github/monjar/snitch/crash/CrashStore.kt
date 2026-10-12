/*
 * Crash follow-up storage (spec §11.8), in noBackupFilesDir/snitch/crash/:
 *
 *   crash-<epochMs>-<kind>-<pid>.txt             a pending crash: the `crash` attachment text
 *                                                (kind: java | native | anr)
 *   crash-<epochMs>-<kind>-<pid>.timeline.ndjson the log of the session that crashed: timeline
 *                                                log events, one per line, sent as the `timeline`
 *   session-log.ndjson                           the current session's newest log lines, saved
 *                                                every 30 s and on background (≤ 200 lines)
 *
 * At launch the previous session's log is taken (and deleted) and, together with
 * the logcat lines of the previous process still in the buffer, attached to the
 * crash that process left behind. Pending crashes older than 7 days are deleted;
 * sending or dismissing the follow-up deletes them all.
 *
 * Every write is atomic (temp file + rename), so a crash mid-write never leaves
 * half a file. Pure java.io + org.json, JVM-testable.
 */
package io.github.monjar.snitch.crash

import io.github.monjar.snitch.logic.TimelineEvent
import io.github.monjar.snitch.logic.TimelineNdjson
import io.github.monjar.snitch.report.Outbox
import io.github.monjar.snitch.report.SnitchLogger
import org.json.JSONException
import org.json.JSONObject
import java.io.File

internal class PendingCrash(val file: File, val time: Long, val kind: String, val pid: Int) {
    /** The crashed session's log, when one was saved. */
    val timelineFile: File get() = File(file.parentFile, file.name.removeSuffix(".txt") + TIMELINE_SUFFIX)

    companion object {
        const val TIMELINE_SUFFIX = ".timeline.ndjson"
    }
}

internal class CrashStore(val dir: File, private val logger: SnitchLogger) {
    /** Saves a crash's text. Synchronous and small: also called from the uncaught-exception handler. */
    fun add(kind: String, time: Long, pid: Int, text: String): File {
        if (!dir.isDirectory) dir.mkdirs()
        val f = File(dir, "crash-$time-$kind-$pid.txt")
        Outbox.writeAtomically(f, text)
        return f
    }

    /** Pending crashes of the last [maxAgeMs], newest first; older ones are deleted. */
    fun pending(now: Long, maxAgeMs: Long = MAX_AGE_MS): List<PendingCrash> {
        val out = ArrayList<PendingCrash>()
        for (f in dir.listFiles() ?: return emptyList()) {
            val m = NAME.matchEntire(f.name) ?: continue
            val crash = PendingCrash(f, m.groupValues[1].toLong(), m.groupValues[2], m.groupValues[3].toInt())
            if (now - crash.time > maxAgeMs) {
                delete(crash)
            } else {
                out.add(crash)
            }
        }
        return out.sortedByDescending { it.time }
    }

    /** Deletes every pending crash (sent or dismissed); the session log stays. */
    fun deleteAll() {
        dir.listFiles()?.forEach { f -> if (f.name.startsWith(PREFIX)) f.delete() }
    }

    private fun delete(crash: PendingCrash) {
        crash.file.delete()
        crash.timelineFile.delete()
    }

    fun readText(crash: PendingCrash): String? = try {
        crash.file.readText()
    } catch (e: java.io.IOException) {
        logger.warn("crash: cannot read ${crash.file.name}", e)
        null
    }

    /** Saves the session that crashed: [events] become [crash]'s timeline. */
    fun attachTimeline(crash: PendingCrash, events: List<TimelineEvent>) {
        if (events.isEmpty()) return
        val text = events.sortedBy { it.t }.joinToString("") { TimelineNdjson.eventLine(it) + "\n" }
        Outbox.writeAtomically(crash.timelineFile, text)
    }

    /** [crash]'s saved timeline events (log lines), oldest first. */
    fun timelineEvents(crash: PendingCrash): List<TimelineEvent> = readEvents(crash.timelineFile)

    /** Replaces the session log with [lines] (encoded timeline log events). */
    fun writeSessionLog(lines: List<String>) {
        if (!dir.isDirectory) dir.mkdirs()
        Outbox.writeAtomically(File(dir, SESSION_LOG), lines.joinToString("") { it + "\n" })
    }

    /** At launch: the previous session's log events, removing the file. */
    fun takeSessionLog(): List<TimelineEvent> {
        val f = File(dir, SESSION_LOG)
        if (!f.isFile) return emptyList()
        val events = readEvents(f)
        f.delete()
        return events
    }

    private fun readEvents(f: File): List<TimelineEvent> {
        if (!f.isFile) return emptyList()
        val lines = try {
            f.readLines()
        } catch (e: java.io.IOException) {
            logger.warn("crash: cannot read ${f.name}", e)
            return emptyList()
        }
        return lines.mapNotNull { decodeLog(it) }
    }

    companion object {
        const val MAX_AGE_MS = 7L * 24 * 60 * 60 * 1000
        const val SESSION_LOG = "session-log.ndjson"
        const val SESSION_LOG_LINES = 200
        private const val PREFIX = "crash-"
        private val NAME = Regex("^crash-(\\d{1,15})-(java|native|anr)-(\\d{1,10})\\.txt$")

        /** A timeline `log` line back into an event; null for anything else. */
        fun decodeLog(line: String): TimelineEvent.Log? {
            if (line.isBlank()) return null
            return try {
                val o = JSONObject(line)
                if (o.optString("k") != "log") return null
                TimelineEvent.log(
                    t = o.getLong("t"),
                    level = o.optString("level", "info"),
                    src = o.optString("src", "app"),
                    msg = o.optString("msg", ""),
                    tag = if (o.has("tag") && !o.isNull("tag")) o.optString("tag") else null,
                )
            } catch (e: JSONException) {
                null
            }
        }
    }
}
