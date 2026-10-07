// Cancels whatever else is tracking the trigger's touches (spec §4.1 step 3).
//
// Toggling `isEnabled` off and on makes UIKit reset a recognizer: a pending
// UILongPressGestureRecognizer never fires, scroll-view pans stop, React
// Native's RCTSurfaceTouchHandler resets and emits TouchCancel to JS (so
// Pressable long-press timers die), and RNGH handlers cancel. Recognizers that
// were already disabled are left alone — toggling them would enable them.

import UIKit

enum TouchCanceller {
    static func recognizers(event: UIEvent?, touches: [UITouch], excluding me: UIGestureRecognizer) -> [UIGestureRecognizer] {
        var all: [UITouch] = touches
        if let eventTouches = event?.allTouches { all.append(contentsOf: eventTouches) }
        var seen = Set<ObjectIdentifier>()
        var out: [UIGestureRecognizer] = []
        for touch in all {
            for recognizer in touch.gestureRecognizers ?? [] where recognizer !== me {
                if seen.insert(ObjectIdentifier(recognizer)).inserted { out.append(recognizer) }
            }
        }
        return out
    }

    static func cancel(_ recognizers: [UIGestureRecognizer]) {
        for recognizer in recognizers where recognizer.isEnabled {
            recognizer.isEnabled = false
            recognizer.isEnabled = true
        }
    }
}
