// ReportCreate JSON: the Codable models round-trip the contract fixture, the
// builder emits exactly the fixture's key set (no extra keys — the server's
// CaptureStats is strict), and a report written to the outbox is consistent.

import CoreGraphics
import XCTest
@testable import Snitch

final class ReportBuilderTests: XCTestCase {
    private var tempDir: URL!

    override func setUpWithError() throws {
        tempDir = FileManager.default.temporaryDirectory.appendingPathComponent("snitch-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tempDir)
    }

    func testFixtureRoundTrips() throws {
        let fixture = try Contract.fixture("report.create.ios.json")
        let decoded = try JSONDecoder().decode(ReportCreate.self, from: fixture)
        let encoded = try ReportJSON.encoder().encode(decoded)
        let a = try JSONSerialization.jsonObject(with: fixture) as? NSDictionary
        let b = try JSONSerialization.jsonObject(with: encoded) as? NSDictionary
        XCTAssertNotNil(a)
        XCTAssertEqual(a, b)
    }

    func testBuilderMatchesFixtureKeySet() throws {
        let fixture = try Contract.fixtureObject("report.create.ios.json")
        let report = ReportBuilder.makeReport(context: fixtureLikeContext(), attachments: fixtureAttachments(), stats: fixtureStats())
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: ReportJSON.encoder().encode(report)) as? [String: Any])
        assertSameKeys(json, fixture, path: "$")
    }

    func testValuesFollowTheContract() throws {
        var context = fixtureLikeContext()
        context.email = "not an email"
        context.user = UserContext.User(id: nil, email: nil, name: nil)
        context.custom = [:]
        context.typeId = "Not Valid!"
        let report = ReportBuilder.makeReport(context: context, attachments: [], stats: nil)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: ReportJSON.encoder().encode(report)) as? [String: Any])

        XCTAssertNil(json["reporter"], "an invalid email must be dropped, not sent (422 would delete the report)")
        XCTAssertNil(json["custom"])
        XCTAssertNil(json["stats"])
        XCTAssertEqual(json["type"] as? String, "other")
        XCTAssertEqual((json["attachments"] as? [Any])?.count, 0)

        let id = try XCTUnwrap(json["clientReportId"] as? String)
        XCTAssertEqual(id, id.lowercased())
        XCTAssertNotNil(UUID(uuidString: id))

        let reportedAt = try XCTUnwrap(json["reportedAt"] as? String)
        XCTAssertNotNil(reportedAt.range(of: #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$"#, options: .regularExpression), reportedAt)
    }

    func testSdkInfoCarriesWrapper() {
        var context = fixtureLikeContext()
        context.wrapper = nil
        XCTAssertEqual(ReportBuilder.makeReport(context: context, attachments: [], stats: nil).sdk,
                       SdkInfo(name: "snitch-ios", version: SnitchVersion.current, wrapper: nil, wrapperVersion: nil))
        context.wrapper = UserContext.Wrapper(name: "react-native", version: "0.1.0")
        let sdk = ReportBuilder.makeReport(context: context, attachments: [], stats: nil).sdk
        XCTAssertEqual(sdk.wrapper, "react-native")
        XCTAssertEqual(sdk.wrapperVersion, "0.1.0")
    }

    func testWriteToOutboxCommitsReportLast() throws {
        let outbox = Outbox(root: tempDir.appendingPathComponent("outbox"))
        let jpeg = try XCTUnwrap(makeJPEG(width: 30, height: 60))
        let screenshot = Screenshot(jpeg: jpeg, width: 30, height: 60, thumbnail: nil)
        var context = fixtureLikeContext()
        context.logText = "line one\nline two\n"
        let dir = try ReportBuilder.write(context: context, screenshot: screenshot, video: nil, to: outbox)

        let pending = outbox.pendingReports()
        XCTAssertEqual(pending.map { $0.id }, [context.clientReportId])
        let report = try XCTUnwrap(outbox.loadReport(in: dir))
        XCTAssertEqual(report.attachments.map { $0.name }, ["screenshot", "logs"])

        let shot = try XCTUnwrap(report.attachments.first { $0.name == "screenshot" })
        let shotData = try Data(contentsOf: dir.appendingPathComponent("screenshot.jpg"))
        XCTAssertEqual(shot.sizeBytes, shotData.count)
        XCTAssertEqual(shot.sha256, Hashing.sha256Hex(shotData))
        XCTAssertEqual(try Hashing.sha256Hex(fileAt: dir.appendingPathComponent("screenshot.jpg")), shot.sha256)
        XCTAssertEqual(shot.contentType, "image/jpeg")
        XCTAssertEqual(shot.width, 30)

        let logs = try XCTUnwrap(report.attachments.first { $0.name == "logs" })
        XCTAssertEqual(logs.contentType, "text/plain")
        XCTAssertEqual(try String(contentsOf: dir.appendingPathComponent("logs.txt"), encoding: .utf8), "line one\nline two\n")
        XCTAssertEqual(outbox.loadState(in: dir), OutboxState())
    }

    func testUncommittedDirectoryIsNotEligible() throws {
        let outbox = Outbox(root: tempDir.appendingPathComponent("outbox"))
        _ = try outbox.createReportDirectory(id: "staging")
        XCTAssertTrue(outbox.pendingReports().isEmpty)
    }

    func testLogAttachmentKeepsTheNewestLines() {
        let lines = (0..<300).map { "line \($0)" }
        let text = LogRing.attachmentText(ringLines: lines, providerText: nil) ?? ""
        let kept = text.split(separator: "\n")
        XCTAssertLessThanOrEqual(kept.count, LogRing.maxLines)
        XCTAssertEqual(kept.last.map { String($0) }, "line 299")
        XCTAssertNil(LogRing.attachmentText(ringLines: [], providerText: "  \n"))
    }

    // MARK: - Fixture-shaped inputs

    private func fixtureLikeContext() -> ReportContext {
        ReportContext(
            clientReportId: ReportBuilder.newReportId(),
            reportedAt: Date(timeIntervalSince1970: 1_791_381_302.12),
            trigger: "gesture",
            typeId: "bug",
            description: "Petting the face froze it for a second.",
            app: AppInfo(id: "com.mochiro.app", name: "Mochiro", version: "0.6.0", build: "15", releaseType: "testflight"),
            device: DeviceInfo(
                platform: "ios",
                osVersion: "26.0.1",
                model: "iPhone16,2",
                manufacturer: "Apple",
                locale: "en_GB",
                timeZone: "Europe/London",
                screen: DeviceInfo.Screen(width: 393, height: 852, scale: 3, orientation: "portrait"),
                memory: DeviceInfo.Memory(appMB: 312, freeMB: nil, totalMB: 8192),
                thermal: "nominal",
                lowPower: false,
                battery: 0.82,
                charging: false,
                network: "wifi",
                darkMode: true,
                screenReader: false,
                fontScale: 1
            ),
            user: UserContext.User(id: nil, email: "tester@example.com", name: nil),
            email: nil,
            custom: ["userTier": "beta"],
            wrapper: UserContext.Wrapper(name: "react-native", version: "0.1.0"),
            stats: nil,
            logText: nil
        )
    }

    private func fixtureStats() -> CaptureStatsBody {
        CaptureStatsBody(
            captureMode: "snapshot", snapshotRenderer: "drawHierarchy", captureMsP50: 6.1, captureMsP95: 11.8,
            effectiveFps: 1.4, ringBytes: 2_411_520, bufferedSeconds: 30, composeMs: 812, framesSkipped: 3,
            uptimeSec: 642, crashLoopDowngrades: 0, videoLost: nil
        )
    }

    private func fixtureAttachments() -> [AttachmentDeclaration] {
        [
            AttachmentDeclaration(name: "screenshot", contentType: "image/jpeg", sizeBytes: 412_833,
                                  sha256: String(repeating: "a", count: 64), width: 1179, height: 2556, durationMs: nil),
            AttachmentDeclaration(name: "video", contentType: "video/mp4", sizeBytes: 1_288_211,
                                  sha256: String(repeating: "b", count: 64), width: 393, height: 852, durationMs: 15_000),
        ]
    }

    private func assertSameKeys(_ a: Any, _ b: Any, path: String, file: StaticString = #filePath, line: UInt = #line) {
        if let da = a as? [String: Any], let db = b as? [String: Any] {
            XCTAssertEqual(Set(da.keys), Set(db.keys), "keys differ at \(path)", file: file, line: line)
            for key in Set(da.keys).intersection(db.keys) {
                assertSameKeys(da[key]!, db[key]!, path: "\(path).\(key)", file: file, line: line)
            }
        } else if let aa = a as? [Any], let ab = b as? [Any] {
            XCTAssertEqual(aa.count, ab.count, "array length differs at \(path)", file: file, line: line)
            for (i, pair) in zip(aa, ab).enumerated() {
                assertSameKeys(pair.0, pair.1, path: "\(path)[\(i)]", file: file, line: line)
            }
        }
    }
}

func makeJPEG(width: Int, height: Int, gray: CGFloat = 0.5) -> Data? {
    guard let ctx = ImageCoding.makeBGRAContext(width: width, height: height) else { return nil }
    ctx.setFillColor(CGColor(gray: gray, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
    guard let image = ctx.makeImage() else { return nil }
    return ImageCoding.jpegData(image, quality: 0.8)
}
