// Two kinds of logging:
// - `SDKLog`: the SDK's own diagnostics, to the unified log (Console.app), with
//   "once" variants so a misconfiguration never spams.
// - `LogRing`: lines the app passes to `Snitch.log`, kept in memory (last 200
//   lines, ≤ 256 KB) and attached to reports as logs.txt.

import Foundation
import os

enum SDKLog {
    private static let logger = Logger(subsystem: "io.github.monjar.snitch", category: "Snitch")
    private static let lock = NSLock()
    private static var onceKeys = Set<String>()

    static func debug(_ message: String) {
        logger.debug("\(message, privacy: .public)")
    }

    static func info(_ message: String) {
        logger.info("[Snitch] \(message, privacy: .public)")
    }

    static func warn(_ message: String) {
        logger.warning("[Snitch] \(message, privacy: .public)")
    }

    static func error(_ message: String) {
        logger.error("[Snitch] \(message, privacy: .public)")
    }

    /// Logs `message` at `level` the first time `key` is seen in this process.
    static func once(_ key: String, level: SnitchLogLevel = .warn, _ message: String) {
        lock.lock()
        let first = onceKeys.insert(key).inserted
        lock.unlock()
        guard first else { return }
        switch level {
        case .debug: debug(message)
        case .info: info(message)
        case .warn: warn(message)
        case .error: error(message)
        }
    }
}

final class LogRing {
    static let shared = LogRing()

    static let maxLines = 200
    static let maxBytes = 256 * 1024

    private let lock = NSLock()
    private var lines: [String] = []
    private let formatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()

    func append(_ message: String, level: SnitchLogLevel) {
        lock.lock()
        defer { lock.unlock() }
        let line = "\(formatter.string(from: Date())) [\(level.rawValue)] \(message)"
        lines.append(line)
        if lines.count > LogRing.maxLines { lines.removeFirst(lines.count - LogRing.maxLines) }
    }

    func snapshot() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return lines
    }

    /// The log attachment body: ring lines plus the app's provider output, newest kept when over the cap.
    static func attachmentText(ringLines: [String], providerText: String?) -> String? {
        var parts: [String] = []
        if !ringLines.isEmpty { parts.append(ringLines.joined(separator: "\n")) }
        if let p = providerText?.trimmingCharacters(in: .whitespacesAndNewlines), !p.isEmpty {
            parts.append("--- app log provider ---\n" + p)
        }
        guard !parts.isEmpty else { return nil }
        var text = parts.joined(separator: "\n") + "\n"
        // Keep the last 200 lines, then the newest ≤ 256 KB.
        let all = text.split(separator: "\n", omittingEmptySubsequences: false)
        if all.count > maxLines + 1 {
            text = all.suffix(maxLines + 1).joined(separator: "\n")
        }
        var data = Data(text.utf8)
        if data.count > maxBytes {
            data = data.suffix(maxBytes)
            // Drop a possibly split first line (and any broken UTF-8 sequence with it).
            if let nl = data.firstIndex(of: 0x0A) { data = data.suffix(from: data.index(after: nl)) }
            text = String(decoding: data, as: UTF8.self)
        }
        return text
    }
}
