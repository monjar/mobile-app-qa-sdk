// AppTransactionRetry: TestFlight builds usually have no receipt file, so the
// release type hangs on StoreKit's AppTransaction. A slow or failed read must
// not leave the SDK inert for the whole launch.

import XCTest
@testable import Snitch

final class AppTransactionRetryTests: XCTestCase {
    /// Runs the retry loop with scripted reads; scheduling is immediate but recorded.
    private func run(reads: [String?], delays: [TimeInterval] = AppTransactionRetry.defaultDelays)
        -> (results: [String?], scheduled: [TimeInterval], readCount: Int)
    {
        var remaining = reads
        var results: [String?] = []
        var scheduled: [TimeInterval] = []
        var readCount = 0
        AppTransactionRetry.run(
            delays: delays,
            read: { done in
                readCount += 1
                done(remaining.isEmpty ? nil : remaining.removeFirst())
            },
            schedule: { delay, work in
                scheduled.append(delay)
                work()
            },
            completion: { results.append($0) }
        )
        return (results, scheduled, readCount)
    }

    func testFirstAnswerIsUsedWithoutRetrying() {
        let r = run(reads: ["sandbox"])
        XCTAssertEqual(r.results, ["sandbox"])
        XCTAssertEqual(r.scheduled, [0])
        XCTAssertEqual(r.readCount, 1)
    }

    func testFailedReadsAreRetriedWithGrowingDelays() {
        let r = run(reads: [nil, nil, "sandbox"])
        XCTAssertEqual(r.results, ["sandbox"])
        XCTAssertEqual(r.scheduled, [0, 5, 15])
    }

    func testGivesUpAfterEveryAttemptFailsAndReportsOnce() {
        let r = run(reads: [nil, nil, nil, nil, "sandbox"])
        XCTAssertEqual(r.results, [nil], "completion fires exactly once, with nil")
        XCTAssertEqual(r.readCount, AppTransactionRetry.defaultDelays.count)
    }

    func testALateAnswerIsStillDelivered() {
        // The old reader dropped anything after 3 s. Now the answer arrives whenever
        // the read finishes: simulate a read that completes later, on its own.
        var pending: ((String?) -> Void)?
        var results: [String?] = []
        AppTransactionRetry.run(
            read: { done in pending = done },
            schedule: { _, work in work() },
            completion: { results.append($0) }
        )
        XCTAssertEqual(results, [], "nothing until StoreKit answers")
        pending?("sandbox")
        XCTAssertEqual(results, ["sandbox"])
    }

    func testTheRefinedAnswerClassifiesAsTestFlight() {
        // No profile, no receipt (a TestFlight install), then AppTransaction says sandbox.
        var s = IosReleaseSignals(isSimulator: false, profile: nil, receipt: nil, appTransactionEnvironment: nil)
        XCTAssertEqual(ReleaseTypeClassifier.classifyIos(s), .unknown)
        XCTAssertTrue(ReleaseTypeClassifier.awaitsAppTransaction(s))
        s.appTransactionEnvironment = "sandbox"
        XCTAssertEqual(ReleaseTypeClassifier.classifyIos(s), .testflight)
    }
}
