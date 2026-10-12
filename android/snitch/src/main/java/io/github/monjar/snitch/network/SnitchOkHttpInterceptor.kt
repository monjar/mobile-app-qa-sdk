/*
 * Records OkHttp requests in the report timeline (spec §11.5):
 *
 *     OkHttpClient.Builder().addInterceptor(SnitchOkHttpInterceptor()).build()
 *
 * Add it as an application interceptor. It may be installed before Snitch has
 * started (React Native builds its client early) and in store builds: until
 * Snitch is active with `captureNetwork` on — and for requests to the Snitch
 * server — it only reads one flag and passes the request through untouched.
 *
 * While recording it notes the start time, sends the request unchanged and
 * wraps the response body in a byte-counting source, so the event's duration
 * and `resBytes` run to the end of the body (or its failure) — streaming keeps
 * working. Bodies that never get read are recorded when they are closed.
 * Responses without a body to read (HEAD, 101, 204, 304) are recorded at once,
 * and a failed request with its exception text. Headers and bodies are never
 * recorded; the URL is stored sanitized.
 *
 * OkHttp is a compileOnly dependency of the SDK: this class is only loaded when
 * an app uses it, so apps without OkHttp are unaffected. It uses the OkHttp 4
 * API (4.9 in React Native 0.76 and later 4.x).
 */
package io.github.monjar.snitch.network

import okhttp3.Interceptor
import okhttp3.MediaType
import okhttp3.Response
import okhttp3.ResponseBody
import okio.Buffer
import okio.BufferedSource
import okio.ForwardingSource
import okio.buffer
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean

class SnitchOkHttpInterceptor : Interceptor {
    @Throws(IOException::class)
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        if (!NetworkCapture.isOn) return chain.proceed(request)
        val url = request.url.toString()
        if (NetworkCapture.isSnitchServer(url)) return chain.proceed(request)

        val method = request.method
        val startWall = System.currentTimeMillis()
        val startNanos = System.nanoTime()
        val reqBytes = try {
            request.body?.contentLength()?.takeIf { it >= 0 }
        } catch (_: IOException) {
            null
        }
        val response = try {
            chain.proceed(request)
        } catch (e: IOException) {
            NetworkCapture.record(startWall, method, url, null, elapsedMs(startNanos), reqBytes, null, NetworkCapture.describe(e))
            throw e
        }
        val code = response.code
        val body = response.body
        if (body == null || code == 101 || code == 204 || code == 304 || method == "HEAD") {
            val resBytes = if (body == null || code == 101) null else 0L
            NetworkCapture.record(startWall, method, url, code, elapsedMs(startNanos), reqBytes, resBytes, null)
            return response
        }
        val counted = CountingBody(body) { bytes, error ->
            NetworkCapture.record(startWall, method, url, code, elapsedMs(startNanos), reqBytes, bytes, error)
        }
        return response.newBuilder().body(counted).build()
    }

    private class CountingBody(
        private val delegate: ResponseBody,
        private val onDone: (bytes: Long, error: String?) -> Unit,
    ) : ResponseBody() {
        private val done = AtomicBoolean(false)

        @Volatile
        private var bytes = 0L

        private val counting: BufferedSource by lazy {
            object : ForwardingSource(delegate.source()) {
                override fun read(sink: Buffer, byteCount: Long): Long {
                    val n = try {
                        super.read(sink, byteCount)
                    } catch (e: IOException) {
                        finish(NetworkCapture.describe(e))
                        throw e
                    }
                    if (n == -1L) finish(null) else bytes += n
                    return n
                }

                override fun close() {
                    finish(null)
                    super.close()
                }
            }.buffer()
        }

        override fun contentType(): MediaType? = delegate.contentType()

        override fun contentLength(): Long = delegate.contentLength()

        override fun source(): BufferedSource = counting

        private fun finish(error: String?) {
            if (!done.compareAndSet(false, true)) return
            try {
                onDone(bytes, error)
            } catch (_: RuntimeException) {
                // Recording must never break the app's request.
            }
        }
    }

    private companion object {
        fun elapsedMs(startNanos: Long): Double = (System.nanoTime() - startNanos) / 1_000_000.0
    }
}
