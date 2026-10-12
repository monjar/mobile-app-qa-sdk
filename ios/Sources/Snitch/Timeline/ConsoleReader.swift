// This process's unified log (os_log, Logger, NSLog) for the report timeline
// (spec §11.4). Read once, at Send, on the report queue — never while the app
// runs — through OSLogStore(scope: .currentProcessIdentifier) (iOS 15+; no
// entitlement needed for the own process).
//
// - Window: the frozen timeline's last 5 minutes; `OSLogEntryLog` entries only.
// - The newest 300 are kept; reading stops after a 2 s budget (OSLogStore can be
//   slow on a busy log), keeping whatever was read by then.
// - Snitch's own subsystem is skipped, and so is `com.facebook.react.log` when the
//   React Native module already records JS console lines (they'd count twice).
// - Levels: debug→debug, info/notice→info, error/fault→error. Tag = subsystem, or
//   the category when there is no subsystem (NSLog).
// Predicates are not used: their support varies by OS release, and filtering the
// few hundred entries of one process in code is cheap.

import Foundation
import OSLog

enum ConsoleReader {
    static let maxEntries = 300
    static let budget: TimeInterval = 2
    static let reactNativeSubsystem = "com.facebook.react.log"

    static func entries(_ request: NativeConsoleRequest, maxEntries: Int = ConsoleReader.maxEntries, budget: TimeInterval = ConsoleReader.budget) -> [TimelineEvent] {
        let deadline = Date().addingTimeInterval(budget)
        guard request.to > request.from, maxEntries > 0 else { return [] }
        let store: OSLogStore
        let sequence: AnySequence<OSLogEntry>
        do {
            store = try OSLogStore(scope: .currentProcessIdentifier)
            let start = Date(timeIntervalSince1970: Double(request.from) / 1000)
            sequence = try store.getEntries(at: store.position(date: start))
        } catch {
            SDKLog.once("console.read", level: .info, "The unified log could not be read for the report timeline: \(error)")
            return []
        }

        // The enumerator reads from the store; keep it alive for the whole walk.
        return withExtendedLifetime(store) {
            collect(sequence, request: request, maxEntries: maxEntries, deadline: deadline)
        }
    }

    private static func collect(
        _ sequence: AnySequence<OSLogEntry>,
        request: NativeConsoleRequest,
        maxEntries: Int,
        deadline: Date
    ) -> [TimelineEvent] {
        var kept: [TimelineEvent] = []
        var seen = 0
        for entry in sequence {
            seen += 1
            if seen % 64 == 0 && Date() > deadline { break }
            guard let log = entry as? OSLogEntryLog else { continue }
            let t = TimelineText.nowMs(log.date)
            if t < request.from { continue }
            if t > request.to { break }
            let subsystem = log.subsystem
            if subsystem == SDKLog.subsystem { continue }
            if request.excludeReactNative && subsystem == reactNativeSubsystem { continue }
            let tag = subsystem.isEmpty ? log.category : subsystem
            kept.append(.log(
                t: t,
                level: level(log.level),
                source: .native,
                message: TimelineText.truncated(log.composedMessage, maxUTF16: TimelineLimits.msgChars),
                tag: tag.isEmpty ? nil : tag
            ))
            // Keep memory flat on a chatty log: only the newest `maxEntries` survive.
            if kept.count >= maxEntries * 2 { kept.removeFirst(kept.count - maxEntries) }
        }
        return Array(kept.suffix(maxEntries))
    }

    static func level(_ level: OSLogEntryLog.Level) -> TimelineLogLevel {
        switch level {
        case .debug: return .debug
        case .info, .notice, .undefined: return .info
        case .error, .fault: return .error
        @unknown default: return .info
        }
    }
}
