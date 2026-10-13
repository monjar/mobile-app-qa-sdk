// Twin of sanitizeUrl in contract/src/timeline.ts. Vectors: contract/vectors/url-sanitize.json.
//
// What a timeline network event stores as its URL: no credentials, no fragment,
// query values replaced by `*`. Plain string surgery on UTF-16 code units, like
// the TypeScript (and Kotlin) versions, so all three give identical output:
//
//   1. No `scheme:` prefix → `…`. A scheme other than http/https, or no `//`
//      after it → `<scheme>:…` (scheme lowercased).
//   2. Cut at the first `#`.
//   3. Authority = after `//` up to the first `/` or `?`; drop everything up to the
//      last `@` (credentials); lowercase it. Empty → `<scheme>:…`.
//   4. Path = from that `/` up to the first `?`, as sent; `/` when there is none.
//   5. Query: split on `&`, skip empty parts, keep each name as `name=*`.
//   6. Longer than TimelineLimits.urlChars UTF-16 code units → the first
//      (limit − 1) plus `…`.
// Every delimiter is ASCII, so cutting at one never splits a surrogate pair.

import Foundation

enum UrlSanitizer {
    private static let colon = UInt16(UInt8(ascii: ":"))
    private static let slash = UInt16(UInt8(ascii: "/"))
    private static let question = UInt16(UInt8(ascii: "?"))
    private static let hash = UInt16(UInt8(ascii: "#"))
    private static let at = UInt16(UInt8(ascii: "@"))
    private static let amp = UInt16(UInt8(ascii: "&"))
    private static let equals = UInt16(UInt8(ascii: "="))

    static func sanitize(_ input: String) -> String {
        let units = Array(input.utf16)
        guard let first = units.first, isAlpha(first) else { return "…" }
        var i = 1
        while i < units.count, isSchemeChar(units[i]) { i += 1 }
        guard i < units.count, units[i] == colon else { return "…" }
        let scheme = string(units[0..<i]).lowercased()

        var rest = Array(units[(i + 1)...])
        guard scheme == "http" || scheme == "https", rest.count >= 2, rest[0] == slash, rest[1] == slash else {
            return "\(scheme):…"
        }
        rest.removeFirst(2)
        if let cut = rest.firstIndex(of: hash) { rest.removeSubrange(cut...) }

        let authorityEnd = rest.firstIndex { $0 == slash || $0 == question } ?? rest.count
        var authority = rest[0..<authorityEnd]
        if let lastAt = authority.lastIndex(of: at) { authority = authority[(lastAt + 1)...] }
        let host = string(authority).lowercased()
        guard !host.isEmpty else { return "\(scheme):…" }

        let tail = rest[authorityEnd...]
        let queryStart = tail.firstIndex(of: question)
        var path = string(queryStart.map { tail[tail.startIndex..<$0] } ?? tail)
        if path.isEmpty { path = "/" }

        var names: [String] = []
        if let q = queryStart {
            for part in tail[(q + 1)...].split(separator: amp, omittingEmptySubsequences: true) {
                let name = part.split(separator: equals, maxSplits: 1, omittingEmptySubsequences: false).first ?? []
                names.append(string(name) + "=*")
            }
        }

        var out = "\(scheme)://\(host)\(path)"
        if !names.isEmpty { out += "?" + names.joined(separator: "&") }
        return TimelineText.truncated(out, maxUTF16: TimelineLimits.urlChars)
    }

    private static func isAlpha(_ u: UInt16) -> Bool {
        (u >= 0x41 && u <= 0x5A) || (u >= 0x61 && u <= 0x7A)
    }

    /// `[a-zA-Z0-9+.-]`
    private static func isSchemeChar(_ u: UInt16) -> Bool {
        isAlpha(u) || (u >= 0x30 && u <= 0x39) || u == 0x2B || u == 0x2E || u == 0x2D
    }

    private static func string<C: Collection>(_ units: C) -> String where C.Element == UInt16 {
        String(decoding: units, as: UTF16.self)
    }
}
