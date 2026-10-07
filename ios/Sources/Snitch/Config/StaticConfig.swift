// Build-time configuration (spec §2.1): the `Snitch` dictionary in Info.plist,
// explicit `Snitch.start(serverURL:ingestKey:options:)` arguments, or the RN
// bridge's options dictionary (same names in lowerCamelCase). Code wins over plist.
//
// Validation is deliberately strict: a malformed URL or key means one warning and
// an inert SDK, never a half-configured one sending to the wrong place.

import Foundation

struct StaticConfig {
    var enabled: Bool
    var serverURL: URL?
    var ingestKey: String?
    var options: SnitchOptions

    /// Arguments passed in code; every field present wins over Info.plist.
    struct Explicit {
        var serverURL: URL
        var ingestKey: String
        var options: SnitchOptions
    }

    static let ingestKeyPattern = "^snitch_pk_[0-9A-HJKMNP-TV-Z]{26}$"

    static func isValidIngestKey(_ key: String) -> Bool {
        key.range(of: ingestKeyPattern, options: .regularExpression) != nil
    }

    /// http(s) with a host; trailing slashes are trimmed so paths can be appended.
    static func normalizedServerURL(_ url: URL?) -> URL? {
        guard let url = url, let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = url.host, !host.isEmpty else { return nil }
        var s = url.absoluteString
        while s.hasSuffix("/") { s.removeLast() }
        return URL(string: s)
    }

    /// Reads the `Snitch` Info.plist dictionary (PascalCase keys).
    static func fromInfoPlist(_ bundle: Bundle = .main) -> StaticConfig {
        let dict = bundle.object(forInfoDictionaryKey: "Snitch") as? [String: Any] ?? [:]
        return fromDictionary(dict, keys: .infoPlist)
    }

    /// Reads a dictionary with either Info.plist (PascalCase) or bridge (lowerCamelCase) keys.
    static func fromDictionary(_ dict: [String: Any], keys: KeyStyle) -> StaticConfig {
        func value(_ name: String) -> Any? {
            dict[keys == .infoPlist ? name : lowerFirst(name)]
        }
        var options = SnitchOptions()
        if let types = stringList(value("EnabledReleaseTypes")) {
            let parsed = types.compactMap { SnitchReleaseType(rawValue: $0.trimmingCharacters(in: .whitespaces)) }
            options.enabledReleaseTypes = Set(parsed)
            if parsed.count != types.count {
                SDKLog.once("config.releaseTypes", "EnabledReleaseTypes has unknown values; they are ignored")
            }
        }
        if let s = value("Gesture") as? String {
            if let g = Gesture(rawValue: s) {
                options.gesture = g
            } else {
                SDKLog.once("config.gesture", "Unknown Gesture \"\(s)\"; using threeFingerHold")
            }
        }
        if let b = bool(value("ScreenshotPrompt")) { options.screenshotPrompt = b }
        if let b = bool(value("MaskTextInputs")) { options.maskTextInputs = b }
        if let s = value("CaptureMode") as? String {
            if let m = CaptureMode(rawValue: s) {
                options.captureMode = m
            } else {
                SDKLog.once("config.captureMode", "Unknown CaptureMode \"\(s)\"; using snapshot")
            }
        }
        if let n = int(value("VideoMaxSeconds")) { options.videoMaxSeconds = n.clamped(1, 30) }
        if let b = bool(value("ShowTesterNotice")) { options.showTesterNotice = b }

        let urlString = (value("ServerURL") as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = (value("IngestKey") as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return StaticConfig(
            enabled: bool(value("Enabled")) ?? true,
            serverURL: urlString.flatMap { URL(string: $0) },
            ingestKey: key,
            options: options
        )
    }

    enum KeyStyle {
        case infoPlist
        case bridge
    }

    /// Explicit arguments win; the plist only supplies `Enabled` (a master switch the app may still set).
    func overlaid(with explicit: Explicit) -> StaticConfig {
        StaticConfig(enabled: enabled, serverURL: explicit.serverURL, ingestKey: explicit.ingestKey, options: explicit.options)
    }

    // MARK: - Parsing helpers (plist values arrive as NSNumber/NSString; bridge values may be strings)

    private static func lowerFirst(_ s: String) -> String {
        guard let first = s.first else { return s }
        return first.lowercased() + s.dropFirst()
    }

    static func bool(_ v: Any?) -> Bool? {
        if let b = v as? Bool { return b }
        if let n = v as? NSNumber { return n.boolValue }
        if let s = v as? String {
            switch s.lowercased() {
            case "true", "yes", "1": return true
            case "false", "no", "0": return false
            default: return nil
            }
        }
        return nil
    }

    static func int(_ v: Any?) -> Int? {
        if let n = v as? Int { return n }
        if let n = v as? NSNumber { return n.intValue }
        if let s = v as? String { return Int(s.trimmingCharacters(in: .whitespaces)) }
        return nil
    }

    static func stringList(_ v: Any?) -> [String]? {
        if let a = v as? [String] { return a }
        if let a = v as? [Any] { return a.compactMap { $0 as? String } }
        if let s = v as? String {
            return s.split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        }
        return nil
    }
}
