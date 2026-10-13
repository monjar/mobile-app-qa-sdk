/*
 * `logcat -d -v epoch` output → timeline log events: header lines skipped,
 * levels and sources mapped per spec §11.4, the SDK's own lines dropped, and a
 * multi-line message (a stack trace) joined back into one event.
 */
package io.github.monjar.snitch.logic

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class LogcatParserTest {
    private val sample = listOf(
        "--------- beginning of main",
        "1791381003.500  4242  4242 I ReactNativeJS: [boot] theme restored in 41 ms",
        "1791381003.512  4242  4251 D OkHttp  : --> GET https://api.example.com/v1/facts",
        "1791381004.000  4242  4242 I Snitch  : started (debug, snapshot capture, server http://10.0.2.2:8080)",
        "1791381005.250  4242  4260 W System.err: java.io.IOException: timeout",
        "1791381005.250  4242  4260 W System.err: \tat okhttp3.internal.http2.Http2Stream.waitForIo(Http2Stream.kt:714)",
        "1791381005.250  4242  4260 W System.err: \tat okhttp3.internal.http2.Http2Stream.takeHeaders(Http2Stream.kt:149)",
        "1791381006.001  4242  4242 E AndroidRuntime: FATAL EXCEPTION: main",
        "1791381006.100  4242  4242 F libc    : Fatal signal 6 (SIGABRT)",
        "1791381006.200  4242  4242 V Choreographer: Skipped 31 frames!",
        "1791381006.300  4242  4242 A DEBUG   : Abort message: 'boom'",
        "1791381006.400  4242  4242 I EmptyMsg:",
        "garbage that is not a log line",
        "",
    )

    @Test
    fun `parses an epoch line`() {
        val e = LogcatParser.parseLine("1791381003.512  4242  4251 D OkHttp  : --> GET https://x: y")!!
        assertEquals(1_791_381_003_512L, e.t)
        assertEquals(4242, e.pid)
        assertEquals(4251, e.tid)
        assertEquals('D', e.priority)
        assertEquals("OkHttp", e.tag)
        assertEquals("--> GET https://x: y", e.msg)
        assertNull(LogcatParser.parseLine("--------- beginning of crash"))
        assertNull(LogcatParser.parseLine("12:00:01.000  1  1 I Tag: threadtime without epoch"))
        // Microsecond precision keeps the milliseconds.
        assertEquals(1_791_381_003_512L, LogcatParser.parseLine("1791381003.512345  1  1 I T: m")!!.t)
    }

    @Test
    fun `maps levels, sources and tags, skipping Snitch's own lines`() {
        val events = LogcatParser.events(sample, 0, Long.MAX_VALUE)
        assertEquals(
            listOf(
                Triple("js", "info", "ReactNativeJS"),
                Triple("logcat", "debug", "OkHttp"),
                Triple("logcat", "warn", "System.err"),
                Triple("logcat", "error", "AndroidRuntime"),
                Triple("logcat", "error", "libc"),
                Triple("logcat", "debug", "Choreographer"),
                Triple("logcat", "error", "DEBUG"),
                Triple("logcat", "info", "EmptyMsg"),
            ),
            events.map { Triple(it.src, it.level, it.tag) },
        )
        assertEquals("[boot] theme restored in 41 ms", events[0].msg)
        assertEquals("", events.last().msg)
    }

    @Test
    fun `framework chatter is dropped below warning, its warnings and other tags stay`() {
        val lines = listOf(
            "1791381003.500  42  42 D OpenGLRenderer: app_time_stats: avg=56.72ms min=11.16ms max=112.02ms count=18",
            "1791381003.600  42  42 I VRI[MainActivity]: visibilityChanged oldVisibility=true newVisibility=false",
            "1791381003.700  42  42 D InsetsController: hide(ime(), fromIme=false)",
            "1791381003.800  42  42 W OpenGLRenderer: Failed to choose config with EGL_SWAP_BEHAVIOR_PRESERVED",
            "1791381003.900  42  42 I Choreographer: Skipped 42 frames!  The application may be doing too much work on its main thread.",
            "1791381004.000  42  42 D MyApp: loaded 3 items",
        )
        val events = LogcatParser.events(lines, 0, Long.MAX_VALUE)
        assertEquals(listOf("OpenGLRenderer", "Choreographer", "MyApp"), events.map { it.tag })
        assertEquals("warn", events[0].level)
    }

    @Test
    fun `continuation lines of one message are joined`() {
        val trace = LogcatParser.events(sample, 0, Long.MAX_VALUE).single { it.tag == "System.err" }
        assertEquals(
            "java.io.IOException: timeout\n" +
                "\tat okhttp3.internal.http2.Http2Stream.waitForIo(Http2Stream.kt:714)\n" +
                "\tat okhttp3.internal.http2.Http2Stream.takeHeaders(Http2Stream.kt:149)",
            trace.msg,
        )
        assertEquals(1_791_381_005_250L, trace.t)
    }

    @Test
    fun `a joined message is capped`() {
        val lines = (0 until 200).map { "1791381005.250  1  2 E Tag: " + "x".repeat(100) }
        val e = LogcatParser.events(lines, 0, Long.MAX_VALUE).single()
        assertEquals(TimelineLimits.MSG_CHARS, e.msg.length)
    }

    @Test
    fun `entries outside the window are left out`() {
        val events = LogcatParser.events(sample, 1_791_381_004_000L, 1_791_381_006_001L)
        assertEquals(listOf("System.err", "AndroidRuntime"), events.map { it.tag })
    }

    @Test
    fun `level letters`() {
        assertEquals(listOf("debug", "debug", "info", "warn", "error", "error", "error"), "VDIWEFA".map { LogcatParser.level(it) })
    }
}
