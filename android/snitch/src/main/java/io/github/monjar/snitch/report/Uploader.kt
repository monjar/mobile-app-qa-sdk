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
 * Chunked, resumable attachments (spec §11.2): when the create response says
 * `upload.resumable`, a file larger than the chunk size (the server's
 * `chunkBytes`, clamped to 64 KiB…8 MiB; the SNITCH_DEBUG_CHUNK_BYTES hook can
 * lower it) goes as Content-Range PUTs of one chunk each, streamed straight from
 * that byte range of the file, with X-Content-SHA256 (the whole file, as
 * declared) and X-Chunk-SHA256 (this chunk). The server's offset per attachment
 * (`receivedBytes` from the create response, then from every 202) is saved in
 * state.json after each step, so an interrupted upload resumes where it stopped.
 *   - 202 → next chunk from the new offset; 201 → stored
 *   - 409 range_mismatch → continue from the server's offset (3 per pass, then back off)
 *   - 422 hash_mismatch with details.chunk → back off; the next pass resends the chunk
 *   - 422 hash_mismatch without it → the server discarded the file: start it again
 *     from 0; a second such failure drops the report
 *   - anything else → as above; a 404 restart clears the offsets
 * Older servers (no `upload` in the create response) get whole-file PUTs.
 *
 * Blocking HttpURLConnection on the caller's thread (the SDK's single I/O
 * thread) — no OkHttp. Pure JVM: endpoint, clock and logger are injected so the
 * whole machine is tested against a local HTTP server.
 */
package io.github.monjar.snitch.report

import io.github.monjar.snitch.logic.ChunkPlan
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.io.RandomAccessFile
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
    /** SNITCH_DEBUG_CHUNK_BYTES: an upper bound for the chunk size, or null. */
    private val chunkCap: () -> Long? = { null },
) {
    private class Response(val status: Int, val body: JSONObject?, val retryAfterMs: Long?) {
        val code: String? get() = body?.optJSONObject("error")?.optString("code")?.ifEmpty { null }
        val details: JSONObject? get() = body?.optJSONObject("error")?.optJSONObject("details")
    }

    private enum class Phase { CREATE, PUT, COMPLETE }

    /** A declared attachment, from report.json. */
    private class Declared(val name: String, val contentType: String, val sha256: String?)

    /** The request body: its length, extra headers, and how to write it. */
    private class Payload(val contentType: String, val length: Long, val headers: List<Pair<String, String>>, val write: (OutputStream) -> Unit)

    /** How one attachment's upload ended. */
    private sealed class PutResult {
        object Stored : PutResult()

        /** Step 1 again (the state has been reset). */
        object Restart : PutResult()

        class Done(val outcome: UploadOutcome) : PutResult()
    }

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
                val r = send(ep, "POST", "/reports", jsonPayload(reportText.toByteArray(Charsets.UTF_8)), timeoutMs)
                if (r.status == 200 || r.status == 201) {
                    val body = r.body
                    val reportId = body?.optString("reportId")?.ifEmpty { null } ?: return backoff(dir, state, r)
                    state.reportId = reportId
                    state.ticket = body.optString("ticket").ifEmpty { null }
                    state.uploaded.clear()
                    state.offsets.clear()
                    val upload = body.optJSONObject("upload")
                    state.resumable = upload?.optBoolean("resumable", false) == true
                    state.chunkBytes = if (state.resumable) ChunkPlan.chunkBytes(upload?.optLong("chunkBytes", 0), null) else 0
                    body.optJSONArray("attachments")?.let { arr ->
                        for (i in 0 until arr.length()) {
                            val a = arr.getJSONObject(i)
                            val name = a.getString("name")
                            if (a.optString("state") == "stored") {
                                state.uploaded.add(name)
                            } else if (state.resumable) {
                                a.optLong("receivedBytes", 0).takeIf { it > 0 }?.let { state.offsets[name] = it }
                            }
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
            for (a in declared) {
                if (a.name in state.uploaded) continue
                val file = File(dir, AttachmentDecl.fileNameFor(a.name, a.contentType))
                if (!file.isFile) {
                    logger.warn("upload: attachment ${a.name} of report $id is missing on disk; dropping the report")
                    outbox.delete(dir)
                    return UploadOutcome.Dropped(id, -1, null)
                }
                val sha = a.sha256 ?: Sha256.hex(file)
                val path = "/reports/$reportId/attachments/${a.name}"
                val size = file.length()
                val chunk = ChunkPlan.chunkBytes(state.chunkBytes.takeIf { it > 0 }, chunkCap())
                val result = if (ChunkPlan.isChunked(state.resumable, size, chunk)) {
                    putChunks(ep, dir, state, path, a, file, size, sha, chunk)
                } else {
                    putWhole(ep, dir, state, path, a, file, sha)
                }
                when (result) {
                    PutResult.Stored -> continue
                    PutResult.Restart -> {
                        restart = true
                        break
                    }
                    is PutResult.Done -> return result.outcome
                }
            }
            if (restart) {
                if (++restarts > 2) return backoff(dir, state, null)
                continue
            }

            // 3. Complete.
            val r = send(ep, "POST", "/reports/$reportId/complete", jsonPayload(ByteArray(0)), timeoutMs)
            if (r.status == 200 || r.status == 201) {
                outbox.delete(dir)
                return UploadOutcome.Sent(id, r.body?.optString("ticket")?.ifEmpty { null } ?: state.ticket)
            }
            if (r.status == 409 && r.code == "attachments_missing") {
                val missing = r.details?.optJSONArray("missing")
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

    /** One whole-file PUT (spec §7.3 step 2). */
    private fun putWhole(ep: Endpoint, dir: File, state: OutboxState, path: String, a: Declared, file: File, sha: String): PutResult {
        val payload = Payload(a.contentType, file.length(), listOf("X-Content-SHA256" to sha)) { out ->
            file.inputStream().use { it.copyTo(out, COPY_BUFFER) }
        }
        val r = send(ep, "PUT", path, payload, uploadTimeoutMs)
        if (r.status == 200 || r.status == 201) {
            stored(dir, state, a.name)
            return PutResult.Stored
        }
        return handleError(dir, state, r, Phase.PUT)?.let { PutResult.Done(it) } ?: PutResult.Restart
    }

    /** Content-Range chunks from the server's offset to the end (spec §11.2). */
    private fun putChunks(
        ep: Endpoint,
        dir: File,
        state: OutboxState,
        path: String,
        a: Declared,
        file: File,
        size: Long,
        sha: String,
        chunk: Long,
    ): PutResult {
        var mismatches = 0
        while (true) {
            val start = ChunkPlan.resumeAt(state.offsets[a.name], size)
            val end = ChunkPlan.endOf(start, size, chunk)
            val length = end - start + 1
            val headers = listOf(
                "Content-Range" to ChunkPlan.contentRange(start, end, size),
                "X-Content-SHA256" to sha,
                "X-Chunk-SHA256" to Sha256.hex(file, start, length),
            )
            val payload = Payload(a.contentType, length, headers) { out -> copyRange(file, start, length, out) }
            val r = send(ep, "PUT", path, payload, uploadTimeoutMs)
            when {
                r.status == 200 || r.status == 201 -> {
                    stored(dir, state, a.name)
                    return PutResult.Stored
                }
                r.status == 202 -> {
                    val received = r.body?.optLong("receivedBytes", -1)?.takeIf { it >= 0 } ?: (end + 1)
                    state.offsets[a.name] = received
                    outbox.writeState(dir, state)
                    // A server that doesn't move forward is treated like a range mismatch.
                    if (received <= start && ++mismatches > MAX_RANGE_MISMATCHES) return PutResult.Done(backoff(dir, state, r))
                }
                r.status == 409 && r.code == "range_mismatch" -> {
                    val received = r.details?.optLong("receivedBytes", -1) ?: -1
                    if (received >= 0) state.offsets[a.name] = received else state.offsets.remove(a.name)
                    outbox.writeState(dir, state)
                    logger.debug("upload: ${a.name} resumes at byte $received (server offset)")
                    if (++mismatches > MAX_RANGE_MISMATCHES) return PutResult.Done(backoff(dir, state, r))
                }
                r.status == 422 && r.code == "hash_mismatch" && r.details?.optBoolean("chunk", false) == true ->
                    return PutResult.Done(backoff(dir, state, r))
                r.status == 422 && r.code == "hash_mismatch" -> {
                    state.offsets.remove(a.name)
                    state.restarts += 1
                    if (state.restarts >= MAX_HASH_RESTARTS) {
                        logger.warn("upload: ${a.name} of report ${dir.name} failed verification twice; deleting the report")
                        outbox.delete(dir)
                        return PutResult.Done(UploadOutcome.Dropped(dir.name, r.status, r.code))
                    }
                    outbox.writeState(dir, state)
                    logger.debug("upload: ${a.name} failed verification; sending it again from byte 0")
                }
                else -> return handleError(dir, state, r, Phase.PUT)?.let { PutResult.Done(it) } ?: PutResult.Restart
            }
        }
    }

    private fun stored(dir: File, state: OutboxState, name: String) {
        state.uploaded.add(name)
        state.offsets.remove(name)
        outbox.writeState(dir, state)
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
                state.offsets.clear()
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

    private fun declaredAttachments(report: JSONObject): List<Declared> {
        val arr = report.optJSONArray("attachments") ?: return emptyList()
        return (0 until arr.length()).map {
            val a = arr.getJSONObject(it)
            Declared(a.getString("name"), a.getString("contentType"), a.optString("sha256").ifEmpty { null })
        }
    }

    private fun jsonPayload(bytes: ByteArray) = Payload("application/json", bytes.size.toLong(), emptyList()) { it.write(bytes) }

    private fun send(ep: Endpoint, method: String, path: String, payload: Payload, readTimeoutMs: Int): Response {
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
            conn.setRequestProperty("Content-Type", payload.contentType)
            for ((name, value) in payload.headers) conn.setRequestProperty(name, value)
            conn.doOutput = true
            conn.setFixedLengthStreamingMode(payload.length)
            conn.outputStream.use { payload.write(it) }
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
        private const val COPY_BUFFER = 64 * 1024
        private const val BASE_BACKOFF_MS = 30_000L
        private const val MAX_BACKOFF_MS = 60L * 60 * 1000
        private const val MAX_RETRY_AFTER_MS = 24L * 60 * 60 * 1000
        private const val MAX_RANGE_MISMATCHES = 3
        private const val MAX_HASH_RESTARTS = 2

        /** contract/src/ingest.ts#isRetryable. */
        fun isRetryable(status: Int, code: String?): Boolean {
            if (status == 429 || status >= 500 || status == 0) return true
            return code == "attachments_missing" || code == "range_mismatch"
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

        /** Writes [length] bytes of [file] from [start] to [out], never reading the rest of the file. */
        private fun copyRange(file: File, start: Long, length: Long, out: OutputStream) {
            RandomAccessFile(file, "r").use { raf ->
                raf.seek(start)
                val buffer = ByteArray(COPY_BUFFER)
                var remaining = length
                while (remaining > 0) {
                    val n = raf.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
                    if (n < 0) throw IOException("${file.name} ended $remaining bytes early")
                    out.write(buffer, 0, n)
                    remaining -= n
                }
            }
        }
    }
}
