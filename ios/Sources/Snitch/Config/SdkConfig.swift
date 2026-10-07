// The remote configuration (`SdkConfig` in contract/src/ingest.ts) and the
// effective settings the SDK runs on.
//
// Merge rule (spec §2.2): static options first, remote config on top — except
// that remote can only *restrict* captureMode (off < snapshot < system), because
// system mode needs app-side setup the build may not have.

import Foundation

struct ReportTypeOption: Codable, Equatable {
    var id: String
    var label: String
}

struct SdkConfig: Codable, Equatable {
    struct Screenshot: Codable, Equatable {
        var enabled: Bool
    }

    struct Video: Codable, Equatable {
        var enabled: Bool
        var maxSeconds: Int
        /// Kept as a string so an unknown future value doesn't fail the whole decode.
        var captureMode: String
        var snapshotRenderer: String
        var idleFps: Double
        var activeFps: Double
        var systemFps: Double
        var mainThreadBudgetPct: Double
    }

    var enabled: Bool
    var ttlSeconds: Int
    var reportTypes: [ReportTypeOption]
    var screenshot: Screenshot
    var video: Video
    var maskTextInputs: Bool
    var screenshotPrompt: Bool
    var message: String?

    /// DEFAULT_SDK_CONFIG from contract/src/ingest.ts.
    static let `default` = SdkConfig(
        enabled: true,
        ttlSeconds: 3600,
        reportTypes: [
            ReportTypeOption(id: "bug", label: "Bug"),
            ReportTypeOption(id: "idea", label: "Idea"),
            ReportTypeOption(id: "other", label: "Other"),
        ],
        screenshot: Screenshot(enabled: true),
        video: Video(
            enabled: true,
            maxSeconds: 30,
            captureMode: "snapshot",
            snapshotRenderer: "drawHierarchy",
            idleFps: 1,
            activeFps: 4,
            systemFps: 10,
            mainThreadBudgetPct: 3
        ),
        maskTextInputs: true,
        screenshotPrompt: true,
        message: nil
    )
}

enum SnapshotRenderer: String {
    case drawHierarchy
    case layerRender
}

/// What the SDK actually does right now.
struct EffectiveConfig: Equatable {
    /// Remote master switch.
    var enabled: Bool
    var reportTypes: [ReportTypeOption]
    var message: String?
    var screenshotEnabled: Bool
    /// `.off` whenever video is disabled for any reason.
    var captureMode: CaptureMode
    var snapshotRenderer: SnapshotRenderer
    var idleFps: Double
    var activeFps: Double
    var systemFps: Double
    var budgetPct: Double
    var videoMaxSeconds: Int
    var maskTextInputs: Bool
    var screenshotPrompt: Bool
    var gesture: Gesture
    var showTesterNotice: Bool
    var ttlSeconds: Int

    var videoEnabled: Bool {
        captureMode != .off
    }
}

enum ConfigMerger {
    private static func rank(_ m: CaptureMode) -> Int {
        switch m {
        case .off: return 0
        case .snapshot: return 1
        case .system: return 2
        }
    }

    /// The more restrictive of the two modes.
    static func restrict(_ staticMode: CaptureMode, _ remoteMode: CaptureMode) -> CaptureMode {
        rank(remoteMode) < rank(staticMode) ? remoteMode : staticMode
    }

    /// `remote` nil means no fetch has succeeded yet: DEFAULT_SDK_CONFIG merged with the static options.
    /// `rendererDowngrade` comes from the crash-loop sentinel: 1 = layerRender, 2 = video off.
    static func effective(options: SnitchOptions, remote: SdkConfig?, rendererDowngrade: Int = 0) -> EffectiveConfig {
        let base = SdkConfig.default
        let r = remote ?? base

        var mode: CaptureMode
        let maxSeconds: Int
        let mask: Bool
        let prompt: Bool
        if let remote = remote {
            // Remote on top of static, except captureMode which may only get stricter.
            let remoteMode = remote.video.enabled ? (CaptureMode(rawValue: remote.video.captureMode) ?? .off) : .off
            mode = restrict(options.captureMode, remoteMode)
            maxSeconds = remote.video.maxSeconds
            mask = remote.maskTextInputs
            prompt = remote.screenshotPrompt
        } else {
            mode = options.captureMode
            maxSeconds = options.videoMaxSeconds
            mask = options.maskTextInputs
            prompt = options.screenshotPrompt
        }

        var renderer = SnapshotRenderer(rawValue: r.video.snapshotRenderer) ?? .drawHierarchy
        if rendererDowngrade >= 1 { renderer = .layerRender }
        if rendererDowngrade >= 2 && mode == .snapshot { mode = .off }

        let types = r.reportTypes.isEmpty ? base.reportTypes : r.reportTypes
        return EffectiveConfig(
            enabled: r.enabled,
            reportTypes: types,
            message: r.message.nonEmpty,
            screenshotEnabled: r.screenshot.enabled,
            captureMode: mode,
            snapshotRenderer: renderer,
            idleFps: r.video.idleFps.clamped(0.2, 10),
            activeFps: r.video.activeFps.clamped(0.2, 15),
            systemFps: r.video.systemFps.clamped(1, 15),
            budgetPct: r.video.mainThreadBudgetPct.clamped(0.5, 20),
            videoMaxSeconds: maxSeconds.clamped(1, 30),
            maskTextInputs: mask,
            screenshotPrompt: prompt,
            gesture: options.gesture,
            showTesterNotice: options.showTesterNotice,
            ttlSeconds: r.ttlSeconds.clamped(60, 86_400)
        )
    }
}
