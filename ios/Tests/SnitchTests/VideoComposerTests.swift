// VideoComposer produces a playable H.264 MP4 of the requested length from
// synthetic JPEG frames (runs on the iOS simulator; no UI needed).

import AVFoundation
import CoreGraphics
import XCTest
@testable import Snitch

final class VideoComposerTests: XCTestCase {
    private var tempDir: URL!

    override func setUpWithError() throws {
        tempDir = FileManager.default.temporaryDirectory.appendingPathComponent("snitch-video-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tempDir)
    }

    private func frames(count: Int, every ms: Double, width: Int = 393, height: Int = 852) throws -> [CapturedFrame] {
        try (0..<count).map { (i: Int) throws -> CapturedFrame in
            let jpeg = try XCTUnwrap(makeJPEG(width: width, height: height, gray: CGFloat(i % 5) / 5))
            return CapturedFrame(t: Double(i) * ms, data: jpeg, width: width, height: height, pixelsPerPoint: 1, checksum: "\(i)")
        }
    }

    func testComposesPlayableClipOfRequestedLength() throws {
        let source = try frames(count: 6, every: 1000)
        let touches = [
            TouchSample(t: 2000, id: 1, x: 100, y: 200, phase: .down),
            TouchSample(t: 2050, id: 1, x: 110, y: 210, phase: .move),
            TouchSample(t: 2150, id: 1, x: 120, y: 220, phase: .up),
        ]
        let url = tempDir.appendingPathComponent("clip.mp4")
        let seconds = 4.0
        let result = try VideoComposer.compose(frames: source, touches: touches, endT: 5000, durationMs: seconds * 1000, to: url)

        XCTAssertEqual(result.width, 392, "dimensions are rounded down to even")
        XCTAssertEqual(result.height, 852)
        XCTAssertEqual(result.frameCount, 40)
        XCTAssertEqual(result.durationMs, 4000)

        let asset = AVURLAsset(url: url)
        XCTAssertEqual(CMTimeGetSeconds(asset.duration), seconds, accuracy: 0.2)
        let tracks = asset.tracks(withMediaType: .video)
        XCTAssertEqual(tracks.count, 1)
        XCTAssertTrue(asset.isPlayable)
        if let track = tracks.first {
            XCTAssertEqual(Double(track.naturalSize.width), 392, accuracy: 1)
            XCTAssertEqual(Double(track.naturalSize.height), 852, accuracy: 1)
        }
    }

    func testMoovAtomComesBeforeMediaData() throws {
        let url = tempDir.appendingPathComponent("faststart.mp4")
        _ = try VideoComposer.compose(frames: try frames(count: 3, every: 500), touches: [], endT: 1500, durationMs: 1500, to: url)
        let data = try Data(contentsOf: url)
        let moov = try XCTUnwrap(data.range(of: Data("moov".utf8)))
        let mdat = try XCTUnwrap(data.range(of: Data("mdat".utf8)))
        XCTAssertLessThan(moov.lowerBound, mdat.lowerBound, "shouldOptimizeForNetworkUse puts moov first")
    }

    func testSingleOldFrameStillMakesAClip() throws {
        let url = tempDir.appendingPathComponent("single.mp4")
        let result = try VideoComposer.compose(frames: try frames(count: 1, every: 0), touches: [], endT: 10_000, durationMs: 2000, to: url)
        XCTAssertEqual(result.frameCount, 20)
        XCTAssertEqual(CMTimeGetSeconds(AVURLAsset(url: url).duration), 2, accuracy: 0.2)
    }

    func testNoFramesThrows() {
        let url = tempDir.appendingPathComponent("none.mp4")
        XCTAssertThrowsError(try VideoComposer.compose(frames: [], touches: [], endT: 1000, durationMs: 1000, to: url))
    }
}
