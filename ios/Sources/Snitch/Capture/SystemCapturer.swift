// System-mode capture (spec §5.3): ReplayKit in-app capture.
//
// - If another in-app ReplayKit session already runs (isRecording, e.g. the host
//   app's own recorder) we don't start; the runtime falls back to snapshot mode
//   and we poll until ReplayKit is free, then ask to be restarted.
// - Sample buffers arrive on a ReplayKit thread: we keep at most `systemFps` per
//   second, downscale on our own queue (Core Image) to a long edge ≤ 960 px,
//   apply mask rects (computed on main at ≤ 4 Hz and cached), JPEG, push.
// - A declined consent prompt means snapshot mode for the rest of the session.

import CoreImage
import CoreMedia
import ImageIO
import ReplayKit
import UIKit

final class SystemCapturer: NSObject {
    enum Fallback {
        /// Another ReplayKit session is running; `onAvailable` fires once it is free.
        case busy
        /// The tester declined the prompt, or ReplayKit is unavailable: snapshot mode for this session.
        case declined
        case unavailable
        case failed
    }

    var systemFps: Double = 10
    var maskTextInputs = true
    /// Called on main when system capture can't run and snapshot mode should take over.
    var onFallback: ((Fallback) -> Void)?
    /// Called on main when a busy ReplayKit became free again.
    var onAvailable: (() -> Void)?

    private let store: FrameStore
    private let stats: CaptureStats
    private let processQueue = DispatchQueue(label: "io.github.monjar.snitch.system", qos: .utility)
    private let ciContext = CIContext(options: [.cacheIntermediates: false])
    private let lock = NSLock()
    private var lastFrameT: Double = -Double.infinity
    private var processing = false
    private var cachedMasks: [CGRect] = []
    private var screenSize: CGSize = .zero
    private var maskTimer: Timer?
    private var busyTimer: Timer?
    private(set) var isCapturing = false
    private var starting = false
    private(set) var declinedThisSession = false
    private let pausedFlag = Locked(false)

    /// While true (sheet visible), incoming frames are dropped; ReplayKit keeps running so
    /// there is no new consent prompt when the sheet closes.
    var isPaused: Bool {
        get { pausedFlag.get() }
        set { pausedFlag.set(newValue) }
    }

    init(store: FrameStore, stats: CaptureStats) {
        self.store = store
        self.stats = stats
        super.init()
    }

    func start() {
        dispatchPrecondition(condition: .onQueue(.main))
        guard !isCapturing, !starting, !declinedThisSession else { return }
        let recorder = RPScreenRecorder.shared()
        guard recorder.isAvailable else {
            onFallback?(.unavailable)
            return
        }
        if recorder.isRecording {
            SDKLog.info("Another ReplayKit session is running; using snapshot capture until it ends")
            onFallback?(.busy)
            startBusyPolling()
            return
        }
        starting = true
        recorder.isMicrophoneEnabled = false
        refreshMasks()
        recorder.startCapture(handler: { [weak self] sampleBuffer, type, error in
            guard error == nil, type == .video else { return }
            self?.handleVideo(sampleBuffer)
        }, completionHandler: { [weak self] error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.starting = false
                if let error = error {
                    self.handleStartError(error)
                } else {
                    self.isCapturing = true
                    self.startMaskTimer()
                }
            }
        })
    }

    func stop() {
        dispatchPrecondition(condition: .onQueue(.main))
        stopTimers()
        guard isCapturing || starting else { return }
        isCapturing = false
        starting = false
        RPScreenRecorder.shared().stopCapture { _ in }
    }

    private func stopTimers() {
        maskTimer?.invalidate()
        maskTimer = nil
        busyTimer?.invalidate()
        busyTimer = nil
    }

    private func handleStartError(_ error: Error) {
        let code = (error as NSError).code
        // RPRecordingErrorCode.userDeclined; compared by value to avoid NS_ERROR_ENUM import naming differences.
        if code == -5801 {
            SDKLog.info("Screen recording was declined; using snapshot capture for this session")
            declinedThisSession = true
            onFallback?(.declined)
        } else {
            SDKLog.warn("ReplayKit capture failed to start (\(code)); using snapshot capture")
            onFallback?(.failed)
            if RPScreenRecorder.shared().isRecording { startBusyPolling() }
        }
    }

    private func startBusyPolling() {
        guard busyTimer == nil else { return }
        let timer = Timer(timeInterval: 5, repeats: true) { [weak self] t in
            guard let self = self else {
                t.invalidate()
                return
            }
            if !RPScreenRecorder.shared().isRecording {
                t.invalidate()
                self.busyTimer = nil
                self.onAvailable?()
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        busyTimer = timer
    }

    private func startMaskTimer() {
        maskTimer?.invalidate()
        let timer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
            self?.refreshMasks()
        }
        RunLoop.main.add(timer, forMode: .common)
        maskTimer = timer
    }

    /// Main thread: recompute mask rects (screen points) for the ReplayKit thread.
    private func refreshMasks() {
        guard let scene = AppWindows.activeScene() else { return }
        let rects = Masker.rects(in: AppWindows.visibleWindows(in: scene), maskTextInputs: maskTextInputs)
        let size = scene.coordinateSpace.bounds.size
        lock.lock()
        cachedMasks = rects
        screenSize = size
        lock.unlock()
    }

    /// ReplayKit thread: throttle, then process on our queue (dropping frames while busy).
    private func handleVideo(_ sampleBuffer: CMSampleBuffer) {
        if pausedFlag.get() { return }
        let now = Clock.nowMs()
        lock.lock()
        let minInterval = 1000 / max(1, systemFps)
        if processing || now - lastFrameT < minInterval {
            lock.unlock()
            return
        }
        lastFrameT = now
        processing = true
        let masks = cachedMasks
        let size = screenSize
        lock.unlock()

        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
            finishProcessing()
            return
        }
        var orientation = CGImagePropertyOrientation.up
        if let number = CMGetAttachment(sampleBuffer, key: RPVideoSampleOrientationKey as CFString, attachmentModeOut: nil) as? NSNumber,
           let o = CGImagePropertyOrientation(rawValue: number.uint32Value) {
            orientation = o
        }
        processQueue.async { [weak self] in
            self?.process(pixelBuffer, orientation: orientation, at: now, masks: masks, screenSize: size)
            self?.finishProcessing()
        }
    }

    private func finishProcessing() {
        lock.lock()
        processing = false
        lock.unlock()
    }

    private func process(_ pixelBuffer: CVPixelBuffer, orientation: CGImagePropertyOrientation, at t: Double, masks: [CGRect], screenSize: CGSize) {
        var image = CIImage(cvPixelBuffer: pixelBuffer).oriented(orientation)
        let extent = image.extent
        guard extent.width > 0, extent.height > 0 else { return }
        let scale = min(1, FrameCapturer.maxLongEdgePx / max(extent.width, extent.height))
        image = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let width = Int((extent.width * scale).rounded(.down))
        let height = Int((extent.height * scale).rounded(.down))
        guard width > 0, height > 0,
              let ctx = ImageCoding.makeBGRAContext(width: width, height: height) else { return }
        let target = CGRect(x: image.extent.origin.x, y: image.extent.origin.y, width: CGFloat(width), height: CGFloat(height))
        guard let scaled = ciContext.createCGImage(image, from: target) else { return }
        ctx.draw(scaled, in: CGRect(x: 0, y: 0, width: width, height: height))

        // Mask rects are in screen points with a top-left origin; the bitmap is bottom-left.
        let ppp = screenSize.width > 0 ? CGFloat(width) / screenSize.width : 1
        if !masks.isEmpty {
            ctx.saveGState()
            ctx.translateBy(x: 0, y: CGFloat(height))
            ctx.scaleBy(x: ppp, y: -ppp)
            Masker.draw(masks, in: ctx, pixelsPerPoint: ppp)
            ctx.restoreGState()
        }
        guard let frame = ctx.makeImage() else { return }
        let checksum = ImageCoding.checksum(frame)
        if checksum != store.newestChecksum, let jpeg = ImageCoding.jpegData(frame, quality: FrameCapturer.jpegQuality) {
            store.push(CapturedFrame(
                t: t, data: jpeg, width: width, height: height,
                pixelsPerPoint: Double(ppp), checksum: checksum
            ))
        }
        stats.recordFrame(at: t)
    }
}
