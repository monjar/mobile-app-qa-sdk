/*
 * Every user-facing string, English only in v1 (spec §6). Kept in Kotlin, not
 * resources, so the library has no res/ and its sources can be compiled
 * inside the React Native module unchanged.
 */
package io.github.monjar.snitch.ui

internal object Strings {
    const val REPORT = "Report"
    const val CLOSE = "Close"
    const val WHAT_HAPPENED = "What happened?"
    const val SCREENSHOT = "Screenshot"
    const val SCREENSHOT_PREVIEW = "Screenshot preview, tap to enlarge"
    const val VIDEO = "Video"
    const val LAST = "last"
    const val SECONDS_UNIT = "s"
    const val SECONDS_FIELD = "Video length in seconds"
    const val FEWER_SECONDS = "Fewer seconds"
    const val MORE_SECONDS = "More seconds"
    const val NOTHING_RECORDED = "Nothing recorded yet"
    const val MORE = "More"
    const val LESS = "Less"
    const val EMAIL = "Email (optional)"
    const val PAUSE_RECORDING = "Pause recording"
    const val SEND = "Send"
    const val SENDING = "Sending…"
    const val SAVED_OFFLINE = "Saved — will send when online"
    const val REJECTED = "Report not accepted by the server"
    const val DISCARD_TITLE = "Discard this report?"
    const val DISCARD = "Discard"
    const val KEEP_EDITING = "Keep editing"
    const val REPORT_THIS_SCREEN = "Report this screen?"
    const val GOT_IT = "Got it"
    const val DRAG_HANDLE = "Drag down to close"

    fun recordedOf(seconds: Int) = "of $seconds s recorded"

    fun sent(ticket: String?) = if (ticket.isNullOrEmpty()) "Sent" else "Sent · $ticket"

    fun sdkVersion(version: String) = "Snitch $version"

    fun testerNotice(gestureHint: String?, videoSeconds: Int?): String {
        val sb = StringBuilder("This is a test build.")
        if (gestureHint != null) sb.append(' ').append(gestureHint).append(" to report a problem.")
        if (videoSeconds != null) {
            sb.append(" The last $videoSeconds seconds of screen activity stay on this device and are only sent with a report you submit.")
        } else {
            sb.append(" Nothing leaves this device unless you send a report.")
        }
        return sb.toString()
    }

    const val HINT_THREE_FINGERS = "Hold three fingers on the screen"
    const val HINT_SHAKE = "Shake the device"
    const val HINT_BOTH = "Hold three fingers on the screen or shake the device"
}
