/*
 * The on-disk outbox (spec §7.2): one directory per report under
 * noBackupFilesDir/snitch/outbox/<clientReportId>/ holding the attachments,
 * `report.json` (the ReportCreate body) and `state.json` (upload progress).
 *
 * A directory is only eligible for upload once report.json exists, and
 * report.json is written last and atomically (temp file + rename), so a crash
 * mid-write never uploads half a report. Caps: 10 reports or 100 MB — the
 * oldest are deleted first. Pure java.io so it is unit-testable on the JVM.
 */
package io.github.monjar.snitch.report

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

internal class OutboxState(
    var reportId: String? = null,
    var ticket: String? = null,
    var attempts: Int = 0,
    var nextAttemptAt: Long = 0,
    val uploaded: MutableSet<String> = LinkedHashSet(),
) {
    fun toJson(): JSONObject {
        val o = JSONObject()
        reportId?.let { o.put("reportId", it) }
        ticket?.let { o.put("ticket", it) }
        o.put("attempts", attempts)
        o.put("nextAttemptAt", nextAttemptAt)
        val arr = JSONArray()
        uploaded.forEach { arr.put(it) }
        o.put("uploaded", arr)
        return o
    }

    companion object {
        fun fromJson(o: JSONObject): OutboxState {
            val uploaded = LinkedHashSet<String>()
            o.optJSONArray("uploaded")?.let { arr -> for (i in 0 until arr.length()) uploaded.add(arr.getString(i)) }
            return OutboxState(
                reportId = if (o.isNull("reportId")) null else o.optString("reportId").ifEmpty { null },
                ticket = if (o.isNull("ticket")) null else o.optString("ticket").ifEmpty { null },
                attempts = o.optInt("attempts", 0),
                nextAttemptAt = o.optLong("nextAttemptAt", 0),
                uploaded = uploaded,
            )
        }
    }
}

internal class Outbox(
    val root: File,
    private val logger: SnitchLogger,
    private val maxReports: Int = 10,
    private val maxBytes: Long = 100L * 1024 * 1024,
) {
    /** Creates (or reuses) the directory for a new report. Not eligible until [commit]. */
    fun newReportDir(clientReportId: String): File {
        val dir = File(root, clientReportId)
        if (!dir.isDirectory && !dir.mkdirs()) throw java.io.IOException("cannot create $dir")
        return dir
    }

    /** Writes state.json then report.json (atomically, last), and enforces the caps. */
    fun commit(dir: File, reportJson: String) {
        writeAtomically(File(dir, STATE), OutboxState().toJson().toString())
        writeAtomically(File(dir, REPORT), reportJson)
        enforceCaps(keep = dir)
    }

    /** Directories with a report.json, oldest first. */
    fun eligible(): List<File> {
        val dirs = root.listFiles { f -> f.isDirectory && File(f, REPORT).isFile } ?: return emptyList()
        return dirs.sortedWith(compareBy<File>({ File(it, REPORT).lastModified() }, { it.name }))
    }

    fun isEmpty(): Boolean = eligible().isEmpty()

    fun readReport(dir: File): JSONObject = JSONObject(File(dir, REPORT).readText())

    fun readState(dir: File): OutboxState {
        val f = File(dir, STATE)
        return try {
            if (f.isFile) OutboxState.fromJson(JSONObject(f.readText())) else OutboxState()
        } catch (e: Exception) {
            logger.warn("outbox: unreadable state for ${dir.name}; starting over", e)
            OutboxState()
        }
    }

    fun writeState(dir: File, state: OutboxState) {
        writeAtomically(File(dir, STATE), state.toJson().toString())
    }

    fun delete(dir: File) {
        dir.deleteRecursively()
    }

    /** Removes directories that never got a report.json (the app died while writing) after an hour. */
    fun removeAbandoned(nowMs: Long) {
        root.listFiles { f -> f.isDirectory && !File(f, REPORT).exists() }?.forEach { dir ->
            if (nowMs - dir.lastModified() > ABANDONED_AFTER_MS) dir.deleteRecursively()
        }
    }

    fun enforceCaps(keep: File? = null) {
        val all = eligible().toMutableList()
        var total = all.sumOf { sizeOf(it) }
        while (all.isNotEmpty() && (all.size > maxReports || total > maxBytes)) {
            val oldest = all.firstOrNull { it != keep } ?: break
            all.remove(oldest)
            total -= sizeOf(oldest)
            logger.warn("outbox full: deleting unsent report ${oldest.name}")
            oldest.deleteRecursively()
        }
    }

    private fun sizeOf(dir: File): Long = dir.walkTopDown().filter { it.isFile }.sumOf { it.length() }

    companion object {
        const val REPORT = "report.json"
        const val STATE = "state.json"
        private const val ABANDONED_AFTER_MS = 60L * 60 * 1000

        fun writeAtomically(target: File, text: String) {
            val tmp = File(target.parentFile, target.name + ".tmp")
            tmp.writeText(text)
            if (!tmp.renameTo(target)) {
                target.delete()
                if (!tmp.renameTo(target)) throw java.io.IOException("cannot write $target")
            }
        }
    }
}
