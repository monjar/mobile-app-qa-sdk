// Crash follow-up storage (spec §11.8), screenshot markup rendering and the
// editor/sheet models (spec §11.7), and screen naming for the timeline (spec §11.6).

import CoreGraphics
import UIKit
import XCTest
@testable import Snitch

final class CrashStoreTests: XCTestCase {
    private var dir: URL!
    private var store: CrashStore!

    override func setUp() {
        super.setUp()
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("snitch-crash-\(UUID().uuidString)")
        store = CrashStore(directory: dir)
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: dir)
        super.tearDown()
    }

    func testTheNewestRecentCrashIsPendingUntilDiscarded() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        store.saveDiagnostic(Data("{\"older\":true}".utf8), at: now.addingTimeInterval(-3600))
        store.saveDiagnostic(Data("{\"newer\":true}".utf8), at: now.addingTimeInterval(-60))
        let stale = try XCTUnwrap(store.saveDiagnostic(Data("{\"stale\":true}".utf8), at: now.addingTimeInterval(-8 * 24 * 3600)))

        let pending = try XCTUnwrap(store.pendingCrash(now: now))
        XCTAssertEqual(pending.text, "{\"newer\":true}")
        XCTAssertFalse(FileManager.default.fileExists(atPath: stale.path), "crashes older than 7 days are deleted unseen")

        store.discardPending()
        XCTAssertNil(store.pendingCrash(now: now))
    }

    func testDiagnosticsAreCutTo512KB() throws {
        let big = Data(repeating: 0x41, count: CrashStore.maxDiagnosticBytes + 1000)
        let url = try XCTUnwrap(store.saveDiagnostic(big, at: Date()))
        XCTAssertEqual(try Data(contentsOf: url).count, CrashStore.maxDiagnosticBytes)
        XCTAssertNil(store.saveDiagnostic(Data(), at: Date()))
    }

    func testTheSessionLogBecomesThePreviousSessionsTimeline() throws {
        let lines = (0..<250).map { i in
            TimelineEncoding.line(.log(t: Int64(1_800_000_000_000 + i), level: .info, source: .app, message: "line \(i)", tag: nil))
        }
        store.saveSessionLog(lines)
        XCTAssertNil(store.previousSessionTimeline(), "this session's log is not the previous one")

        store.promoteSessionLog() // next launch
        let timeline = try XCTUnwrap(store.previousSessionTimeline())
        XCTAssertEqual(timeline.events.count, CrashStore.sessionLogLines, "≤ 200 lines are kept")
        XCTAssertEqual(timeline.end, 1_800_000_000_249)
        XCTAssertEqual(timeline.events.first?.t, 1_800_000_000_050)
        XCTAssertNil(timeline.nativeConsole)

        store.promoteSessionLog() // a launch that never saved a log
        XCTAssertNil(store.previousSessionTimeline(), "a stale previous log is not kept around")
    }

    func testDiscardingAlsoForgetsThePreviousSessionLog() {
        store.saveSessionLog([TimelineEncoding.line(.log(t: 1, level: .info, source: .app, message: "x", tag: nil))])
        store.promoteSessionLog()
        XCTAssertNotNil(store.previousSessionTimeline())
        store.discardPending()
        XCTAssertNil(store.previousSessionTimeline())
    }
}

final class MarkupTests: XCTestCase {
    /// A width×height image of 1-px black/white columns.
    private func stripes(width: Int, height: Int) throws -> CGImage {
        let ctx = try XCTUnwrap(ImageCoding.makeBGRAContext(width: width, height: height))
        ctx.setFillColor(CGColor(gray: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        ctx.setFillColor(CGColor(gray: 0, alpha: 1))
        for x in stride(from: 0, to: width, by: 2) {
            ctx.fill(CGRect(x: x, y: 0, width: 1, height: height))
        }
        return try XCTUnwrap(ctx.makeImage())
    }

    /// BGRA bytes of pixel (x, y), top-left origin.
    private func pixel(_ image: CGImage, _ x: Int, _ y: Int) throws -> [UInt8] {
        let ctx = try XCTUnwrap(ImageCoding.makeBGRAContext(width: image.width, height: image.height))
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        let base = try XCTUnwrap(ctx.data?.assumingMemoryBound(to: UInt8.self))
        let p = base + y * ctx.bytesPerRow + x * 4
        return [p[0], p[1], p[2], p[3]]
    }

    func testBlurAveragesSixteenPixelBlocksInsideTheRectOnly() throws {
        let image = try stripes(width: 64, height: 64)
        let mark = MarkupMark(tool: .blur, start: CGPoint(x: 0, y: 0), end: CGPoint(x: 32, y: 32))
        let out = try XCTUnwrap(MarkupRenderer.render(image, marks: [mark], strokeWidth: 4))
        for (x, y) in [(0, 0), (1, 5), (17, 20), (31, 31)] {
            let p = try pixel(out, x, y)
            XCTAssertEqual(Double(p[0]), 128, accuracy: 2, "(\(x), \(y)) is the block average")
            XCTAssertEqual(Double(p[2]), 128, accuracy: 2)
        }
        XCTAssertEqual(try pixel(out, 40, 40)[0], 0, "outside the rect the stripes stay")
        XCTAssertEqual(try pixel(out, 41, 40)[0], 255)
        XCTAssertEqual(try pixel(out, 32, 10)[0], 0, "the rect's right edge is exclusive")
    }

    func testBoxAndArrowDrawRedInImagePixelsFromTheTopLeft() throws {
        let ctx = try XCTUnwrap(ImageCoding.makeBGRAContext(width: 100, height: 200))
        ctx.setFillColor(CGColor(gray: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: 100, height: 200))
        let white = try XCTUnwrap(ctx.makeImage())
        let box = MarkupMark(tool: .box, start: CGPoint(x: 10, y: 10), end: CGPoint(x: 50, y: 40))
        let out = try XCTUnwrap(MarkupRenderer.render(white, marks: [box], strokeWidth: 4))
        let edge = try pixel(out, 30, 10) // top edge, near the image's top
        XCTAssertGreaterThan(edge[2], 240, "red")
        XCTAssertLessThan(edge[1], 80)
        XCTAssertLessThan(edge[0], 80)
        XCTAssertEqual(try pixel(out, 30, 25), [255, 255, 255, 255], "inside the box is untouched")
        XCTAssertEqual(try pixel(out, 30, 190), [255, 255, 255, 255], "nothing mirrored at the bottom")

        let arrow = MarkupMark(tool: .arrow, start: CGPoint(x: 10, y: 150), end: CGPoint(x: 90, y: 150))
        let pointed = try XCTUnwrap(MarkupRenderer.render(white, marks: [arrow], strokeWidth: 4))
        let shaft = try pixel(pointed, 50, 150)
        XCTAssertGreaterThan(shaft[2], 240, "the shaft is red")
        XCTAssertLessThan(shaft[0], 80)
        XCTAssertLessThan(try pixel(pointed, 84, 150)[1], 80, "the filled head, past the end of the shaft")
        XCTAssertEqual(try pixel(pointed, 50, 100), [255, 255, 255, 255])
    }

    func testGeometry() {
        let fit = MarkupGeometry.fit(imageSize: CGSize(width: 100, height: 200), in: CGSize(width: 300, height: 300))
        XCTAssertEqual(fit, CGRect(x: 75, y: 0, width: 150, height: 300))
        let head = MarkupGeometry.arrowHead(from: .zero, to: CGPoint(x: 100, y: 0), width: 4)
        XCTAssertEqual(head.count, 3)
        XCTAssertEqual(head[0], CGPoint(x: 100, y: 0), "the tip is the end point")
        XCTAssertEqual(head[1].x, 84, accuracy: 0.001)
        XCTAssertTrue(MarkupGeometry.arrowHead(from: .zero, to: .zero, width: 4).isEmpty)
    }

    func testEditorReplacesTheScreenshotOnDone() throws {
        let jpeg = try XCTUnwrap(makeJPEG(width: 60, height: 120, gray: 0.9))
        let original = Screenshot(jpeg: jpeg, width: 60, height: 120, thumbnail: nil, scale: 2)
        let editor = try XCTUnwrap(MarkupEditorModel(screenshot: original))
        XCTAssertEqual(editor.strokeWidth, 8, "4 pt at 2x")
        var finished: [Screenshot?] = []
        editor.onFinish = { finished.append($0) }

        editor.endDrag(from: CGPoint(x: 1, y: 1), to: CGPoint(x: 2, y: 2))
        XCTAssertTrue(editor.marks.isEmpty, "a tap is not a mark")
        editor.tool = .blur
        editor.endDrag(from: CGPoint(x: 0, y: 0), to: CGPoint(x: 40, y: 40))
        editor.tool = .box
        editor.endDrag(from: CGPoint(x: 10, y: 60), to: CGPoint(x: 50, y: 110))
        XCTAssertEqual(editor.marks.map { $0.tool }, [.blur, .box])
        editor.undo()
        XCTAssertEqual(editor.marks.map { $0.tool }, [.blur])
        editor.clear()
        XCTAssertTrue(editor.marks.isEmpty)

        editor.done()
        XCTAssertEqual(finished.count, 1)
        XCTAssertNil(finished[0], "Done without marks changes nothing")

        editor.endDrag(from: CGPoint(x: 500, y: -10), to: CGPoint(x: 5, y: 5)) // clamped into the image
        XCTAssertEqual(editor.marks.first?.start, CGPoint(x: 60, y: 0))
        editor.done()
        let edited = try XCTUnwrap(finished.last ?? nil)
        XCTAssertEqual(edited.width, 60)
        XCTAssertEqual(edited.height, 120)
        XCTAssertNotEqual(edited.jpeg, jpeg)
        XCTAssertNotNil(ImageCoding.decode(edited.jpeg))
        XCTAssertNotNil(edited.thumbnail)
    }

    func testSheetModelTakesTheEditedScreenshot() throws {
        let jpeg = try XCTUnwrap(makeJPEG(width: 30, height: 60))
        let model = ReportSheetModel(
            reportTypes: [], preselectedType: nil, message: nil,
            screenshot: Screenshot(jpeg: jpeg, width: 30, height: 60, thumbnail: nil, scale: 1),
            videoAvailable: false, recordedSeconds: 0, videoMaxSeconds: 30, email: nil, pauseRecording: false,
            screenshotSelected: false
        )
        XCTAssertFalse(model.includeScreenshot)
        model.openMarkup()
        let editor = try XCTUnwrap(model.markup)
        editor.tool = .arrow
        editor.endDrag(from: CGPoint(x: 2, y: 2), to: CGPoint(x: 28, y: 50))
        editor.done()
        XCTAssertNil(model.markup, "the editor closes")
        XCTAssertTrue(model.includeScreenshot, "a marked-up screenshot is meant to be sent")
        XCTAssertNotEqual(model.screenshot?.jpeg, jpeg)

        var sent: ReportSheetModel.Submission?
        model.onSend = { sent = $0 }
        model.send()
        XCTAssertEqual(sent?.screenshot?.jpeg, model.screenshot?.jpeg)
    }

    func testCrashSheetCanSendWithoutTextOrAttachments() {
        let model = ReportSheetModel(
            reportTypes: [], preselectedType: "bug", message: nil, screenshot: nil,
            videoAvailable: false, recordedSeconds: 0, videoMaxSeconds: 30, email: nil, pauseRecording: false,
            crashAttached: true
        )
        XCTAssertTrue(model.canSend, "the crash diagnostic goes along")
        XCTAssertEqual(model.selectedType, "bug")
    }
}

final class ScreenNamingTests: XCTestCase {
    private final class ProfileViewController: UIViewController {}

    func testNamesPreferTitlesThenTheClassName() {
        let titled = UIViewController()
        titled.title = "Settings"
        XCTAssertEqual(ScreenNaming.name(of: titled), "Settings")

        let navTitled = UIViewController()
        navTitled.navigationItem.title = "Inbox"
        XCTAssertEqual(ScreenNaming.name(of: navTitled), "Inbox")

        XCTAssertEqual(ScreenNaming.name(of: ProfileViewController()), "ProfileViewController")
        XCTAssertEqual(ScreenNaming.className("MyApp.SettingsViewController"), "SettingsViewController")
        XCTAssertEqual(ScreenNaming.className("UIHostingController<ModifiedContent<Text, _PaddingLayout>>"), "UIHostingController")
    }

    func testTopViewControllerFollowsContainers() {
        let detail = ProfileViewController()
        let nav = UINavigationController(rootViewController: UIViewController())
        nav.pushViewController(detail, animated: false)
        let other = UIViewController()
        let tabs = UITabBarController()
        tabs.viewControllers = [nav, other]
        tabs.selectedIndex = 0
        XCTAssertTrue(ScreenNaming.topViewController(from: tabs) === detail)

        let container = UIViewController()
        let child = UIViewController()
        container.addChild(child)
        child.didMove(toParent: container)
        XCTAssertTrue(ScreenNaming.topViewController(from: container) === child)
        XCTAssertNil(ScreenNaming.topViewController(from: nil))
    }
}
