/*
 * Chunk arithmetic for the resumable attachment upload (spec §11.2,
 * contract/src/ingest.ts): the chunk size the SDK uses, whether a file goes in
 * chunks, the next byte range and its Content-Range header.
 *
 * - The size is the server's `upload.chunkBytes` (CHUNK_BYTES_DEFAULT when it
 *   gave none) clamped to CHUNK_BYTES_MIN…MAX; the SNITCH_DEBUG_CHUNK_BYTES test
 *   hook can only lower it, and never below the minimum.
 * - A file larger than the chunk size goes in chunks when the server is
 *   resumable; anything else is one whole-file PUT.
 * - Ranges are inclusive, as in HTTP: `bytes <start>-<end>/<total>`.
 *
 * Pure Kotlin; the Uploader does the I/O.
 */
package io.github.monjar.snitch.logic

object ChunkPlan {
    const val MIN_BYTES = 64L * 1024
    const val MAX_BYTES = 8L * 1024 * 1024
    const val DEFAULT_BYTES = 1024L * 1024

    /** The chunk size to use for the server's [serverChunkBytes] and an optional debug [cap]. */
    @JvmStatic
    fun chunkBytes(serverChunkBytes: Long?, cap: Long?): Long {
        var size = (serverChunkBytes?.takeIf { it > 0 } ?: DEFAULT_BYTES).coerceIn(MIN_BYTES, MAX_BYTES)
        if (cap != null && cap > 0) size = minOf(size, cap).coerceAtLeast(MIN_BYTES)
        return size
    }

    @JvmStatic
    fun isChunked(resumable: Boolean, size: Long, chunkBytes: Long): Boolean = resumable && size > chunkBytes

    /**
     * Where to resume a file of [size] bytes the server has [offset] bytes of. An
     * unknown or impossible offset — including all of it, whose answer got lost —
     * starts over at 0; the server then verifies or answers with its real offset.
     */
    @JvmStatic
    fun resumeAt(offset: Long?, size: Long): Long = if (offset == null || offset < 0 || offset >= size) 0 else offset

    /** The inclusive last byte of the chunk starting at [start]. */
    @JvmStatic
    fun endOf(start: Long, size: Long, chunkBytes: Long): Long = minOf(start + chunkBytes, size) - 1

    @JvmStatic
    fun contentRange(start: Long, end: Long, total: Long): String = "bytes $start-$end/$total"
}
