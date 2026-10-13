/*
 * Turns `logcat -d -v epoch -t 500 --pid=<pid>` output into timeline log events
 * (spec §11.4).
 *
 * Line format (threadtime with epoch seconds):
 *   `1791381003.500  4242  4242 I ReactNativeJS: [boot] theme restored`
 * i.e. seconds.millis, pid, tid, priority, tag padded with spaces, `: `, message.
 * Lines that don't match (`--------- beginning of main`, blank) are skipped.
 *
 * Levels: V/D → debug, I → info, W → warn, E/F/A → error. Sources: the tag
 * `ReactNativeJS` → `js`; the SDK's own tag `Snitch` is skipped; everything else
 * → `logcat`, with the tag kept. logcat prints each line of a multi-line message
 * (a stack trace) as its own entry with the same header; consecutive entries with
 * the same time, thread, level and tag are joined back into one event.
 *
 * The framework writes routine chatter into every app's log — HWUI's per-second
 * `app_time_stats`, ViewRootImpl and IME bookkeeping, emulator GL lines — which
 * would fill the timeline's 500 lines within minutes. Verbose, debug and info
 * lines of those tags are dropped; their warnings and errors are kept, as is
 * everything from other tags (Choreographer's "Skipped N frames" included).
 *
 * Pure Kotlin; the process is run by timeline/LogcatReader on the device.
 */
package io.github.monjar.snitch.logic

object LogcatParser {
    class Entry(val t: Long, val pid: Int, val tid: Int, val priority: Char, val tag: String, val msg: String)

    const val TAG_JS = "ReactNativeJS"
    const val TAG_SNITCH = "Snitch"

    /** Framework tags whose V/D/I lines are routine chatter (see the header). */
    val FRAMEWORK_CHATTER: Set<String> = setOf(
        "OpenGLRenderer", "HWUI", "EGL_emulation", "libEGL", "HostConnection", "goldfish-address-space",
        "Gralloc4", "AdrenoGLES", "AdrenoGLES-0", "BLASTBufferQueue", "FrameEvents", "SurfaceView",
        "ViewRootImpl", "InsetsController", "InsetsSourceConsumer", "ImeTracker", "InputMethodManager",
        "WindowOnBackDispatcher", "CompatChangeReporter", "CompatibilityChangeReporter", "ProfileInstaller",
        "nativeloader", "ziparchive", "AutofillManager", "AssistStructure", "TextClassifier", "ResourcesManager",
        "DesktopModeFlags", "ApplicationLoaders", "GraphicsEnvironment", "AppCompatDelegate",
    )

    /** Whether a line is framework chatter to leave out of the timeline. */
    @JvmStatic
    fun isChatter(priority: Char, tag: String): Boolean =
        (priority == 'V' || priority == 'D' || priority == 'I') &&
            (tag in FRAMEWORK_CHATTER || tag.startsWith("VRI["))

    private val LINE = Regex("^\\s*(\\d+)\\.(\\d{3})\\d*\\s+(\\d+)\\s+(\\d+)\\s+([VDIWEFA])\\s+(.*?)\\s*:(?: (.*))?$")

    /** One `-v epoch` line, or null when it isn't a log entry. */
    @JvmStatic
    fun parseLine(line: String): Entry? {
        val m = LINE.find(line.trimEnd('\r', '\n')) ?: return null
        val g = m.groupValues
        val seconds = g[1].toLongOrNull() ?: return null
        val millis = g[2].toLongOrNull() ?: return null
        return Entry(
            t = seconds * 1000 + millis,
            pid = g[3].toIntOrNull() ?: return null,
            tid = g[4].toIntOrNull() ?: return null,
            priority = g[5][0],
            tag = g[6].trim(),
            msg = g[7],
        )
    }

    @JvmStatic
    fun level(priority: Char): String = when (priority) {
        'V', 'D' -> "debug"
        'I' -> "info"
        'W' -> "warn"
        else -> "error"
    }

    /**
     * Timeline events from raw logcat [lines], oldest first, keeping only entries
     * with [from] ≤ t ≤ [to] (wall-clock epoch ms).
     */
    @JvmStatic
    fun events(lines: List<String>, from: Long, to: Long): List<TimelineEvent.Log> {
        val out = ArrayList<TimelineEvent.Log>()
        var pending: Entry? = null
        var text: StringBuilder? = null

        fun flush() {
            val p = pending ?: return
            val body = text?.toString() ?: p.msg
            pending = null
            text = null
            if (p.tag == TAG_SNITCH || isChatter(p.priority, p.tag) || p.t < from || p.t > to) return
            val src = if (p.tag == TAG_JS) "js" else "logcat"
            out.add(TimelineEvent.log(p.t, level(p.priority), src, body, p.tag))
        }

        for (line in lines) {
            val e = parseLine(line) ?: continue
            val p = pending
            if (p != null && p.t == e.t && p.pid == e.pid && p.tid == e.tid && p.priority == e.priority && p.tag == e.tag) {
                val sb = text ?: StringBuilder(p.msg).also { text = it }
                if (sb.length <= TimelineLimits.MSG_CHARS) sb.append('\n').append(e.msg)
                continue
            }
            flush()
            pending = e
        }
        flush()
        return out
    }
}
