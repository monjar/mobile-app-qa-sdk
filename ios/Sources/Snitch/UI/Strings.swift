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
    static let crashPrompt = "The app closed unexpectedly. Report it?"
    static let crashAttached = "Details of the unexpected exit are attached."
    static let dismiss = "Dismiss"

    static let editScreenshot = "Edit screenshot"
    static let editScreenshotHint = "Opens the screenshot to draw arrows and boxes or blur parts of it"
    static let markupTools = "Markup tool"
    static let markupArrow = "Arrow"
    static let markupBox = "Box"
    static let markupBlur = "Blur"
    static let markupCanvas = "Screenshot"
    static let markupCanvasHint = "Drag to draw with the selected tool"
    static let undo = "Undo"
    static let clearMarks = "Clear"
    static let cancel = "Cancel"
    static let done = "Done"

    static func testerNotice(gesture: Gesture, seconds: Int) -> String {
        let how: String
        switch gesture {
        case .threeFingerHold, .both:
            how = "Hold three fingers on the screen to report a problem."
        case .shake:
            how = "Shake the device to report a problem."
        case Gesture.none:
            how = "Use the app's report option to report a problem."
        case .edgeHandle:
            how = "Pull the tab on the edge of the screen to report a problem."
        }
        return "This is a test build. \(how) The last \(seconds) seconds of screen activity stay on this device and are only sent with a report you submit."
    }

    static let gotIt = "Got it"
    static let edgeHandleLabel = "Report a problem"
    static let edgeHandleHint = "Pull, or activate, to report a problem with this screen"
}
