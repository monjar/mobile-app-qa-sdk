/*
 * Network capture (spec §11.5): the gate and the recording shared by
 * SnitchOkHttpInterceptor and Snitch.recordNetwork.
 *
 * - Off unless Snitch is active and network capture is effective (the static
 *   `captureNetwork` option AND the remote `timeline.network` switch); the check
 *   is one volatile read of the recorder's switch.
 * - Requests to the Snitch server itself (same host and port as SERVER_URL) are
 *   never recorded.
 * - What is kept: method, the sanitized URL (UrlSanitizer), status, duration,
 *   byte counts and an error text. Never headers or bodies.
 *
 * No android.* imports, so the interceptor runs in JVM unit tests.
 */
package io.github.monjar.snitch.network

import io.github.monjar.snitch.SnitchState
import io.github.monjar.snitch.logic.UrlSanitizer

internal object NetworkCapture {
    /** Snitch is active with network capture on. */
    val isOn: Boolean get() = SnitchState.timeline.networkOn

    /** True for a URL on the Snitch server: same host and port as its SERVER_URL. */
    fun isSnitchServer(url: String): Boolean {
        val server = SnitchState.serverOrigin ?: return false
        val origin = UrlSanitizer.origin(url) ?: return false
        return origin == server
    }

    /** A request that started at [startWall] (epoch ms) and took [ms]. */
    fun record(startWall: Long, method: String, url: String, status: Int?, ms: Double?, reqBytes: Long?, resBytes: Long?, error: String?) {
        if (!isOn || isSnitchServer(url)) return
        SnitchState.timeline.net(startWall, method, url, status, ms, reqBytes, resBytes, error)
    }

    /** Snitch.recordNetwork: the request finished now, after [durationMs]. */
    fun recordFinished(method: String, url: String, status: Int?, durationMs: Double?, reqBytes: Long?, resBytes: Long?, error: String?) {
        if (!isOn) return
        val now = System.currentTimeMillis()
        val ms = durationMs?.takeIf { !it.isNaN() && !it.isInfinite() && it >= 0 }
        record(if (ms != null) now - ms.toLong() else now, method, url, status, ms, reqBytes, resBytes, error)
    }

    /** `SocketTimeoutException: timeout`; the class name alone when there is no message. */
    fun describe(e: Throwable): String {
        val message = e.message?.trim()?.takeIf { it.isNotEmpty() }
        return if (message == null) e.javaClass.simpleName else "${e.javaClass.simpleName}: $message"
    }
}
