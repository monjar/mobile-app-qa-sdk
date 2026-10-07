// Objective-C entry points (spec §8.1) for the React Native module and for a
// `+load` autostart. Strings and dictionaries only — no React types here; the RN
// wrapper converts its values before calling in. Options use the Info.plist
// names in lowerCamelCase (enabledReleaseTypes, gesture, screenshotPrompt,
// maskTextInputs, captureMode, videoMaxSeconds, showTesterNotice).

import Foundation

@objc(SNSnitchBridge)
public final class SnitchBridge: NSObject {
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
}
