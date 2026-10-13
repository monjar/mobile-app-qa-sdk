/*
 * The in-memory timeline: switches gate every kind (nothing is kept while off),
 * rings keep the newest TIMELINE_LIMITS entries and count the rest as dropped,
 * nothing older than 5 minutes leaves in a freeze, and screens are recorded only
 * when they change.
 */
package io.github.monjar.snitch.logic

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.util.concurrent.CountDownLatch

class TimelineRecorderTest {
    private var now = 1_000_000L
    private val recorder = TimelineRecorder { now }

    private fun recordOneOfEach() {
        recorder.log("info", "app", "hello")
        recorder.net(now, "GET", "https://a.example/x", 200, 3.0, null, 10, null)
        recorder.screen("Home", "native")
        recorder.app("foreground")
    }

    @Test
    fun `nothing is recorded until Snitch is active`() {
        recordOneOfEach()
        assertTrue(recorder.freeze().events.isEmpty())

        recorder.configure(active = false, console = true, network = true, screens = true)
        recordOneOfEach()
        assertTrue(recorder.freeze().events.isEmpty())
        assertFalse(recorder.networkOn)
    }

    @Test
    fun `each kind follows its switch, app events follow active`() {
        recorder.configure(active = true, console = false, network = false, screens = false)
        recordOneOfEach()
        assertEquals(listOf<TimelineEvent>(TimelineEvent.App(now, "foreground")), recorder.freeze().events)

        recorder.configure(active = true, console = true, network = true, screens = true)
        recordOneOfEach()
        val kinds = recorder.freeze().events.map { it.javaClass.simpleName }.toSet()
        assertEquals(setOf("App", "Screen", "Net", "Log"), kinds)
        assertTrue(recorder.freeze().console)
    }

    @Test
    fun `rings keep the newest entries and count drops`() {
        recorder.configure(active = true, console = true, network = true, screens = true)
        repeat(TimelineLimits.LOGS + 20) { recorder.log("info", "app", "line $it") }
        repeat(TimelineLimits.NETWORK + 5) { recorder.net(now, "GET", "https://a.example/$it", 200, 1.0, null, null, null) }
        val snap = recorder.freeze()
        val logs = snap.events.filterIsInstance<TimelineEvent.Log>()
        assertEquals(TimelineLimits.LOGS, logs.size)
        assertEquals("line 20", logs.first().msg)
        assertEquals(TimelineLimits.NETWORK, snap.events.filterIsInstance<TimelineEvent.Net>().size)
        assertEquals(25, snap.dropped)
    }

    @Test
    fun `events older than five minutes are left out`() {
        recorder.configure(active = true, console = true, network = true, screens = true)
        recorder.log("info", "app", "old")
        recorder.app("launch")
        now += TimelineLimits.MAX_AGE_MS + 1
        recorder.log("info", "app", "new")
        val events = recorder.freeze().events
        assertEquals(listOf("new"), events.filterIsInstance<TimelineEvent.Log>().map { it.msg })
        assertTrue(events.none { it is TimelineEvent.App })
    }

    @Test
    fun `screens are recorded when they change and setScreen(null) clears the current one`() {
        recorder.configure(active = true, console = true, network = true, screens = true)
        assertTrue(recorder.screen("Home", "native"))
        assertFalse(recorder.screen("Home", "app"))
        assertTrue(recorder.screen("Settings", "app"))
        assertEquals("Settings", recorder.freeze().screen)
        recorder.clearScreen()
        assertNull(recorder.freeze().screen)
        assertTrue(recorder.screen("Settings", "app"))
        assertEquals(3, recorder.freeze().events.filterIsInstance<TimelineEvent.Screen>().size)
    }

    @Test
    fun `recent logs and the log version feed the session log`() {
        recorder.configure(active = true, console = true, network = false, screens = false)
        val v0 = recorder.logVersion
        repeat(250) { recorder.log("warn", "app", "l$it") }
        assertEquals(v0 + 250, recorder.logVersion)
        val recent = recorder.recentLogs(200)
        assertEquals(200, recent.size)
        assertEquals("l50", recent.first().msg)
        assertEquals("l249", recent.last().msg)
    }

    @Test
    fun `concurrent records are all kept`() {
        val r = TimelineRecorder()
        r.configure(active = true, console = true, network = true, screens = true)
        val threads = 8
        val start = CountDownLatch(1)
        val done = CountDownLatch(threads)
        repeat(threads) { n ->
            Thread {
                start.await()
                repeat(50) { r.log("info", "app", "t$n-$it") }
                done.countDown()
            }.start()
        }
        start.countDown()
        done.await()
        assertEquals(400, r.freeze().events.size)
        assertEquals(0, r.freeze().dropped)
    }
}
