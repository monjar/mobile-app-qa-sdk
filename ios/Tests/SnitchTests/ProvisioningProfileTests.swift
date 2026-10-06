// embedded.mobileprovision parsing: real profiles are CMS (PKCS#7) envelopes with
// the XML plist embedded verbatim, so the fixtures here wrap a generated plist in
// DER-looking binary bytes (including NULs and stray '<' characters).

import XCTest
@testable import Snitch

final class ProvisioningProfileTests: XCTestCase {
    private func profileBytes(_ plist: [String: Any]) throws -> Data {
        let xml = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        var data = Data([0x30, 0x82, 0x4E, 0x1F, 0x06, 0x09, 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x07, 0x02, 0xA0])
        data.append(contentsOf: [0x00, 0x3C, 0x00, 0xFF, 0x80, 0x31, 0x0B]) // includes a lone "<"
        data.append(xml)
        data.append(contentsOf: [0xA0, 0x82, 0x0A, 0x00, 0x3C, 0x2F, 0x00, 0x30, 0x82, 0x04, 0x00])
        return data
    }

    private func basePlist() -> [String: Any] {
        [
            "AppIDName": "Example",
            "Name": "Example Profile",
            "TeamIdentifier": ["ABCDE12345"],
            "Entitlements": ["application-identifier": "ABCDE12345.io.github.monjar.snitch.example"] as [String: Any],
        ]
    }

    func testDevelopmentProfileIsDebug() throws {
        var plist = basePlist()
        plist["Entitlements"] = ["get-task-allow": true, "application-identifier": "X.Y"] as [String: Any]
        plist["ProvisionedDevices"] = ["00008110-0001", "00008110-0002", "00008110-0003"]
        let signals = ProvisioningProfileParser.parse(try profileBytes(plist))
        XCTAssertEqual(signals, ProvisioningProfileSignals(getTaskAllow: true, provisionsAllDevices: false, provisionedDeviceCount: 3))
        XCTAssertEqual(classify(signals), .debug)
    }

    func testAdHocProfile() throws {
        var plist = basePlist()
        plist["Entitlements"] = ["get-task-allow": false] as [String: Any]
        plist["ProvisionedDevices"] = (0..<12).map { "device-\($0)" }
        let signals = ProvisioningProfileParser.parse(try profileBytes(plist))
        XCTAssertEqual(signals.provisionedDeviceCount, 12)
        XCTAssertFalse(signals.getTaskAllow)
        XCTAssertEqual(classify(signals), .adhoc)
    }

    func testEnterpriseProfile() throws {
        var plist = basePlist()
        plist["ProvisionsAllDevices"] = true
        let signals = ProvisioningProfileParser.parse(try profileBytes(plist))
        XCTAssertTrue(signals.provisionsAllDevices)
        XCTAssertEqual(classify(signals), .enterprise)
    }

    func testProfileWithoutDevicesIsUnknown() throws {
        let signals = ProvisioningProfileParser.parse(try profileBytes(basePlist()))
        XCTAssertEqual(classify(signals), .unknown)
    }

    func testGarbageFailsClosed() {
        let garbage = Data([0x30, 0x82, 0x00, 0x10, 0x3C, 0x3F, 0x78, 0x00, 0x01, 0x02])
        let signals = ProvisioningProfileParser.parse(garbage)
        XCTAssertEqual(signals, ProvisioningProfileSignals(getTaskAllow: false, provisionsAllDevices: false, provisionedDeviceCount: 0))
        XCTAssertEqual(classify(signals), .unknown)
        XCTAssertEqual(classify(ProvisioningProfileParser.parse(Data())), .unknown)
    }

    func testTruncatedPlistFailsClosed() throws {
        let full = try profileBytes(basePlist())
        let cut = full.prefix(full.count / 2)
        XCTAssertEqual(classify(ProvisioningProfileParser.parse(Data(cut))), .unknown)
    }

    private func classify(_ profile: ProvisioningProfileSignals) -> SnitchReleaseType {
        ReleaseTypeClassifier.classifyIos(IosReleaseSignals(isSimulator: false, profile: profile, receipt: nil, appTransactionEnvironment: nil))
    }
}
