// Every user-visible string, in one table (English only in v1; no resource bundles,
// since the sources are also compiled inside a CocoaPod).

import Foundation

enum Strings {
    static let reportTitle = "Report"
    static let close = "Close"
    static let descriptionPlaceholder = "What happened?"
    static let descriptionLabel = "Description"
    static let reportTypeLabel = "Report type"
    static let screenshot = "Screenshot"
    static let screenshotPreview = "Screenshot preview"
    static let video = "Video"
    static let videoLast = "last"
    static let secondsUnit = "s"
    static let videoSecondsLabel = "Video length in seconds"
    static let decreaseSeconds = "Fewer seconds"
    static let increaseSeconds = "More seconds"
    static let nothingRecorded = "Nothing recorded yet"
    static func recordedCaption(_ seconds: Int) -> String { "of \(seconds) s recorded" }
    static let more = "More"
    static let email = "Email"
    static let emailPlaceholder = "you@example.com"
    static let pauseRecording = "Pause recording"
    static func sdkVersion(_ v: String) -> String { "Snitch \(v)" }
    static let send = "Send"
    static let discardTitle = "Discard this report?"
    static let discard = "Discard"
    static let keepEditing = "Keep editing"

    static let sending = "Sending…"
    static func sent(_ ticket: String) -> String { "Sent · \(ticket)" }
    static let sentNoTicket = "Sent"
    static let savedOffline = "Saved — will send when online"
    static let rejected = "The server didn't accept this report"
    static let saveFailed = "Couldn't save the report"

    static let screenshotPrompt = "Report this screen?"

    static func testerNotice(gesture: Gesture, seconds: Int) -> String {
        let how: String
        switch gesture {
        case .threeFingerHold, .both:
            how = "Hold three fingers on the screen to report a problem."
        case .shake:
            how = "Shake the device to report a problem."
        case Gesture.none:
            how = "Use the app's report option to report a problem."
        }
        return "This is a test build. \(how) The last \(seconds) seconds of screen activity stay on this device and are only sent with a report you submit."
    }

    static let gotIt = "Got it"
}
