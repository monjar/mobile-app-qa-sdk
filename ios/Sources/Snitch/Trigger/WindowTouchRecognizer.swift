// Observes every touch of a window without disturbing it (spec §4.1).
//
// The recognizer stays `.possible` for the whole sequence, feeding each touch to
// the three-finger detector and the touch log, and never delays, prevents or
// waits for anything. Only when the detector fires does it act, in this order,
// synchronously on the main thread:
//   1. the host freezes the frame ring at the sequence's first touch and takes the screenshot
//   2. `state = .recognized` — UIKit sends touchesCancelled to the touched views
//   3. every other recognizer on these touches is toggled off/on (TouchCanceller),
//      which resets long-press timers, scroll pans, RN touch handlers…
//   4. on the next run-loop turn the host presents the sheet
// No swizzling: this is a plain UIGestureRecognizer subclass on each UIWindow.

import UIKit
import UIKit.UIGestureRecognizerSubclass

protocol WindowTouchRecognizerHost: AnyObject {
    /// Whether the three-finger detector may fire (VoiceOver off, sheet hidden, enabled…).
    var gestureDetectionEnabled: Bool { get }
    /// SNITCH_DEBUG_CANCEL_AFTER_MS, debug builds only.
    var debugCancelAfterMs: Double? { get }
    func recognizer(_ recognizer: WindowTouchRecognizer, observed sample: TouchSample)
    /// Step 1. Return false to abort the fire (nothing is cancelled then).
    func recognizerWillFire(_ recognizer: WindowTouchRecognizer, sequenceStart: Double, debug: Bool) -> Bool
    /// Step 4, on the next run-loop turn.
    func recognizerDidFire(_ recognizer: WindowTouchRecognizer, debug: Bool)
}

final class WindowTouchRecognizer: UIGestureRecognizer, UIGestureRecognizerDelegate {
    weak var host: WindowTouchRecognizerHost?

    private let detector = ThreeFingerHoldDetector()
    private var trackedTouches: [ObjectIdentifier: (id: Int, touch: UITouch)] = [:]
    private var nextTouchId = 1
    private var sequenceStartT: Double = 0
    private weak var lastEvent: UIEvent?
    private var tickTimer: Timer?
    private var debugTimer: Timer?

    /// Convenience so the inherited designated initializers (incl. any coder init) stay untouched.
    convenience init(host: WindowTouchRecognizerHost) {
        self.init(target: nil, action: nil)
        self.host = host
        cancelsTouchesInView = true
        delaysTouchesBegan = false
        delaysTouchesEnded = false
        requiresExclusiveTouchType = false
        delegate = self
    }

    // MARK: - Touches

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        lastEvent = event
        let now = Clock.nowMs()
        let startsSequence = trackedTouches.isEmpty
        if startsSequence { sequenceStartT = now }
        for touch in touches {
            let id = nextTouchId
            nextTouchId += 1
            trackedTouches[ObjectIdentifier(touch)] = (id: id, touch: touch)
            let p = point(of: touch)
            record(TouchSample(t: now, id: id, x: p.x, y: p.y, phase: .down))
            if state == .possible { feed(.down(t: now, id: id, x: p.x, y: p.y)) }
        }
        if startsSequence { scheduleDebugCancel() }
        scheduleTick()
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        lastEvent = event
        let now = Clock.nowMs()
        for touch in touches {
            guard let entry = trackedTouches[ObjectIdentifier(touch)] else { continue }
            let p = point(of: touch)
            record(TouchSample(t: now, id: entry.id, x: p.x, y: p.y, phase: .move))
            if state == .possible { feed(.move(t: now, id: entry.id, x: p.x, y: p.y)) }
        }
        scheduleTick()
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        lastEvent = event
        finish(touches, cancelled: false)
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        lastEvent = event
        finish(touches, cancelled: true)
    }

    private func finish(_ touches: Set<UITouch>, cancelled: Bool) {
        let now = Clock.nowMs()
        for touch in touches {
            guard let entry = trackedTouches.removeValue(forKey: ObjectIdentifier(touch)) else { continue }
            let p = point(of: touch)
            record(TouchSample(t: now, id: entry.id, x: p.x, y: p.y, phase: .up))
            let e: DetectorEvent = cancelled
                ? .cancel(t: now, id: entry.id, x: p.x, y: p.y)
                : .up(t: now, id: entry.id, x: p.x, y: p.y)
            if state == .possible { feed(e) }
        }
        if trackedTouches.isEmpty {
            invalidateTimers()
            if state == .possible { state = .failed }
        }
    }

    override func reset() {
        super.reset()
        // UIKit stops delivering this sequence's touches after recognition; tell the detector they're gone.
        let now = Clock.nowMs()
        for entry in trackedTouches.values {
            _ = detector.handle(.cancel(t: now, id: entry.id, x: 0, y: 0))
        }
        trackedTouches = [:]
        lastEvent = nil
        invalidateTimers()
    }

    // MARK: - Detection

    private func feed(_ event: DetectorEvent) {
        detector.config.enabled = host?.gestureDetectionEnabled ?? false
        if detector.handle(event) {
            fire(debug: false)
        }
    }

    /// One timer at the moment the hold becomes due, instead of a per-frame tick.
    private func scheduleTick() {
        tickTimer?.invalidate()
        tickTimer = nil
        guard state == .possible, let due = detector.fireDueAt else { return }
        let delay = max(0, due - Clock.nowMs()) / 1000 + 0.001
        let timer = Timer(timeInterval: delay, repeats: false) { [weak self] _ in
            guard let self = self, self.state == .possible else { return }
            self.feed(.tick(t: Clock.nowMs()))
        }
        RunLoop.main.add(timer, forMode: .common)
        tickTimer = timer
    }

    private func scheduleDebugCancel() {
        debugTimer?.invalidate()
        debugTimer = nil
        guard let ms = host?.debugCancelAfterMs, ms >= 0 else { return }
        let timer = Timer(timeInterval: ms / 1000, repeats: false) { [weak self] _ in
            guard let self = self, self.state == .possible, !self.trackedTouches.isEmpty else { return }
            self.fire(debug: true)
        }
        RunLoop.main.add(timer, forMode: .common)
        debugTimer = timer
    }

    private func invalidateTimers() {
        tickTimer?.invalidate()
        tickTimer = nil
        debugTimer?.invalidate()
        debugTimer = nil
    }

    private func fire(debug: Bool) {
        guard state == .possible, let host = host else { return }
        // Collect before recognizing: cancellation can detach recognizers from the touches.
        let others = TouchCanceller.recognizers(
            event: lastEvent,
            touches: trackedTouches.values.map { $0.touch },
            excluding: self
        )
        guard host.recognizerWillFire(self, sequenceStart: sequenceStartT, debug: debug) else { return }
        state = .recognized
        TouchCanceller.cancel(others)
        invalidateTimers()
        DispatchQueue.main.async { [weak self, weak host] in
            guard let self = self else { return }
            host?.recognizerDidFire(self, debug: debug)
        }
    }

    // MARK: - Helpers

    /// Window coordinates offset by the window origin (screen points).
    private func point(of touch: UITouch) -> (x: Double, y: Double) {
        let p = touch.location(in: view)
        let origin = view?.frame.origin ?? .zero
        return (x: Double(p.x + origin.x), y: Double(p.y + origin.y))
    }

    private func record(_ sample: TouchSample) {
        host?.recognizer(self, observed: sample)
    }

    // MARK: - Never interfere with other recognizers

    override func canPrevent(_ preventedGestureRecognizer: UIGestureRecognizer) -> Bool {
        false
    }

    override func canBePrevented(by preventingGestureRecognizer: UIGestureRecognizer) -> Bool {
        false
    }

    override func shouldRequireFailure(of otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        false
    }

    override func shouldBeRequiredToFail(by otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        false
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
        true
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRequireFailureOf otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
        false
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldBeRequiredToFailBy otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
        false
    }
}
