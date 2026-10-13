// The `timeline` attachment's wire format (contract/src/timeline.ts):
// application/x-ndjson, a `meta` line, then one JSON object per event in time
// order. Lines are written by hand rather than with JSONEncoder so key order is
// stable (`k` first, as in contract/fixtures/timeline.ndjson) and every field is
// clamped to the schema here, in one place.
//
// The document stays under the 2 MB attachment cap by dropping the oldest log
// lines first (then, only if logs alone can't make room, the oldest of anything);
// what was dropped is added to `meta.dropped`.

import Foundation

struct TimelineMeta: Equatable {
    var start: Int64
    var end: Int64
    var videoStart: Int64?
    var videoEnd: Int64?
    var dropped: Int
}

struct TimelineDocument {
    var data: Data
    var meta: TimelineMeta
    /// Event lines written (the meta line not counted).
    var eventCount: Int
}

enum TimelineEncoding {
    static let platform = "ios"
    /// Room kept for the meta line when fitting events under the cap.
    static let metaReserve = 512

    // MARK: - Lines

    static func line(_ event: TimelineEvent) -> String {
        var o = JSONObjectWriter()
        switch event {
        case let .log(t, level, source, message, tag):
            o.add("k", "log")
            o.add("t", t)
            o.add("level", level.rawValue)
            o.add("src", source.rawValue)
            o.add("msg", TimelineText.truncated(message, maxUTF16: TimelineLimits.msgChars))
            if let tag = TimelineText.field(tag, maxUTF16: TimelineLimits.tagChars) { o.add("tag", tag) }
        case let .net(net):
            o.add("k", "net")
            o.add("t", net.t)
            o.add("method", TimelineText.field(net.method.uppercased(), maxUTF16: TimelineLimits.methodChars) ?? "GET")
            o.add("url", TimelineText.truncated(net.url, maxUTF16: TimelineLimits.urlChars))
            if let status = net.status, (100...999).contains(status) { o.add("status", status) }
            if let ms = net.ms, ms >= 0 { o.add("ms", number: ms) }
            if let bytes = net.reqBytes, bytes >= 0 { o.add("reqBytes", bytes) }
            if let bytes = net.resBytes, bytes >= 0 { o.add("resBytes", bytes) }
            if let error = TimelineText.field(net.error, maxUTF16: TimelineLimits.errorChars) { o.add("error", error) }
        case let .screen(t, name, source):
            o.add("k", "screen")
            o.add("t", t)
            o.add("name", TimelineText.field(name, maxUTF16: TimelineLimits.screenChars) ?? "?")
            o.add("src", source.rawValue)
        case let .touch(t, x, y, fingers):
            o.add("k", "touch")
            o.add("t", t)
            o.add("x", number: x.clamped(0, 1))
            o.add("y", number: y.clamped(0, 1))
            if let n = fingers { o.add("n", n.clamped(1, 20)) }
        case let .app(t, event):
            o.add("k", "app")
            o.add("t", t)
            o.add("event", event.rawValue)
        }
        return o.text
    }

    static func metaLine(_ meta: TimelineMeta) -> String {
        var o = JSONObjectWriter()
        o.add("k", "meta")
        o.add("v", 1)
        o.add("platform", platform)
        o.add("start", meta.start)
        o.add("end", meta.end)
        if let v = meta.videoStart { o.add("videoStart", v) }
        if let v = meta.videoEnd { o.add("videoEnd", v) }
        o.add("dropped", meta.dropped)
        return o.text
    }

    // MARK: - Document

    /// The whole attachment: meta line, then `events` in time order (ties keep their order),
    /// trimmed to `maxBytes`. `meta.start` becomes the earliest kept event (never after `end`).
    static func document(
        events: [TimelineEvent],
        end: Int64,
        videoStart: Int64? = nil,
        videoEnd: Int64? = nil,
        dropped: Int = 0,
        maxBytes: Int = TimelineLimits.maxBytes
    ) -> TimelineDocument {
        let sorted = events.enumerated()
            .sorted { $0.element.t == $1.element.t ? $0.offset < $1.offset : $0.element.t < $1.element.t }
            .map { $0.element }
        let lines = sorted.map(line)
        let sizes = lines.map { $0.utf8.count + 1 }
        var total = sizes.reduce(0, +)
        let budget = max(0, maxBytes - metaReserve)
        var removed = [Bool](repeating: false, count: lines.count)
        var removedCount = 0
        if total > budget {
            for (i, event) in sorted.enumerated() where total > budget && event.isLog {
                removed[i] = true
                removedCount += 1
                total -= sizes[i]
            }
            for i in sorted.indices where total > budget && !removed[i] {
                removed[i] = true
                removedCount += 1
                total -= sizes[i]
            }
        }

        var kept: [String] = []
        var start = end
        for (i, l) in lines.enumerated() where !removed[i] {
            kept.append(l)
            start = min(start, sorted[i].t)
        }
        let meta = TimelineMeta(start: max(0, start), end: end, videoStart: videoStart, videoEnd: videoEnd,
                                dropped: max(0, dropped) + removedCount)
        var text = metaLine(meta) + "\n"
        for l in kept {
            text += l
            text += "\n"
        }
        return TimelineDocument(data: Data(text.utf8), meta: meta, eventCount: kept.count)
    }

    // MARK: - Reading saved log lines (crash follow-up)

    /// Parses one saved `log` line back into an event; nil for anything else.
    static func decodeLog(_ line: String) -> TimelineEvent? {
        guard let data = line.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              object["k"] as? String == "log",
              let tNumber = object["t"] as? NSNumber,
              let level = (object["level"] as? String).flatMap(TimelineLogLevel.init(rawValue:)),
              let source = (object["src"] as? String).flatMap(TimelineLogSource.init(rawValue:)),
              let message = object["msg"] as? String
        else { return nil }
        let t = tNumber.int64Value
        guard t >= 0 else { return nil }
        return .log(t: t, level: level, source: source, message: message, tag: object["tag"] as? String)
    }
}

/// Builds one JSON object as text, keys in insertion order.
struct JSONObjectWriter {
    private var members: [String] = []

    mutating func add(_ key: String, _ value: String) {
        members.append(JSONText.quote(key) + ":" + JSONText.quote(value))
    }

    mutating func add(_ key: String, _ value: Int64) {
        members.append(JSONText.quote(key) + ":" + String(value))
    }

    mutating func add(_ key: String, _ value: Int) {
        members.append(JSONText.quote(key) + ":" + String(value))
    }

    /// Non-finite numbers are left out (JSON has no NaN/Infinity).
    mutating func add(_ key: String, number value: Double) {
        guard let n = JSONText.number(value) else { return }
        members.append(JSONText.quote(key) + ":" + n)
    }

    var text: String {
        "{" + members.joined(separator: ",") + "}"
    }
}

enum JSONText {
    /// A JSON string literal: quotes, backslashes and control characters escaped
    /// (plus U+2028/U+2029, which some JavaScript parsers reject unescaped).
    static func quote(_ s: String) -> String {
        var out = "\""
        out.reserveCapacity(s.utf8.count + 2)
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 || scalar.value == 0x2028 || scalar.value == 0x2029 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        out += "\""
        return out
    }

    /// Integers without a fraction ("30001"), anything else in Swift's shortest
    /// round-trip form ("812.4"); nil for NaN/Infinity.
    static func number(_ d: Double) -> String? {
        guard d.isFinite else { return nil }
        if d == d.rounded(), abs(d) < 1e15 { return String(Int64(d)) }
        return "\(d)"
    }
}
