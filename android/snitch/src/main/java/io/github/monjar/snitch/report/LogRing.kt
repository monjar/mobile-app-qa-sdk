/*
 * In-memory ring of Snitch.log() lines, sent as the `logs` attachment (spec
 * §7.1): the last 200 lines, at most 256 KB, merged with the app's log
 * provider output at send time. Nothing is written to disk until a report is sent.
 */
package io.github.monjar.snitch.report

import io.github.monjar.snitch.SnitchLogLevel

internal class LogRing(private val maxLines: Int, private val maxBytes: Int) {
    private val lines = ArrayDeque<String>()
    private var bytes = 0

    fun append(epochMs: Long, level: SnitchLogLevel, message: String) {
        val line = "${Iso8601.format(epochMs)} ${level.name} ${message.take(MAX_LINE_CHARS)}"
        synchronized(this) {
            lines.addLast(line)
            bytes += line.length + 1
            while (lines.size > maxLines || (bytes > maxBytes && lines.size > 1)) {
                bytes -= lines.removeFirst().length + 1
            }
        }
    }

    fun snapshot(): List<String> = synchronized(this) { lines.toList() }

    companion object {
        private const val MAX_LINE_CHARS = 4000

        /**
         * The attachment text: ring lines then provider output, trimmed to the last
         * [maxLines] lines and [maxBytes] UTF-8 bytes. Null when there is nothing to send.
         */
        fun compose(ring: List<String>, providerText: String?, maxLines: Int, maxBytes: Int): String? {
            val all = ArrayList<String>(ring)
            if (!providerText.isNullOrBlank()) all.addAll(providerText.trimEnd().lines())
            if (all.isEmpty()) return null
            var kept = all.takeLast(maxLines)
            var text = kept.joinToString("\n", postfix = "\n")
            while (text.toByteArray(Charsets.UTF_8).size > maxBytes && kept.size > 1) {
                kept = kept.drop(maxOf(1, kept.size / 10))
                text = kept.joinToString("\n", postfix = "\n")
            }
            val encoded = text.toByteArray(Charsets.UTF_8)
            if (encoded.size > maxBytes) text = String(encoded, encoded.size - maxBytes, maxBytes, Charsets.UTF_8)
            return text.ifBlank { null }
        }
    }
}
