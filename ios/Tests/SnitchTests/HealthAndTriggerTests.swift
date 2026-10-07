// Crash-loop sentinel, capture-stat percentiles, the shake rule and the touch log.

import XCTest
@testable import Snitch

final class HealthAndTriggerTests: XCTestCase {
    private var suite: String!
    private var defaults: UserDefaults!

    override func setUpWithError() throws {
        suite = "snitch.tests.\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    }

    override func tearDownWithError() throws {
        defaults.removePersistentDomain(forName: suite)
    }

    func testTwoAbruptSessionsDowngradeTheRendererForThisBuild() {
        let sentinel = CrashLoopSentinel(defaults: defaults, build: "7")
        XCTAssertFalse(sentinel.checkAtLaunch(), "clean launch")

        defaults.set("drawHierarchy", forKey: DefaultsKey.captureSession)
        XCTAssertFalse(sentinel.checkAtLaunch())
        XCTAssertEqual(sentinel.downgradeLevel, 0)

        defaults.set("drawHierarchy", forKey: DefaultsKey.captureSession)
        XCTAssertTrue(sentinel.checkAtLaunch())
        XCTAssertEqual(sentinel.downgradeLevel, 1)
        XCTAssertTrue(sentinel.healthPending)
        sentinel.healthReported()
        XCTAssertFalse(sentinel.healthPending)

        // Killed while a debugger was attached (Xcode Stop) doesn't count.
        defaults.set("layerRender|debugger", forKey: DefaultsKey.captureSession)
        XCTAssertFalse(sentinel.checkAtLaunch())
        defaults.set("layerRender|debugger", forKey: DefaultsKey.captureSession)
        XCTAssertFalse(sentinel.checkAtLaunch())
        XCTAssertEqual(sentinel.downgradeLevel, 1)

        defaults.set("layerRender", forKey: DefaultsKey.captureSession)
        XCTAssertFalse(sentinel.checkAtLaunch())
        defaults.set("layerRender", forKey: DefaultsKey.captureSession)
        XCTAssertTrue(sentinel.checkAtLaunch())
        XCTAssertEqual(sentinel.downgradeLevel, 2)

        XCTAssertEqual(CrashLoopSentinel(defaults: defaults, build: "8").downgradeLevel, 0, "a new build starts fresh")
    }

    func testCleanExitClearsTheSession() {
        let sentinel = CrashLoopSentinel(defaults: defaults, build: "1")
        sentinel.sessionStarted(renderer: "drawHierarchy")
        XCTAssertNotNil(defaults.string(forKey: DefaultsKey.captureSession))
        sentinel.sessionEnded()
        XCTAssertNil(defaults.string(forKey: DefaultsKey.captureSession))
        XCTAssertFalse(sentinel.checkAtLaunch())
    }

    func testPercentiles() {
        let values = (1...100).map { Double($0) }
        XCTAssertEqual(CaptureStats.percentile(values, 0.5), 50)
        XCTAssertEqual(CaptureStats.percentile(values, 0.95), 95)
        XCTAssertEqual(CaptureStats.percentile([7], 0.95), 7)
        XCTAssertNil(CaptureStats.percentile([], 0.5))
    }

    func testStatsKeepTheLast100Costs() {
        let stats = CaptureStats()
        for _ in 0..<200 { stats.recordCost(100) }
        for _ in 0..<100 { stats.recordCost(1) }
        XCTAssertEqual(stats.snapshot().p95, 1)
    }

    func testShakeNeedsThreeStrongReversalsWithinASecond() {
        var rule = ShakeRule()
        XCTAssertFalse(rule.handle(t: 0, x: 3, y: 0, z: 0))
        XCTAssertFalse(rule.handle(t: 100, x: -3, y: 0, z: 0))
        XCTAssertFalse(rule.handle(t: 200, x: 1, y: 0, z: 0), "weak samples don't count")
        XCTAssertFalse(rule.handle(t: 300, x: 3, y: 0, z: 0))
        XCTAssertTrue(rule.handle(t: 400, x: -3, y: 0, z: 0))
        XCTAssertFalse(rule.handle(t: 500, x: 3, y: 0, z: 0), "cooldown")

        var slow = ShakeRule()
        XCTAssertFalse(slow.handle(t: 0, x: 3, y: 0, z: 0))
        XCTAssertFalse(slow.handle(t: 600, x: -3, y: 0, z: 0))
        XCTAssertFalse(slow.handle(t: 1200, x: 3, y: 0, z: 0))
        XCTAssertFalse(slow.handle(t: 1800, x: -3, y: 0, z: 0), "reversals spread over more than 1 s")
    }

    func testTouchLogThrottlesMovesAndExpires() {
        let log = TouchLog(maxAgeMs: 1000)
        log.add(TouchSample(t: 0, id: 1, x: 0, y: 0, phase: .down))
        log.add(TouchSample(t: 5, id: 1, x: 1, y: 1, phase: .move))
        log.add(TouchSample(t: 10, id: 1, x: 2, y: 2, phase: .move))
        log.add(TouchSample(t: 30, id: 1, x: 3, y: 3, phase: .move))
        XCTAssertEqual(log.samples.map { $0.t }, [0, 5, 30], "moves are kept at ≤ 60 Hz per pointer")
        log.add(TouchSample(t: 3000, id: 1, x: 3, y: 3, phase: .up))
        XCTAssertEqual(log.samples.map { $0.t }, [3000], "older than maxAge + 1 s is dropped")
        XCTAssertEqual(log.window(start: 2999, end: 3000).count, 1)
    }

    func testDetectorReportsWhenTheHoldIsDue() {
        let d = ThreeFingerHoldDetector()
        _ = d.handle(.down(t: 0, id: 1, x: 0, y: 0))
        _ = d.handle(.down(t: 10, id: 2, x: 50, y: 0))
        XCTAssertNil(d.fireDueAt)
        _ = d.handle(.down(t: 20, id: 3, x: 100, y: 0))
        XCTAssertEqual(d.fireDueAt, 270)
        XCTAssertEqual(d.sequenceStartT, 0)
        XCTAssertTrue(d.handle(.tick(t: 270)))
        XCTAssertTrue(d.isConsumingSequence)
        XCTAssertNil(d.fireDueAt)
    }
}
