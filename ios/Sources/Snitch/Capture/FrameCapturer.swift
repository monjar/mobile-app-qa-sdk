// Snapshot-mode capture (spec §5.2): draws the app's own windows a few times a
// second into one reused bitmap and hands the result to a background queue for
// checksum + JPEG + ring push.
//
// - The timer runs in RunLoop.main's `.default` mode only, so nothing is captured
//   while a scroll view is tracking (that's when frames would hitch the most).
// - The governor sets the pace: 1 fps idle, activeFps for 1.5 s after a touch,
//   and never more than the main-thread budget allows given the measured cost.
// - Only the drawing and masking happen on the main thread; at most two frames
//   are in flight on the encode queue, beyond that a frame is skipped.

import UIKit

final class FrameCapturer {
    struct Settings: Equatable {
        var renderer: SnapshotRenderer
        var governor: GovernorConfig
        var maskTextInputs: Bool
    }

    static let maxLongEdgePx: CGFloat = 960
    static let jpegQuality = 0.55

    var settings: Settings
    private let store: FrameStore
    private let stats: CaptureStats

    /// Evaluated before every frame: sheet visible, backgrounded, paused by the app or tester…
    var isPaused: () -> Bool = { false }
    /// Monotonic ms of the last touch anywhere in the app.
    var lastTouchAt: () -> Double? = { nil }

    private var running = false
    private var timer: Timer?
    private var scheduledAt: Double?
    private var lastCaptureAt: Double?
    private var avgCost: Double?
    private var context: CGContext?
    private var contextWidth = 0
    private var contextHeight = 0
    private var inFlight = 0
    private let encodeQueue = DispatchQueue(label: "io.github.monjar.snitch.encode", qos: .utility)

    init(settings: Settings, store: FrameStore, stats: CaptureStats) {
        self.settings = settings
        self.store = store
        self.stats = stats
    }

    var isRunning: Bool {
        running
    }

    func start() {
        dispatchPrecondition(condition: .onQueue(.main))
        running = true
        reschedule()
    }

    func stop() {
        dispatchPrecondition(condition: .onQueue(.main))
        running = false
        cancelTimer()
        context = nil
    }

    /// Re-evaluates the governor (after a touch, a pause change, thermal or power changes).
    func reschedule() {
        guard running else { return }
        let now = Clock.nowMs()
        let processInfo = ProcessInfo.processInfo
        let input = GovernorInput(
            now: now,
            lastTouchAt: lastTouchAt(),
            avgCostMs: avgCost ?? 0,
            lowPower: processInfo.isLowPowerModeEnabled,
            thermal: DeviceInfoCollector.governorThermal(processInfo.thermalState),
            paused: isPaused()
        )
        guard let delay = CaptureGovernor.nextCaptureDelayMs(settings.governor, input) else {
            cancelTimer()
            return
        }
        let due = max(now, (lastCaptureAt ?? -Double.infinity) + delay)
        if timer != nil, let current = scheduledAt, current <= due + 1 { return }
        cancelTimer()
        let timer = Timer(timeInterval: max(0, due - now) / 1000, repeats: false) { [weak self] _ in
            self?.fire()
        }
        timer.tolerance = min(0.05, delay / 1000 / 10)
        RunLoop.main.add(timer, forMode: .default)
        self.timer = timer
        scheduledAt = due
    }

    private func cancelTimer() {
        timer?.invalidate()
        timer = nil
        scheduledAt = nil
    }

    private func fire() {
        timer = nil
        scheduledAt = nil
        guard running, !isPaused() else { return }
        if inFlight >= 2 {
            stats.recordSkipped()
            lastCaptureAt = Clock.nowMs()
        } else {
            captureFrame()
        }
        reschedule()
    }

    private func captureFrame() {
        guard let scene = AppWindows.activeScene(), scene.activationState == .foregroundActive else { return }
        let windows = AppWindows.visibleWindows(in: scene)
        guard !windows.isEmpty else { return }
        let bounds = scene.coordinateSpace.bounds
        let longEdge = max(bounds.width, bounds.height)
        guard longEdge > 0 else { return }
        let scale = min(1, FrameCapturer.maxLongEdgePx / longEdge)
        let width = Int((bounds.width * scale).rounded(.down))
        let height = Int((bounds.height * scale).rounded(.down))
        guard width > 0, height > 0 else { return }

        if context == nil || contextWidth != width || contextHeight != height {
            context = ImageCoding.makeBGRAContext(width: width, height: height)
            contextWidth = width
            contextHeight = height
        }
        guard let ctx = context else { return }

        let start = CACurrentMediaTime()
        ctx.saveGState()
        ctx.setFillColor(UIColor.black.cgColor)
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        // Flip to UIKit's top-left origin and scale points to pixels.
        ctx.translateBy(x: 0, y: CGFloat(height))
        ctx.scaleBy(x: scale, y: -scale)
        ctx.translateBy(x: -bounds.origin.x, y: -bounds.origin.y)
        let masks = Masker.rects(in: windows, maskTextInputs: settings.maskTextInputs)
        WindowRenderer.draw(windows, renderer: settings.renderer, in: ctx)
        Masker.draw(masks, in: ctx, pixelsPerPoint: scale)
        ctx.restoreGState()
        let image = ctx.makeImage()
        let costMs = (CACurrentMediaTime() - start) * 1000

        avgCost = CaptureGovernor.updateAverageCost(avgCost, costMs)
        stats.recordCost(costMs)
        let t = start * 1000
        lastCaptureAt = t
        guard let cgImage = image else { return }

        inFlight += 1
        let store = self.store
        let stats = self.stats
        let ppp = Double(scale)
        encodeQueue.async { [weak self] in
            let checksum = ImageCoding.checksum(cgImage)
            if checksum != store.newestChecksum,
               let jpeg = ImageCoding.jpegData(cgImage, quality: FrameCapturer.jpegQuality) {
                store.push(CapturedFrame(
                    t: t, data: jpeg, width: cgImage.width, height: cgImage.height,
                    pixelsPerPoint: ppp, checksum: checksum
                ))
            }
            stats.recordFrame(at: t)
            DispatchQueue.main.async {
                self?.inFlight -= 1
            }
        }
    }
}
