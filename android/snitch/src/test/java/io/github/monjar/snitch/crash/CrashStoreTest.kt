/*
 * The crash follow-up's files: pending crashes (newest first, nothing older
 * than 7 days), the session log taken at the next launch, a crash's own
 * timeline, and deleting everything once it is sent or dismissed.
 */
package io.github.monjar.snitch.crash

import io.github.monjar.snitch.logic.TimelineEvent
import io.github.monjar.snitch.logic.TimelineNdjson
import io.github.monjar.snitch.report.SnitchLogger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class CrashStoreTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private val logger = object : SnitchLogger {
        override fun debug(message: String) = Unit

        override fun info(message: String) = Unit

        override fun warn(message: String, error: Throwable?) = Unit
    }

    private val day = 24L * 60 * 60 * 1000
    private val now = 1_800_000_000_000L

    private fun store() = CrashStore(File(tmp.root, "crash"), logger)

    @Test
    fun `pending crashes are newest first and expire after seven days`() {
        val s = store()
        s.add("anr", now - 8 * day, 10, "old ANR")
        s.add("java", now - 2 * day, 11, "java crash")
        s.add("native", now - day, 12, "native crash")
        val pending = s.pending(now)
        assertEquals(listOf("native", "java"), pending.map { it.kind })
        assertEquals(listOf(12, 11), pending.map { it.pid })
        assertEquals(now - day, pending.first().time)
        assertEquals("native crash", s.readText(pending.first()))
        // The expired one is gone from disk.
        assertFalse(File(tmp.root, "crash/crash-${now - 8 * day}-anr-10.txt").exists())
    }

    @Test
    fun `a crash keeps the log of the session that crashed`() {
        val s = store()
        s.writeSessionLog(
            listOf(
                TimelineNdjson.eventLine(TimelineEvent.log(now - 2000, "info", "app", "checkout started")),
                TimelineNdjson.eventLine(TimelineEvent.log(now - 1000, "warn", "js", "slow render", "ReactNativeJS")),
            ),
        )
        val previous = s.takeSessionLog()
        assertEquals(listOf("checkout started", "slow render"), previous.map { (it as TimelineEvent.Log).msg })
        assertTrue(s.takeSessionLog().isEmpty()) // taken once
        val crash = File(tmp.root, "crash").let { s.add("java", now, 42, "boom") }
        val pending = s.pending(now + 1).single()
        assertEquals(crash, pending.file)
        val logcat = TimelineEvent.log(now - 1500, "error", "logcat", "FATAL EXCEPTION: main", "AndroidRuntime")
        s.attachTimeline(pending, previous + logcat)
        assertTrue(pending.timelineFile.isFile)
        val events = s.timelineEvents(pending)
        assertEquals(listOf(now - 2000, now - 1500, now - 1000), events.map { it.t })
        assertEquals("AndroidRuntime", (events[1] as TimelineEvent.Log).tag)
    }

    @Test
    fun `deleting removes every crash but not the session log`() {
        val s = store()
        val c = s.add("anr", now, 7, "anr")
        s.attachTimeline(s.pending(now).single(), listOf(TimelineEvent.log(now, "info", "app", "x")))
        s.writeSessionLog(listOf(TimelineNdjson.eventLine(TimelineEvent.log(now, "info", "app", "current"))))
        s.deleteAll()
        assertFalse(c.exists())
        assertTrue(s.pending(now).isEmpty())
        assertEquals(1, s.takeSessionLog().size)
    }

    @Test
    fun `only timeline log lines decode`() {
        val line = TimelineNdjson.eventLine(TimelineEvent.log(5, "debug", "logcat", "a \"quoted\"\nline", "Tag"))
        val back = CrashStore.decodeLog(line)!!
        assertEquals("a \"quoted\"\nline", back.msg)
        assertEquals("Tag", back.tag)
        assertNull(CrashStore.decodeLog("""{"k":"app","t":1,"event":"launch"}"""))
        assertNull(CrashStore.decodeLog("not json"))
        assertNull(CrashStore.decodeLog(""))
    }

    @Test
    fun `an empty store has nothing pending`() {
        val s = store()
        assertTrue(s.pending(now).isEmpty())
        assertTrue(s.takeSessionLog().isEmpty())
        s.deleteAll()
    }
}
