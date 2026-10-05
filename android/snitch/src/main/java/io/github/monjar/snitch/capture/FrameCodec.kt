/*
 * Frame encoding on the capture thread: a cheap content checksum and JPEG.
 *
 * Checksum: FNV-1a over every 16th byte of the bitmap's pixels (spec §5.1), so
 * an unchanged screen is detected without hashing megabytes; the ring drops a
 * frame whose checksum equals the previous one. The pixel buffer and the JPEG
 * output stream are reused between frames. Not thread-safe: one instance per
 * encoding thread.
 *
 * Buffer bookkeeping goes through java.nio.Buffer: compiled against API 34+,
 * ByteBuffer.clear()/position(int) resolve to covariant overrides that older
 * Android versions don't have.
 */
package io.github.monjar.snitch.capture

import android.graphics.Bitmap
import java.io.ByteArrayOutputStream
import java.nio.Buffer
import java.nio.ByteBuffer

internal class FrameCodec {
    private var pixels: ByteBuffer? = null
    private val jpegOut = ByteArrayOutputStream(256 * 1024)

    fun checksum(bitmap: Bitmap): String {
        val needed = bitmap.byteCount
        val buf = pixels?.takeIf { it.capacity() >= needed } ?: ByteBuffer.allocateDirect(needed).also { pixels = it }
        buf.clearCompat()
        bitmap.copyPixelsToBuffer(buf)
        val n = buf.position()
        var h = FNV_OFFSET
        var i = 0
        while (i < n) {
            h = (h xor (buf.get(i).toInt() and 0xFF)) * FNV_PRIME
            i += STRIDE
        }
        return Integer.toHexString(h) + ":" + bitmap.width + "x" + bitmap.height
    }

    fun jpeg(bitmap: Bitmap, quality: Int): ByteArray {
        jpegOut.reset()
        bitmap.compress(Bitmap.CompressFormat.JPEG, quality, jpegOut)
        return jpegOut.toByteArray()
    }

    companion object {
        private const val FNV_OFFSET = -0x7ee3623b // 0x811C9DC5
        private const val FNV_PRIME = 0x01000193
        private const val STRIDE = 16
        const val VIDEO_QUALITY = 55
        const val SCREENSHOT_QUALITY = 80
    }
}

/** Buffer.clear() bound to java.nio.Buffer (see the header). */
internal fun Buffer.clearCompat() {
    clear()
}

/** Buffer.limit(int) + position(int) bound to java.nio.Buffer (see the header). */
internal fun Buffer.setRange(position: Int, limit: Int) {
    limit(limit)
    position(position)
}
