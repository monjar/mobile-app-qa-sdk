/*
 * The upload state machine (spec §7.3), one report at a time:
 *   1. POST /api/v1/reports                        (unless state.json already has a reportId)
 *   2. PUT  /api/v1/reports/{id}/attachments/{name} for each declared attachment not yet stored
 *   3. POST /api/v1/reports/{id}/complete          → 200: delete the directory
 *
 * Errors follow contract/src/ingest.ts#isRetryable: 401/403/413/415/422 drop the
 * report; 409 attachments_missing re-uploads what the server lacks; 409
 * report_completed is done; 404 on PUT/complete restarts at step 1;
 * 429/5xx/network back off for min(30 s · 2^(attempts-1), 1 h), or Retry-After.
 *
 * Blocking HttpURLConnection on the caller's thread (the SDK's single I/O
 * thread) — no OkHttp. Pure JVM: endpoint, clock and logger are injected so the
 * whole machine is tested against a local HTTP server.
 */
package io.github.monjar.snitch.report

import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Locale

internal data class Endpoint(
    val baseUrl: String,
    val ingestKey: String,
    /** X-Snitch-SDK, e.g. `android/0.1.0`. */
    val sdkHeader: String,
    val userAgent: String,
)

internal sealed class UploadOutcome {
    abstract val clientReportId: String

    data class Sent(override val clientReportId: String, val ticket: String?) : UploadOutcome()

    /** [offline]: the request never reached the server (no network, DNS, TLS, cleartext blocked). */
    data class Deferred(override val clientReportId: String, val nextAttemptAt: Long, val offline: Boolean) : UploadOutcome()

    data class Dropped(override val clientReportId: String, val status: Int, val code: String?) : UploadOutcome()
}

internal class UploadRun(val outcomes: List<UploadOutcome>, val nextAttemptAt: Long?)

internal class Uploader(
    private val outbox: Outbox,
    private val endpoint: () -> Endpoint?,
    private val logger: SnitchLogger,
    private val clock: () -> Long = { System.currentTimeMillis() },
    private val timeoutMs: Int = 30_000,
    private val uploadTimeoutMs: Int = 120_000,
) {
    private class Response(val status: Int, val body: JSONObject?, val retryAfterMs: Long?) {
        val code: String? get() = body?.optJSONObject("error")?.optString("code")?.ifEmpty { null }
    }

    private enum class Phase { CREATE, PUT, COMPLETE }

    /** Uploads every eligible report once, serially. */
    fun runOnce(): UploadRun {
        val ep = endpoint() ?: return UploadRun(emptyList(), null)
        val outcomes = ArrayList<UploadOutcome>()
        var next: Long? = null
        for (dir in outbox.eligible()) {
            val state = outbox.readState(dir)
            if (state.nextAttemptAt > clock()) {
                next = minOf(next ?: Long.MAX_VALUE, state.nextAttemptAt)
                continue
            }
            val outcome = try {
                upload(ep, dir, state)
            } catch (e: Exception) {
                // A corrupt report.json or an unexpected server body: never retry forever.
                logger.warn("upload: dropping unreadable report ${dir.name}", e)
                outbox.delete(dir)
                UploadOutcome.Dropped(dir.name, -1, null)
            }
            outcomes.add(outcome)
            if (outcome is UploadOutcome.Deferred) {
                next = minOf(next ?: Long.MAX_VALUE, outcome.nextAttemptAt)
                // Offline: the rest would fail the same way; they go with the next run.
                if (outcome.offline) break
            }
        }
        return UploadRun(outcomes, next)
    }

    private fun upload(ep: Endpoint, dir: File, state: OutboxState): UploadOutcome {
        val id = dir.name
        val reportText = File(dir, Outbox.REPORT).readText()
        val declared = declaredAttachments(JSONObject(reportText))
        var restarts = 0
        var missingRounds = 0

        while (true) {
            // 1. Create.
            if (state.reportId == null) {
                val r = send(ep, "POST", "/reports", reportText.toByteArray(Charsets.UTF_8), "application/json", null, timeoutMs)
                if (r.status == 200 || r.status == 201) {
                    val body = r.body
                    val reportId = body?.optString("reportId")?.ifEmpty { null } ?: return backoff(dir, state, r)
                    state.reportId = reportId
                    state.ticket = body.optString("ticket").ifEmpty { null }
                    state.uploaded.clear()
                    body.optJSONArray("attachments")?.let { arr ->
                        for (i in 0 until arr.length()) {
                            val a = arr.getJSONObject(i)
                            if (a.optString("state") == "stored") state.uploaded.add(a.getString("name"))
                        }
                    }
                    outbox.writeState(dir, state)
                } else {
                    return handleError(dir, state, r, Phase.CREATE) ?: continue
                }
            }
            val reportId = state.reportId ?: continue

            // 2. Attachments.
            var restart = false
            for ((name, contentType) in declared) {
                if (name in state.uploaded) continue
                val file = File(dir, AttachmentDecl.fileNameFor(name, contentType))
                if (!file.isFile) {
                    logger.warn("upload: attachment $name of report $id is missing on disk; dropping the report")
                    outbox.delete(dir)
                    return UploadOutcome.Dropped(id, -1, null)
                }
                val r = sendFile(ep, "/reports/$reportId/attachments/$name", file, contentType)
                if (r.status == 200 || r.status == 201) {
                    state.uploaded.add(name)
                    outbox.writeState(dir, state)
                } else {
                    val outcome = handleError(dir, state, r, Phase.PUT)
                    if (outcome != null) return outcome
                    restart = true
                    break
                }
            }
            if (restart) {
                if (++restarts > 2) return backoff(dir, state, null)
                continue
            }

            // 3. Complete.
            val r = send(ep, "POST", "/reports/$reportId/complete", ByteArray(0), "application/json", null, timeoutMs)
            if (r.status == 200 || r.status == 201) {
                outbox.delete(dir)
                return UploadOutcome.Sent(id, r.body?.optString("ticket")?.ifEmpty { null } ?: state.ticket)
            }
            if (r.status == 409 && r.code == "attachments_missing") {
                val missing = r.body?.optJSONObject("error")?.optJSONObject("details")?.optJSONArray("missing")
                if (missing != null && missing.length() > 0) {
                    for (i in 0 until missing.length()) state.uploaded.remove(missing.getString(i))
                } else {
                    state.uploaded.clear()
                }
                outbox.writeState(dir, state)
                if (++missingRounds > 2) return backoff(dir, state, r)
                continue
            }
            val outcome = handleError(dir, state, r, Phase.COMPLETE)
            if (outcome != null) return outcome
            if (++restarts > 2) return backoff(dir, state, null)
        }
    }

    /** Returns the final outcome, or null to restart at step 1 (state already reset). */
    private fun handleError(dir: File, state: OutboxState, r: Response, phase: Phase): UploadOutcome? {
        val id = dir.name
        val status = r.status
        val code = r.code
        return when {
            status == 401 || status == 403 || status == 413 || status == 415 || status == 422 -> {
                logger.warn("upload: server rejected report $id (HTTP $status${code?.let { " $it" } ?: ""}); deleting it")
                outbox.delete(dir)
                UploadOutcome.Dropped(id, status, code)
            }
            status == 409 && code == "report_completed" -> {
                outbox.delete(dir)
                UploadOutcome.Sent(id, state.ticket)
            }
            status == 404 && phase != Phase.CREATE -> {
                state.reportId = null
                state.ticket = null
                state.uploaded.clear()
                outbox.writeState(dir, state)
                null
            }
            isRetryable(status, code) -> backoff(dir, state, r)
            else -> {
                logger.warn("upload: report $id failed with HTTP $status${code?.let { " $it" } ?: ""}; deleting it")
                outbox.delete(dir)
                UploadOutcome.Dropped(id, status, code)
            }
        }
    }

    private fun backoff(dir: File, state: OutboxState, r: Response?): UploadOutcome {
        state.attempts += 1
        val now = clock()
        val delay = r?.retryAfterMs?.coerceIn(1_000L, MAX_RETRY_AFTER_MS) ?: backoffMs(state.attempts)
        state.nextAttemptAt = now + delay
        outbox.writeState(dir, state)
        logger.debug("upload: report ${dir.name} deferred ${delay / 1000}s (attempt ${state.attempts}, HTTP ${r?.status ?: "-"})")
        return UploadOutcome.Deferred(dir.name, state.nextAttemptAt, offline = r?.status == 0)
    }

    private fun declaredAttachments(report: JSONObject): List<Pair<String, String>> {
        val arr = report.optJSONArray("attachments") ?: return emptyList()
        return (0 until arr.length()).map {
            val a = arr.getJSONObject(it)
            a.getString("name") to a.getString("contentType")
        }
    }

    private fun sendFile(ep: Endpoint, path: String, file: File, contentType: String): Response {
        val sha = Sha256.hex(file)
        return file.inputStream().use { input ->
            send(ep, "PUT", path, null, contentType, Body(input, file.length(), sha), uploadTimeoutMs)
        }
    }

    private class Body(val stream: InputStream, val length: Long, val sha256: String)

    private fun send(
        ep: Endpoint,
        method: String,
        path: String,
        bytes: ByteArray?,
        contentType: String,
        stream: Body?,
        readTimeoutMs: Int,
    ): Response {
        var conn: HttpURLConnection? = null
        try {
            conn = URL(ep.baseUrl.trimEnd('/') + API_PREFIX + path).openConnection() as HttpURLConnection
            conn.requestMethod = method
            conn.connectTimeout = timeoutMs
            conn.readTimeout = readTimeoutMs
            conn.useCaches = false
            conn.instanceFollowRedirects = false
            conn.setRequestProperty("X-Snitch-Key", ep.ingestKey)
            conn.setRequestProperty("X-Snitch-SDK", ep.sdkHeader)
            conn.setRequestProperty("User-Agent", ep.userAgent)
            conn.setRequestProperty("Accept", "application/json")
            conn.setRequestProperty("Content-Type", contentType)
            conn.doOutput = true
            if (stream != null) {
                conn.setRequestProperty("X-Content-SHA256", stream.sha256)
                conn.setFixedLengthStreamingMode(stream.length)
                conn.outputStream.use { out -> stream.stream.copyTo(out, 64 * 1024) }
            } else {
                val body = bytes ?: ByteArray(0)
                conn.setFixedLengthStreamingMode(body.size)
                conn.outputStream.use { it.write(body) }
            }
            val status = conn.responseCode
            val text = (if (status >= 400) conn.errorStream else conn.inputStream)?.use { readCapped(it) }
            val json = text?.let { runCatching { JSONObject(it) }.getOrNull() }
            return Response(status, json, parseRetryAfter(conn.getHeaderField("Retry-After"), clock()))
        } catch (e: IOException) {
            if (e.message?.contains("CLEARTEXT", ignoreCase = true) == true) {
                logger.warn("upload: cleartext HTTP to ${ep.baseUrl} is blocked; use https or a network security config", e)
            } else {
                logger.debug("upload: network error ${e.javaClass.simpleName}: ${e.message}")
            }
            return Response(0, null, null)
        } finally {
            conn?.disconnect()
        }
    }

    private fun readCapped(input: InputStream): String {
        val buf = ByteArray(MAX_RESPONSE_BYTES)
        var n = 0
        while (n < buf.size) {
            val r = input.read(buf, n, buf.size - n)
            if (r < 0) break
            n += r
        }
        return String(buf, 0, n, Charsets.UTF_8)
    }

    companion object {
        const val API_PREFIX = "/api/v1"
        private const val MAX_RESPONSE_BYTES = 64 * 1024
        private const val BASE_BACKOFF_MS = 30_000L
        private const val MAX_BACKOFF_MS = 60L * 60 * 1000
        private const val MAX_RETRY_AFTER_MS = 24L * 60 * 60 * 1000

        /** contract/src/ingest.ts#isRetryable. */
        fun isRetryable(status: Int, code: String?): Boolean {
            if (status == 429 || status >= 500 || status == 0) return true
            return code == "attachments_missing"
        }

        /** min(30 s · 2^(attempts-1), 1 h). */
        fun backoffMs(attempts: Int): Long {
            val exp = (attempts - 1).coerceIn(0, 20)
            return minOf(BASE_BACKOFF_MS shl exp, MAX_BACKOFF_MS)
        }

        /** Retry-After as delta-seconds or an HTTP-date; null when absent or unparseable. */
        fun parseRetryAfter(value: String?, nowMs: Long): Long? {
            val v = value?.trim()?.takeIf { it.isNotEmpty() } ?: return null
            v.toLongOrNull()?.let { return if (it >= 0) it * 1000 else null }
            return try {
                val format = SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss zzz", Locale.US)
                val at = format.parse(v)?.time ?: return null
                maxOf(0L, at - nowMs)
            } catch (e: Exception) {
                null
            }
        }
    }
}
