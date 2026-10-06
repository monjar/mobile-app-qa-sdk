// Public API of the Snitch iOS SDK (spec §8.1).
//
// Everything here is a thin, thread-safe front for SnitchRuntime: calls may come
// from any thread and hop to the main thread internally. State the app sets before
// `start()` (user, metadata, log provider, masks) is kept and used once the SDK runs.

import UIKit

/// How the running build was distributed, as detected at runtime.
public enum SnitchReleaseType: String, CaseIterable {
    case debug
    case adhoc
    case enterprise
    case testflight
    case appstore
    case `internal`
    case play
    case unknown
}

public enum SnitchLogLevel: String, CaseIterable {
    case debug
    case info
    case warn
    case error
}

/// Which gesture opens the report sheet.
public enum Gesture: String, CaseIterable {
    case threeFingerHold
    case shake
    case both
    /// No gesture; open the sheet with `Snitch.show()`.
    case none
}

/// Where the video frames come from.
public enum CaptureMode: String, CaseIterable {
    /// The SDK draws the app's own windows a few times a second; no permission prompt.
    case snapshot
    /// ReplayKit in-app capture; full frame rate, OS consent prompt each session.
    case system
    /// No video; screenshots still work.
    case off
}

/// Build-time options. Defaults match the Info.plist defaults (spec §2.1).
public struct SnitchOptions {
    public var enabledReleaseTypes: Set<SnitchReleaseType>
    public var gesture: Gesture
    public var screenshotPrompt: Bool
    public var maskTextInputs: Bool
    public var captureMode: CaptureMode
    /// Longest clip offered, clamped to 1...30.
    public var videoMaxSeconds: Int
    public var showTesterNotice: Bool

    public init(
        enabledReleaseTypes: Set<SnitchReleaseType> = [.debug, .adhoc, .enterprise, .testflight, .`internal`],
        gesture: Gesture = .threeFingerHold,
        screenshotPrompt: Bool = true,
        maskTextInputs: Bool = true,
        captureMode: CaptureMode = .snapshot,
        videoMaxSeconds: Int = 30,
        showTesterNotice: Bool = true
    ) {
        self.enabledReleaseTypes = enabledReleaseTypes
        self.gesture = gesture
        self.screenshotPrompt = screenshotPrompt
        self.maskTextInputs = maskTextInputs
        self.captureMode = captureMode
        self.videoMaxSeconds = min(max(videoMaxSeconds, 1), 30)
        self.showTesterNotice = showTesterNotice
    }
}

public enum Snitch {
    /// Starts the SDK from the `Snitch` dictionary in Info.plist.
    public static func start() {
        onMain { SnitchRuntime.shared.start(explicit: nil) }
    }

    /// Starts the SDK with explicit settings; these win over Info.plist.
    public static func start(serverURL: URL, ingestKey: String, options: SnitchOptions = .init()) {
        let explicit = StaticConfig.Explicit(serverURL: serverURL, ingestKey: ingestKey, options: options)
        onMain { SnitchRuntime.shared.start(explicit: explicit) }
    }

    /// Opens the report sheet. `type` preselects a report type id (e.g. "bug").
    public static func show(type: String? = nil) {
        onMain { SnitchRuntime.shared.show(type: type) }
    }

    public static func setUser(id: String?, email: String?, name: String?) {
        UserContext.shared.setUser(id: id, email: email, name: name)
    }

    /// Attaches a custom key/value to every report; nil removes the key.
    public static func setMetadata(_ key: String, _ value: String?) {
        UserContext.shared.setMetadata(key, value)
    }

    /// Adds a line to the log attached to reports (last 200 lines, ≤ 256 KB).
    public static func log(_ message: String, level: SnitchLogLevel = .info) {
        LogRing.shared.append(message, level: level)
    }

    /// A closure called when a report is sent; its text is attached to the report log.
    public static func setLogProvider(_ provider: (() -> String?)?) {
        UserContext.shared.setLogProvider(provider)
    }

    /// Runtime pause by the app: false stops the gesture, capture and prompt until true again.
    public static func setEnabled(_ enabled: Bool) {
        onMain { SnitchRuntime.shared.setAppEnabled(enabled) }
    }

    /// Started, release type allowed, not paused by the app, and enabled by remote config.
    public static var isEnabled: Bool {
        SnitchRuntime.shared.publicState.isEnabled
    }

    public static var releaseType: SnitchReleaseType {
        SnitchRuntime.shared.publicState.releaseType
    }

    /// Masks a view in screenshots and video (held weakly).
    public static func mask(_ view: UIView) {
        onMain { MaskRegistry.shared.add(view) }
    }

    public static func unmask(_ view: UIView) {
        onMain { MaskRegistry.shared.remove(view) }
    }

    static func onMain(_ work: @escaping () -> Void) {
        if Thread.isMainThread {
            work()
        } else {
            DispatchQueue.main.async(execute: work)
        }
    }
}
