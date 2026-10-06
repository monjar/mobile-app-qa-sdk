// UI tests driven through the SDK's debug hooks (debug builds only):
// - autoreport: the app files a report on its own; the CI job then checks that the
//   Snitch server on 127.0.0.1:8080 received it (with screenshot and video)
// - cancellation: the real fire path runs 300 ms into a press, so the app's 600 ms
//   long-press must never fire; a control test shows it does fire without the hook

import XCTest

final class SnitchExampleUITests: XCTestCase {
    private let serverURL = "http://127.0.0.1:8080"
    private let ingestKey = "snitch_pk_0123456789ABCDEFGHJKMNPQRS"

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    private func launch(_ environment: [String: String]) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment = environment
        app.launch()
        return app
    }

    func testAutoReportReachesServer() {
        let app = launch([
            "SNITCH_DEBUG_SERVER_URL": serverURL,
            "SNITCH_DEBUG_INGEST_KEY": ingestKey,
            "SNITCH_DEBUG_AUTOREPORT": "6",
        ])
        XCTAssertTrue(app.staticTexts["longPressLabel"].waitForExistence(timeout: 20))

        // Some on-screen activity before the report so the clip isn't one still frame.
        let list = app.tables["list"]
        if list.waitForExistence(timeout: 5) {
            list.swipeUp()
            list.swipeDown()
        }

        // Keep the app in the foreground while the SDK composes and uploads the report.
        let uploadWindow = XCTestExpectation(description: "upload window")
        _ = XCTWaiter.wait(for: [uploadWindow], timeout: 25)
        XCTAssertEqual(app.state, .runningForeground)
    }

    func testDebugHookCancelsTheLongPress() {
        let app = launch([
            "SNITCH_DEBUG_SERVER_URL": serverURL,
            "SNITCH_DEBUG_INGEST_KEY": ingestKey,
            "SNITCH_DEBUG_CANCEL_AFTER_MS": "300",
        ])
        let label = app.staticTexts["longPressLabel"]
        XCTAssertTrue(label.waitForExistence(timeout: 20))
        let row = app.cells["row-2"]
        XCTAssertTrue(row.waitForExistence(timeout: 10))

        row.press(forDuration: 2.0)

        // Give a (wrongly) surviving long-press time to land before checking.
        _ = XCTWaiter.wait(for: [XCTestExpectation(description: "settle")], timeout: 1)
        XCTAssertEqual(label.label, "long presses: 0")
    }

    func testLongPressCountsWithoutTheHook() {
        let app = launch([
            "SNITCH_DEBUG_SERVER_URL": serverURL,
            "SNITCH_DEBUG_INGEST_KEY": ingestKey,
        ])
        let label = app.staticTexts["longPressLabel"]
        XCTAssertTrue(label.waitForExistence(timeout: 20))
        let row = app.cells["row-2"]
        XCTAssertTrue(row.waitForExistence(timeout: 10))

        row.press(forDuration: 2.0)

        let counted = NSPredicate(format: "label == %@", "long presses: 1")
        let expectation = XCTNSPredicateExpectation(predicate: counted, object: label)
        XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: 5), .completed, "control: the long-press works when Snitch doesn't fire")
    }
}
