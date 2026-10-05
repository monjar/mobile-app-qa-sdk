/*
 * Mp4FastStart on a synthetic MP4 (ftyp, free, mdat, moov/trak/mdia/minf/stbl/stco):
 * moov must end up before mdat, chunk offsets must still point at the same
 * sample bytes, and an already fast-start file must be left alone.
 */
package io.github.monjar.snitch.video

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer

class Mp4FastStartTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private fun box(type: String, payload: ByteArray): ByteArray =
        ByteBuffer.allocate(8 + payload.size).putInt(8 + payload.size).put(type.toByteArray(Charsets.ISO_8859_1)).put(payload).array()

    private fun stco(offsets: List<Int>): ByteArray {
        val b = ByteBuffer.allocate(8 + offsets.size * 4).putInt(0).putInt(offsets.size)
        offsets.forEach { b.putInt(it) }
        return box("stco", b.array())
    }

    private fun moov(offsets: List<Int>) =
        box("moov", box("mvhd", ByteArray(20)) + box("trak", box("mdia", box("minf", box("stbl", stco(offsets))))))

    private fun topLevel(bytes: ByteArray): List<String> {
        val out = ArrayList<String>()
        var i = 0
        while (i + 8 <= bytes.size) {
            val size = ByteBuffer.wrap(bytes, i, 4).int
            out.add(String(bytes, i + 4, 4, Charsets.ISO_8859_1))
            i += size
        }
        return out
    }

    private fun offsetsIn(bytes: ByteArray): List<Int> {
        val at = String(bytes, Charsets.ISO_8859_1).indexOf("stco") + 4 + 4
        val count = ByteBuffer.wrap(bytes, at, 4).int
        return (0 until count).map { ByteBuffer.wrap(bytes, at + 4 + it * 4, 4).int }
    }

    @Test
    fun `moves moov before mdat and fixes chunk offsets`() {
        val ftyp = box("ftyp", "isom\u0000\u0000\u0000\u0000isom".toByteArray(Charsets.ISO_8859_1))
        val free = box("free", ByteArray(16))
        val samples = listOf("AAAA", "BBBBBB", "CC").map { it.toByteArray() }
        val mdatStart = ftyp.size + free.size
        val sampleOffsets = samples.runningFold(mdatStart + 8) { acc, s -> acc + s.size }.dropLast(1)
        val mdat = box("mdat", samples.fold(ByteArray(0)) { a, s -> a + s })
        val original = ByteArrayOutputStream().apply {
            write(ftyp)
            write(free)
            write(mdat)
            write(moov(sampleOffsets))
        }.toByteArray()
        val file = tmp.newFile("clip.mp4").apply { writeBytes(original) }

        assertTrue(Mp4FastStart.process(file))

        val out = file.readBytes()
        assertEquals(listOf("ftyp", "free", "moov", "mdat"), topLevel(out))
        assertEquals(original.size, out.size)
        val offsets = offsetsIn(out)
        for ((i, s) in samples.withIndex()) {
            assertArrayEquals(s, out.copyOfRange(offsets[i], offsets[i] + s.size))
        }
    }

    @Test
    fun `leaves fast-start files alone`() {
        val ftyp = box("ftyp", ByteArray(8))
        val m = moov(listOf(0))
        val bytes = ftyp + m + box("mdat", ByteArray(4))
        val file = File(tmp.root, "ok.mp4").apply { writeBytes(bytes) }
        assertFalse(Mp4FastStart.process(file))
        assertArrayEquals(bytes, file.readBytes())
    }

    @Test
    fun `ignores files it cannot parse`() {
        val file = tmp.newFile("junk.mp4").apply { writeBytes(ByteArray(100) { 7 }) }
        assertFalse(Mp4FastStart.process(file))
    }
}
