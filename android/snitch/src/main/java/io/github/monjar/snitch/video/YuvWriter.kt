/*
 * ARGB → YUV 4:2:0 into a MediaCodec input Image (COLOR_FormatYUV420Flexible),
 * honouring each plane's row and pixel stride, so the same code serves I420
 * (pixelStride 1) and NV12/NV21 (pixelStride 2, interleaved chroma) encoders.
 * BT.601 limited range; chroma is the average of each 2×2 block.
 *
 * Luma rows are written in bulk; chroma with absolute puts (interleaved planes
 * share memory, so a bulk row write into one would clobber the other).
 */
package io.github.monjar.snitch.video

import android.media.Image
import java.nio.Buffer

internal class YuvWriter(private val width: Int, private val height: Int) {
    private val row = ByteArray(width)

    fun write(image: Image, argb: IntArray) {
        val planes = image.planes
        val crop = image.cropRect
        val left = crop?.left ?: 0
        val top = crop?.top ?: 0
        val yPlane = planes[0]
        val yBuf = yPlane.buffer
        val yRow = yPlane.rowStride
        val yPix = yPlane.pixelStride
        for (y in 0 until height) {
            val base = y * width
            for (x in 0 until width) {
                val c = argb[base + x]
                val r = (c shr 16) and 0xFF
                val g = (c shr 8) and 0xFF
                val b = c and 0xFF
                row[x] = (((66 * r + 129 * g + 25 * b + 128) shr 8) + 16).toByte()
            }
            val offset = (top + y) * yRow + left * yPix
            if (yPix == 1) {
                yBuf.seek(offset)
                yBuf.put(row, 0, width)
            } else {
                for (x in 0 until width) yBuf.put(offset + x * yPix, row[x])
            }
        }
        val uPlane = planes[1]
        val vPlane = planes[2]
        val uBuf = uPlane.buffer
        val vBuf = vPlane.buffer
        val uRow = uPlane.rowStride
        val vRow = vPlane.rowStride
        val uPix = uPlane.pixelStride
        val vPix = vPlane.pixelStride
        val cw = width / 2
        val ch = height / 2
        for (y in 0 until ch) {
            val r0 = 2 * y * width
            val r1 = r0 + width
            for (x in 0 until cw) {
                val i = r0 + 2 * x
                val j = r1 + 2 * x
                val c0 = argb[i]
                val c1 = argb[i + 1]
                val c2 = argb[j]
                val c3 = argb[j + 1]
                val r = (((c0 shr 16) and 0xFF) + ((c1 shr 16) and 0xFF) + ((c2 shr 16) and 0xFF) + ((c3 shr 16) and 0xFF)) shr 2
                val g = (((c0 shr 8) and 0xFF) + ((c1 shr 8) and 0xFF) + ((c2 shr 8) and 0xFF) + ((c3 shr 8) and 0xFF)) shr 2
                val b = ((c0 and 0xFF) + (c1 and 0xFF) + (c2 and 0xFF) + (c3 and 0xFF)) shr 2
                val u = ((-38 * r - 74 * g + 112 * b + 128) shr 8) + 128
                val v = ((112 * r - 94 * g - 18 * b + 128) shr 8) + 128
                uBuf.put((top / 2 + y) * uRow + (left / 2 + x) * uPix, u.toByte())
                vBuf.put((top / 2 + y) * vRow + (left / 2 + x) * vPix, v.toByte())
            }
        }
    }
}

/** Buffer.position(int) bound to java.nio.Buffer: ByteBuffer's covariant override is missing on older Android. */
private fun Buffer.seek(position: Int) {
    position(position)
}
