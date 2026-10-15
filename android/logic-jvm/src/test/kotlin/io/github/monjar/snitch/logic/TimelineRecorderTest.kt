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
    fun `requests still running at freeze are in flight`() {
        recorder.configure(active = true, console = true, network = true, screens = true)
        val slow = recorder.requestStarted(now, "get", "https://a.example/slow?id=7")
        val quick = recorder.requestStarted(now + 10, "POST", "https://a.example/quick")
        now += 40
        recorder.net(now - 30, "POST", "https://a.example/quick", 201, 30.0, 2, 0, null, quick)
        now += 2_460

        val nets = recorder.freeze().events.filterIsInstance<TimelineEvent.Net>()
        assertEquals(listOf("https://a.example/quick", "https://a.example/slow?id=*"), nets.map { it.url })
        assertEquals(
            TimelineEvent.Net(now - 2_500, "GET", "https://a.example/slow?id=*", null, 2_500.0, null, null, TimelineEvent.NET_IN_FLIGHT),
            nets[1],
        )

        recorder.net(now - 2_500, "GET", "https://a.example/slow?id=7", 200, 2_500.0, null, 5, null, slow)
        val after = recorder.freeze().events.filterIsInstance<TimelineEvent.Net>()
        assertEquals(listOf(201, 200), after.map { it.status }, "both recorded, nothing left in flight")
    }

    @Test
    fun `in-flight tracking follows the network switch and is bounded`() {
        assertEquals(0L, recorder.requestStarted(now, "GET", "https://a.example/off"))
        recorder.configure(active = true, console = true, network = true, screens = true)
        recorder.requestStarted(now, "GET", "https://a.example/gone")
        recorder.configure(active = true, console = true, network = false, screens = true)
        recorder.configure(active = true, console = true, network = true, screens = true)
        assertTrue(recorder.freeze().events.isEmpty(), "turning network capture off forgets running requests")

        repeat(TimelineLimits.NETWORK + 5) { recorder.requestStarted(now, "GET", "https://a.example/$it") }
        val urls = recorder.freeze().events.filterIsInstance<TimelineEvent.Net>().map { it.url }
        assertEquals(TimelineLimits.NETWORK, urls.size)
        assertEquals("https://a.example/5", urls.first(), "the oldest are forgotten first")
        assertEquals(0, recorder.freeze().dropped, "not counted as dropped events")

        val id = recorder.requestStarted(now, "GET", "https://a.example/ended")
        recorder.requestEnded(id)
        assertTrue(recorder.freeze().events.none { it is TimelineEvent.Net && it.url.endsWith("/ended") })
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
