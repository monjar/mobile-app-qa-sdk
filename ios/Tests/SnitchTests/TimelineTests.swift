// The report timeline (spec §11.3): sanitizeUrl against the shared vectors, the
// ndjson encoding byte-for-byte against contract/fixtures/timeline.ndjson, the
// 2 MB cap (oldest logs go first), and the recorder — switches, ring limits,
// the 5-minute window, touch-time conversion at freeze, screen naming rules.

import XCTest
@testable import Snitch

final class UrlSanitizeVectorTests: XCTestCase {
    func testVectors() throws {
        let root = try Contract.vector("url-sanitize.json")
        let cases = try XCTUnwrap(root["cases"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty)
        for c in cases {
            let name = Contract.string(c["name"]) ?? "?"
            let input = try XCTUnwrap(Contract.string(c["in"]), name)
            let expected = try XCTUnwrap(Contract.string(c["out"]), name)
            let got = UrlSanitizer.sanitize(input)
            XCTAssertEqual(got, expected, name)
            XCTAssertLessThanOrEqual(got.utf16.count, TimelineLimits.urlChars, name)
        }
    }

    func testTruncationNeverSplitsASurrogatePair() {
        // "https://a.example/" is 18 units: the emoji's two units sit at 498 and 499, right
        // where the cut (the first 499 units) falls between them.
        let emoji = "😀"
        let path = String(repeating: "a", count: 480) + emoji + "bbb"
        let out = UrlSanitizer.sanitize("https://a.example/" + path)
        XCTAssertEqual(out.utf16.count, TimelineLimits.urlChars - 1, "the lone half is dropped, not kept or replaced")
        XCTAssertLessThanOrEqual(out.utf16.count, TimelineLimits.urlChars)
        XCTAssertTrue(out.hasSuffix("…"))
        XCTAssertFalse(out.unicodeScalars.contains("\u{FFFD}"))
    }
}

final class TimelineEncodingTests: XCTestCase {
    /// The fixture's events, as the SDK would record them.
    private let fixtureEvents: [TimelineEvent] = [
        .app(t: 1_791_381_002_120, event: .launch),
        .screen(t: 1_791_381_003_010, name: "onboarding", source: .app),
        .log(t: 1_791_381_003_500, level: .info, source: .js, message: "[boot] theme restored in 41 ms", tag: nil),
        .net(TimelineNet(t: 1_791_381_004_000, method: "POST", url: "https://api.mochiro.app/v1/conversation?session=*",
                         status: 200, ms: 812.4, reqBytes: 412, resBytes: 20311, error: nil)),
        .screen(t: 1_791_381_090_000, name: "index", source: .app),
        .touch(t: 1_791_381_290_000, x: 0.52, y: 0.61, fingers: 1),
        .log(t: 1_791_381_295_000, level: .warn, source: .native,
             message: "Task <8F1C…> finished with error [-1001] The request timed out.", tag: "com.apple.network"),
        .net(TimelineNet(t: 1_791_381_296_000, method: "GET", url: "https://api.mochiro.app/v1/facts",
                         status: nil, ms: 30001, reqBytes: nil, resBytes: nil, error: "The request timed out.")),
        .app(t: 1_791_381_299_000, event: .background),
        .log(t: 1_791_381_301_000, level: .error, source: .js,
             message: "TypeError: undefined is not an object (evaluating 'turn.reply')", tag: nil),
    ]

    func testLinesMatchTheContractFixture() throws {
        let fixture = String(decoding: try Contract.fixture("timeline.ndjson"), as: UTF8.self)
        // The fixture also shows lines a reader must skip; the SDK never writes those.
        let known = fixture.split(separator: "\n").map(String.init)
            .filter { $0.hasPrefix("{") && !$0.contains("future-kind") }
        let meta = TimelineMeta(start: 1_791_381_002_120, end: 1_791_381_302_120,
                                videoStart: 1_791_381_287_120, videoEnd: 1_791_381_302_120, dropped: 0)
        XCTAssertEqual([TimelineEncoding.metaLine(meta)] + fixtureEvents.map(TimelineEncoding.line), known)
    }

    func testDocumentSortsAndFillsMeta() throws {
        let doc = TimelineEncoding.document(
            events: fixtureEvents.reversed(),
            end: 1_791_381_302_120,
            videoStart: 1_791_381_287_120,
            videoEnd: 1_791_381_302_120
        )
        let lines = String(decoding: doc.data, as: UTF8.self).split(separator: "\n").map(String.init)
        XCTAssertEqual(lines.count, fixtureEvents.count + 1)
        XCTAssertEqual(lines.dropFirst().map { $0 }, fixtureEvents.map(TimelineEncoding.line), "events come out in time order")
        XCTAssertEqual(doc.meta.start, 1_791_381_002_120)
        XCTAssertEqual(doc.eventCount, fixtureEvents.count)
        for line in lines {
            XCTAssertNotNil(try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any], line)
        }
    }

    func testCapDropsTheOldestLogLinesFirst() throws {
        var events: [TimelineEvent] = [.app(t: 1000, event: .launch), .screen(t: 1001, name: "Home", source: .native)]
        for i in 0..<100 {
            events.append(.log(t: Int64(2000 + i), level: .info, source: .app, message: "line \(i) " + String(repeating: "x", count: 80), tag: nil))
        }
        let maxBytes = 4096
        let doc = TimelineEncoding.document(events: events, end: 5000, dropped: 3, maxBytes: maxBytes)
        XCTAssertLessThanOrEqual(doc.data.count, maxBytes)
        let text = String(decoding: doc.data, as: UTF8.self)
        XCTAssertTrue(text.contains(#""event":"launch""#), "non-log events survive")
        XCTAssertTrue(text.contains(#""name":"Home""#))
        XCTAssertTrue(text.contains("line 99 "), "the newest log lines are kept")
        XCTAssertFalse(text.contains("line 0 "), "the oldest go first")
        XCTAssertEqual(doc.meta.dropped, 3 + (100 + 2 - doc.eventCount))
        XCTAssertEqual(doc.meta.start, 1000)
    }

    func testFieldsAreClampedToTheSchema() throws {
        let long = String(repeating: "é", count: 2500)
        let line = TimelineEncoding.line(.log(t: 1, level: .debug, source: .app, message: long, tag: String(repeating: "t", count: 100)))
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
        let msg = try XCTUnwrap(object["msg"] as? String)
        XCTAssertEqual(msg.utf16.count, TimelineLimits.msgChars)
        XCTAssertTrue(msg.hasSuffix("…"))
        XCTAssertEqual((object["tag"] as? String)?.utf16.count, TimelineLimits.tagChars)

        let touch = TimelineEncoding.line(.touch(t: 1, x: 1.7, y: -0.2, fingers: 40))
        XCTAssertEqual(touch, #"{"k":"touch","t":1,"x":1,"y":0,"n":20}"#)
        let net = TimelineEncoding.line(.net(TimelineNet(t: 1, method: "", url: "u", status: 42, ms: .nan, reqBytes: -1, resBytes: nil, error: "  ")))
        XCTAssertEqual(net, #"{"k":"net","t":1,"method":"GET","url":"u"}"#)
    }

    func testJSONText() {
        XCTAssertEqual(JSONText.quote("a\"b\\c\nd\te\u{01}é/"), #""a\"b\\c\nd\te\u0001é/""#)
        XCTAssertEqual(JSONText.number(812.4), "812.4")
        XCTAssertEqual(JSONText.number(30001), "30001")
        XCTAssertEqual(JSONText.number(0.52), "0.52")
        XCTAssertNil(JSONText.number(.infinity))
    }

    func testSavedLogLinesDecode() {
        let event = TimelineEvent.log(t: 42, level: .warn, source: .js, message: "line \"one\"\nnext", tag: "tag")
        XCTAssertEqual(TimelineEncoding.decodeLog(TimelineEncoding.line(event)), event)
        XCTAssertNil(TimelineEncoding.decodeLog(#"{"k":"app","t":1,"event":"launch"}"#))
        XCTAssertNil(TimelineEncoding.decodeLog("not json"))
    }
}

final class TimelineRecorderTests: XCTestCase {
    private var recorder: TimelineRecorder!
    private var wall: Int64 = 1_800_000_000_000
    private var mono: Double = 50_000

    override func setUp() {
        super.setUp()
        recorder = TimelineRecorder()
        recorder.wallNow = { [unowned self] in self.wall }
        recorder.monoNow = { [unowned self] in self.mono }
    }

    private func allOn() {
        recorder.configure(TimelineRecorder.Switches(on: true, console: true, network: true, screens: true))
    }

    private func logCount(_ snapshot: TimelineSnapshot) -> Int {
        snapshot.events.filter { $0.isLog }.count
    }

    func testNothingIsRecordedWhileOff() {
        recorder.log(level: .info, source: .app, message: "x")
        recorder.appEvent(.launch)
        recorder.touchDown(mono: mono, x: 0.5, y: 0.5, fingers: 1)
        recorder.network(TimelineNet(t: wall, method: "GET", url: "https://a.example/", status: 200, ms: 1, reqBytes: nil, resBytes: 0, error: nil))
        let snapshot = recorder.freeze()
        XCTAssertTrue(snapshot.events.isEmpty)
        XCTAssertNil(snapshot.nativeConsole)
    }

    func testEachKindFollowsItsSwitch() {
        recorder.configure(TimelineRecorder.Switches(on: true, console: false, network: false, screens: false))
        recorder.log(level: .info, source: .app, message: "x")
        recorder.network(TimelineNet(t: wall, method: "GET", url: "u", status: 200, ms: 1, reqBytes: nil, resBytes: nil, error: nil))
        recorder.inferredScreen("Home")
        recorder.appEvent(.foreground)
        recorder.touchDown(mono: mono, x: 0.25, y: 0.75, fingers: 2)
        let snapshot = recorder.freeze()
        XCTAssertEqual(snapshot.events.count, 2, "touches and app events always record while on")
        XCTAssertNil(snapshot.nativeConsole)
        XCTAssertNil(snapshot.screen)
    }

    func testRingsKeepTheNewestAndCountDrops() {
        allOn()
        for i in 0..<(TimelineLimits.logs + 100) {
            recorder.log(level: .info, source: .app, message: "\(i)")
        }
        let snapshot = recorder.freeze()
        XCTAssertEqual(logCount(snapshot), TimelineLimits.logs)
        XCTAssertEqual(snapshot.dropped, 100)
        guard case let .log(_, _, _, message, _)? = snapshot.events.first(where: { $0.isLog }) else {
            return XCTFail("no log")
        }
        XCTAssertEqual(message, "100")
    }

    func testNothingOlderThanFiveMinutes() {
        allOn()
        recorder.log(level: .info, source: .app, message: "old")
        recorder.touchDown(mono: mono, x: 0.1, y: 0.1, fingers: 1)
        wall += TimelineLimits.maxAgeMs + 1
        mono += Double(TimelineLimits.maxAgeMs) + 1
        recorder.log(level: .info, source: .app, message: "new")
        let snapshot = recorder.freeze()
        XCTAssertEqual(snapshot.events.count, 1)
        XCTAssertEqual(snapshot.end, wall)
    }

    func testTouchesAreConvertedToWallClockAtFreeze() {
        allOn()
        recorder.touchDown(mono: 48_000, x: 0.123456, y: 0.5, fingers: 3)
        let snapshot = recorder.freeze()
        // wall = mono + (wallNow − monoNow) = 48_000 + (1_800_000_000_000 − 50_000)
        XCTAssertEqual(snapshot.events, [.touch(t: 1_799_999_998_000, x: 0.1235, y: 0.5, fingers: 3)])
        XCTAssertEqual(snapshot.monoToWallMs, Double(wall) - mono)
    }

    func testAppNamedScreensWinAndInferenceStops() {
        recorder.setAppScreen("Example") // before activation: remembered, not recorded
        XCTAssertTrue(recorder.freeze().events.isEmpty)
        allOn()
        XCTAssertEqual(recorder.freeze().events, [.screen(t: wall, name: "Example", source: .app)], "named on activation")
        XCTAssertFalse(recorder.acceptsInferredScreens)
        recorder.inferredScreen("MainViewController")
        recorder.setAppScreen("Example")
        recorder.setAppScreen("Settings")
        let snapshot = recorder.freeze()
        XCTAssertEqual(snapshot.events.count, 2, "inferred names are ignored and repeats are not recorded")
        XCTAssertEqual(snapshot.screen, "Settings")
    }

    func testInferredScreensRecordOnlyChanges() {
        allOn()
        XCTAssertTrue(recorder.acceptsInferredScreens)
        recorder.inferredScreen("Home")
        recorder.inferredScreen("Home")
        recorder.inferredScreen("Detail")
        XCTAssertEqual(recorder.freeze().events.count, 2)
    }

    func testTurningOffClearsAndConsoleRequestFollowsTheJSHook() {
        allOn()
        recorder.log(level: .info, source: .app, message: "x")
        XCTAssertEqual(recorder.freeze().nativeConsole?.excludeReactNative, false)
        recorder.markJSConsoleUsed()
        let request = recorder.freeze().nativeConsole
        XCTAssertEqual(request?.excludeReactNative, true)
        XCTAssertEqual(request?.to, wall)
        XCTAssertEqual(request?.from, wall - TimelineLimits.maxAgeMs)

        recorder.configure(TimelineRecorder.Switches())
        allOn()
        XCTAssertTrue(recorder.freeze().events.isEmpty, "off clears the rings")
    }

    func testSessionLogLinesAreTheNewestLogs() {
        allOn()
        for i in 0..<300 { recorder.log(level: .info, source: .app, message: "\(i)") }
        let lines = recorder.sessionLogLines(limit: CrashStore.sessionLogLines)
        XCTAssertEqual(lines.count, CrashStore.sessionLogLines)
        XCTAssertTrue(lines.last?.contains(#""msg":"299""#) ?? false)
    }

    func testBridgeLevelsAndJSLines() {
        XCTAssertEqual(SnitchBridge.timelineLevel("warning"), .warn)
        XCTAssertEqual(SnitchBridge.timelineLevel("ERROR"), .error)
        XCTAssertEqual(SnitchBridge.timelineLevel("trace"), .debug)
        XCTAssertEqual(SnitchBridge.timelineLevel("log"), .info)

        let shared = TimelineRecorder.shared
        shared.reset()
        defer { shared.reset() }
        SnitchBridge.logJS("dropped while off", level: "info")
        XCTAssertTrue(shared.freeze().events.isEmpty)
        shared.configure(TimelineRecorder.Switches(on: true, console: true, network: false, screens: false))
        SnitchBridge.logJS("hello", level: "warn")
        guard case let .log(_, level, source, message, _)? = shared.freeze().events.first else {
            return XCTFail("no js line")
        }
        XCTAssertEqual(level, .warn)
        XCTAssertEqual(source, .js)
        XCTAssertEqual(message, "hello")
        XCTAssertEqual(shared.freeze().nativeConsole?.excludeReactNative, true)
    }
}

final class ConsoleReaderFilterTests: XCTestCase {
    func testAppleFrameworkChatterIsDroppedButItsErrorsAreKept() {
        XCTAssertFalse(ConsoleReader.keeps(subsystem: "com.apple.UIKit", level: .info, excludeReactNative: false))
        XCTAssertFalse(ConsoleReader.keeps(subsystem: "com.apple.runningboard", level: .debug, excludeReactNative: false))
        XCTAssertFalse(ConsoleReader.keeps(subsystem: "com.apple.network", level: .notice, excludeReactNative: false))
        XCTAssertTrue(ConsoleReader.keeps(subsystem: "com.apple.network", level: .error, excludeReactNative: false))
        XCTAssertTrue(ConsoleReader.keeps(subsystem: "com.apple.CFNetwork", level: .fault, excludeReactNative: false))
    }

    func testAppLibraryAndNSLogLinesAreKeptAtEveryLevel() {
        XCTAssertTrue(ConsoleReader.keeps(subsystem: "com.mochiro.app", level: .debug, excludeReactNative: false))
        XCTAssertTrue(ConsoleReader.keeps(subsystem: "host.exp.Expo", level: .info, excludeReactNative: false))
        XCTAssertTrue(ConsoleReader.keeps(subsystem: "", level: .info, excludeReactNative: false))
    }

    func testSnitchAndDoubleCountedReactNativeLinesAreSkipped() {
        XCTAssertFalse(ConsoleReader.keeps(subsystem: SDKLog.subsystem, level: .error, excludeReactNative: false))
        XCTAssertTrue(ConsoleReader.keeps(subsystem: ConsoleReader.reactNativeSubsystem, level: .info, excludeReactNative: false))
        XCTAssertFalse(ConsoleReader.keeps(subsystem: ConsoleReader.reactNativeSubsystem, level: .info, excludeReactNative: true))
    }
}
