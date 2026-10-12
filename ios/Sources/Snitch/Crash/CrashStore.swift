// Crash follow-up on disk (spec §11.8), in Application Support/Snitch/crash/:
//
//   crash-<epochMs>-<id>.json     one MetricKit MXCrashDiagnostic each (its
//                                 jsonRepresentation, ≤ 512 KB), named by the
//                                 payload's end time
//   session-log.ndjson            this session's timeline log lines (≤ 200), saved
//                                 every 30 s and on background while active
//   previous-session-log.ndjson   the last session's file, promoted at launch
//
// A crash younger than 7 days is "pending" until the tester sends a report about
// it or dismisses the offer; older ones are deleted unseen. The previous session's
// log becomes the crash report's timeline (the video is gone: frames live only in
// memory). Nothing here is read or sent unless the tester sends that report.
// File operations are synchronous and cheap; callers pick the queue.

import Foundation
import MetricKit

struct PendingCrash: Equatable {
    var url: URL
    var date: Date
    /// The diagnostic (JSON) as text, for the `crash` attachment.
    var text: String
}

final class CrashStore {
    static let maxDiagnosticBytes = 512 * 1024
    static let maxAge: TimeInterval = 7 * 24 * 3600
    static let sessionLogLines = 200

    private static let crashPrefix = "crash-"
    private static let sessionLog = "session-log.ndjson"
    private static let previousSessionLog = "previous-session-log.ndjson"

    let directory: URL
    private let fm = FileManager.default

    init(directory: URL) {
        self.directory = directory
    }

    /// Application Support/Snitch/crash.
    static func makeDefault() -> CrashStore? {
        guard let snitchDir = Outbox.snitchDirectory() else { return nil }
        let store = CrashStore(directory: snitchDir.appendingPathComponent("crash", isDirectory: true))
        do {
            try store.ensureDirectory()
        } catch {
            SDKLog.warn("Crash follow-up unavailable: \(error)")
            return nil
        }
        return store
    }

    private func ensureDirectory() throws {
        try fm.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
    }

    private func write(_ data: Data, to url: URL) throws {
        try ensureDirectory()
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    // MARK: - Diagnostics

    /// Saves one crash diagnostic (cut to 512 KB). Returns its file.
    @discardableResult
    func saveDiagnostic(_ data: Data, at date: Date) -> URL? {
        guard !data.isEmpty else { return nil }
        let ms = TimelineText.nowMs(date)
        let id = UUID().uuidString.lowercased().prefix(8)
        let url = directory.appendingPathComponent("\(CrashStore.crashPrefix)\(ms)-\(id).json")
        do {
            try write(data.count > CrashStore.maxDiagnosticBytes ? data.prefix(CrashStore.maxDiagnosticBytes) : data, to: url)
            return url
        } catch {
            SDKLog.once("crash.save", "Couldn't save a crash diagnostic: \(error)")
            return nil
        }
    }

    /// The newest crash of the last 7 days; crashes older than that are deleted.
    func pendingCrash(now: Date = Date()) -> PendingCrash? {
        var newest: (url: URL, date: Date)?
        for (url, date) in crashFiles() {
            if now.timeIntervalSince(date) > CrashStore.maxAge {
                try? fm.removeItem(at: url)
                continue
            }
            if newest == nil || date > (newest?.date ?? .distantPast) { newest = (url, date) }
        }
        guard let pick = newest, let data = try? Data(contentsOf: pick.url), !data.isEmpty else { return nil }
        return PendingCrash(url: pick.url, date: pick.date, text: String(decoding: data, as: UTF8.self))
    }

    /// The tester sent a report about it or dismissed the offer: forget every pending crash.
    func discardPending() {
        for (url, _) in crashFiles() { try? fm.removeItem(at: url) }
        try? fm.removeItem(at: directory.appendingPathComponent(CrashStore.previousSessionLog))
    }

    private func crashFiles() -> [(URL, Date)] {
        guard let names = try? fm.contentsOfDirectory(atPath: directory.path) else { return [] }
        return names.compactMap { name -> (URL, Date)? in
            guard name.hasPrefix(CrashStore.crashPrefix), name.hasSuffix(".json") else { return nil }
            let stamp = name.dropFirst(CrashStore.crashPrefix.count).prefix { $0.isNumber }
            guard let ms = Double(stamp) else { return nil }
            return (directory.appendingPathComponent(name), Date(timeIntervalSince1970: ms / 1000))
        }
    }

    // MARK: - Session log

    /// At launch: the last session's log becomes the previous session's (or none).
    func promoteSessionLog() {
        let current = directory.appendingPathComponent(CrashStore.sessionLog)
        let previous = directory.appendingPathComponent(CrashStore.previousSessionLog)
        try? fm.removeItem(at: previous)
        if fm.fileExists(atPath: current.path) {
            try? fm.moveItem(at: current, to: previous)
        }
    }

    /// Replaces this session's log with `lines` (already encoded timeline log lines).
    func saveSessionLog(_ lines: [String]) {
        let url = directory.appendingPathComponent(CrashStore.sessionLog)
        let kept = lines.suffix(CrashStore.sessionLogLines)
        guard !kept.isEmpty else {
            try? fm.removeItem(at: url)
            return
        }
        do {
            try write(Data((kept.joined(separator: "\n") + "\n").utf8), to: url)
        } catch {
            SDKLog.once("crash.sessionLog", "Couldn't save the session log: \(error)")
        }
    }

    /// The previous session's log as a timeline for the crash report; nil when there is none.
    func previousSessionTimeline() -> TimelineSnapshot? {
        let url = directory.appendingPathComponent(CrashStore.previousSessionLog)
        guard let data = try? Data(contentsOf: url) else { return nil }
        let events = String(decoding: data, as: UTF8.self)
            .split(separator: "\n")
            .compactMap { TimelineEncoding.decodeLog(String($0)) }
        guard let last = events.map({ $0.t }).max() else { return nil }
        return TimelineSnapshot(events: events, dropped: 0, end: last, monoToWallMs: 0, nativeConsole: nil, screen: nil)
    }
}

/// MetricKit delivers crash diagnostics of earlier sessions (on iOS 15+, shortly after
/// the next launch subscribes); each is saved for the crash follow-up.
final class CrashDiagnosticsSubscriber: NSObject, MXMetricManagerSubscriber {
    private let store: CrashStore
    /// Called on the main thread after at least one crash was saved.
    var onSaved: (() -> Void)?

    init(store: CrashStore) {
        self.store = store
        super.init()
    }

    func start() {
        MXMetricManager.shared.add(self)
    }

    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        var saved = false
        for payload in payloads {
            for crash in payload.crashDiagnostics ?? [] {
                if store.saveDiagnostic(crash.jsonRepresentation(), at: payload.timeStampEnd) != nil { saved = true }
            }
        }
        guard saved else { return }
        DispatchQueue.main.async { [weak self] in self?.onSaved?() }
    }
}
