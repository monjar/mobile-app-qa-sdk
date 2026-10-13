// Check-in (spec §11.1): installId, the extra config-query fields and the §3.1
// signals summary; and the 0.3 configuration plumbing — new static options from
// Info.plist and the RN bridge, optional remote timeline/crashPrompt/features
// (old caches and old servers must still decode), and the effective switches
// (static option AND remote switch).

import XCTest
@testable import Snitch

final class CheckInTests: XCTestCase {
    private var suite: String!
    private var defaults: UserDefaults!

    override func setUpWithError() throws {
        suite = "snitch.tests.\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    }

    override func tearDownWithError() throws {
        defaults.removePersistentDomain(forName: suite)
    }

    func testInstallIdIsALowercaseUUIDKeptAcrossLaunches() {
        let id = InstallId.current(defaults: defaults)
        XCTAssertEqual(id, id.lowercased())
        XCTAssertNotNil(UUID(uuidString: id))
        XCTAssertEqual(InstallId.current(defaults: defaults), id)
        XCTAssertEqual(defaults.string(forKey: DefaultsKey.installId), id)

        defaults.set("not-a-uuid", forKey: DefaultsKey.installId)
        let replaced = InstallId.current(defaults: defaults)
        XCTAssertNotEqual(replaced, "not-a-uuid")
        XCTAssertTrue(InstallId.isValid(replaced))
        XCTAssertFalse(InstallId.isValid("3D8E6C1A-2B4F-4E5D-8A9B-0C1D2E3F4A5B"), "uppercase is not what the contract stores")
    }

    func testConfigQueryCarriesTheCheckInFields() {
        let fields = CheckInFields(
            installId: "3d8e6c1a-2b4f-4e5d-8a9b-0c1d2e3f4a5b",
            appId: "io.github.monjar.snitch.example",
            sdkVersion: "0.3.0",
            wrapper: nil,
            model: "iPhone16,2",
            signals: "sim=1;profile=none;devices=0;receipt=none;at=none",
            active: true
        )
        let query = RemoteConfigQuery(releaseType: "debug", appVersion: "1.0", build: "1", os: "18.0", health: "ok", checkIn: fields)
        let items = Dictionary(uniqueKeysWithValues: query.queryItems.map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(query.queryItems.map { $0.name }, [
            "platform", "releaseType", "appVersion", "build", "os", "health",
            "installId", "appId", "sdkVersion", "model", "signals", "active",
        ], "no wrapper parameter when not wrapped")
        XCTAssertEqual(items["installId"], "3d8e6c1a-2b4f-4e5d-8a9b-0c1d2e3f4a5b")
        XCTAssertEqual(items["active"], "1")
        XCTAssertEqual(items["signals"], "sim=1;profile=none;devices=0;receipt=none;at=none")

        var ping = fields
        ping.active = false
        ping.wrapper = "react-native"
        let pingItems = ping.queryItems
        XCTAssertEqual(pingItems.first { $0.name == "active" }?.value, "0")
        XCTAssertEqual(pingItems.first { $0.name == "wrapper" }?.value, "react-native")

        let legacy = RemoteConfigQuery(releaseType: "debug", appVersion: "1.0", build: "1", os: "18.0", health: "ok", checkIn: nil)
        XCTAssertEqual(legacy.queryItems.count, 6)
    }

    func testSignalsSummary() {
        func summary(_ profile: ProvisioningProfileSignals?, sim: Bool = false, receipt: String? = nil,
                     at: AppTransactionState = .notNeeded) -> String {
            ReleaseSignalsSummary.ios(
                IosReleaseSignals(isSimulator: sim, profile: profile, receipt: receipt, appTransactionEnvironment: nil),
                appTransaction: at
            )
        }
        XCTAssertEqual(summary(nil, sim: true), "sim=1;profile=none;devices=0;receipt=none;at=none")
        XCTAssertEqual(summary(ProvisioningProfileSignals(getTaskAllow: true, provisionsAllDevices: false, provisionedDeviceCount: 3)),
                       "sim=0;profile=dev;devices=3;receipt=none;at=none")
        XCTAssertEqual(summary(ProvisioningProfileSignals(getTaskAllow: false, provisionsAllDevices: true, provisionedDeviceCount: 0)),
                       "sim=0;profile=enterprise;devices=0;receipt=none;at=none")
        XCTAssertEqual(summary(ProvisioningProfileSignals(getTaskAllow: false, provisionsAllDevices: false, provisionedDeviceCount: 12)),
                       "sim=0;profile=adhoc;devices=12;receipt=none;at=none")
        XCTAssertEqual(summary(ProvisioningProfileSignals(getTaskAllow: false, provisionsAllDevices: false, provisionedDeviceCount: 0)),
                       "sim=0;profile=other;devices=0;receipt=none;at=none")
        XCTAssertEqual(summary(ProvisioningProfileParser.parse(Data([0x30, 0x82]))),
                       "sim=0;profile=unreadable;devices=0;receipt=none;at=none")
        XCTAssertEqual(summary(nil, receipt: "sandboxReceipt"), "sim=0;profile=none;devices=0;receipt=sandboxReceipt;at=none")
        XCTAssertEqual(summary(nil, at: .pending), "sim=0;profile=none;devices=0;receipt=none;at=pending")
        XCTAssertEqual(summary(nil, at: .failed), "sim=0;profile=none;devices=0;receipt=none;at=failed")
        XCTAssertEqual(summary(nil, at: AppTransactionState(environment: "production")),
                       "sim=0;profile=none;devices=0;receipt=none;at=production")

        let detection = ReleaseDetection(
            type: .testflight,
            signals: IosReleaseSignals(isSimulator: false, profile: nil, receipt: nil, appTransactionEnvironment: "sandbox"),
            appTransaction: .sandbox,
            isFinal: true
        )
        XCTAssertEqual(detection.summary, "sim=0;profile=none;devices=0;receipt=none;at=sandbox")
    }
}

final class TimelineConfigTests: XCTestCase {
    func testA02ConfigWithoutTheNewFieldsStillDecodes() throws {
        let old = """
        {"enabled":true,"ttlSeconds":3600,"reportTypes":[{"id":"bug","label":"Bug"}],"screenshot":{"enabled":true},
         "video":{"enabled":true,"maxSeconds":30,"captureMode":"snapshot","snapshotRenderer":"drawHierarchy",
                  "idleFps":1,"activeFps":4,"systemFps":10,"mainThreadBudgetPct":3},
         "maskTextInputs":true,"screenshotPrompt":true,"message":null}
        """
        let config = try JSONDecoder().decode(SdkConfig.self, from: Data(old.utf8))
        XCTAssertNil(config.timeline)
        XCTAssertNil(config.crashPrompt)
        XCTAssertNil(config.features)

        let e = ConfigMerger.effective(options: SnitchOptions(captureNetwork: true), remote: config)
        XCTAssertTrue(e.consoleCapture)
        XCTAssertTrue(e.networkCapture)
        XCTAssertTrue(e.trackScreens)
        XCTAssertTrue(e.crashPrompt)
        XCTAssertTrue(e.serverFeatures.isEmpty, "an old server supports nothing beyond 0.1")

        // A 0.2 cache (Cached wrapper) round-trips too.
        let cached = RemoteConfigStore.Cached(config: config, etag: "\"v1\"", fetchedAt: Date(timeIntervalSince1970: 1_800_000_000))
        XCTAssertEqual(try JSONDecoder().decode(RemoteConfigStore.Cached.self, from: JSONEncoder().encode(cached)), cached)
    }

    func testPartialTimelineSwitchesDefaultToOn() throws {
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: Contract.fixture("sdk-config.json")) as? [String: Any])
        json["timeline"] = ["network": false]
        json["features"] = ["resumable-upload", "timeline", "trigger-crash", "checkin", "something-newer"]
        let config = try JSONDecoder().decode(SdkConfig.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertEqual(config.timeline, SdkConfig.Timeline(console: true, network: false, screens: true))
        let e = ConfigMerger.effective(options: SnitchOptions(captureNetwork: true), remote: config)
        XCTAssertFalse(e.networkCapture)
        XCTAssertTrue(e.serverFeatures.contains(ServerFeature.timeline))
        XCTAssertTrue(e.serverFeatures.contains(ServerFeature.triggerCrash))
    }

    func testRemoteSwitchesOnlyNarrowTheStaticOptions() {
        var remote = SdkConfig.default
        remote.timeline = SdkConfig.Timeline(console: true, network: true, screens: true)
        remote.crashPrompt = true

        let defaults = ConfigMerger.effective(options: SnitchOptions(), remote: remote)
        XCTAssertTrue(defaults.consoleCapture)
        XCTAssertFalse(defaults.networkCapture, "network capture is opt-in at build time; the server can't turn it on")
        XCTAssertTrue(defaults.trackScreens)
        XCTAssertTrue(defaults.crashPrompt)

        let staticOff = ConfigMerger.effective(
            options: SnitchOptions(captureConsole: false, captureNetwork: false, trackScreens: false, crashPrompt: false),
            remote: remote
        )
        XCTAssertFalse(staticOff.consoleCapture)
        XCTAssertFalse(staticOff.trackScreens)
        XCTAssertFalse(staticOff.crashPrompt)

        remote.timeline = SdkConfig.Timeline(console: false, network: false, screens: false)
        remote.crashPrompt = false
        let remoteOff = ConfigMerger.effective(options: SnitchOptions(captureNetwork: true), remote: remote)
        XCTAssertFalse(remoteOff.consoleCapture)
        XCTAssertFalse(remoteOff.networkCapture)
        XCTAssertFalse(remoteOff.trackScreens)
        XCTAssertFalse(remoteOff.crashPrompt)

        let noRemote = ConfigMerger.effective(options: SnitchOptions(captureNetwork: true), remote: nil)
        XCTAssertTrue(noRemote.networkCapture, "until a config arrives, the static options apply")
        XCTAssertTrue(noRemote.serverFeatures.isEmpty)
    }

    func testNewStaticOptionsFromInfoPlistAndBridge() {
        let defaults = SnitchOptions()
        XCTAssertTrue(defaults.captureConsole)
        XCTAssertFalse(defaults.captureNetwork)
        XCTAssertTrue(defaults.trackScreens)
        XCTAssertTrue(defaults.crashPrompt)
        XCTAssertFalse(defaults.checkInWhenInactive)

        let plist = StaticConfig.fromDictionary([
            "CaptureConsole": false, "CaptureNetwork": true, "TrackScreens": false,
            "CrashPrompt": false, "CheckInWhenInactive": true,
        ], keys: .infoPlist).options
        XCTAssertFalse(plist.captureConsole)
        XCTAssertTrue(plist.captureNetwork)
        XCTAssertFalse(plist.trackScreens)
        XCTAssertFalse(plist.crashPrompt)
        XCTAssertTrue(plist.checkInWhenInactive)

        let bridge = StaticConfig.fromDictionary([
            "captureConsole": "false", "captureNetwork": 1, "trackScreens": NSNumber(value: false),
            "crashPrompt": "no", "checkInWhenInactive": "yes",
        ], keys: .bridge).options
        XCTAssertFalse(bridge.captureConsole)
        XCTAssertTrue(bridge.captureNetwork)
        XCTAssertFalse(bridge.trackScreens)
        XCTAssertFalse(bridge.crashPrompt)
        XCTAssertTrue(bridge.checkInWhenInactive)
    }

    func testChunkBytesDebugHook() {
        let env = ["SNITCH_DEBUG_CHUNK_BYTES": "65536"]
        XCTAssertEqual(DebugHooks.read(releaseType: .debug, environment: env).chunkBytes, 65536)
        XCTAssertNil(DebugHooks.read(releaseType: .debug, environment: ["SNITCH_DEBUG_CHUNK_BYTES": "-5"]).chunkBytes)
        XCTAssertEqual(DebugHooks.read(releaseType: .adhoc, environment: env), DebugHooks.inactive, "debug builds only")
    }
}
