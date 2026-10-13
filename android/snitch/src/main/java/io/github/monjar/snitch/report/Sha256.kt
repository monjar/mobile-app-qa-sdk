/*
 * SHA-256 as lowercase hex, for attachment declarations and the
 * X-Content-SHA256 / X-Chunk-SHA256 upload headers. Files (and byte ranges of
 * them) are streamed, never loaded whole.
 */
package io.github.monjar.snitch.report

import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.security.MessageDigest

internal object Sha256 {
    fun hex(bytes: ByteArray): String = toHex(MessageDigest.getInstance("SHA-256").digest(bytes))

    fun hex(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buffer)
                if (n < 0) break
                digest.update(buffer, 0, n)
            }
        }
        return toHex(digest.digest())
    }

    /** The hash of [length] bytes of [file] starting at [start]. */
    fun hex(file: File, start: Long, length: Long): String {
        val digest = MessageDigest.getInstance("SHA-256")
        RandomAccessFile(file, "r").use { raf ->
            raf.seek(start)
            val buffer = ByteArray(64 * 1024)
            var remaining = length
            while (remaining > 0) {
                val n = raf.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
                if (n < 0) throw IOException("${file.name} ended $remaining bytes early")
                digest.update(buffer, 0, n)
                remaining -= n
            }
        }
        return toHex(digest.digest())
    }

    private fun toHex(bytes: ByteArray): String {
        val out = CharArray(bytes.size * 2)
        for (i in bytes.indices) {
            val v = bytes[i].toInt() and 0xFF
            out[i * 2] = HEX[v ushr 4]
            out[i * 2 + 1] = HEX[v and 0x0F]
        }
        return String(out)
    }

    private val HEX = "0123456789abcdef".toCharArray()
}
