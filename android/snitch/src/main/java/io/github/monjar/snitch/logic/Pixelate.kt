/*
 * The markup editor's Blur tool (spec §11.7): pixelation in 16-pixel blocks of
 * the image, applied to the pixels themselves, so what was under a blurred box
 * cannot be recovered from the sent JPEG.
 *
 * Blocks are aligned to the image grid (not to the box), so overlapping blurs
 * line up. Each block of the region becomes the average colour of the pixels
 * it covers inside the region. Pure Kotlin on an ARGB IntArray: the editor reads
 * the region with Bitmap.getPixels and writes it back with setPixels.
 */
package io.github.monjar.snitch.logic

object Pixelate {
    const val BLOCK = 16

    /**
     * Pixelates [pixels], a [width] × [height] ARGB region whose top-left pixel is at
     * ([left], [top]) in the image, in [block]-pixel squares of the image grid.
     */
    @JvmStatic
    fun region(pixels: IntArray, width: Int, height: Int, left: Int, top: Int, block: Int = BLOCK) {
        if (width <= 0 || height <= 0 || block <= 1) return
        require(left >= 0 && top >= 0) { "the region must lie inside the image" }
        require(pixels.size >= width * height) { "pixels holds ${pixels.size}, need ${width * height}" }
        var by = top / block * block
        while (by < top + height) {
            val y0 = maxOf(by, top) - top
            val y1 = minOf(by + block, top + height) - top
            var bx = left / block * block
            while (bx < left + width) {
                val x0 = maxOf(bx, left) - left
                val x1 = minOf(bx + block, left + width) - left
                fill(pixels, width, x0, y0, x1, y1)
                bx += block
            }
            by += block
        }
    }

    /** Replaces [x0, x1) × [y0, y1) of [pixels] (row stride [stride]) with its average colour. */
    private fun fill(pixels: IntArray, stride: Int, x0: Int, y0: Int, x1: Int, y1: Int) {
        var a = 0L
        var r = 0L
        var g = 0L
        var b = 0L
        for (y in y0 until y1) {
            val row = y * stride
            for (x in x0 until x1) {
                val p = pixels[row + x]
                a += (p ushr 24) and 0xFF
                r += (p shr 16) and 0xFF
                g += (p shr 8) and 0xFF
                b += p and 0xFF
            }
        }
        val n = ((x1 - x0) * (y1 - y0)).toLong()
        if (n <= 0) return
        val avg = (((a / n).toInt() and 0xFF) shl 24) or (((r / n).toInt() and 0xFF) shl 16) or
            (((g / n).toInt() and 0xFF) shl 8) or ((b / n).toInt() and 0xFF)
        for (y in y0 until y1) {
            val row = y * stride
            for (x in x0 until x1) pixels[row + x] = avg
        }
    }
}
