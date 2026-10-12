/*
 * The upload state machine (spec §7.3) against a real local HTTP server
 * (TestHttpServer): create → PUT each attachment → complete, plus the
 * error paths — 409 attachments_missing, 401 drop, 5xx/429 backoff with
 * Retry-After, 404 restart, offline, and resuming from state.json.
 *
 * Chunked uploads (spec §11.2) run against FakeResumableServer, which keeps
 * the bytes it received per attachment and answers like the real server:
 * 202 with the new offset, 201 once the whole file verifies, 409
 * range_mismatch, 422 hash_mismatch with or without `chunk`.
 */
package io.github.monjar.snitch.report

import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList

class UploaderTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private class Recorded(val method: String, val path: String, val headers: Map<String, String>, val body: ByteArray)

    private class Reply(val status: Int, val body: String? = null, val headers: Map<String, String> = emptyMap())

    private val requests = CopyOnWriteArrayList<Recorded>()

    @Volatile
    private var respond: (Recorded) -> Reply = { Reply(500) }

    private lateinit var server: TestHttpServer
    private lateinit var outbox: Outbox
    private var now = 1_000_000L
    private val logger = object : SnitchLogger {
        override fun debug(message: String) = Unit

        override fun info(message: String) = Unit

        override fun warn(message: String, error: Throwable?) = Unit
    }

    private val screenshotBytes = ByteArray(2048) { (it % 251).toByte() }
    private val videoBytes = ByteArray(4096) { (it % 241).toByte() }

    @Before
    fun setUp() {
        server = TestHttpServer { req ->
            val rec = Recorded(req.method, req.path, req.headers, req.body)
            requests.add(rec)
            val reply = respond(rec)
            val bytes = reply.body?.toByteArray()
            val headers = if (bytes == null) reply.headers else reply.headers + ("Content-Type" to "application/json")
            TestHttpServer.Response(reply.status, headers, bytes)
        }
        outbox = Outbox(tmp.newFolder("outbox"), logger)
    }

    @After
    fun tearDown() {
        server.stop()
    }

    private fun uploader(base: String = "http://127.0.0.1:${server.port}", chunkCap: Long? = null) = Uploader(
        outbox = outbox,
        endpoint = { Endpoint(base, KEY, "android/0.1.0", "Snitch/0.1.0 (android)") },
        logger = logger,
        clock = { now },
        timeoutMs = 5_000,
        uploadTimeoutMs = 5_000,
        chunkCap = { chunkCap },
    )

    /** Queues a report with a screenshot and a video, as SnitchRuntime would. */
    private fun enqueue(id: String = "0b6f7a52-3c9e-4d8a-b1f2-7e6d5c4b3a29", videoBytes: ByteArray = this.videoBytes): File {
        val dir = outbox.newReportDir(id)
        File(dir, "screenshot.jpg").writeBytes(screenshotBytes)
        File(dir, "video.mp4").writeBytes(videoBytes)
        val payload = ReportPayload(
            clientReportId = id,
            type = "bug",
            description = "it broke",
            reporter = null,
            reportedAtMs = 1_790_000_000_000L,
            trigger = "gesture",
            app = AppInfo("com.example", null, "1.0", "1", "internal"),
            device = DeviceSnapshot(osVersion = "15", model = "Pixel 8"),
            sdk = SdkInfo("snitch-android", "0.1.0"),
            custom = null,
            stats = null,
            attachments = listOf(
                AttachmentDecl("screenshot", "image/jpeg", screenshotBytes.size.toLong(), Sha256.hex(screenshotBytes), 100, 200),
                AttachmentDecl("video", "video/mp4", videoBytes.size.toLong(), Sha256.hex(videoBytes), 96, 192, 5000),
            ),
        )
        outbox.commit(dir, ReportBuilder.toJson(payload).toString())
        return dir
    }

    private fun created(id: String, vararg stored: String) = Reply(
        201,
        JSONObject()
            .put("reportId", id)
            .put("ticket", "MOCH-42")
            .put("number", 42)
            .put("state", "pending")
            .put(
                "attachments",
                org.json.JSONArray().apply {
                    for (n in listOf("screenshot", "video")) put(JSONObject().put("name", n).put("state", if (n in stored) "stored" else "missing"))
                },
            ).toString(),
    )

    private fun stored(name: String, size: Int) =
        Reply(201, JSONObject().put("name", name).put("state", "stored").put("sizeBytes", size).toString())

    private fun completed(id: String) =
        Reply(200, JSONObject().put("reportId", id).put("ticket", "MOCH-42").put("state", "complete").toString())

    private fun error(status: Int, code: String, details: JSONObject? = null, headers: Map<String, String> = emptyMap()) = Reply(
        status,
        JSONObject().put("error", JSONObject().put("code", code).put("message", code).apply { if (details != null) put("details", details) }).toString(),
        headers,
    )

    /** A server that does everything right. */
    private fun happyServer(id: String = "R1"): (Recorded) -> Reply = { r ->
        when {
            r.method == "POST" && r.path == "/api/v1/reports" -> created(id)
            r.method == "PUT" && r.path.endsWith("/screenshot") -> stored("screenshot", r.body.size)
            r.method == "PUT" && r.path.endsWith("/video") -> stored("video", r.body.size)
            r.method == "POST" && r.path == "/api/v1/reports/$id/complete" -> completed(id)
            else -> Reply(500)
        }
    }

    private fun calls() = requests.map { "${it.method} ${it.path}" }

    @Test
    fun `create, put every attachment, complete, then delete`() {
        val dir = enqueue()
        respond = happyServer()

        val run = uploader().runOnce()

        assertEquals(
            listOf(
                "POST /api/v1/reports",
                "PUT /api/v1/reports/R1/attachments/screenshot",
                "PUT /api/v1/reports/R1/attachments/video",
                "POST /api/v1/reports/R1/complete",
            ),
            calls(),
        )
        assertEquals(listOf<UploadOutcome>(UploadOutcome.Sent(dir.name, "MOCH-42")), run.outcomes)
        assertNull(run.nextAttemptAt)
        assertFalse(dir.exists())
        assertTrue(outbox.isEmpty())
    }

    @Test
    fun `requests carry the contract headers and bodies`() {
        val dir = enqueue()
        val reportJson = File(dir, Outbox.REPORT).readText()
        respond = happyServer()

        uploader().runOnce()

        for (r in requests) {
            assertEquals(KEY, r.headers["x-snitch-key"])
            assertEquals("android/0.1.0", r.headers["x-snitch-sdk"])
            assertEquals("Snitch/0.1.0 (android)", r.headers["user-agent"])
        }
        val create = requests[0]
        assertEquals("application/json", create.headers["content-type"])
        assertEquals(reportJson, String(create.body, Charsets.UTF_8))
        val shot = requests[1]
        assertEquals("image/jpeg", shot.headers["content-type"])
        assertEquals(screenshotBytes.size.toString(), shot.headers["content-length"])
        assertEquals(Sha256.hex(screenshotBytes), shot.headers["x-content-sha256"])
        assertArrayEquals(screenshotBytes, shot.body)
        val video = requests[2]
        assertEquals("video/mp4", video.headers["content-type"])
        assertEquals(Sha256.hex(videoBytes), video.headers["x-content-sha256"])
        assertArrayEquals(videoBytes, video.body)
    }

    @Test
    fun `attachments the server already stored are not uploaded again`() {
        enqueue()
        val base = happyServer()
        respond = { r -> if (r.method == "POST" && r.path == "/api/v1/reports") created("R1", "screenshot") else base(r) }

        uploader().runOnce()

        assertEquals(listOf("POST /api/v1/reports", "PUT /api/v1/reports/R1/attachments/video", "POST /api/v1/reports/R1/complete"), calls())
    }

    @Test
    fun `409 attachments_missing on complete re-uploads what the server lacks`() {
        val dir = enqueue()
        val base = happyServer()
        var completes = 0
        respond = { r ->
            if (r.path.endsWith("/complete") && completes++ == 0) {
                error(409, "attachments_missing", JSONObject().put("missing", org.json.JSONArray().put("video")))
            } else {
                base(r)
            }
        }

        val run = uploader().runOnce()

        assertEquals(
            listOf(
                "POST /api/v1/reports",
                "PUT /api/v1/reports/R1/attachments/screenshot",
                "PUT /api/v1/reports/R1/attachments/video",
                "POST /api/v1/reports/R1/complete",
                "PUT /api/v1/reports/R1/attachments/video",
                "POST /api/v1/reports/R1/complete",
            ),
            calls(),
        )
        assertEquals(UploadOutcome.Sent(dir.name, "MOCH-42"), run.outcomes.single())
        assertTrue(outbox.isEmpty())
    }

    @Test
    fun `401 drops the report without retrying`() {
        val dir = enqueue()
        respond = { error(401, "unauthorized") }

        val run = uploader().runOnce()

        assertEquals(listOf("POST /api/v1/reports"), calls())
        // Status only: in streaming mode the JDK's HttpURLConnection hides 401 bodies (Android's doesn't).
        val dropped = run.outcomes.single() as UploadOutcome.Dropped
        assertEquals(dir.name, dropped.clientReportId)
        assertEquals(401, dropped.status)
        assertNull(run.nextAttemptAt)
        assertTrue(outbox.isEmpty())
    }

    @Test
    fun `422 and 413 drop too`() {
        for ((status, code) in listOf(422 to "invalid_request", 413 to "payload_too_large", 403 to "forbidden", 415 to "unsupported_media_type")) {
            requests.clear()
            enqueue()
            respond = { error(status, code) }
            val run = uploader().runOnce()
            assertTrue("HTTP $status", run.outcomes.single() is UploadOutcome.Dropped)
            assertTrue(outbox.isEmpty())
        }
    }

    @Test
    fun `503 backs off exponentially and keeps the report`() {
        val dir = enqueue()
        respond = { error(503, "internal") }
        val up = uploader()

        val first = up.runOnce()
        val d1 = first.outcomes.single() as UploadOutcome.Deferred
        assertEquals(now + 30_000, d1.nextAttemptAt)
        assertFalse(d1.offline)
        assertEquals(1, outbox.readState(dir).attempts)
        assertEquals(now + 30_000, first.nextAttemptAt)

        // Not due yet: nothing is sent.
        requests.clear()
        val idle = up.runOnce()
        assertTrue(idle.outcomes.isEmpty())
        assertTrue(requests.isEmpty())
        assertEquals(now + 30_000, idle.nextAttemptAt)

        now += 30_000
        val second = up.runOnce().outcomes.single() as UploadOutcome.Deferred
        assertEquals(now + 60_000, second.nextAttemptAt)
        assertEquals(2, outbox.readState(dir).attempts)

        now += 60_000
        respond = happyServer()
        assertEquals(UploadOutcome.Sent(dir.name, "MOCH-42"), up.runOnce().outcomes.single())
        assertTrue(outbox.isEmpty())
    }

    @Test
    fun `Retry-After overrides the backoff`() {
        val dir = enqueue()
        respond = { error(429, "rate_limited", headers = mapOf("Retry-After" to "120")) }

        val d = uploader().runOnce().outcomes.single() as UploadOutcome.Deferred

        assertEquals(now + 120_000, d.nextAttemptAt)
        assertEquals(1, outbox.readState(dir).attempts)
    }

    @Test
    fun `a 5xx during upload resumes from state on the next run`() {
        val dir = enqueue()
        val base = happyServer()
        respond = { r -> if (r.path.endsWith("/video")) Reply(502) else base(r) }
        uploader().runOnce()
        val state = outbox.readState(dir)
        assertEquals("R1", state.reportId)
        assertEquals(setOf("screenshot"), state.uploaded)

        // A fresh uploader (app restart) resumes at the video PUT: no second create.
        requests.clear()
        now += 30_000
        respond = base
        val run = uploader().runOnce()
        assertEquals(listOf("PUT /api/v1/reports/R1/attachments/video", "POST /api/v1/reports/R1/complete"), calls())
        assertEquals(UploadOutcome.Sent(dir.name, "MOCH-42"), run.outcomes.single())
    }

    @Test
    fun `404 on an attachment restarts at create`() {
        enqueue()
        var creates = 0
        respond = { r ->
            when {
                r.method == "POST" && r.path == "/api/v1/reports" -> created(if (creates++ == 0) "OLD" else "NEW")
                r.path.startsWith("/api/v1/reports/OLD/") -> error(404, "not_found")
                else -> happyServer("NEW")(r)
            }
        }

        val run = uploader().runOnce()

        assertEquals(
            listOf(
                "POST /api/v1/reports",
                "PUT /api/v1/reports/OLD/attachments/screenshot",
                "POST /api/v1/reports",
                "PUT /api/v1/reports/NEW/attachments/screenshot",
                "PUT /api/v1/reports/NEW/attachments/video",
                "POST /api/v1/reports/NEW/complete",
            ),
            calls(),
        )
        assertTrue(run.outcomes.single() is UploadOutcome.Sent)
    }

    @Test
    fun `409 report_completed counts as done`() {
        enqueue()
        val base = happyServer()
        respond = { r -> if (r.path.endsWith("/complete")) error(409, "report_completed") else base(r) }

        val run = uploader().runOnce()

        assertTrue(run.outcomes.single() is UploadOutcome.Sent)
        assertTrue(outbox.isEmpty())
    }

    @Test
    fun `network errors defer as offline`() {
        val dir = enqueue()
        server.stop()

        val d = uploader().runOnce().outcomes.single() as UploadOutcome.Deferred

        assertTrue(d.offline)
        assertEquals(now + 30_000, d.nextAttemptAt)
        assertEquals(1, outbox.readState(dir).attempts)
        assertFalse(outbox.isEmpty())
    }

    @Test
    fun `reports go one at a time, oldest first`() {
        val a = enqueue("00000000-0000-4000-8000-00000000000a")
        File(a, Outbox.REPORT).setLastModified(1_000)
        val b = enqueue("00000000-0000-4000-8000-00000000000b")
        File(b, Outbox.REPORT).setLastModified(2_000)
        respond = happyServer()

        val run = uploader().runOnce()

        assertEquals(listOf(a.name, b.name), run.outcomes.map { it.clientReportId })
        assertEquals(8, requests.size)
    }

    @Test
    fun `backoff and Retry-After parsing`() {
        assertEquals(30_000L, Uploader.backoffMs(1))
        assertEquals(60_000L, Uploader.backoffMs(2))
        assertEquals(120_000L, Uploader.backoffMs(3))
        assertEquals(3_600_000L, Uploader.backoffMs(8))
        assertEquals(3_600_000L, Uploader.backoffMs(100))
        assertEquals(5_000L, Uploader.parseRetryAfter("5", 0))
        assertNull(Uploader.parseRetryAfter("soon", 0))
        assertNull(Uploader.parseRetryAfter(null, 0))
        val at = Uploader.parseRetryAfter("Thu, 01 Jan 1970 00:02:00 GMT", 60_000)
        assertEquals(60_000L, at)
        assertTrue(Uploader.isRetryable(0, null))
        assertTrue(Uploader.isRetryable(429, "rate_limited"))
        assertTrue(Uploader.isRetryable(503, null))
        assertTrue(Uploader.isRetryable(409, "attachments_missing"))
        assertTrue(Uploader.isRetryable(409, "range_mismatch"))
        assertFalse(Uploader.isRetryable(409, "report_completed"))
        assertFalse(Uploader.isRetryable(401, "unauthorized"))
    }

    @Test
    fun `outbox caps evict the oldest report`() {
        val small = Outbox(tmp.newFolder("capped"), logger, maxReports = 2)
        val dirs = (1..3).map { i ->
            val dir = small.newReportDir("id-$i")
            File(dir, "logs.txt").writeText("x")
            small.commit(dir, "{}")
            File(dir, Outbox.REPORT).setLastModified(i * 1000L)
            dir
        }
        small.enforceCaps()
        assertEquals(listOf(dirs[1].name, dirs[2].name), small.eligible().map { it.name })
    }

    // ── Chunked, resumable uploads (spec §11.2) ─────────────────────────────

    /** 200 000 bytes: three 64 KiB chunks and a 3 392-byte tail. */
    private val bigVideo = ByteArray(200_000) { (it * 31 % 253).toByte() }

    /**
     * A server that takes Content-Range chunks the way the real one does. [hooks]
     * can answer a PUT differently (return null to fall through).
     */
    private inner class FakeResumableServer(
        val chunkBytes: Long = 65_536,
        val id: String = "R1",
        val resumable: Boolean = true,
    ) {
        val received = HashMap<String, ByteArrayOutputStream>()
        var hooks: (Recorded) -> Reply? = { null }
        val creates get() = requests.count { it.method == "POST" && it.path == "/api/v1/reports" }

        fun bytesOf(name: String): ByteArray = received[name]?.toByteArray() ?: ByteArray(0)

        fun handle(r: Recorded): Reply {
            hooks(r)?.let { return it }
            return when {
                r.method == "POST" && r.path == "/api/v1/reports" -> {
                    val body = JSONObject()
                        .put("reportId", id)
                        .put("ticket", "MOCH-42")
                        .put("number", 42)
                        .put("state", "pending")
                        .put(
                            "attachments",
                            org.json.JSONArray().apply {
                                for (n in listOf("screenshot", "video")) {
                                    put(JSONObject().put("name", n).put("state", "missing").put("receivedBytes", bytesOf(n).size))
                                }
                            },
                        )
                    if (resumable) body.put("upload", JSONObject().put("resumable", true).put("chunkBytes", chunkBytes))
                    Reply(201, body.toString())
                }
                r.method == "PUT" && r.path.startsWith("/api/v1/reports/$id/attachments/") -> put(r, r.path.substringAfterLast('/'))
                r.method == "POST" && r.path == "/api/v1/reports/$id/complete" -> completed(id)
                else -> error(404, "not_found")
            }
        }

        private fun put(r: Recorded, name: String): Reply {
            val range = r.headers["content-range"] ?: run {
                received[name] = ByteArrayOutputStream().apply { write(r.body) }
                return stored(name, r.body.size)
            }
            val m = Regex("^bytes (\\d+)-(\\d+)/(\\d+)$").find(range)!!.groupValues
            val start = m[1].toInt()
            val total = m[3].toInt()
            val buf = received.getOrPut(name) { ByteArrayOutputStream() }
            if (start != buf.size()) return error(409, "range_mismatch", JSONObject().put("receivedBytes", buf.size()))
            if (r.headers["x-chunk-sha256"] != Sha256.hex(r.body)) return error(422, "hash_mismatch", JSONObject().put("chunk", true))
            buf.write(r.body)
            if (buf.size() < total) return Reply(202, JSONObject().put("name", name).put("state", "partial").put("receivedBytes", buf.size()).toString())
            if (Sha256.hex(buf.toByteArray()) != r.headers["x-content-sha256"]) {
                received.remove(name)
                return error(422, "hash_mismatch")
            }
            return stored(name, total)
        }
    }

    private fun puts(name: String) = requests.filter { it.method == "PUT" && it.path.endsWith("/$name") }

    @Test
    fun `a resumable server gets large attachments in chunks`() {
        val dir = enqueue(videoBytes = bigVideo)
        val fake = FakeResumableServer()
        respond = fake::handle

        val run = uploader().runOnce()

        assertEquals(UploadOutcome.Sent(dir.name, "MOCH-42"), run.outcomes.single())
        assertTrue(outbox.isEmpty())
        // The small screenshot goes whole, without Content-Range.
        val shot = puts("screenshot").single()
        assertNull(shot.headers["content-range"])
        assertArrayEquals(screenshotBytes, shot.body)
        // The video: three full chunks and the tail, each with its own hash.
        val chunks = puts("video")
        assertEquals(
            listOf("bytes 0-65535/200000", "bytes 65536-131071/200000", "bytes 131072-196607/200000", "bytes 196608-199999/200000"),
            chunks.map { it.headers["content-range"] },
        )
        assertEquals(listOf("65536", "65536", "65536", "3392"), chunks.map { it.headers["content-length"] })
        for (c in chunks) {
            assertEquals(Sha256.hex(bigVideo), c.headers["x-content-sha256"])
            assertEquals(Sha256.hex(c.body), c.headers["x-chunk-sha256"])
            assertEquals("video/mp4", c.headers["content-type"])
        }
        assertArrayEquals(bigVideo, fake.bytesOf("video"))
    }

    @Test
    fun `the chunk size follows the server within bounds and the debug cap lowers it`() {
        enqueue(videoBytes = bigVideo)
        respond = FakeResumableServer(chunkBytes = 1)::handle
        uploader().runOnce()
        assertEquals(4, puts("video").size) // clamped up to 64 KiB

        requests.clear()
        enqueue(videoBytes = bigVideo)
        respond = FakeResumableServer(chunkBytes = 150_000)::handle
        uploader(chunkCap = 70_000).runOnce()
        assertEquals(listOf("bytes 0-69999/200000", "bytes 70000-139999/200000", "bytes 140000-199999/200000"), puts("video").map { it.headers["content-range"] })

        requests.clear()
        enqueue(videoBytes = bigVideo)
        respond = FakeResumableServer(chunkBytes = 150_000)::handle
        uploader(chunkCap = 1).runOnce()
        assertEquals(4, puts("video").size) // the cap never goes below 64 KiB

        requests.clear()
        enqueue(videoBytes = bigVideo)
        respond = FakeResumableServer(chunkBytes = 100L * 1024 * 1024)::handle
        uploader().runOnce()
        assertNull(puts("video").single().headers["content-range"]) // 8 MiB chunks: one whole-file PUT
        assertTrue(outbox.isEmpty())
    }

    @Test
    fun `a server without resumable upload gets whole files`() {
        enqueue(videoBytes = bigVideo)
        val fake = FakeResumableServer(resumable = false)
        respond = fake::handle

        assertTrue(uploader().runOnce().outcomes.single() is UploadOutcome.Sent)

        val video = puts("video").single()
        assertNull(video.headers["content-range"])
        assertNull(video.headers["x-chunk-sha256"])
        assertEquals("200000", video.headers["content-length"])
        assertArrayEquals(bigVideo, fake.bytesOf("video"))
    }

    @Test
    fun `offsets are saved after every chunk and an interrupted upload resumes there`() {
        val dir = enqueue(videoBytes = bigVideo)
        val fake = FakeResumableServer()
        fake.hooks = { r -> if (r.headers["content-range"]?.startsWith("bytes 131072-") == true) Reply(503) else null }
        respond = fake::handle

        val first = uploader().runOnce().outcomes.single()
        assertTrue(first is UploadOutcome.Deferred)
        val state = outbox.readState(dir)
        assertTrue(state.resumable)
        assertEquals(65_536L, state.chunkBytes)
        assertEquals(mapOf("video" to 131_072L), state.offsets)
        assertEquals(setOf("screenshot"), state.uploaded)

        // An app restart: a new uploader picks up at byte 131 072, without a second create.
        requests.clear()
        now += 30_000
        fake.hooks = { null }
        val run = uploader().runOnce()
        assertEquals(UploadOutcome.Sent(dir.name, "MOCH-42"), run.outcomes.single())
        assertEquals(listOf("bytes 131072-196607/200000", "bytes 196608-199999/200000"), puts("video").map { it.headers["content-range"] })
        assertEquals(0, fake.creates)
        assertArrayEquals(bigVideo, fake.bytesOf("video"))
    }

    @Test
    fun `the create response's receivedBytes resumes a lost offset`() {
        enqueue(videoBytes = bigVideo)
        val fake = FakeResumableServer()
        fake.received["video"] = ByteArrayOutputStream().apply { write(bigVideo, 0, 65_536) }
        respond = fake::handle

        assertTrue(uploader().runOnce().outcomes.single() is UploadOutcome.Sent)

        assertEquals("bytes 65536-131071/200000", puts("video").first().headers["content-range"])
        assertArrayEquals(bigVideo, fake.bytesOf("video"))
    }

    @Test
    fun `409 range_mismatch continues from the server's offset`() {
        val dir = enqueue(videoBytes = bigVideo)
        val fake = FakeResumableServer()
        respond = fake::handle
        // The client thinks the server has nothing of the video; the server has two chunks.
        val state = OutboxState(reportId = "R1", ticket = "MOCH-42", resumable = true, chunkBytes = 65_536)
        state.uploaded.add("screenshot")
        outbox.writeState(dir, state)
        fake.received["video"] = ByteArrayOutputStream().apply { write(bigVideo, 0, 131_072) }

        assertTrue(uploader().runOnce().outcomes.single() is UploadOutcome.Sent)

        assertEquals(
            listOf("bytes 0-65535/200000", "bytes 131072-196607/200000", "bytes 196608-199999/200000"),
            puts("video").map { it.headers["content-range"] },
        )
        assertArrayEquals(bigVideo, fake.bytesOf("video"))
    }

    @Test
    fun `more than three range mismatches in a pass back off`() {
        val dir = enqueue(videoBytes = bigVideo)
        val fake = FakeResumableServer()
        var offset = 0
        fake.hooks = { r ->
            if (r.headers["content-range"] != null) {
                offset = (offset + 7) % 1000 // a server that keeps moving its offset
                error(409, "range_mismatch", JSONObject().put("receivedBytes", offset))
            } else {
                null
            }
        }
        respond = fake::handle

        val d = uploader().runOnce().outcomes.single() as UploadOutcome.Deferred

        assertEquals(4, puts("video").size)
        assertEquals(now + 30_000, d.nextAttemptAt)
        assertEquals(28L, outbox.readState(dir).offsets["video"])
    }

    @Test
    fun `a chunk that fails its hash backs off and is sent again next pass`() {
        val dir = enqueue(videoBytes = bigVideo)
        val fake = FakeResumableServer()
        var corrupted = false
        fake.hooks = { r ->
            if (!corrupted && r.headers["content-range"]?.startsWith("bytes 65536-") == true) {
                corrupted = true
                error(422, "hash_mismatch", JSONObject().put("chunk", true))
            } else {
                null
            }
        }
        respond = fake::handle

        val d = uploader().runOnce().outcomes.single()
        assertTrue(d is UploadOutcome.Deferred)
        assertEquals(65_536L, outbox.readState(dir).offsets["video"])
        assertFalse(outbox.isEmpty())

        requests.clear()
        now += 30_000
        assertTrue(uploader().runOnce().outcomes.single() is UploadOutcome.Sent)
        assertEquals("bytes 65536-131071/200000", puts("video").first().headers["content-range"])
        assertArrayEquals(bigVideo, fake.bytesOf("video"))
    }

    @Test
    fun `a whole-file hash failure starts the file again, a second one drops the report`() {
        val dir = enqueue(videoBytes = bigVideo)
        val fake = FakeResumableServer()
        var failures = 1
        fake.hooks = { r ->
            if (failures > 0 && r.headers["content-range"]?.startsWith("bytes 196608-") == true) {
                failures--
                fake.received.remove("video")
                error(422, "hash_mismatch")
            } else {
                null
            }
        }
        respond = fake::handle

        assertEquals(UploadOutcome.Sent(dir.name, "MOCH-42"), uploader().runOnce().outcomes.single())
        assertEquals(8, puts("video").size) // four chunks, then all four again
        assertEquals("bytes 0-65535/200000", puts("video")[4].headers["content-range"])
        assertArrayEquals(bigVideo, fake.bytesOf("video"))

        requests.clear()
        val again = enqueue(videoBytes = bigVideo)
        val bad = FakeResumableServer()
        bad.hooks = { r ->
            if (r.headers["content-range"]?.startsWith("bytes 196608-") == true) {
                bad.received.remove("video")
                error(422, "hash_mismatch")
            } else {
                null
            }
        }
        respond = bad::handle
        val dropped = uploader().runOnce().outcomes.single() as UploadOutcome.Dropped
        assertEquals(again.name, dropped.clientReportId)
        assertEquals(422, dropped.status)
        assertTrue(outbox.isEmpty())
    }

    @Test
    fun `a 404 restart clears the offsets`() {
        val dir = enqueue(videoBytes = bigVideo)
        val fake = FakeResumableServer(id = "NEW")
        val state = OutboxState(reportId = "OLD", ticket = "MOCH-1", resumable = true, chunkBytes = 65_536)
        state.offsets["video"] = 131_072
        state.uploaded.add("screenshot")
        outbox.writeState(dir, state)
        fake.hooks = { r -> if (r.path.startsWith("/api/v1/reports/OLD/")) error(404, "not_found") else null }
        respond = fake::handle

        assertTrue(uploader().runOnce().outcomes.single() is UploadOutcome.Sent)

        assertEquals("bytes 131072-196607/200000", puts("video").first().headers["content-range"])
        val afterRestart = requests.dropWhile { !(it.method == "POST" && it.path == "/api/v1/reports") }
        assertEquals("bytes 0-65535/200000", afterRestart.first { it.path.endsWith("/video") }.headers["content-range"])
        assertArrayEquals(bigVideo, fake.bytesOf("video"))
    }

    @Test
    fun `state files written before chunked uploads still load and upload whole files`() {
        val dir = enqueue(videoBytes = bigVideo)
        File(dir, Outbox.STATE).writeText("""{"reportId":"R1","ticket":"MOCH-42","attempts":2,"nextAttemptAt":0,"uploaded":["screenshot"]}""")
        val loaded = outbox.readState(dir)
        assertEquals(2, loaded.attempts)
        assertFalse(loaded.resumable)
        assertEquals(0L, loaded.chunkBytes)
        assertTrue(loaded.offsets.isEmpty())
        assertEquals(0, loaded.restarts)
        respond = FakeResumableServer()::handle

        assertTrue(uploader().runOnce().outcomes.single() is UploadOutcome.Sent)
        assertNull(puts("video").single().headers["content-range"])
    }

    @Test
    fun `outbox state round-trips the resumable fields`() {
        val s = OutboxState(reportId = "R", ticket = "T", attempts = 3, nextAttemptAt = 9, resumable = true, chunkBytes = 65_536, restarts = 1)
        s.uploaded.add("screenshot")
        s.offsets["video"] = 131_072
        val back = OutboxState.fromJson(JSONObject(s.toJson().toString()))
        assertEquals("R", back.reportId)
        assertEquals(setOf("screenshot"), back.uploaded)
        assertTrue(back.resumable)
        assertEquals(65_536L, back.chunkBytes)
        assertEquals(mapOf("video" to 131_072L), back.offsets)
        assertEquals(1, back.restarts)
    }

    companion object {
        private const val KEY = "snitch_pk_0123456789ABCDEFGHJKMNPQRS"
    }
}
