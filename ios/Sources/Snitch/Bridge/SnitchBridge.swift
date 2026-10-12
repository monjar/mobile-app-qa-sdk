// Objective-C entry points (spec §8.1, §11.9) for the React Native module and for a
// `+load` autostart. Strings and dictionaries only — no React types here; the RN
// wrapper converts its values before calling in. Options use the Info.plist
// names in lowerCamelCase (enabledReleaseTypes, gesture, screenshotPrompt,
// maskTextInputs, captureMode, videoMaxSeconds, showTesterNotice, captureConsole,
// captureNetwork, trackScreens, crashPrompt, checkInWhenInactive).
//
// Everything here is safe from any thread: the RN console hook calls `logJS` from
// whatever thread logged, and `isActive`/`consoleCaptureEnabled` read a lock-guarded
// snapshot of the runtime's state.

import Foundation

@objc(SNSnitchBridge)
public final class SnitchBridge: NSObject {
    /// Posted (NotificationCenter.default, main thread) right after Snitch activates.
    @objc public static let didActivateNotification: String = "SNSnitchDidActivate"

    @objc public static func startFromInfoPlist() {
        Snitch.start()
    }

    @objc public static func start(serverURL: String, ingestKey: String, options: [String: Any]) {
        guard let url = URL(string: serverURL.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            SDKLog.warn("SNSnitchBridge.start: serverURL is not a URL; Snitch stays inert")
            return
        }
        let parsed = StaticConfig.fromDictionary(options, keys: .bridge)
        Snitch.start(serverURL: url, ingestKey: ingestKey, options: parsed.options)
    }

    @objc public static func show(_ type: String?) {
        Snitch.show(type: type)
    }

    @objc public static func setUser(_ id: String?, email: String?, name: String?) {
        Snitch.setUser(id: id, email: email, name: name)
    }

    @objc public static func setMetadata(_ key: String, value: String?) {
        Snitch.setMetadata(key, value)
    }

    @objc public static func log(_ message: String, level: String) {
        Snitch.log(message, level: SnitchLogLevel(rawValue: level.lowercased()) ?? (level.lowercased() == "warning" ? .warn : .info))
    }

    @objc public static func setEnabled(_ enabled: Bool) {
        Snitch.setEnabled(enabled)
    }

    @objc public static func isEnabled() -> Bool {
        Snitch.isEnabled
    }

    @objc public static func releaseType() -> String {
        Snitch.releaseType.rawValue
    }

    /// Identifies the wrapper in reports (`sdk.wrapper`) and in the X-Snitch-SDK header.
    @objc public static func setWrapper(_ name: String, version: String) {
        UserContext.shared.setWrapper(name: name, version: version)
    }

    /// Names the current screen (router hooks); see `Snitch.setScreen`.
    @objc public static func setScreen(_ name: String?) {
        Snitch.setScreen(name)
    }

    /// A JavaScript console line for the report timeline (source `js`). Dropped unless Snitch
    /// is active with console capture on. From the first call on, the unified-log copies of JS
    /// lines (`com.facebook.react.log`) are left out of the timeline so they don't count twice.
    @objc public static func logJS(_ message: String, level: String) {
        let recorder = TimelineRecorder.shared
        recorder.markJSConsoleUsed()
        recorder.log(level: timelineLevel(level), source: .js, message: message)
    }

    /// Snitch activated (release type allowed, configured) and is currently on.
    @objc public static func isActive() -> Bool {
        SnitchRuntime.shared.publicState.isEnabled
    }

    /// Active, and the app enabled CaptureConsole: the RN module installs its console hook.
    @objc public static func consoleCaptureEnabled() -> Bool {
        SnitchRuntime.shared.publicState.consoleCapture
    }

    /// The forwarding URLProtocol for React Native's session configuration. Its canInit only
    /// accepts requests while Snitch is active with network capture on, so it is safe to
    /// install before Snitch has activated (or in a build where it never does).
    @objc public static func networkProtocolClass() -> AnyClass {
        SnitchURLProtocol.self
    }

    /// "debug"|"info"|"warn"|"error" (also "warning", "log", "trace"); anything else is info.
    static func timelineLevel(_ level: String) -> TimelineLogLevel {
        switch level.lowercased() {
        case "debug", "trace": return .debug
        case "warn", "warning": return .warn
        case "error", "fatal": return .error
        default: return .info
        }
    }
}
