// Debug hooks for UI tests and CI (spec §9). Read from the process environment
// (XCUIApplication.launchEnvironment, or SIMCTL_CHILD_* when launched by simctl)
// and honoured only when the release type is `debug`, so a shipped build can't
// be redirected or driven through its environment.

import Foundation

struct DebugHooks: Equatable {
    var serverURL: URL?
    var ingestKey: String?
    /// File a report without UI after this many seconds.
    var autoReportAfter: TimeInterval?
    /// Run the real fire path this many ms into every touch sequence, then dismiss.
    var cancelAfterMs: Double?
    var showOnLaunch: Bool

    static let inactive = DebugHooks(serverURL: nil, ingestKey: nil, autoReportAfter: nil, cancelAfterMs: nil, showOnLaunch: false)

    static func read(releaseType: SnitchReleaseType, environment: [String: String] = ProcessInfo.processInfo.environment) -> DebugHooks {
        guard releaseType == .debug else { return .inactive }
        func value(_ key: String) -> String? {
            guard let v = environment[key]?.trimmingCharacters(in: .whitespacesAndNewlines), !v.isEmpty else { return nil }
            return v
        }
        var hooks = DebugHooks.inactive
        hooks.serverURL = value("SNITCH_DEBUG_SERVER_URL").flatMap { URL(string: $0) }
        hooks.ingestKey = value("SNITCH_DEBUG_INGEST_KEY")
        if let s = value("SNITCH_DEBUG_AUTOREPORT").flatMap({ Double($0) }), s >= 0 {
            hooks.autoReportAfter = s
        }
        if let ms = value("SNITCH_DEBUG_CANCEL_AFTER_MS").flatMap({ Double($0) }), ms >= 0 {
            hooks.cancelAfterMs = ms
        }
        hooks.showOnLaunch = value("SNITCH_DEBUG_SHOW_ON_LAUNCH") == "1"
        if hooks != DebugHooks.inactive {
            SDKLog.info("Debug hooks active: \(hooks.summary)")
        }
        return hooks
    }

    private var summary: String {
        var parts: [String] = []
        if serverURL != nil { parts.append("serverURL") }
        if ingestKey != nil { parts.append("ingestKey") }
        if let s = autoReportAfter { parts.append("autoreport=\(s)s") }
        if let ms = cancelAfterMs { parts.append("cancelAfter=\(ms)ms") }
        if showOnLaunch { parts.append("showOnLaunch") }
        return parts.joined(separator: ", ")
    }
}
