// Gesture.edgeHandle: the pull maths, the option parsing (Info.plist and bridge
// keys), and the effective config the runtime reads.

import XCTest
@testable import Snitch

final class EdgeHandleGeometryTests: XCTestCase {
    func testARightHandleIsPulledLeftwards() {
        XCTAssertEqual(EdgeHandleGeometry.pull(translationX: -30, side: .right), 30)
        XCTAssertEqual(EdgeHandleGeometry.pull(translationX: 30, side: .right), 0, "towards the edge is no pull")
        XCTAssertFalse(EdgeHandleGeometry.opens(translationX: -43, side: .right))
        XCTAssertTrue(EdgeHandleGeometry.opens(translationX: -44, side: .right))
    }

    func testALeftHandleIsPulledRightwards() {
        XCTAssertEqual(EdgeHandleGeometry.pull(translationX: 30, side: .left), 30)
        XCTAssertEqual(EdgeHandleGeometry.pull(translationX: -30, side: .left), 0)
        XCTAssertTrue(EdgeHandleGeometry.opens(translationX: 50, side: .left))
        XCTAssertFalse(EdgeHandleGeometry.opens(translationX: -50, side: .left))
    }

    func testThePullIsCappedAndTheTabMovesTowardsTheCentre() {
        XCTAssertEqual(EdgeHandleGeometry.pull(translationX: -500, side: .right), EdgeHandleGeometry.maxPull)
        XCTAssertEqual(EdgeHandleGeometry.offset(pull: 20, side: .right), -20)
        XCTAssertEqual(EdgeHandleGeometry.offset(pull: 20, side: .left), 20)
        XCTAssertEqual(EdgeHandleGeometry.progress(pull: 0), 0)
        XCTAssertEqual(EdgeHandleGeometry.progress(pull: 22), 0.5)
        XCTAssertEqual(EdgeHandleGeometry.progress(pull: 70), 1)
    }

    func testPositionIsClamped() {
        XCTAssertEqual(EdgeHandleGeometry.clampPosition(0.5), 0.5)
        XCTAssertEqual(EdgeHandleGeometry.clampPosition(0), 0.1)
        XCTAssertEqual(EdgeHandleGeometry.clampPosition(2), 0.9)
        XCTAssertEqual(EdgeHandleGeometry.clampPosition(.nan), 0.33)
    }

    func testHexColors() {
        let c = EdgeHandleGeometry.rgba(hex: "#00E5DB")
        XCTAssertEqual(c?.r, 0)
        XCTAssertEqual(c?.g ?? 0, 229.0 / 255, accuracy: 0.0001)
        XCTAssertEqual(c?.a, 1)
        XCTAssertEqual(EdgeHandleGeometry.rgba(hex: "ff000080")?.a ?? 0, 128.0 / 255, accuracy: 0.0001)
        for bad in [nil, "", "#12345", "#GGGGGG", "red", "#1234567"] {
            XCTAssertNil(EdgeHandleGeometry.rgba(hex: bad), "\(bad ?? "nil")")
        }
    }
}

final class EdgeHandleConfigTests: XCTestCase {
    func testInfoPlistKeys() {
        let c = StaticConfig.fromDictionary([
            "Gesture": "edgeHandle",
            "EdgeHandleSide": "left",
            "EdgeHandlePosition": 0.6,
            "EdgeHandleColor": "#00E5DB",
        ], keys: .infoPlist)
        XCTAssertEqual(c.options.gesture, .edgeHandle)
        XCTAssertEqual(c.options.edgeHandleSide, .left)
        XCTAssertEqual(c.options.edgeHandlePosition, 0.6)
        XCTAssertEqual(c.options.edgeHandleColor, "#00E5DB")
    }

    func testBridgeKeys() {
        let c = StaticConfig.fromDictionary(["gesture": "edgeHandle", "edgeHandlePosition": 5, "edgeHandleColor": "nope"], keys: .bridge)
        XCTAssertEqual(c.options.gesture, .edgeHandle)
        XCTAssertEqual(c.options.edgeHandleSide, .right, "default side")
        XCTAssertEqual(c.options.edgeHandlePosition, 0.9, "clamped")
        XCTAssertNil(c.options.edgeHandleColor, "a malformed color falls back to the system tint")
    }

    func testDefaultsAndEffectiveConfig() {
        let options = SnitchOptions(gesture: .edgeHandle)
        XCTAssertEqual(options.edgeHandleSide, .right)
        XCTAssertEqual(options.edgeHandlePosition, 0.33)
        let effective = ConfigMerger.effective(options: options, remote: nil)
        XCTAssertEqual(effective.gesture, .edgeHandle)
        XCTAssertEqual(effective.edgeHandleSide, .right)
        XCTAssertEqual(effective.edgeHandlePosition, 0.33)
    }

    func testTheTesterNoticeExplainsTheHandle() {
        XCTAssertTrue(Strings.testerNotice(gesture: .edgeHandle, seconds: 30).contains("Pull the tab"))
    }
}
