/*
 * A minimal HTTP/1.1 server for JVM unit tests, built on java.net.ServerSocket.
 * The JDK's com.sun.net.httpserver is not on the Android unit-test compile
 * classpath (android.jar replaces the JDK API surface), so tests can't use it.
 *
 * One request per connection (responses carry Connection: close); bodies are
 * read by Content-Length or chunked transfer coding.
 */
package io.github.monjar.snitch.report

import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket

internal class TestHttpServer(
    private val handler: (Request) -> Response,
) {
    class Request(val method: String, val path: String, val headers: Map<String, String>, val body: ByteArray)

    class Response(val status: Int, val headers: Map<String, String> = emptyMap(), val body: ByteArray? = null)

    private val socket = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))

    val port: Int get() = socket.localPort

    init {
        Thread({ acceptLoop() }, "test-http-accept").apply { isDaemon = true }.start()
    }

    fun stop() {
        try {
            socket.close()
        } catch (_: IOException) {
        }
    }

    private fun acceptLoop() {
        while (!socket.isClosed) {
            val client = try {
                socket.accept()
            } catch (_: IOException) {
                return
            }
            Thread({ serve(client) }, "test-http-conn").apply { isDaemon = true }.start()
        }
    }

    private fun serve(client: Socket) {
        client.use { s ->
            val input = BufferedInputStream(s.getInputStream())
            val requestLine = readLine(input) ?: return
            val parts = requestLine.split(' ')
            if (parts.size < 2) return
            val headers = LinkedHashMap<String, String>()
            while (true) {
                val line = readLine(input) ?: return
                if (line.isEmpty()) break
                val colon = line.indexOf(':')
                if (colon > 0) headers[line.substring(0, colon).trim().lowercase()] = line.substring(colon + 1).trim()
            }
            val body = when {
                headers["transfer-encoding"]?.contains("chunked", ignoreCase = true) == true -> readChunked(input)
                headers["content-length"] != null -> readExactly(input, headers.getValue("content-length").toInt())
                else -> ByteArray(0)
            }
            val path = parts[1].substringBefore('?')
            val response = handler(Request(parts[0], path, headers, body))
            val payload = response.body ?: ByteArray(0)
            val head = StringBuilder("HTTP/1.1 ${response.status} ${reason(response.status)}\r\n")
            response.headers.forEach { (k, v) -> head.append(k).append(": ").append(v).append("\r\n") }
            head.append("Content-Length: ").append(payload.size).append("\r\n")
            head.append("Connection: close\r\n\r\n")
            val out = s.getOutputStream()
            out.write(head.toString().toByteArray(Charsets.ISO_8859_1))
            out.write(payload)
            out.flush()
        }
    }

    private fun readLine(input: InputStream): String? {
        val buf = ByteArrayOutputStream()
        while (true) {
            val b = input.read()
            if (b == -1) return if (buf.size() == 0) null else buf.toString(Charsets.ISO_8859_1.name())
            if (b == '\n'.code) break
            if (b != '\r'.code) buf.write(b)
        }
        return buf.toString(Charsets.ISO_8859_1.name())
    }

    private fun readExactly(input: InputStream, n: Int): ByteArray {
        val out = ByteArray(n)
        var read = 0
        while (read < n) {
            val r = input.read(out, read, n - read)
            if (r == -1) break
            read += r
        }
        return if (read == n) out else out.copyOf(read)
    }

    private fun readChunked(input: InputStream): ByteArray {
        val out = ByteArrayOutputStream()
        while (true) {
            val sizeLine = readLine(input) ?: break
            val size = sizeLine.substringBefore(';').trim().toInt(16)
            if (size == 0) {
                // Trailer section ends with an empty line.
                while (true) {
                    val trailer = readLine(input) ?: break
                    if (trailer.isEmpty()) break
                }
                break
            }
            out.write(readExactly(input, size))
            readLine(input) // CRLF after each chunk
        }
        return out.toByteArray()
    }

    private fun reason(status: Int): String = when (status) {
        200 -> "OK"
        201 -> "Created"
        304 -> "Not Modified"
        401 -> "Unauthorized"
        403 -> "Forbidden"
        404 -> "Not Found"
        409 -> "Conflict"
        413 -> "Payload Too Large"
        415 -> "Unsupported Media Type"
        422 -> "Unprocessable Entity"
        429 -> "Too Many Requests"
        500 -> "Internal Server Error"
        503 -> "Service Unavailable"
        else -> "Status"
    }
}
