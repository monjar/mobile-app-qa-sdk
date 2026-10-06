// Remote configuration: the default matches the contract fixture, the merge rule
// (remote on top of static, but captureMode can only get stricter), crash-loop
// downgrades, and the cache's 200/304/error handling.

import XCTest
@testable import Snitch

final class RemoteConfigTests: XCTestCase {
    private func remote(_ mutate: (inout SdkConfig) -> Void) -> SdkConfig {
        var c = SdkConfig.default
        mutate(&c)
        return c
    }

    func testDefaultMatchesFixture() throws {
        let decoded = try JSONDecoder().decode(SdkConfig.self, from: Contract.fixture("sdk-config.json"))
        XCTAssertEqual(decoded, SdkConfig.default)
    }

    func testRemoteCannotUpgradeSnapshotToSystem() {
        let e = ConfigMerger.effective(options: SnitchOptions(captureMode: .snapshot), remote: remote { $0.video.captureMode = "system" })
        XCTAssertEqual(e.captureMode, .snapshot)
    }

    func testRemoteCannotTurnStaticOffOn() {
        let e = ConfigMerger.effective(options: SnitchOptions(captureMode: .off), remote: remote { $0.video.captureMode = "snapshot" })
        XCTAssertEqual(e.captureMode, .off)
    }

    func testRemoteCanRestrictSystemToSnapshotOrOff() {
        XCTAssertEqual(ConfigMerger.effective(options: SnitchOptions(captureMode: .system), remote: remote { $0.video.captureMode = "snapshot" }).captureMode, .snapshot)
        XCTAssertEqual(ConfigMerger.effective(options: SnitchOptions(captureMode: .system), remote: remote { $0.video.captureMode = "off" }).captureMode, .off)
        XCTAssertEqual(ConfigMerger.effective(options: SnitchOptions(captureMode: .system), remote: remote { $0.video.captureMode = "system" }).captureMode, .system)
    }

    func testRemoteVideoDisabledMeansOff() {
        let e = ConfigMerger.effective(options: SnitchOptions(), remote: remote { $0.video.enabled = false })
        XCTAssertEqual(e.captureMode, .off)
        XCTAssertFalse(e.videoEnabled)
    }

    func testUnknownRemoteCaptureModeFailsClosed() {
        let e = ConfigMerger.effective(options: SnitchOptions(), remote: remote { $0.video.captureMode = "hologram" })
        XCTAssertEqual(e.captureMode, .off)
    }

    func testWithoutRemoteStaticOptionsApply() {
        let options = SnitchOptions(gesture: .shake, screenshotPrompt: false, maskTextInputs: false, captureMode: .system, videoMaxSeconds: 12, showTesterNotice: false)
        let e = ConfigMerger.effective(options: options, remote: nil)
        XCTAssertEqual(e.captureMode, .system)
        XCTAssertEqual(e.videoMaxSeconds, 12)
        XCTAssertFalse(e.maskTextInputs)
        XCTAssertFalse(e.screenshotPrompt)
        XCTAssertEqual(e.gesture, .shake)
        XCTAssertFalse(e.showTesterNotice)
        XCTAssertTrue(e.enabled)
        XCTAssertEqual(e.reportTypes.map { $0.id }, ["bug", "idea", "other"])
    }

    func testRemoteValuesWinOtherwise() {
        let r = remote {
            $0.enabled = false
            $0.maskTextInputs = true
            $0.video.maxSeconds = 10
            $0.message = "Thanks for testing"
            $0.reportTypes = [ReportTypeOption(id: "crash", label: "Crash")]
        }
        let e = ConfigMerger.effective(options: SnitchOptions(maskTextInputs: false, videoMaxSeconds: 30), remote: r)
        XCTAssertFalse(e.enabled)
        XCTAssertTrue(e.maskTextInputs)
        XCTAssertEqual(e.videoMaxSeconds, 10)
        XCTAssertEqual(e.message, "Thanks for testing")
        XCTAssertEqual(e.reportTypes.map { $0.id }, ["crash"])
    }

    func testCrashLoopDowngrades() {
        XCTAssertEqual(ConfigMerger.effective(options: SnitchOptions(), remote: nil, rendererDowngrade: 0).snapshotRenderer, .drawHierarchy)
        let one = ConfigMerger.effective(options: SnitchOptions(), remote: nil, rendererDowngrade: 1)
        XCTAssertEqual(one.snapshotRenderer, .layerRender)
        XCTAssertEqual(one.captureMode, .snapshot)
        XCTAssertEqual(ConfigMerger.effective(options: SnitchOptions(), remote: nil, rendererDowngrade: 2).captureMode, .off)
    }

    func testStoreAppliesResponses() throws {
        let suite = "snitch.tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        let store = RemoteConfigStore(defaults: defaults)
        XCTAssertNil(store.config)
        XCTAssertTrue(store.isStale())

        let t0 = Date(timeIntervalSince1970: 1_800_000_000)
        var body = SdkConfig.default
        body.video.captureMode = "off"
        let ok = HTTPResponse(status: 200, data: try JSONEncoder().encode(body), headers: ["etag": "\"v1\""], errorCode: nil, transportError: nil)
        XCTAssertEqual(store.apply(ok, now: t0).changed, true)
        XCTAssertEqual(store.cached?.etag, "\"v1\"")
        XCTAssertFalse(store.isStale(now: t0.addingTimeInterval(10)))
        XCTAssertTrue(store.isStale(now: t0.addingTimeInterval(3600)))

        let notModified = HTTPResponse(status: 304, data: Data(), headers: [:], errorCode: nil, transportError: nil)
        let outcome = store.apply(notModified, now: t0.addingTimeInterval(4000))
        XCTAssertTrue(outcome.succeeded)
        XCTAssertFalse(outcome.changed)
        XCTAssertEqual(store.cached?.fetchedAt, t0.addingTimeInterval(4000))

        let failure = HTTPResponse(status: 0, data: Data(), headers: [:], errorCode: nil, transportError: URLError(.timedOut))
        XCTAssertFalse(store.apply(failure, now: t0.addingTimeInterval(9000)).succeeded)
        XCTAssertEqual(store.config?.video.captureMode, "off", "network errors keep the cache")

        // The cache survives a restart.
        XCTAssertEqual(RemoteConfigStore(defaults: defaults).cached, store.cached)
    }

    func testStaticConfigParsing() {
        let plist: [String: Any] = [
            "ServerURL": "https://snitch.example.com/",
            "IngestKey": "snitch_pk_0123456789ABCDEFGHJKMNPQRS",
            "EnabledReleaseTypes": ["debug", "testflight"],
            "Gesture": "both",
            "CaptureMode": "system",
            "VideoMaxSeconds": 99,
            "MaskTextInputs": false,
        ]
        let c = StaticConfig.fromDictionary(plist, keys: .infoPlist)
        XCTAssertTrue(c.enabled)
        XCTAssertEqual(StaticConfig.normalizedServerURL(c.serverURL)?.absoluteString, "https://snitch.example.com")
        XCTAssertEqual(c.options.enabledReleaseTypes, [.debug, .testflight])
        XCTAssertEqual(c.options.gesture, .both)
        XCTAssertEqual(c.options.captureMode, .system)
        XCTAssertEqual(c.options.videoMaxSeconds, 30)
        XCTAssertFalse(c.options.maskTextInputs)

        let bridge = StaticConfig.fromDictionary(["captureMode": "off", "enabledReleaseTypes": "debug, adhoc"], keys: .bridge)
        XCTAssertEqual(bridge.options.captureMode, .off)
        XCTAssertEqual(bridge.options.enabledReleaseTypes, [.debug, .adhoc])

        XCTAssertTrue(StaticConfig.isValidIngestKey("snitch_pk_0123456789ABCDEFGHJKMNPQRS"))
        XCTAssertFalse(StaticConfig.isValidIngestKey("snitch_pk_0123456789ABCDEFGHIJKLMNOP"))
        XCTAssertNil(StaticConfig.normalizedServerURL(URL(string: "ftp://example.com")))
    }

    func testDebugHooksOnlyInDebug() {
        let env = ["SNITCH_DEBUG_SERVER_URL": "http://127.0.0.1:8080", "SNITCH_DEBUG_AUTOREPORT": "6", "SNITCH_DEBUG_CANCEL_AFTER_MS": "300"]
        let debug = DebugHooks.read(releaseType: .debug, environment: env)
        XCTAssertEqual(debug.serverURL?.absoluteString, "http://127.0.0.1:8080")
        XCTAssertEqual(debug.autoReportAfter, 6)
        XCTAssertEqual(debug.cancelAfterMs, 300)
        XCTAssertEqual(DebugHooks.read(releaseType: .testflight, environment: env), DebugHooks.inactive)
    }
}
