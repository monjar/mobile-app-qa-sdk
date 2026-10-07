// SHA-256 (lowercase hex) of attachment files, streamed so a 30 MB video never
// sits in memory twice. CryptoKit is available from iOS 13.

import CryptoKit
import Foundation

enum Hashing {
    static func sha256Hex(_ data: Data) -> String {
        hex(SHA256.hash(data: data))
    }

    static func sha256Hex(fileAt url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while true {
            let chunk = try handle.read(upToCount: 1 << 20) ?? Data()
            if chunk.isEmpty { break }
            hasher.update(data: chunk)
        }
        return hex(hasher.finalize())
    }

    private static func hex(_ digest: SHA256.Digest) -> String {
        digest.map { String(format: "%02x", $0) }.joined()
    }
}
