/*
 * Runs the SDK's pure logic against every shared vector in contract/vectors —
 * the same files the TypeScript reference (contract/test/vectors.test.ts) and
 * the Swift SDK are tested with. One dynamic test per vector case.
 */
package io.github.monjar.snitch.logic

import org.json.JSONArray
import org.json.JSONObject
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.DynamicTest.dynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import java.io.File
import kotlin.math.abs

class VectorsTest {
    private val vectorsDir: File =
        File(System.getProperty("snitch.vectorsDir") ?: error("snitch.vectorsDir not set"))

    private fun load(name: String): JSONObject = JSONObject(File(vectorsDir, name).readText())

    private fun JSONArray.objects(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }

    private fun JSONArray.longs(): LongArray = LongArray(length()) { getLong(it) }

    private fun JSONArray.ints(): IntArray = IntArray(length()) { getInt(it) }

    @Test
    fun `every vector file is covered`() {
        val files = vectorsDir.listFiles { f -> f.extension == "json" }!!.map { it.name }.toSet()
        assertEquals(setOf("gesture.json", "governor.json", "ring.json", "compose.json", "release-type.json"), files)
    }

    @TestFactory
    fun gesture(): List<DynamicTest> {
        val v = load("gesture.json")
        val defaults = v.getJSONObject("defaults")
        return v.getJSONArray("cases").objects().map { c ->
            dynamicTest("gesture: ${c.getString("name")}") {
                val cfg = c.optJSONObject("config") ?: JSONObject()
                fun num(key: String) = if (cfg.has(key)) cfg.getDouble(key) else defaults.getDouble(key)
                val config = DetectorConfig(
                    pointers = num("pointers").toInt(),
                    landingWindowMs = num("landingWindowMs").toLong(),
                    holdMs = num("holdMs").toLong(),
                    slop = num("slop"),
                    cooldownMs = num("cooldownMs").toLong(),
                    enabled = if (cfg.has("enabled")) cfg.getBoolean("enabled") else defaults.getBoolean("enabled"),
                )
                val d = ThreeFingerHoldDetector(config)
                val fires = ArrayList<Long>()
                for (e in c.getJSONArray("events").objects()) {
                    val t = e.getLong("t")
                    val type = when (val s = e.getString("type")) {
                        "down" -> DetectorEvent.Type.DOWN
                        "move" -> DetectorEvent.Type.MOVE
                        "up" -> DetectorEvent.Type.UP
                        "cancel" -> DetectorEvent.Type.CANCEL
                        "tick" -> DetectorEvent.Type.TICK
                        else -> error("unknown event type $s")
                    }
                    val event = if (type == DetectorEvent.Type.TICK) {
                        DetectorEvent.tick(t)
                    } else {
                        DetectorEvent(t, type, e.getInt("id"), e.getDouble("x"), e.getDouble("y"))
                    }
                    if (d.handle(event)) fires.add(t)
                }
                assertEquals(c.getJSONArray("fires").longs().toList(), fires)
            }
        }
    }

    @TestFactory
    fun governor(): List<DynamicTest> {
        val v = load("governor.json")
        val defaults = v.getJSONObject("defaults")
        val cases = v.getJSONArray("cases").objects().map { c ->
            dynamicTest("governor: ${c.getString("name")}") {
                val cfg = c.optJSONObject("config") ?: JSONObject()
                fun num(key: String) = if (cfg.has(key)) cfg.getDouble(key) else defaults.getDouble(key)
                val config = GovernorConfig(
                    idleFps = num("idleFps"),
                    activeFps = num("activeFps"),
                    budgetPct = num("budgetPct"),
                    activeWindowMs = num("activeWindowMs").toLong(),
                )
                val i = c.getJSONObject("input")
                val input = GovernorInput(
                    now = i.getLong("now"),
                    lastTouchAt = if (i.isNull("lastTouchAt")) null else i.getLong("lastTouchAt"),
                    avgCostMs = i.getDouble("avgCostMs"),
                    lowPower = i.getBoolean("lowPower"),
                    thermal = ThermalState.valueOf(i.getString("thermal").uppercase()),
                    paused = i.getBoolean("paused"),
                )
                val expected = if (c.isNull("delayMs")) null else c.getLong("delayMs")
                assertEquals(expected, CaptureGovernor.nextCaptureDelayMs(config, input))
            }
        }
        val ewma = v.getJSONObject("ewma")
        return cases + dynamicTest("governor: ewma") {
            var avg: Double? = null
            val samples = ewma.getJSONArray("samples")
            val expect = ewma.getJSONArray("expect")
            assertEquals(samples.length(), expect.length())
            for (k in 0 until samples.length()) {
                val next = CaptureGovernor.updateAverageCost(avg, samples.getDouble(k))
                avg = next
                assertTrue(abs(next - expect.getDouble(k)) < 1e-9, "sample $k: got $next, want ${expect.getDouble(k)}")
            }
        }
    }

    private class TestFrame(override val t: Long, override val size: Int, override val checksum: String) : RingFrame

    @TestFactory
    fun ring(): List<DynamicTest> {
        val v = load("ring.json")
        return v.getJSONArray("cases").objects().map { c ->
            dynamicTest("ring: ${c.getString("name")}") {
                val ring = FrameRing<TestFrame>(c.getLong("maxBytes"), c.getLong("maxAgeMs"))
                for (op in c.getJSONArray("ops").objects()) {
                    when (val name = op.getString("op")) {
                        "push" -> ring.push(TestFrame(op.getLong("t"), op.getInt("size"), op.getString("checksum")))
                        "expect" -> {
                            assertEquals(op.getJSONArray("ts").longs().toList(), ring.frames.map { it.t })
                            assertEquals(op.getLong("totalBytes"), ring.totalBytes)
                        }
                        "select" -> assertEquals(
                            op.getJSONArray("ts").longs().toList(),
                            ring.select(op.getLong("endT"), op.getLong("durationMs")).map { it.t },
                        )
                        "trimHalf" -> ring.trimHalf()
                        "buffered" -> assertEquals(op.getLong("ms"), ring.bufferedMs(op.getLong("endT")))
                        else -> error("unknown op $name")
                    }
                }
            }
        }
    }

    @TestFactory
    fun compose(): List<DynamicTest> {
        val v = load("compose.json")
        return v.getJSONArray("cases").objects().map { c ->
            dynamicTest("compose: ${c.getString("name")}") {
                val got = ClipSchedule.clipSchedule(
                    c.getJSONArray("frameTimes").longs(),
                    c.getLong("start"),
                    c.getLong("end"),
                    c.getDouble("fps"),
                )
                assertArrayEquals(c.getJSONArray("expect").ints(), got)
            }
        }
    }

    @TestFactory
    fun releaseTypeAndroid(): List<DynamicTest> {
        val v = load("release-type.json")
        return v.getJSONArray("android").objects().map { c ->
            dynamicTest("release-type android: ${c.getString("name")}") {
                val s = c.getJSONObject("signals")
                val signals = AndroidSignals(
                    debuggable = s.getBoolean("debuggable"),
                    installer = if (s.isNull("installer")) null else s.getString("installer"),
                    override = if (s.isNull("override")) null else s.getString("override"),
                )
                assertEquals(c.getString("expect"), ReleaseTypeClassifier.classifyAndroid(signals))
            }
        }
    }
}
