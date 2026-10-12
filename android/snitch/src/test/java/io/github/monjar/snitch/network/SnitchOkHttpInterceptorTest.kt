/*
 * SnitchOkHttpInterceptor in a real OkHttp client against TestHttpServer, and
 * Snitch.recordNetwork: nothing is recorded while network capture is off or
 * for the Snitch server; recorded requests keep only the method, the sanitized
 * URL, status, duration, byte counts and the error text.
 */
package io.github.monjar.snitch.network

import io.github.monjar.snitch.Snitch
import io.github.monjar.snitch.SnitchState
import io.github.monjar.snitch.logic.TimelineEvent
import io.github.monjar.snitch.report.TestHttpServer
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.TimeUnit

class SnitchOkHttpInterceptorTest {
    private lateinit var server: TestHttpServer
    private val client = OkHttpClient.Builder()
        .addInterceptor(SnitchOkHttpInterceptor())
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.SECONDS)
        .build()

    private val base get() = "http://127.0.0.1:${server.port}"

    @Before
    fun setUp() {
        server = TestHttpServer { req ->
            when (req.path) {
                "/empty" -> TestHttpServer.Response(204)
                "/missing" -> TestHttpServer.Response(404, body = "nope".toByteArray())
                else -> TestHttpServer.Response(200, mapOf("Content-Type" to "text/plain"), "hello ${req.path}".toByteArray())
            }
        }
        SnitchState.serverOrigin = null
        SnitchState.timeline.configure(active = true, console = true, network = true, screens = true)
    }

    @After
    fun tearDown() {
        server.stop()
        SnitchState.timeline.configure(active = false, console = false, network = false, screens = false)
        SnitchState.serverOrigin = null
    }

    /** Recorded requests whose URL contains [marker]. */
    private fun recorded(marker: String): List<TimelineEvent.Net> =
        SnitchState.timeline.freeze().events.filterIsInstance<TimelineEvent.Net>().filter { it.url.contains(marker) }

    private fun get(path: String): String = client.newCall(Request.Builder().url(base + path).build()).execute().use { it.body!!.string() }

    @Test
    fun `nothing is recorded while network capture is off`() {
        SnitchState.timeline.configure(active = true, console = true, network = false, screens = true)
        assertEquals("hello /off", get("/off"))
        SnitchState.timeline.configure(active = false, console = true, network = true, screens = true)
        assertEquals("hello /inactive", get("/inactive"))
        SnitchState.timeline.configure(active = true, console = true, network = true, screens = true)
        assertTrue(recorded("/off").isEmpty())
        assertTrue(recorded("/inactive").isEmpty())
    }

    @Test
    fun `a request is recorded with its sanitized URL, status and sizes`() {
        val before = System.currentTimeMillis()
        assertEquals("hello /items", get("/items?token=secret&page=2#frag"))
        val e = recorded("/items").single()
        assertEquals("GET", e.method)
        assertEquals("$base/items?token=*&page=*", e.url)
        assertEquals(200, e.status)
        assertEquals("hello /items".length.toLong(), e.resBytes)
        assertNull(e.reqBytes)
        assertNull(e.error)
        assertNotNull(e.ms)
        assertTrue(e.t >= before && e.t <= System.currentTimeMillis())
    }

    @Test
    fun `request bodies are counted, never recorded`() {
        val body = "{\"password\":\"hunter2\"}".toRequestBody("application/json".toMediaType())
        client.newCall(Request.Builder().url("$base/login").post(body).build()).execute().use { it.body!!.string() }
        val e = recorded("/login").single()
        assertEquals("POST", e.method)
        assertEquals(22L, e.reqBytes)
        assertTrue(e.toString().contains("hunter2").not())
    }

    @Test
    fun `responses without a body and error statuses are recorded`() {
        client.newCall(Request.Builder().url("$base/empty").build()).execute().close()
        assertEquals(204, recorded("/empty").single().status)
        assertEquals(0L, recorded("/empty").single().resBytes)
        client.newCall(Request.Builder().url("$base/missing").build()).execute().use { it.body!!.string() }
        assertEquals(404, recorded("/missing").single().status)
    }

    @Test
    fun `a body closed without reading is still recorded`() {
        client.newCall(Request.Builder().url("$base/unread").build()).execute().close()
        val e = recorded("/unread").single()
        assertEquals(200, e.status)
        assertEquals(0L, e.resBytes)
    }

    @Test
    fun `a failed request is recorded with the error`() {
        val closed = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { it.localPort }
        val url = "http://127.0.0.1:$closed/refused"
        try {
            client.newCall(Request.Builder().url(url).build()).execute().close()
        } catch (_: IOException) {
            // Expected: nothing listens there.
        }
        val e = recorded("/refused").single()
        assertNull(e.status)
        assertTrue(e.error!!.contains("Exception"))
    }

    @Test
    fun `requests to the Snitch server are never recorded`() {
        SnitchState.serverOrigin = "127.0.0.1:${server.port}"
        assertEquals("hello /api/v1/reports", get("/api/v1/reports"))
        Snitch.recordNetwork("PUT", "$base/api/v1/reports/R1/attachments/video", 202, 12.0, 100, 10, null)
        assertTrue(recorded("/api/v1/reports").isEmpty())
    }

    @Test
    fun `recordNetwork dates the request from its duration`() {
        val before = System.currentTimeMillis()
        Snitch.recordNetwork("get", "https://u:p@API.example.com/v1/facts?id=7", null, 1500.0, null, null, "timeout")
        val e = recorded("api.example.com/v1/facts").single()
        assertEquals("GET", e.method)
        assertEquals("https://api.example.com/v1/facts?id=*", e.url)
        assertEquals("timeout", e.error)
        assertEquals(1500.0, e.ms!!, 0.0)
        assertTrue(e.t <= System.currentTimeMillis() - 1500 && e.t >= before - 1500)

        SnitchState.timeline.configure(active = true, console = true, network = false, screens = true)
        Snitch.recordNetwork("GET", "https://api.example.com/off", 200, 1.0, null, null, null)
        SnitchState.timeline.configure(active = true, console = true, network = true, screens = true)
        assertTrue(recorded("/off").isEmpty())
    }
}
