// Composes the clip at send time (spec §5.7): frozen JPEG frames + touch log →
// H.264 MP4 at 10 fps.
//
// - AVAssetWriter, .mp4, shouldOptimizeForNetworkUse (moov atom first, so the
//   dashboard can start playing before the whole file arrives)
// - dimensions of the first frame rounded down to even, 1.2 Mbps, keyframe every 10 frames
// - explicit CMTime(k, 10) per output frame from ClipSchedule; each source JPEG
//   is decoded once and redrawn while the schedule repeats it
// - touch trails: samples in (t-200 ms, t] as fading circles, newest per pointer unfaded
//
// Synchronous and UIKit-free: the caller runs it off the main thread inside a
// background task (so it is also unit-testable on the simulator).

import AVFoundation
import CoreGraphics
import CoreVideo
import Foundation

enum VideoComposer {
    static let fps: Double = 10
    static let bitRate = 1_200_000
    static let trailMs: Double = 200
    static let trailRadiusPt: Double = 14
    static let trailOutlinePt: Double = 1.5
    static let trailAlpha: Double = 0.55

    struct Result: Equatable {
        var url: URL
        var width: Int
        var height: Int
        var durationMs: Int
        var frameCount: Int
    }

    enum ComposeError: Error {
        case noFrames
        case writerSetup(String)
        case decodeFailed
        case writeFailed(String)
    }

    /// Writes [endT - durationMs, endT] of `frames` to `outputURL` (replaced if present).
    static func compose(
        frames source: [CapturedFrame],
        touches: [TouchSample],
        endT: Double,
        durationMs: Double,
        to outputURL: URL
    ) throws -> Result {
        guard let first = source.first else { throw ComposeError.noFrames }
        let start = endT - durationMs
        let schedule = ClipSchedule.clipSchedule(source.map { $0.t }, start, endT, fps)
        guard !schedule.isEmpty else { throw ComposeError.noFrames }

        let width = (first.width / 2) * 2
        let height = (first.height / 2) * 2
        guard width >= 2, height >= 2 else { throw ComposeError.writerSetup("frame too small") }

        try? FileManager.default.removeItem(at: outputURL)
        let writer: AVAssetWriter
        do {
            writer = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)
        } catch {
            throw ComposeError.writerSetup("\(error)")
        }
        writer.shouldOptimizeForNetworkUse = true

        let settings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: bitRate,
                AVVideoMaxKeyFrameIntervalKey: 10,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            ] as [String: Any],
        ]
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        input.expectsMediaDataInRealTime = false
        let attributes: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: width,
            kCVPixelBufferHeightKey as String: height,
            kCVPixelBufferCGImageCompatibilityKey as String: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey as String: true,
        ]
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: attributes)
        guard writer.canAdd(input) else { throw ComposeError.writerSetup("cannot add input") }
        writer.add(input)
        guard writer.startWriting() else {
            throw ComposeError.writerSetup(writer.error.map { "\($0)" } ?? "startWriting failed")
        }
        writer.startSession(atSourceTime: .zero)

        var decodedIndex = -1
        var decoded: CGImage?
        let step = 1000 / fps
        for (k, sourceIndex) in schedule.enumerated() {
            if sourceIndex != decodedIndex {
                decoded = ImageCoding.decode(source[sourceIndex].data)
                decodedIndex = sourceIndex
            }
            guard let image = decoded else {
                writer.cancelWriting()
                throw ComposeError.decodeFailed
            }
            guard waitUntilReady(input, writer: writer), let pool = adaptor.pixelBufferPool else {
                writer.cancelWriting()
                throw ComposeError.writeFailed(writer.error.map { "\($0)" } ?? "input not ready")
            }
            var pixelBuffer: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &pixelBuffer)
            guard let buffer = pixelBuffer else {
                writer.cancelWriting()
                throw ComposeError.writeFailed("no pixel buffer")
            }
            let t = start + Double(k) * step
            draw(image: image, frame: source[sourceIndex], touches: touches, at: t, into: buffer, width: width, height: height)
            let time = CMTime(value: CMTimeValue(k), timescale: CMTimeScale(fps))
            if !adaptor.append(buffer, withPresentationTime: time) {
                writer.cancelWriting()
                throw ComposeError.writeFailed(writer.error.map { "\($0)" } ?? "append failed")
            }
        }

        input.markAsFinished()
        writer.endSession(atSourceTime: CMTime(value: CMTimeValue(schedule.count), timescale: CMTimeScale(fps)))
        let done = DispatchSemaphore(value: 0)
        writer.finishWriting { done.signal() }
        done.wait()
        guard writer.status == .completed else {
            throw ComposeError.writeFailed(writer.error.map { "\($0)" } ?? "status \(writer.status.rawValue)")
        }
        return Result(
            url: outputURL,
            width: width,
            height: height,
            durationMs: Int((Double(schedule.count) * step).rounded()),
            frameCount: schedule.count
        )
    }

    private static func waitUntilReady(_ input: AVAssetWriterInput, writer: AVAssetWriter) -> Bool {
        let deadline = Date().addingTimeInterval(10)
        while !input.isReadyForMoreMediaData {
            if writer.status != .writing || Date() > deadline { return false }
            Thread.sleep(forTimeInterval: 0.002)
        }
        return true
    }

    private static func draw(
        image: CGImage,
        frame: CapturedFrame,
        touches: [TouchSample],
        at t: Double,
        into buffer: CVPixelBuffer,
        width: Int,
        height: Int
    ) {
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        guard let ctx = ImageCoding.makeBGRAContext(
            width: width,
            height: height,
            data: CVPixelBufferGetBaseAddress(buffer),
            bytesPerRow: CVPixelBufferGetBytesPerRow(buffer)
        ) else { return }

        let canvas = CGRect(x: 0, y: 0, width: width, height: height)
        ctx.setFillColor(CGColor(gray: 0, alpha: 1))
        ctx.fill(canvas)
        // Aspect-fit: frames normally match the canvas, but rotation mid-clip changes their shape.
        let iw = CGFloat(image.width)
        let ih = CGFloat(image.height)
        let fit = min(CGFloat(width) / iw, CGFloat(height) / ih)
        let drawW = iw * fit
        let drawH = ih * fit
        let rect = CGRect(x: (CGFloat(width) - drawW) / 2, y: (CGFloat(height) - drawH) / 2, width: drawW, height: drawH)
        ctx.interpolationQuality = .medium
        ctx.draw(image, in: rect)

        // Touch trails, in the frame's pixel space (top-left origin) mapped into `rect`.
        let recent = touches.filter { $0.t > t - trailMs && $0.t <= t }
        guard !recent.isEmpty else { return }
        var newest: [Int: Double] = [:]
        for s in recent { newest[s.id] = max(newest[s.id] ?? -Double.infinity, s.t) }
        let pxPerPt = CGFloat(frame.pixelsPerPoint) * fit
        let radius = CGFloat(trailRadiusPt) * pxPerPt
        ctx.setLineWidth(CGFloat(trailOutlinePt) * pxPerPt)
        for s in recent {
            let recency = s.t == newest[s.id] ? 1 : max(0, 1 - (t - s.t) / trailMs)
            let alpha = CGFloat(trailAlpha * recency)
            guard alpha > 0.01 else { continue }
            let x = rect.minX + CGFloat(s.x) * pxPerPt
            let y = rect.maxY - CGFloat(s.y) * pxPerPt
            let circle = CGRect(x: x - radius, y: y - radius, width: radius * 2, height: radius * 2)
            ctx.setFillColor(CGColor(gray: 1, alpha: alpha))
            ctx.fillEllipse(in: circle)
            ctx.setStrokeColor(CGColor(gray: 0, alpha: min(1, alpha * 1.2)))
            ctx.strokeEllipse(in: circle)
        }
    }
}
