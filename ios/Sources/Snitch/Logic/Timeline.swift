// The report timeline's data model (contract/src/timeline.ts): the event kinds,
// the per-kind limits the recorder keeps (TIMELINE_LIMITS) and the bounded ring
// they live in. Pure Foundation, so limits and encoding are unit-tested directly.
//
// Times are wall-clock epoch milliseconds (Int64), taken when the event happens;
// touches are the exception — they are stored in monotonic ms and converted once
// when the recorder is frozen (see TimelineRecorder).

import Foundation

/// TIMELINE_LIMITS, plus the schema's per-field caps.
enum TimelineLimits {
    static let logs = 500
    static let network = 100
    static let screens = 50
    static let touches = 300
    static let app = 50
    /// UTF-16 code units per log message; longer ones are cut and end with `…`.
    static let msgChars = 2000
    /// UTF-16 code units per sanitized URL.
    static let urlChars = 500
    static let maxAgeMs: Int64 = 5 * 60 * 1000
    /// ATTACHMENT_LIMITS['application/x-ndjson'].
    static let maxBytes = 2 * 1024 * 1024

    static let tagChars = 64
    static let methodChars = 16
    static let errorChars = 300
    static let screenChars = 200
}

enum TimelineLogLevel: String {
    case debug, info, warn, error
}

enum TimelineLogSource: String {
    case app, js, native, logcat, sdk
}

enum TimelineScreenSource: String {
    case app, native
}

enum TimelineAppEvent: String {
    case launch, foreground, background
    case memoryWarning = "memory_warning"
}

struct TimelineNet: Equatable {
    /// When the request started.
    var t: Int64
    var method: String
    /// Already sanitized (UrlSanitizer).
    var url: String
    var status: Int?
    var ms: Double?
    var reqBytes: Int?
    var resBytes: Int?
    var error: String?
}

enum TimelineEvent: Equatable {
    case log(t: Int64, level: TimelineLogLevel, source: TimelineLogSource, message: String, tag: String?)
    case net(TimelineNet)
    case screen(t: Int64, name: String, source: TimelineScreenSource)
    /// `x`/`y` as a fraction of the screen, `fingers` down at that moment.
    case touch(t: Int64, x: Double, y: Double, fingers: Int?)
    case app(t: Int64, event: TimelineAppEvent)

    var t: Int64 {
        switch self {
        case let .log(t, _, _, _, _): return t
        case let .net(net): return net.t
        case let .screen(t, _, _): return t
        case let .touch(t, _, _, _): return t
        case let .app(t, _): return t
        }
    }

    var isLog: Bool {
        if case .log = self { return true }
        return false
    }
}

/// A FIFO with a fixed capacity: appending beyond it evicts the oldest elements.
struct BoundedRing<Element> {
    let capacity: Int
    private(set) var items: [Element] = []

    init(capacity: Int) {
        self.capacity = max(1, capacity)
    }

    /// Appends `element`; returns how many of the oldest elements were evicted to make room.
    @discardableResult
    mutating func append(_ element: Element) -> Int {
        items.append(element)
        let over = items.count - capacity
        guard over > 0 else { return 0 }
        items.removeFirst(over)
        return over
    }

    /// Drops leading elements while `predicate` holds (age pruning: oldest first).
    mutating func removeLeading(while predicate: (Element) -> Bool) {
        let keepFrom = items.firstIndex { !predicate($0) } ?? items.count
        if keepFrom > 0 { items.removeFirst(keepFrom) }
    }

    mutating func removeAll() {
        items.removeAll()
    }

    var isEmpty: Bool {
        items.isEmpty
    }
}

enum TimelineText {
    /// `s` if it fits in `maxUTF16` UTF-16 code units, else the first (max − 1) units plus `…`
    /// (one unit), backing off one unit rather than splitting a surrogate pair.
    static func truncated(_ s: String, maxUTF16: Int) -> String {
        let units = s.utf16
        guard units.count > maxUTF16, maxUTF16 >= 1 else { return s }
        var keep = Array(units.prefix(maxUTF16 - 1))
        if let last = keep.last, UTF16.isLeadSurrogate(last) { keep.removeLast() }
        return String(decoding: keep, as: UTF16.self) + "…"
    }

    /// Trimmed and truncated; nil when nothing is left.
    static func field(_ s: String?, maxUTF16: Int) -> String? {
        guard let trimmed = s?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
        return truncated(trimmed, maxUTF16: maxUTF16)
    }

    /// Wall-clock now in epoch milliseconds.
    static func nowMs(_ date: Date = Date()) -> Int64 {
        Int64((date.timeIntervalSince1970 * 1000).rounded())
    }
}
