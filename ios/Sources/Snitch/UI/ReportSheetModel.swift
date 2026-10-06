// State behind the report sheet. Plain ObservableObject mutated on the main
// thread; the runtime builds it from the frozen capture at trigger time and gets
// a Submission back on Send.

import SwiftUI
import UIKit

final class ReportSheetModel: ObservableObject {
    struct Submission {
        var typeId: String
        var description: String
        var includeScreenshot: Bool
        var includeVideo: Bool
        var videoSeconds: Int
        var email: String?
        var pauseRecording: Bool
    }

    static let defaultSeconds = 15

    let reportTypes: [ReportTypeOption]
    let message: String?
    let thumbnail: UIImage?
    private let screenshotJPEG: Data?
    /// Video is configured on (the row is hidden otherwise).
    let videoAvailable: Bool
    /// Whole seconds in the frozen ring (rounded up), 0 when nothing was recorded.
    let recordedSeconds: Int
    /// Upper bound of the seconds field: min(videoMaxSeconds, recorded).
    let maxSeconds: Int
    let version: String

    @Published var selectedType: String
    @Published var text = ""
    @Published var includeScreenshot: Bool
    @Published var includeVideo: Bool
    @Published private(set) var secondsText: String
    @Published var email: String
    @Published var pauseRecording: Bool
    @Published var showMore = false
    @Published var confirmDiscard = false
    @Published var isShown = false
    @Published var previewImage: UIImage? = nil

    var onSend: ((Submission) -> Void)?
    var onDismiss: (() -> Void)?
    private var finished = false

    init(
        reportTypes: [ReportTypeOption],
        preselectedType: String?,
        message: String?,
        screenshot: Screenshot?,
        videoAvailable: Bool,
        recordedSeconds: Int,
        videoMaxSeconds: Int,
        email: String?,
        pauseRecording: Bool,
        version: String = SnitchVersion.current
    ) {
        let types = reportTypes.isEmpty ? SdkConfig.default.reportTypes : reportTypes
        self.reportTypes = types
        self.message = message
        thumbnail = screenshot?.thumbnail
        screenshotJPEG = screenshot?.jpeg
        self.videoAvailable = videoAvailable
        self.recordedSeconds = max(0, recordedSeconds)
        maxSeconds = max(0, min(videoMaxSeconds, recordedSeconds))
        self.version = version
        if let pre = preselectedType, types.contains(where: { $0.id == pre }) {
            selectedType = pre
        } else {
            selectedType = types[0].id
        }
        includeScreenshot = screenshot != nil
        includeVideo = videoAvailable && recordedSeconds > 0
        secondsText = String(min(ReportSheetModel.defaultSeconds, max(1, min(videoMaxSeconds, recordedSeconds))))
        self.email = email ?? ""
        self.pauseRecording = pauseRecording
    }

    var hasScreenshot: Bool {
        thumbnail != nil
    }

    var hasRecording: Bool {
        maxSeconds >= 1
    }

    /// The seconds field parsed and clamped to 1...maxSeconds.
    var seconds: Int {
        let fallback = min(ReportSheetModel.defaultSeconds, max(1, maxSeconds))
        return (Int(secondsText) ?? fallback).clamped(1, max(1, maxSeconds))
    }

    var canSend: Bool {
        let hasText = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let hasShot = includeScreenshot && hasScreenshot
        let hasVideo = includeVideo && videoAvailable && hasRecording
        return hasText || hasShot || hasVideo
    }

    /// Digits only, at most two of them, never above maxSeconds. Empty is allowed while typing.
    func setSecondsText(_ raw: String) {
        let digits = String(raw.filter { $0.isASCII && $0.isNumber }.prefix(2))
        if let n = Int(digits), n > maxSeconds {
            secondsText = String(max(1, maxSeconds))
        } else {
            secondsText = digits
        }
    }

    /// Normalizes the field when editing ends (empty or 0 becomes a valid value).
    func commitSeconds() {
        secondsText = String(seconds)
    }

    func stepSeconds(_ delta: Int) {
        secondsText = String((seconds + delta).clamped(1, max(1, maxSeconds)))
    }

    func openPreview() {
        guard let data = screenshotJPEG else { return }
        previewImage = UIImage(data: data)
    }

    func closePreview() {
        previewImage = nil
    }

    func requestDismiss() {
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            dismiss()
        } else {
            confirmDiscard = true
        }
    }

    func dismiss() {
        guard !finished else { return }
        finished = true
        isShown = false
        onDismiss?()
    }

    func send() {
        guard !finished, canSend else { return }
        finished = true
        let trimmedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines)
        let submission = Submission(
            typeId: selectedType,
            description: String(text.prefix(10_000)),
            includeScreenshot: includeScreenshot && hasScreenshot,
            includeVideo: includeVideo && videoAvailable && hasRecording,
            videoSeconds: seconds,
            email: trimmedEmail.isEmpty ? nil : trimmedEmail,
            pauseRecording: pauseRecording
        )
        isShown = false
        onSend?(submission)
    }
}
