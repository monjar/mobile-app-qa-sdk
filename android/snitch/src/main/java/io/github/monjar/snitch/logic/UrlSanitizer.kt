/*
 * The URL a timeline network event stores.
 *
 * Twin of sanitizeUrl in contract/src/timeline.ts (and the Swift UrlSanitizer),
 * tested against contract/vectors/url-sanitize.json by android/logic-jvm. Plain
 * string surgery, no URI parsing, so every SDK gives byte-identical results:
 *
 *   1. No `scheme:` prefix → `…`. A scheme other than http/https, or no `//`
 *      after it → `<scheme>:…` (scheme lowercased).
 *   2. Cut at the first `#`.
 *   3. Authority = after `//` up to the first `/` or `?`; drop everything up to the
 *      last `@` (credentials); lowercase it. Empty → `<scheme>:…`.
 *   4. Path = from that `/` up to the first `?`, as sent; `/` when there is none.
 *   5. Query: split on `&`, skip empty parts, keep each name as `name=*`.
 *   6. Longer than 500 UTF-16 code units → the first 499 plus `…`.
 *
 * [origin] uses the same authority rules to tell whether a request goes to the
 * Snitch server itself (those are never recorded).
 */
package io.github.monjar.snitch.logic

object UrlSanitizer {
    /** TIMELINE_LIMITS.urlChars. */
    const val MAX_CHARS = 500

    private const val ELLIPSIS = "…"
    private val SCHEME = Regex("^([a-zA-Z][a-zA-Z0-9+.-]*):")

    @JvmStatic
    fun sanitize(input: String): String {
        val m = SCHEME.find(input) ?: return ELLIPSIS
        val scheme = m.groupValues[1].lowercase()
        var rest = input.substring(m.value.length)
        if ((scheme != "http" && scheme != "https") || !rest.startsWith("//")) return "$scheme:$ELLIPSIS"
        rest = rest.substring(2)
        val hash = rest.indexOf('#')
        if (hash >= 0) rest = rest.substring(0, hash)
        val authorityEnd = authorityEnd(rest)
        val authority = hostPart(rest.substring(0, authorityEnd))
        if (authority.isEmpty()) return "$scheme:$ELLIPSIS"
        val tail = rest.substring(authorityEnd)
        val q = tail.indexOf('?')
        val path = (if (q >= 0) tail.substring(0, q) else tail).ifEmpty { "/" }
        val out = StringBuilder(scheme.length + authority.length + path.length + 8)
        out.append(scheme).append("://").append(authority).append(path)
        if (q >= 0) {
            var first = true
            for (part in tail.substring(q + 1).split('&')) {
                if (part.isEmpty()) continue
                out.append(if (first) '?' else '&').append(part.substringBefore('=')).append("=*")
                first = false
            }
        }
        return if (out.length > MAX_CHARS) out.substring(0, MAX_CHARS - 1) + ELLIPSIS else out.toString()
    }

    /**
     * `host:port` of an http(s) URL, lowercased, with the scheme's default port
     * filled in (`api.example.com:443`); null for anything else. IPv6 literals keep
     * their brackets.
     */
    @JvmStatic
    fun origin(input: String): String? {
        val m = SCHEME.find(input.trim()) ?: return null
        val scheme = m.groupValues[1].lowercase()
        var rest = input.trim().substring(m.value.length)
        if ((scheme != "http" && scheme != "https") || !rest.startsWith("//")) return null
        rest = rest.substring(2)
        val hash = rest.indexOf('#')
        if (hash >= 0) rest = rest.substring(0, hash)
        val authority = hostPart(rest.substring(0, authorityEnd(rest)))
        if (authority.isEmpty()) return null
        val defaultPort = if (scheme == "https") 443 else 80
        // The port follows the last ':' after an IPv6 literal's closing bracket.
        val bracket = authority.lastIndexOf(']')
        val colon = authority.lastIndexOf(':')
        if (colon > bracket) {
            val host = authority.substring(0, colon)
            val port = authority.substring(colon + 1).toIntOrNull()?.takeIf { it in 1..65535 } ?: defaultPort
            return if (host.isEmpty()) null else "$host:$port"
        }
        return "$authority:$defaultPort"
    }

    /** Index of the first `/` or `?` in [rest] (the end of the authority). */
    private fun authorityEnd(rest: String): Int {
        for (i in rest.indices) {
            val c = rest[i]
            if (c == '/' || c == '?') return i
        }
        return rest.length
    }

    /** The authority without credentials (up to the last `@`), lowercased. */
    private fun hostPart(authority: String): String {
        val at = authority.lastIndexOf('@')
        return (if (at >= 0) authority.substring(at + 1) else authority).lowercase()
    }
}
