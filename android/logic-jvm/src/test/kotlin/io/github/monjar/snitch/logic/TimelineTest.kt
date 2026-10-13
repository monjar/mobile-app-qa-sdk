/*
 * The timeline encoding against contract/fixtures/timeline.ndjson (every valid
 * record survives decode → encode unchanged), JSON escaping, the contract's
 * field limits, and the 2 MB cap: oldest log lines go first.
 */
package io.github.monjar.snitch.logic

import org.json.JSONObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File

class TimelineTest {
    private val fixturesDir: File =
        File(System.getProperty("snitch.fixturesDir") ?: error("snitch.fixturesDir not set"))

    /** What a reader of the contract would build from one ndjson record. */
    private fun decode(o: JSONObject): TimelineEvent? {
        fun optLong(k: String) = if (o.has(k)) o.getLong(k) else null
        fun optString(k: String) = if (o.has(k)) o.getString(k) else null
        val t = o.optLong("t")
        return when (o.optString("k")) {
            "log" -> TimelineEvent.log(t, o.getString("level"), o.getString("src"), o.getString("msg"), optString("tag"))
            "net" -> TimelineEvent.net(
                t,
                o.getString("method"),
                o.getString("url"),
                if (o.has("status")) o.getInt("status") else null,
                if (o.has("ms")) o.getDouble("ms") else null,
                optLong("reqBytes"),
                optLong("resBytes"),
                optString("error"),
            )
            "screen" -> TimelineEvent.screen(t, o.getString("name"), o.getString("src"))
            "touch" -> TimelineEvent.touch(t, o.getDouble("x"), o.getDouble("y"), if (o.has("n")) o.getInt("n") else null)
            "app" -> TimelineEvent.app(t, o.getString("event"))
            else -> null
        }
    }

    private fun sameJson(want: JSONObject, got: JSONObject) {
        assertEquals(want.keySet(), got.keySet(), "keys of $got")
        for (k in want.keySet()) {
            val w = want.get(k)
            val g = got.get(k)
            if (w is Number && g is Number) assertEquals(w.toDouble(), g.toDouble(), 1e-9, k) else assertEquals(w, g, k)
        }
    }

    @Test
    fun `every valid fixture record encodes back to itself`() {
        val lines = File(fixturesDir, "timeline.ndjson").readLines().filter { it.isNotBlank() }
        var events = 0
        for (line in lines) {
            val o = try {
                JSONObject(line)
            } catch (e: Exception) {
                continue // the fixture's deliberately broken line
            }
            if (o.optString("k") == "meta") {
                val m = TimelineMeta(
                    platform = o.getString("platform"),
                    start = o.getLong("start"),
                    end = o.getLong("end"),
                    videoStart = o.getLong("videoStart"),
                    videoEnd = o.getLong("videoEnd"),
                    dropped = o.getInt("dropped"),
                )
                val encoded = JSONObject(TimelineNdjson.metaLine(m))
                o.remove("dropped") // 0 is the default and is omitted
                sameJson(o, encoded)
                continue
            }
            val e = decode(o) ?: continue // the fixture's future kind
            sameJson(o, JSONObject(TimelineNdjson.eventLine(e)))
            events++
        }
        assertEquals(10, events)
    }

    @Test
    fun `strings are escaped into valid JSON and UTF-8`() {
        val nasty = "quote \" backslash \\ newline \n tab \t nul \u0000 bell \u0007 sep   emoji 😀 lone \uD83D end"
        val line = TimelineNdjson.eventLine(TimelineEvent.log(1, "info", "app", nasty, "t\"ag"))
        assertFalse(line.contains('\n'))
        val parsed = JSONObject(line)
        assertEquals(nasty, parsed.getString("msg"))
        assertEquals("t\"ag", parsed.getString("tag"))
        val bytes = line.toByteArray(Charsets.UTF_8)
        assertEquals(TimelineNdjson.utf8Length(line), bytes.size)
        assertEquals(line, String(bytes, Charsets.UTF_8))
    }

    @Test
    fun `events are normalised to the contract's limits`() {
        val long = TimelineEvent.log(5, "verbose", "nowhere", "x".repeat(5000), "T".repeat(100))
        assertEquals("info", long.level)
        assertEquals("app", long.src)
        assertEquals(TimelineLimits.MSG_CHARS, long.msg.length)
        assertTrue(long.msg.endsWith("…"))
        assertEquals(TimelineLimits.TAG_CHARS, long.tag!!.length)

        // A cut never leaves half a surrogate pair behind.
        val emoji = "😀".repeat(1500)
        val cut = TimelineEvent.cut(emoji, TimelineLimits.MSG_CHARS)
        assertTrue(cut.length <= TimelineLimits.MSG_CHARS)
        assertFalse(cut[cut.length - 2].isHighSurrogate())

        val net = TimelineEvent.net(1, " post ", "https://u:p@API.example.com/x?token=abc#f", 42, -3.0, -1, 10, "  ")
        assertEquals("POST", net.method)
        assertEquals("https://api.example.com/x?token=*", net.url)
        assertNull(net.status)
        assertNull(net.ms)
        assertNull(net.reqBytes)
        assertEquals(10L, net.resBytes)
        assertNull(net.error)
        assertEquals(812.4, TimelineEvent.net(1, "GET", "https://a", 200, 812.4444, null, null, null).ms)

        val touch = TimelineEvent.touch(1, 1.7, -0.2, 40)
        assertEquals(1.0, touch.x)
        assertEquals(0.0, touch.y)
        assertNull(touch.n)
        assertEquals(0.1235, TimelineEvent.touch(1, 0.123456, 0.5, 2).x)

        assertNull(TimelineEvent.screen(1, "   ", "app"))
        assertEquals("native", TimelineEvent.screen(1, " Home ", "native")!!.src)
        assertEquals("Home", TimelineEvent.screen(1, " Home ", "native")!!.name)
        assertEquals(TimelineLimits.NAME_CHARS, TimelineEvent.screen(1, "n".repeat(300), "app")!!.name.length)
        assertNull(TimelineEvent.app(1, "crash"))
    }

    @Test
    fun `the file is a meta line then events in time order`() {
        val events = listOf(
            TimelineEvent.app(3000, "foreground")!!,
            TimelineEvent.log(1000, "info", "app", "first"),
            TimelineEvent.touch(2000, 0.5, 0.5, 1),
        )
        val out = TimelineNdjson.encode(TimelineMeta("android", 5000, 5000, videoStart = 4000, videoEnd = 6000, dropped = 2), events)
        val lines = out.text.trimEnd('\n').split('\n')
        assertEquals(4, lines.size)
        assertTrue(out.text.endsWith("\n"))
        val meta = JSONObject(lines[0])
        assertEquals("meta", meta.getString("k"))
        assertEquals(1, meta.getInt("v"))
        assertEquals("android", meta.getString("platform"))
        assertEquals(1000L, meta.getLong("start"))
        assertEquals(6000L, meta.getLong("end"))
        assertEquals(4000L, meta.getLong("videoStart"))
        assertEquals(6000L, meta.getLong("videoEnd"))
        assertEquals(2, meta.getInt("dropped"))
        assertEquals(listOf(1000L, 2000L, 3000L), lines.drop(1).map { JSONObject(it).getLong("t") })
        assertEquals(out.text.toByteArray(Charsets.UTF_8).size, out.byteCount)
        assertEquals(3, out.eventCount)
        assertEquals(0, out.trimmed)
    }

    @Test
    fun `an empty timeline is just the meta line`() {
        val out = TimelineNdjson.encode(TimelineMeta("android", 10, 10), emptyList())
        assertEquals("{\"k\":\"meta\",\"v\":1,\"platform\":\"android\",\"start\":10,\"end\":10}\n", out.text)
    }

    @Test
    fun `the size cap drops the oldest log lines first`() {
        val big = "é".repeat(1900) // 3800 bytes per message
        val logs = (0 until 600).map { TimelineEvent.log(10_000L + it, "info", "app", "$it $big") }
        val others = listOf(
            TimelineEvent.app(9_000, "launch")!!,
            TimelineEvent.net(9_500, "GET", "https://a.example/x", 200, 5.0, null, null, null),
            TimelineEvent.screen(9_600, "Home", "native")!!,
        )
        val out = TimelineNdjson.encode(TimelineMeta("android", 20_000, 20_000), logs + others, maxBytes = 1_000_000)
        assertTrue(out.byteCount <= 1_000_000, "${out.byteCount} bytes")
        val records = out.text.trimEnd('\n').split('\n').map { JSONObject(it) }
        val kept = records.drop(1)
        assertEquals(setOf("app", "net", "screen", "log"), kept.map { it.getString("k") }.toSet())
        val keptLogs = kept.filter { it.getString("k") == "log" }
        // The newest lines survive, contiguous up to the last one.
        assertEquals("599", keptLogs.last().getString("msg").substringBefore(' '))
        val first = keptLogs.first().getString("msg").substringBefore(' ').toInt()
        assertEquals(600 - first, keptLogs.size)
        assertEquals(600 - keptLogs.size, out.trimmed)
        assertEquals(out.trimmed, records[0].getInt("dropped"))
        // Close to the cap: one more line would not have fitted.
        assertTrue(out.byteCount > 1_000_000 - 4000)
    }

    @Test
    fun `without log lines the oldest events of any kind go`() {
        val events = (0 until 100).map { TimelineEvent.net(1000L + it, "GET", "https://a.example/" + "p".repeat(300), 200, 1.0, null, null, null) }
        val out = TimelineNdjson.encode(TimelineMeta("android", 5000, 5000), events, maxBytes = 10_000)
        assertTrue(out.byteCount <= 10_000)
        val kept = out.text.trimEnd('\n').split('\n').drop(1).map { JSONObject(it).getLong("t") }
        assertEquals(1099L, kept.last())
        assertEquals((1100L - kept.size until 1100L).toList(), kept)
    }
}
