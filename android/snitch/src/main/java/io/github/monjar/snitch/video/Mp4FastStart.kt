/*
 * Moves an MP4's `moov` box in front of `mdat` ("fast start", like iOS's
 * shouldOptimizeForNetworkUse) so the dashboard can play a clip while it
 * downloads. MediaMuxer only writes `moov` first when it fits the small space
 * it reserves up front, so longer clips end up with `moov` last.
 *
 * The qt-faststart algorithm: read the (small) moov box, add its size to every
 * stco/co64 chunk offset that pointed before its old position, and rewrite the
 * file as [boxes before the first mdat] + moov + [the rest without moov].
 * Pure java.io; a no-op when the file is already fast-start or unparseable.
 */
package io.github.monjar.snitch.video

import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer

internal object Mp4FastStart {
    private class Box(val type: String, val offset: Long, val size: Long)

    private val CONTAINERS = setOf("moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "udta", "mvex")
    private const val MAX_MOOV_BYTES = 16L * 1024 * 1024

    /** Returns true when the file was rewritten. */
    fun process(file: File): Boolean {
        val boxes = RandomAccessFile(file, "r").use { topLevelBoxes(it) } ?: return false
        val moovIndex = boxes.indexOfFirst { it.type == "moov" }
        val mdatIndex = boxes.indexOfFirst { it.type == "mdat" }
        if (moovIndex < 0 || mdatIndex < 0 || moovIndex < mdatIndex) return false
        val moov = boxes[moovIndex]
        if (moov.size > MAX_MOOV_BYTES) return false

        val moovBytes = ByteArray(moov.size.toInt())
        RandomAccessFile(file, "r").use { raf ->
            raf.seek(moov.offset)
            raf.readFully(moovBytes)
        }
        if (!patchOffsets(ByteBuffer.wrap(moovBytes), 0, moovBytes.size, moov.offset, moov.size)) return false

        val tmp = File(file.parentFile, file.name + ".faststart")
        RandomAccessFile(file, "r").use { input ->
            tmp.outputStream().buffered(64 * 1024).use { out ->
                for ((i, box) in boxes.withIndex()) {
                    if (i == mdatIndex) out.write(moovBytes)
                    if (i == moovIndex) continue
                    copy(input, box.offset, box.size, out)
                }
            }
        }
        if (!tmp.renameTo(file)) {
            file.delete()
            if (!tmp.renameTo(file)) {
                tmp.delete()
                return false
            }
        }
        return true
    }

    private fun topLevelBoxes(raf: RandomAccessFile): List<Box>? {
        val out = ArrayList<Box>()
        val length = raf.length()
        var pos = 0L
        val header = ByteArray(16)
        while (pos + 8 <= length) {
            raf.seek(pos)
            raf.readFully(header, 0, 8)
            var size = ByteBuffer.wrap(header, 0, 4).int.toLong() and 0xFFFFFFFFL
            val type = String(header, 4, 4, Charsets.ISO_8859_1)
            if (size == 1L) {
                if (pos + 16 > length) return null
                raf.readFully(header, 8, 8)
                size = ByteBuffer.wrap(header, 8, 8).long
            } else if (size == 0L) {
                size = length - pos
            }
            if (size < 8 || pos + size > length) return null
            out.add(Box(type, pos, size))
            pos += size
        }
        return out
    }

    /** Walks [buf] boxes in [start, end) and shifts chunk offsets in place. False on a malformed tree. */
    private fun patchOffsets(buf: ByteBuffer, start: Int, end: Int, moovOffset: Long, moovSize: Long): Boolean {
        var pos = start
        while (pos + 8 <= end) {
            val size32 = buf.getInt(pos).toLong() and 0xFFFFFFFFL
            val type = String(byteArrayOf(buf.get(pos + 4), buf.get(pos + 5), buf.get(pos + 6), buf.get(pos + 7)), Charsets.ISO_8859_1)
            var headerSize = 8
            val size = when (size32) {
                1L -> {
                    headerSize = 16
                    if (pos + 16 > end) return false
                    buf.getLong(pos + 8)
                }
                0L -> (end - pos).toLong()
                else -> size32
            }
            if (size < headerSize || pos + size > end) return false
            val boxEnd = (pos + size).toInt()
            when (type) {
                in CONTAINERS -> if (!patchOffsets(buf, pos + headerSize, boxEnd, moovOffset, moovSize)) return false
                "stco" -> {
                    val count = buf.getInt(pos + headerSize + 4)
                    var p = pos + headerSize + 8
                    if (count < 0 || p + count.toLong() * 4 > boxEnd) return false
                    repeat(count) {
                        val old = buf.getInt(p).toLong() and 0xFFFFFFFFL
                        val new = if (old < moovOffset) old + moovSize else old
                        if (new > 0xFFFFFFFFL) return false
                        buf.putInt(p, new.toInt())
                        p += 4
                    }
                }
                "co64" -> {
                    val count = buf.getInt(pos + headerSize + 4)
                    var p = pos + headerSize + 8
                    if (count < 0 || p + count.toLong() * 8 > boxEnd) return false
                    repeat(count) {
                        val old = buf.getLong(p)
                        buf.putLong(p, if (old < moovOffset) old + moovSize else old)
                        p += 8
                    }
                }
            }
            pos = boxEnd
        }
        return true
    }

    private fun copy(input: RandomAccessFile, offset: Long, size: Long, out: java.io.OutputStream) {
        input.seek(offset)
        val buffer = ByteArray(64 * 1024)
        var left = size
        while (left > 0) {
            val n = input.read(buffer, 0, minOf(buffer.size.toLong(), left).toInt())
            if (n < 0) throw java.io.EOFException()
            out.write(buffer, 0, n)
            left -= n
        }
    }
}
