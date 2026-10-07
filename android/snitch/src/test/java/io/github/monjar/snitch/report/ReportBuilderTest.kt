/*
 * ReportBuilder output vs the wire contract: the minimal Android report has
 * exactly the key set of contract/fixtures/report.create.android.json (nil
 * fields omitted, never null), a full report only uses keys the contract
 * defines (CaptureStats is strict), and invalid optional values are dropped
 * rather than risking a 422 that would delete the queued report.
 */
package io.github.monjar.snitch.report

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class ReportBuilderTest {
    private val contractDir = File(System.getProperty("snitch.contractDir") ?: "../../contract")

    private fun fixture(name: String) = JSONObject(File(contractDir, "fixtures/$name").readText())

    /** The fixture's report, rebuilt from SDK data classes. */
    private fun fixturePayload() = ReportPayload(
        clientReportId = "0b6f7a52-3c9e-4d8a-b1f2-7e6d5c4b3a29",
        type = "idea",
        description = "Would be nice to long-press a reminder to snooze it.",
        reporter = null,
        reportedAtMs = 1_791_378_164_000L,
        trigger = "api",
        app = AppInfo(id = "com.mochiro.app", name = null, version = "0.6.0", build = "15", releaseType = "internal"),
        device = DeviceSnapshot(osVersion = "15", model = "Pixel 8", manufacturer = "Google", locale = "en_US", network = "cellular"),
        sdk = SdkInfo("snitch-android", "0.1.0"),
        custom = null,
        stats = null,
        attachments = listOf(
            AttachmentDecl("screenshot", "image/png", 220114, "aa2c1d0e4b7a6f5e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e", 1080, 2400),
        ),
    )

    /** Recursive key paths, e.g. "device.model", "attachments[].sha256". */
    private fun keyPaths(value: Any?, prefix: String = ""): Set<String> = when (value) {
        is JSONObject -> value.keys().asSequence().flatMap { k ->
            val path = if (prefix.isEmpty()) k else "$prefix.$k"
            sequenceOf(path) + keyPaths(value.get(k), path).asSequence()
        }.toSet()
        is JSONArray -> (0 until value.length()).flatMap { keyPaths(value.get(it), "$prefix[]") }.toSet()
        else -> emptySet()
    }

    @Test
    fun `minimal report has exactly the fixture's key set`() {
        val built = ReportBuilder.toJson(fixturePayload())
        assertEquals(keyPaths(fixture("report.create.android.json")), keyPaths(built))
    }

    @Test
    fun `minimal report matches the fixture's values`() {
        val built = ReportBuilder.toJson(fixturePayload())
        val want = fixture("report.create.android.json")
        for (key in listOf("clientReportId", "type", "description", "trigger")) assertEquals(key, want.get(key), built.get(key))
        for (section in listOf("app", "device", "sdk")) {
            val w = want.getJSONObject(section)
            val b = built.getJSONObject(section)
            for (k in w.keys()) assertEquals("$section.$k", w.get(k).toString(), b.get(k).toString())
        }
        val wa = want.getJSONArray("attachments").getJSONObject(0)
        val ba = built.getJSONArray("attachments").getJSONObject(0)
        for (k in wa.keys()) assertEquals("attachments[0].$k", wa.get(k).toString(), ba.get(k).toString())
    }

    @Test
    fun `reportedAt is ISO-8601 UTC with milliseconds`() {
        val built = ReportBuilder.toJson(fixturePayload().copy(reportedAtMs = 1_791_378_164_120L))
        assertEquals("2026-10-07T13:02:44.120Z", built.getString("reportedAt"))
        assertTrue(Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$").matches(built.getString("reportedAt")))
    }

    @Test
    fun `absent optional fields are omitted, never null`() {
        val text = ReportBuilder.toJson(fixturePayload()).toString()
        assertFalse(text, text.contains("null"))
        assertFalse(text.contains("\"reporter\""))
        assertFalse(text.contains("\"custom\""))
        assertFalse(text.contains("\"stats\""))
    }

    @Test
    fun `a fully populated report only uses contract keys`() {
        val full = fixturePayload().copy(
            reporter = ReporterInfo(email = "tester@example.com", name = "Tess", id = "u-1"),
            app = AppInfo("com.mochiro.app", "Mochiro", "0.6.0", "15", "internal"),
            device = DeviceSnapshot(
                osVersion = "15",
                model = "Pixel 8",
                manufacturer = "Google",
                locale = "en_US",
                timeZone = "Europe/London",
                screen = ScreenInfo(411.4, 914.3, 2.625, "portrait"),
                memory = MemoryInfo(appMB = 212, freeMB = 3100, totalMB = 7800),
                thermal = "nominal",
                lowPower = false,
                battery = 0.82,
                charging = true,
                network = "wifi",
                darkMode = true,
                screenReader = false,
                fontScale = 1.0,
            ),
            sdk = SdkInfo("snitch-android", "0.1.0", "react-native", "0.1.0"),
            custom = mapOf("userTier" to "beta"),
            stats = StatsSnapshot(
                captureMode = "snapshot",
                captureMsP50 = 2.4,
                captureMsP95 = 6.0,
                effectiveFps = 1.4,
                ringBytes = 2_411_520,
                bufferedSeconds = 30.0,
                composeMs = 812.0,
                framesSkipped = 3,
                uptimeSec = 642.0,
                crashLoopDowngrades = 0,
                videoLost = true,
            ),
            attachments = listOf(
                AttachmentDecl("screenshot", "image/jpeg", 412833, "9f2c1d0e4b7a6f5e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e", 1080, 2400),
                AttachmentDecl("video", "video/mp4", 1288211, "0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7", 432, 960, 15000),
                AttachmentDecl("logs", "text/plain", 1200, "1e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7"),
            ),
        )
        val built = keyPaths(ReportBuilder.toJson(full))
        // The iOS fixture exercises every optional field; Android adds memory.freeMB and stats.videoLost.
        val allowed = keyPaths(fixture("report.create.ios.json")) + setOf("device.memory.freeMB", "stats.videoLost", "reporter.name", "reporter.id")
        assertEquals(emptySet<String>(), built - allowed)
        val stats = ReportBuilder.toJson(full).getJSONObject("stats").keys().asSequence().toSet()
        val captureStatsKeys = setOf(
            "captureMode", "snapshotRenderer", "captureMsP50", "captureMsP95", "effectiveFps", "ringBytes",
            "bufferedSeconds", "composeMs", "framesSkipped", "uptimeSec", "crashLoopDowngrades", "videoLost",
        )
        assertTrue(captureStatsKeys.containsAll(stats))
    }

    @Test
    fun `invalid optional values are dropped and long strings clamped`() {
        val p = fixturePayload().copy(
            type = "Not A Type!",
            description = "x".repeat(12_000),
            reporter = ReporterInfo(email = "not-an-email", name = null, id = null),
            custom = (1..60).associate { "key$it" to "v".repeat(2000) },
            device = DeviceSnapshot(osVersion = "15", model = "M".repeat(100), battery = 1.5, network = "5g"),
        )
        val o = ReportBuilder.toJson(p)
        assertEquals("other", o.getString("type"))
        assertEquals(10_000, o.getString("description").length)
        assertFalse(o.has("reporter"))
        assertEquals(50, o.getJSONObject("custom").length())
        assertEquals(1000, o.getJSONObject("custom").getString("key1").length)
        assertEquals(64, o.getJSONObject("device").getString("model").length)
        assertFalse(o.getJSONObject("device").has("battery"))
        assertFalse(o.getJSONObject("device").has("network"))
    }

    @Test
    fun `email validation follows the server`() {
        assertTrue(ReportBuilder.isValidEmail("tester@example.com"))
        assertTrue(ReportBuilder.isValidEmail("first.last+qa@sub.example.co.uk"))
        assertFalse(ReportBuilder.isValidEmail("tester@"))
        assertFalse(ReportBuilder.isValidEmail("a..b@example.com"))
        assertFalse(ReportBuilder.isValidEmail("tester@example"))
        assertFalse(ReportBuilder.isValidEmail(null))
    }

    @Test
    fun `duplicate attachment names are sent once`() {
        val a = fixturePayload().attachments.single()
        val o = ReportBuilder.toJson(fixturePayload().copy(attachments = listOf(a, a)))
        assertEquals(1, o.getJSONArray("attachments").length())
    }

    @Test
    fun `log text keeps the newest lines within the caps`() {
        val ring = (1..300).map { "line $it" }
        val text = LogRing.compose(ring, "provider 1\nprovider 2", maxLines = 200, maxBytes = 256 * 1024)!!
        val lines = text.trimEnd().lines()
        assertEquals(200, lines.size)
        assertEquals("provider 2", lines.last())
        assertNull(LogRing.compose(emptyList(), "  ", 200, 1024))
        val capped = LogRing.compose(List(100) { "y".repeat(100) }, null, 200, 1000)!!
        assertTrue(capped.toByteArray().size <= 1000)
    }
}
