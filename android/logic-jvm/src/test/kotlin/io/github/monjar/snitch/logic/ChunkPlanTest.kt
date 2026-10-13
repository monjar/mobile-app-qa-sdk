/*
 * Chunk sizes (server value clamped to CHUNK_BYTES_MIN…MAX, the debug cap only
 * lowering it), resume offsets, and ranges that cover a file exactly once with
 * Content-Range headers the contract's parseContentRange accepts.
 */
package io.github.monjar.snitch.logic

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class ChunkPlanTest {
    @Test
    fun `chunk size follows the server within the contract bounds`() {
        assertEquals(ChunkPlan.DEFAULT_BYTES, ChunkPlan.chunkBytes(null, null))
        assertEquals(ChunkPlan.DEFAULT_BYTES, ChunkPlan.chunkBytes(0, null))
        assertEquals(2L * 1024 * 1024, ChunkPlan.chunkBytes(2L * 1024 * 1024, null))
        assertEquals(ChunkPlan.MIN_BYTES, ChunkPlan.chunkBytes(1000, null))
        assertEquals(ChunkPlan.MAX_BYTES, ChunkPlan.chunkBytes(100L * 1024 * 1024, null))
        assertEquals(65_536L, ChunkPlan.MIN_BYTES)
        assertEquals(8_388_608L, ChunkPlan.MAX_BYTES)
        assertEquals(1_048_576L, ChunkPlan.DEFAULT_BYTES)
    }

    @Test
    fun `the debug cap only lowers the size, never below the minimum`() {
        assertEquals(100_000L, ChunkPlan.chunkBytes(1_048_576, 100_000))
        assertEquals(ChunkPlan.MIN_BYTES, ChunkPlan.chunkBytes(1_048_576, 1))
        assertEquals(1_048_576L, ChunkPlan.chunkBytes(1_048_576, 5_000_000))
        assertEquals(1_048_576L, ChunkPlan.chunkBytes(1_048_576, 0))
    }

    @Test
    fun `only files larger than a chunk on resumable servers go in chunks`() {
        assertTrue(ChunkPlan.isChunked(true, 65_537, 65_536))
        assertFalse(ChunkPlan.isChunked(true, 65_536, 65_536))
        assertFalse(ChunkPlan.isChunked(false, 10_000_000, 65_536))
    }

    @Test
    fun `resume offsets outside the file start over`() {
        assertEquals(0L, ChunkPlan.resumeAt(null, 100))
        assertEquals(40L, ChunkPlan.resumeAt(40, 100))
        assertEquals(0L, ChunkPlan.resumeAt(100, 100))
        assertEquals(0L, ChunkPlan.resumeAt(-5, 100))
    }

    @Test
    fun `ranges cover every byte once with valid headers`() {
        val parse = Regex("^bytes (\\d{1,12})-(\\d{1,12})/(\\d{1,12})$")
        for (size in listOf(65_537L, 200_000L, 196_608L, 1_000_003L)) {
            val chunk = 65_536L
            var start = 0L
            var covered = 0L
            var chunks = 0
            while (start < size) {
                val end = ChunkPlan.endOf(start, size, chunk)
                val header = ChunkPlan.contentRange(start, end, size)
                val m = parse.find(header)!!.groupValues
                assertEquals(start, m[1].toLong())
                assertTrue(m[2].toLong() in start until size, header)
                assertTrue(end - start + 1 <= chunk)
                covered += end - start + 1
                start = end + 1
                chunks++
            }
            assertEquals(size, covered)
            assertEquals(((size + chunk - 1) / chunk).toInt(), chunks)
        }
        assertEquals("bytes 0-65535/200000", ChunkPlan.contentRange(0, ChunkPlan.endOf(0, 200_000, 65_536), 200_000))
        assertEquals(199_999L, ChunkPlan.endOf(196_608, 200_000, 65_536))
    }
}
