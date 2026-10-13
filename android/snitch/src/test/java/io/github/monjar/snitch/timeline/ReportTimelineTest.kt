/*
 * The report's timeline attachment as SnitchRuntime builds it at Send: the
 * frozen snapshot, touch downs converted from uptime to wall-clock time, logcat
 * lines, and the clip's wall-clock span in the meta line. Plus the logcat
 * reader's time budget, with a stand-in command.
 */
package io.github.monjar.snitch.timeline

import io.github.monjar.snitch.capture.TouchSample
import io.github.monjar.snitch.logic.TimelineEvent
import io.github.monjar.snitch.logic.TimelineRecorder
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

class ReportTimelineTest {
    private var wall = 1_800_000_000_000L
    private val recorder = TimelineRecorder { wall }

    private fun lines(text: String) = text.trimEnd('\n').split('\n').map { JSONObject(it) }

    @Test
    fun `touches, logcat and the clip span join the frozen timeline`() {
        recorder.configure(active = true, console = true, network = true, screens = true)
        recorder.app("launch")
        wall += 1000
        recorder.screen("Example", "app")
        recorder.log("info", "app", "example screen created")
        wall += 9000
        val snap = recorder.freeze()

        // Uptime 50 000 ms is wall-clock `wall` at the freeze.
        val wallOffset = wall - 50_000
        val downs = listOf(
            TouchSample(45_000, 0, 100f, 200f, TouchSample.Phase.DOWN, fx = 0.25f, fy = 0.5f, fingers = 1),
            TouchSample(46_000, 1, 10f, 20f, TouchSample.Phase.DOWN, fx = 1.4f, fy = 0.1f, fingers = 3),
        )
        val logcat = listOf(TimelineEvent.log(wall - 500, "warn", "logcat", "slow frame", "Choreographer"))
        // The clip ended at uptime 48 000 and lasted 15 s.
        val out = ReportTimeline.encode(snap, downs, wallOffset, logcat, videoEndWall = 48_000 + wallOffset, videoDurationMs = 15_000)!!

        val records = lines(out.text)
        val meta = records[0]
        assertEquals("android", meta.getString("platform"))
        assertEquals(wall - 2000, meta.getLong("videoEnd"))
        assertEquals(wall - 17_000, meta.getLong("videoStart"))
        assertEquals(wall - 17_000, meta.getLong("start")) // the clip starts before the first event
        assertEquals(wall, meta.getLong("end"))
        val kinds = records.drop(1).map { it.getString("k") }
        assertEquals(listOf("app", "screen", "log", "touch", "touch", "log"), kinds)
        val touch = records.drop(1).first { it.getString("k") == "touch" }
        assertEquals(wall - 5000, touch.getLong("t"))
        assertEquals(0.25, touch.getDouble("x"), 0.0)
        assertEquals(1, touch.getInt("n"))
        assertEquals(1.0, records.drop(1).filter { it.getString("k") == "touch" }[1].getDouble("x"), 0.0)
        val times = records.drop(1).map { it.getLong("t") }
        assertEquals(times.sorted(), times)
    }

    @Test
    fun `no events and no video means no timeline`() {
        val snap = recorder.freeze()
        assertNull(ReportTimeline.encode(snap, emptyList(), 0, emptyList(), null, null))
        assertNull(ReportTimeline.encodePast(emptyList()))
        val withVideo = ReportTimeline.encode(snap, emptyList(), 0, emptyList(), videoEndWall = wall, videoDurationMs = 3000)!!
        assertEquals(1, withVideo.text.trimEnd('\n').split('\n').size)
    }

    @Test
    fun `a past session becomes a timeline without video`() {
        val out = ReportTimeline.encodePast(
            listOf(TimelineEvent.log(2000, "error", "logcat", "FATAL EXCEPTION: main", "AndroidRuntime"), TimelineEvent.log(1000, "info", "app", "checkout")),
        )!!
        val records = lines(out.text)
        assertEquals(1000L, records[0].getLong("start"))
        assertEquals(2000L, records[0].getLong("end"))
        assertFalse(records[0].has("videoStart"))
        assertEquals(listOf("checkout", "FATAL EXCEPTION: main"), records.drop(1).map { it.getString("msg") })
    }

    @Test
    fun `logcat output is read within the budget`() {
        assumeTrue(File("/bin/sh").canExecute())
        val lines = LogcatReader.read(listOf("/bin/sh", "-c", "echo '1791381003.500  1  1 I Tag: one'; echo '1791381003.600  1  1 W Tag: two'"))
        assertEquals(2, lines.size)
        val start = System.nanoTime()
        val slow = LogcatReader.read(listOf("/bin/sh", "-c", "echo early; sleep 20; echo late"), timeoutMs = 300)
        val elapsedMs = (System.nanoTime() - start) / 1_000_000
        assertTrue("took $elapsedMs ms", elapsedMs < 5_000)
        assertEquals(listOf("early"), slow)
        assertTrue(LogcatReader.read(listOf("/definitely/not/a/binary")).isEmpty())
        assertEquals(listOf("logcat", "-d", "-v", "epoch", "-t", "1500", "--pid=42"), LogcatReader.command(42))
    }
}
