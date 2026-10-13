/*
 * The report timeline (contract/src/timeline.ts): the events, their limits and
 * the `application/x-ndjson` encoding sent as the `timeline` attachment.
 *
 * Events are normalised when they are created (TimelineEvent.log(…) and
 * friends), so everything kept in memory already satisfies the contract's
 * schema: messages cut to 2000 characters ending in `…`, URLs sanitized, status
 * codes in range, coordinates clamped. The encoder writes one JSON object per
 * line by hand (logic/ has no JSON library), escaping control characters and
 * lone surrogates so the output is always valid UTF-8 JSON.
 *
 * The file is a `meta` line followed by the events in time order. It is kept
 * under the attachment cap (2 MB) by dropping the oldest log lines first, then
 * — never needed with the ring limits, but kept as a guarantee — the oldest
 * events of any kind. Pure Kotlin, tested by android/logic-jvm against
 * contract/fixtures/timeline.ndjson.
 */
package io.github.monjar.snitch.logic

/** contract/src/timeline.ts TIMELINE_LIMITS, plus the schema's field caps. */
object TimelineLimits {
    const val LOGS = 500
    const val NETWORK = 100
    const val SCREENS = 50
    const val TOUCHES = 300
    const val APP = 50
    const val MSG_CHARS = 2000
    const val URL_CHARS = 500
    const val MAX_AGE_MS = 5L * 60 * 1000
    const val TAG_CHARS = 64
    const val METHOD_CHARS = 16
    const val ERROR_CHARS = 300
    const val NAME_CHARS = 200

    /** ATTACHMENT_LIMITS['application/x-ndjson']. */
    const val MAX_BYTES = 2 * 1024 * 1024
}

/** Wire vocabularies (contract LOG_LEVELS, LOG_SOURCES, APP_EVENTS). */
object TimelineVocabulary {
    val LOG_LEVELS: Set<String> = setOf("debug", "info", "warn", "error")
    val LOG_SOURCES: Set<String> = setOf("app", "js", "native", "logcat", "sdk")
    val APP_EVENTS: Set<String> = setOf("launch", "foreground", "background", "memory_warning")
    val SCREEN_SOURCES: Set<String> = setOf("app", "native")
}

sealed class TimelineEvent {
    /** Wall-clock epoch milliseconds. */
    abstract val t: Long

    data class Log(override val t: Long, val level: String, val src: String, val msg: String, val tag: String?) : TimelineEvent()

    data class Net(
        override val t: Long,
        val method: String,
        val url: String,
        val status: Int?,
        val ms: Double?,
        val reqBytes: Long?,
        val resBytes: Long?,
        val error: String?,
    ) : TimelineEvent()

    data class Screen(override val t: Long, val name: String, val src: String) : TimelineEvent()

    data class Touch(override val t: Long, val x: Double, val y: Double, val n: Int?) : TimelineEvent()

    data class App(override val t: Long, val event: String) : TimelineEvent()

    companion object {
        /** A log line; an unknown level becomes `info`, an unknown source `app`. */
        @JvmStatic
        fun log(t: Long, level: String, src: String, msg: String, tag: String? = null): Log = Log(
            t = maxOf(0L, t),
            level = if (level in TimelineVocabulary.LOG_LEVELS) level else "info",
            src = if (src in TimelineVocabulary.LOG_SOURCES) src else "app",
            msg = cut(msg, TimelineLimits.MSG_CHARS),
            tag = tag?.takeIf { it.isNotEmpty() }?.let { cut(it, TimelineLimits.TAG_CHARS) },
        )

        /** A request; [url] is sanitized here, so pass it as the app used it. */
        @JvmStatic
        fun net(
            t: Long,
            method: String,
            url: String,
            status: Int?,
            ms: Double?,
            reqBytes: Long?,
            resBytes: Long?,
            error: String?,
        ): Net = Net(
            t = maxOf(0L, t),
            method = method.trim().uppercase().take(TimelineLimits.METHOD_CHARS).ifEmpty { "GET" },
            url = UrlSanitizer.sanitize(url),
            status = status?.takeIf { it in 100..999 },
            ms = ms?.takeIf { !it.isNaN() && !it.isInfinite() && it >= 0 }?.let { Math.round(it * 10) / 10.0 },
            reqBytes = reqBytes?.takeIf { it >= 0 },
            resBytes = resBytes?.takeIf { it >= 0 },
            error = error?.takeIf { it.isNotBlank() }?.let { cut(it, TimelineLimits.ERROR_CHARS) },
        )

        /** A screen; null when [name] is blank. */
        @JvmStatic
        fun screen(t: Long, name: String, src: String): Screen? {
            val n = name.trim().takeIf { it.isNotEmpty() } ?: return null
            return Screen(maxOf(0L, t), cut(n, TimelineLimits.NAME_CHARS), if (src in TimelineVocabulary.SCREEN_SOURCES) src else "app")
        }

        /** A finger going down at ([x], [y]) as fractions of the screen, with [n] fingers down. */
        @JvmStatic
        fun touch(t: Long, x: Double, y: Double, n: Int?): Touch =
            Touch(maxOf(0L, t), round4(clamp01(x)), round4(clamp01(y)), n?.takeIf { it in 1..20 })

        /** An app event; null for an event the contract doesn't know. */
        @JvmStatic
        fun app(t: Long, event: String): App? = if (event in TimelineVocabulary.APP_EVENTS) App(maxOf(0L, t), event) else null

        /**
         * [s] cut to at most [max] UTF-16 code units, ending in `…` when cut; never
         * splits a surrogate pair.
         */
        @JvmStatic
        fun cut(s: String, max: Int): String {
            if (s.length <= max) return s
            var end = max - 1
            if (end > 0 && s[end - 1].isHighSurrogate()) end--
            return s.substring(0, end) + "…"
        }

        private fun clamp01(v: Double): Double = if (v.isNaN()) 0.0 else v.coerceIn(0.0, 1.0)

        private fun round4(v: Double): Double = Math.round(v * 10_000) / 10_000.0
    }
}

/** The first line of a timeline. Times are wall-clock epoch milliseconds. */
data class TimelineMeta(
    val platform: String,
    val start: Long,
    val end: Long,
    val videoStart: Long? = null,
    val videoEnd: Long? = null,
    /** Events dropped because a ring was full (or, rarely, to fit the size cap). */
    val dropped: Int = 0,
)

object TimelineNdjson {
    class Encoded(val text: String, val byteCount: Int, val eventCount: Int, val trimmed: Int)

    /**
     * The attachment: [meta] then [events] sorted by time, at most [maxBytes] UTF-8
     * bytes. `meta.start`/`end` are widened to cover the video and the kept events;
     * events trimmed for size are added to `meta.dropped`.
     */
    @JvmStatic
    fun encode(meta: TimelineMeta, events: List<TimelineEvent>, maxBytes: Int = TimelineLimits.MAX_BYTES): Encoded {
        val sorted = events.sortedBy { it.t }
        val lines = Array(sorted.size) { eventLine(sorted[it]) }
        val sizes = IntArray(lines.size) { utf8Length(lines[it]) + 1 }
        // Reserve the meta line at its longest (every event counted as dropped).
        val metaReserve = utf8Length(metaLine(meta.copy(dropped = meta.dropped + sorted.size))) + 1
        val budget = maxBytes - metaReserve
        val keep = BooleanArray(lines.size) { true }
        var total = sizes.sum()
        var trimmed = 0
        var nextLog = 0
        var nextAny = 0
        while (total > budget) {
            while (nextLog < sorted.size && (!keep[nextLog] || sorted[nextLog] !is TimelineEvent.Log)) nextLog++
            val drop = if (nextLog < sorted.size) {
                nextLog
            } else {
                while (nextAny < sorted.size && !keep[nextAny]) nextAny++
                if (nextAny >= sorted.size) break
                nextAny
            }
            keep[drop] = false
            total -= sizes[drop]
            trimmed++
        }
        var start = minOf(meta.start, meta.videoStart ?: meta.start)
        var end = maxOf(meta.end, meta.videoEnd ?: meta.end)
        for (i in sorted.indices) {
            if (!keep[i]) continue
            start = minOf(start, sorted[i].t)
            end = maxOf(end, sorted[i].t)
        }
        val head = metaLine(meta.copy(start = start, end = maxOf(start, end), dropped = meta.dropped + trimmed))
        val sb = StringBuilder(total + head.length + 1)
        sb.append(head).append('\n')
        var count = 0
        for (i in lines.indices) {
            if (!keep[i]) continue
            sb.append(lines[i]).append('\n')
            count++
        }
        val text = sb.toString()
        return Encoded(text, utf8Length(text), count, trimmed)
    }

    @JvmStatic
    fun metaLine(m: TimelineMeta): String {
        val sb = StringBuilder(160)
        sb.append("{\"k\":\"meta\",\"v\":1,\"platform\":")
        quote(m.platform, sb)
        sb.append(",\"start\":").append(m.start).append(",\"end\":").append(m.end)
        m.videoStart?.let { sb.append(",\"videoStart\":").append(it) }
        m.videoEnd?.let { sb.append(",\"videoEnd\":").append(it) }
        if (m.dropped > 0) sb.append(",\"dropped\":").append(m.dropped)
        return sb.append('}').toString()
    }

    @JvmStatic
    fun eventLine(e: TimelineEvent): String {
        val sb = StringBuilder(96)
        when (e) {
            is TimelineEvent.Log -> {
                sb.append("{\"k\":\"log\",\"t\":").append(e.t)
                sb.append(",\"level\":")
                quote(e.level, sb)
                sb.append(",\"src\":")
                quote(e.src, sb)
                sb.append(",\"msg\":")
                quote(e.msg, sb)
                e.tag?.let {
                    sb.append(",\"tag\":")
                    quote(it, sb)
                }
            }
            is TimelineEvent.Net -> {
                sb.append("{\"k\":\"net\",\"t\":").append(e.t)
                sb.append(",\"method\":")
                quote(e.method, sb)
                sb.append(",\"url\":")
                quote(e.url, sb)
                e.status?.let { sb.append(",\"status\":").append(it) }
                e.ms?.let { sb.append(",\"ms\":").append(number(it)) }
                e.reqBytes?.let { sb.append(",\"reqBytes\":").append(it) }
                e.resBytes?.let { sb.append(",\"resBytes\":").append(it) }
                e.error?.let {
                    sb.append(",\"error\":")
                    quote(it, sb)
                }
            }
            is TimelineEvent.Screen -> {
                sb.append("{\"k\":\"screen\",\"t\":").append(e.t)
                sb.append(",\"name\":")
                quote(e.name, sb)
                sb.append(",\"src\":")
                quote(e.src, sb)
            }
            is TimelineEvent.Touch -> {
                sb.append("{\"k\":\"touch\",\"t\":").append(e.t)
                sb.append(",\"x\":").append(number(e.x)).append(",\"y\":").append(number(e.y))
                e.n?.let { sb.append(",\"n\":").append(it) }
            }
            is TimelineEvent.App -> {
                sb.append("{\"k\":\"app\",\"t\":").append(e.t)
                sb.append(",\"event\":")
                quote(e.event, sb)
            }
        }
        return sb.append('}').toString()
    }

    /** A JSON number: integral values without a fraction, others as Kotlin prints them (valid JSON). */
    private fun number(v: Double): String {
        if (v.isNaN() || v.isInfinite()) return "0"
        val asLong = v.toLong()
        return if (asLong.toDouble() == v && kotlin.math.abs(v) < 1e15) asLong.toString() else v.toString()
    }

    /** Appends [s] as a JSON string literal. */
    @JvmStatic
    fun quote(s: String, sb: StringBuilder) {
        sb.append('"')
        var i = 0
        while (i < s.length) {
            val c = s[i]
            when {
                c == '"' -> sb.append("\\\"")
                c == '\\' -> sb.append("\\\\")
                c == '\n' -> sb.append("\\n")
                c == '\r' -> sb.append("\\r")
                c == '\t' -> sb.append("\\t")
                c.code < 0x20 || c == ' ' || c == ' ' -> unicodeEscape(c, sb)
                c.isHighSurrogate() && i + 1 < s.length && s[i + 1].isLowSurrogate() -> {
                    sb.append(c).append(s[i + 1])
                    i++
                }
                c.isSurrogate() -> unicodeEscape(c, sb)
                else -> sb.append(c)
            }
            i++
        }
        sb.append('"')
    }

    private fun unicodeEscape(c: Char, sb: StringBuilder) {
        val code = c.code
        sb.append("\\u")
        for (shift in intArrayOf(12, 8, 4, 0)) sb.append(HEX[(code shr shift) and 0xF])
    }

    private const val HEX = "0123456789abcdef"

    /** UTF-8 length of [s]; a lone surrogate counts as 3 bytes (the encoder never emits one). */
    @JvmStatic
    fun utf8Length(s: String): Int {
        var n = 0
        var i = 0
        while (i < s.length) {
            val c = s[i]
            n += when {
                c.code < 0x80 -> 1
                c.code < 0x800 -> 2
                c.isHighSurrogate() && i + 1 < s.length && s[i + 1].isLowSurrogate() -> {
                    i++
                    4
                }
                else -> 3
            }
            i++
        }
        return n
    }
}
