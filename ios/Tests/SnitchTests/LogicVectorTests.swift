// The pure-logic twins against contract/vectors: gesture, governor (incl. EWMA),
// ring, compose and the iOS release-type classifier.

import XCTest
@testable import Snitch

final class GestureVectorTests: XCTestCase {
    func testDefaultsMatchContract() throws {
        let root = try Contract.vector("gesture.json")
        let d = try XCTUnwrap(root["defaults"] as? [String: Any])
        let c = DetectorConfig()
        XCTAssertEqual(Contract.number(d["pointers"]), Double(c.pointers))
        XCTAssertEqual(Contract.number(d["landingWindowMs"]), c.landingWindowMs)
        XCTAssertEqual(Contract.number(d["holdMs"]), c.holdMs)
        XCTAssertEqual(Contract.number(d["slop"]), c.slop)
        XCTAssertEqual(Contract.number(d["cooldownMs"]), c.cooldownMs)
        XCTAssertEqual(d["enabled"] as? Bool, c.enabled)
    }

    func testVectors() throws {
        let root = try Contract.vector("gesture.json")
        let cases = try XCTUnwrap(root["cases"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty)
        for c in cases {
            let name = Contract.string(c["name"]) ?? "?"
            var config = DetectorConfig()
            if let o = c["config"] as? [String: Any] {
                if let v = Contract.number(o["pointers"]) { config.pointers = Int(v) }
                if let v = Contract.number(o["landingWindowMs"]) { config.landingWindowMs = v }
                if let v = Contract.number(o["holdMs"]) { config.holdMs = v }
                if let v = Contract.number(o["slop"]) { config.slop = v }
                if let v = Contract.number(o["cooldownMs"]) { config.cooldownMs = v }
                if let v = o["enabled"] as? Bool { config.enabled = v }
            }
            let detector = ThreeFingerHoldDetector(config: config)
            var fires: [Double] = []
            for raw in try XCTUnwrap(c["events"] as? [[String: Any]], name) {
                let event = try parseEvent(raw)
                if detector.handle(event) { fires.append(event.t) }
            }
            let expected = try XCTUnwrap(c["fires"] as? [Any], name).compactMap { Contract.number($0) }
            XCTAssertEqual(fires, expected, name)
        }
    }

    private func parseEvent(_ e: [String: Any]) throws -> DetectorEvent {
        let t = try XCTUnwrap(Contract.number(e["t"]))
        let type = try XCTUnwrap(Contract.string(e["type"]))
        if type == "tick" { return .tick(t: t) }
        let id = Int(try XCTUnwrap(Contract.number(e["id"])))
        let x = try XCTUnwrap(Contract.number(e["x"]))
        let y = try XCTUnwrap(Contract.number(e["y"]))
        switch type {
        case "down": return .down(t: t, id: id, x: x, y: y)
        case "move": return .move(t: t, id: id, x: x, y: y)
        case "up": return .up(t: t, id: id, x: x, y: y)
        case "cancel": return .cancel(t: t, id: id, x: x, y: y)
        default:
            XCTFail("unknown event type \(type)")
            return .tick(t: t)
        }
    }
}

final class GovernorVectorTests: XCTestCase {
    func testVectors() throws {
        let root = try Contract.vector("governor.json")
        let defaults = try XCTUnwrap(root["defaults"] as? [String: Any])
        let cases = try XCTUnwrap(root["cases"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty)
        for c in cases {
            let name = Contract.string(c["name"]) ?? "?"
            var config = GovernorConfig()
            XCTAssertEqual(Contract.number(defaults["idleFps"]), config.idleFps)
            XCTAssertEqual(Contract.number(defaults["activeFps"]), config.activeFps)
            XCTAssertEqual(Contract.number(defaults["budgetPct"]), config.budgetPct)
            XCTAssertEqual(Contract.number(defaults["activeWindowMs"]), config.activeWindowMs)
            if let o = c["config"] as? [String: Any] {
                if let v = Contract.number(o["idleFps"]) { config.idleFps = v }
                if let v = Contract.number(o["activeFps"]) { config.activeFps = v }
                if let v = Contract.number(o["budgetPct"]) { config.budgetPct = v }
                if let v = Contract.number(o["activeWindowMs"]) { config.activeWindowMs = v }
            }
            let i = try XCTUnwrap(c["input"] as? [String: Any], name)
            let input = GovernorInput(
                now: try XCTUnwrap(Contract.number(i["now"])),
                lastTouchAt: Contract.number(i["lastTouchAt"]),
                avgCostMs: try XCTUnwrap(Contract.number(i["avgCostMs"])),
                lowPower: try XCTUnwrap(i["lowPower"] as? Bool),
                thermal: try XCTUnwrap(GovernorThermalState(rawValue: Contract.string(i["thermal"]) ?? "")),
                paused: try XCTUnwrap(i["paused"] as? Bool)
            )
            XCTAssertEqual(CaptureGovernor.nextCaptureDelayMs(config, input), Contract.number(c["delayMs"]), name)
        }
    }

    func testEwma() throws {
        let root = try Contract.vector("governor.json")
        let ewma = try XCTUnwrap(root["ewma"] as? [String: Any])
        let samples = try XCTUnwrap(ewma["samples"] as? [Any]).compactMap { Contract.number($0) }
        let expected = try XCTUnwrap(ewma["expect"] as? [Any]).compactMap { Contract.number($0) }
        XCTAssertEqual(samples.count, expected.count)
        var avg: Double?
        for (sample, want) in zip(samples, expected) {
            let next = CaptureGovernor.updateAverageCost(avg, sample)
            XCTAssertEqual(next, want, accuracy: 1e-9)
            avg = next
        }
    }
}

private struct TestFrame: RingFrame, Equatable {
    var t: Double
    var size: Int
    var checksum: String
}

final class RingVectorTests: XCTestCase {
    func testVectors() throws {
        let root = try Contract.vector("ring.json")
        let cases = try XCTUnwrap(root["cases"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty)
        for c in cases {
            let name = Contract.string(c["name"]) ?? "?"
            var ring = FrameRing<TestFrame>(
                maxBytes: Int(try XCTUnwrap(Contract.number(c["maxBytes"]))),
                maxAgeMs: try XCTUnwrap(Contract.number(c["maxAgeMs"]))
            )
            for op in try XCTUnwrap(c["ops"] as? [[String: Any]], name) {
                switch Contract.string(op["op"]) ?? "" {
                case "push":
                    ring.push(TestFrame(
                        t: try XCTUnwrap(Contract.number(op["t"])),
                        size: Int(try XCTUnwrap(Contract.number(op["size"]))),
                        checksum: try XCTUnwrap(Contract.string(op["checksum"]))
                    ))
                case "expect":
                    let ts = try XCTUnwrap(op["ts"] as? [Any]).compactMap { Contract.number($0) }
                    XCTAssertEqual(ring.frames.map { $0.t }, ts, name)
                    XCTAssertEqual(Double(ring.totalBytes), Contract.number(op["totalBytes"]), name)
                case "select":
                    let ts = try XCTUnwrap(op["ts"] as? [Any]).compactMap { Contract.number($0) }
                    let got = ring.select(try XCTUnwrap(Contract.number(op["endT"])), try XCTUnwrap(Contract.number(op["durationMs"])))
                    XCTAssertEqual(got.map { $0.t }, ts, name)
                case "trimHalf":
                    ring.trimHalf()
                case "buffered":
                    let got = ring.bufferedMs(try XCTUnwrap(Contract.number(op["endT"])))
                    XCTAssertEqual(got, Contract.number(op["ms"]), name)
                default:
                    XCTFail("\(name): unknown op \(op["op"] ?? "nil")")
                }
            }
        }
    }

    func testFrozenCopyIsIndependent() {
        var live = FrameRing<TestFrame>(maxBytes: 1000, maxAgeMs: 30_000)
        live.push(TestFrame(t: 0, size: 10, checksum: "a"))
        let frozen = live
        live.push(TestFrame(t: 100, size: 10, checksum: "b"))
        XCTAssertEqual(frozen.frames.count, 1)
        XCTAssertEqual(live.frames.count, 2)
    }
}

final class ComposeVectorTests: XCTestCase {
    func testVectors() throws {
        let root = try Contract.vector("compose.json")
        let cases = try XCTUnwrap(root["cases"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty)
        for c in cases {
            let name = Contract.string(c["name"]) ?? "?"
            let frameTimes = try XCTUnwrap(c["frameTimes"] as? [Any]).compactMap { Contract.number($0) }
            let got = ClipSchedule.clipSchedule(
                frameTimes,
                try XCTUnwrap(Contract.number(c["start"])),
                try XCTUnwrap(Contract.number(c["end"])),
                try XCTUnwrap(Contract.number(c["fps"]))
            )
            let expected = try XCTUnwrap(c["expect"] as? [Any]).compactMap { Contract.number($0) }.map { Int($0) }
            XCTAssertEqual(got, expected, name)
        }
    }
}

final class ReleaseTypeVectorTests: XCTestCase {
    func testIosVectors() throws {
        let root = try Contract.vector("release-type.json")
        let cases = try XCTUnwrap(root["ios"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty)
        for c in cases {
            let name = Contract.string(c["name"]) ?? "?"
            let s = try XCTUnwrap(c["signals"] as? [String: Any], name)
            var profile: ProvisioningProfileSignals?
            if let p = s["profile"] as? [String: Any] {
                profile = ProvisioningProfileSignals(
                    getTaskAllow: try XCTUnwrap(p["getTaskAllow"] as? Bool),
                    provisionsAllDevices: try XCTUnwrap(p["provisionsAllDevices"] as? Bool),
                    provisionedDeviceCount: Int(try XCTUnwrap(Contract.number(p["provisionedDeviceCount"])))
                )
            }
            let signals = IosReleaseSignals(
                isSimulator: try XCTUnwrap(s["isSimulator"] as? Bool),
                profile: profile,
                receipt: Contract.string(s["receipt"]),
                appTransactionEnvironment: Contract.string(s["appTransactionEnvironment"])
            )
            XCTAssertEqual(ReleaseTypeClassifier.classifyIos(signals).rawValue, Contract.string(c["expect"]), name)
        }
    }
}
