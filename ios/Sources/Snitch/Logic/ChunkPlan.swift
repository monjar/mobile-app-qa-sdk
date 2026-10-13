// Chunked, resumable attachment upload (spec §11.2; protocol in the header of
// contract/src/ingest.ts): which chunk size to use, whether a file is sent in
// chunks at all, and the byte range and Content-Range of the next chunk.
// Pure, so the arithmetic is tested apart from the uploader's state machine.

import Foundation

enum ChunkPlan {
    /// CHUNK_BYTES_MIN / _MAX / _DEFAULT.
    static let minBytes = 64 * 1024
    static let maxBytes = 8 * 1024 * 1024
    static let defaultBytes = 1024 * 1024

    /// The server's preferred size (or the default) clamped to MIN…MAX, then capped by the
    /// SNITCH_DEBUG_CHUNK_BYTES hook — which can't go below MIN either.
    static func chunkBytes(server: Int?, debugCap: Int?) -> Int {
        var bytes = (server ?? defaultBytes).clamped(minBytes, maxBytes)
        if let cap = debugCap, cap > 0 {
            bytes = min(bytes, max(cap, minBytes))
        }
        return bytes
    }

    /// Chunks only for a resumable upload of a file larger than one chunk; everything
    /// else is one whole-file PUT, exactly as before 0.3.
    static func isChunked(resumable: Bool, size: Int, chunkBytes: Int) -> Bool {
        resumable && chunkBytes > 0 && size > chunkBytes
    }

    /// The next chunk from `offset` (end inclusive), or nil when `offset` is not inside the file.
    static func nextRange(offset: Int, size: Int, chunkBytes: Int) -> ClosedRange<Int>? {
        guard chunkBytes > 0, offset >= 0, offset < size else { return nil }
        return offset...(min(offset + chunkBytes, size) - 1)
    }

    /// `bytes <start>-<end>/<total>`
    static func contentRange(_ range: ClosedRange<Int>, total: Int) -> String {
        "bytes \(range.lowerBound)-\(range.upperBound)/\(total)"
    }
}
