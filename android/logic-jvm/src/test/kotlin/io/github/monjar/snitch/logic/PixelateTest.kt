/*
 * The Blur tool's pixelation: 16-pixel blocks aligned to the image grid, each
 * the average colour of what it covered, so the original pixels are gone.
 */
package io.github.monjar.snitch.logic

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class PixelateTest {
    private fun argb(a: Int, r: Int, g: Int, b: Int) = (a shl 24) or (r shl 16) or (g shl 8) or b

    @Test
    fun `a whole block becomes its average colour`() {
        val px = IntArray(16 * 16) { i -> if (i % 2 == 0) argb(255, 200, 0, 100) else argb(255, 0, 100, 0) }
        Pixelate.region(px, 16, 16, 0, 0)
        assertTrue(px.all { it == argb(255, 100, 50, 50) })
    }

    @Test
    fun `blocks align to the image grid, not to the region`() {
        // A 20×10 region at (10, 4): it spans image columns 10..29 → grid blocks [0,16) and [16,32).
        val w = 20
        val h = 10
        val px = IntArray(w * h) { i -> argb(255, (i % w) * 10, 0, 0) }
        Pixelate.region(px, w, h, 10, 4)
        for (y in 0 until h) {
            val row = (0 until w).map { (px[y * w + it] shr 16) and 0xFF }
            // Columns 10..15 (6 px: reds 0..50 → 25) and 16..29 (14 px: reds 60..190 → 125).
            assertEquals(List(6) { 25 } + List(14) { 125 }, row)
        }
    }

    @Test
    fun `nothing of the original survives inside a block`() {
        val w = 48
        val h = 32
        val px = IntArray(w * h) { it * 7919 or (0xFF shl 24) }
        Pixelate.region(px, w, h, 0, 0)
        for (by in 0 until h step 16) {
            for (bx in 0 until w step 16) {
                val first = px[by * w + bx]
                for (y in by until by + 16) for (x in bx until bx + 16) assertEquals(first, px[y * w + x])
            }
        }
    }

    @Test
    fun `empty regions and tiny blocks are no-ops`() {
        val px = intArrayOf(1, 2, 3, 4)
        Pixelate.region(px, 0, 2, 0, 0)
        Pixelate.region(px, 2, 2, 0, 0, block = 1)
        assertEquals(listOf(1, 2, 3, 4), px.toList())
    }
}
