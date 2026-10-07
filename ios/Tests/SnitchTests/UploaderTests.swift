// The upload state machine (spec §7.3) against a URLProtocol stub:
// create → put → complete, 409 attachments_missing, 401 drop, 503 backoff with
// Retry-After, 404 restart. Uploads run on a background queue as in the SDK.

import XCTest
@testable import Snitch

final class StubURLProtocol: URLProtocol {
    struct Response {
        var status: Int
        var headers: [String: String] = [:]
        var body: Data = Data()
    }

    private static let lock = NSLock()
    private static var _handler: ((URLRequest) -> Response)?
    private static var _requests: [URLRequest] = []

    static func setHandler(_ handler: @escaping (URLRequest) -> Response) {
        lock.lock()
        _handler = handler
        _requests = []
        lock.unlock()
    }

    static var requests: [URLRequest] {
        lock.lock()
        defer { lock.unlock() }
        return _requests
    }

    /// "METHOD /path" of every request so far.
    static var log: [String] {
        requests.map { "\($0.httpMethod ?? "?") \($0.url?.path ?? "?")" }
    }

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        StubURLProtocol.lock.lock()
        StubURLProtocol._requests.append(request)
        let handler = StubURLProtocol._handler
        StubURLProtocol.lock.unlock()
        guard let respond = handler, let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }
        let r = respond(request)
        if r.status == 0 {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }
        let response = HTTPURLResponse(url: url, statusCode: r.status, httpVersion: "HTTP/1.1", headerFields: r.headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: r.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class UploaderTests: XCTestCase {
    private var tempDir: URL!
    private var outbox: Outbox!
    private var uploader: Uploader!
    private var clock = Date(timeIntervalSince1970: 1_800_000_000)
    private let key = "snitch_pk_0123456789ABCDEFGHJKMNPQRS"

    override func setUpWithError() throws {
        tempDir = FileManager.default.temporaryDirectory.appendingPathComponent("snitch-upload-\(UUID().uuidString)")
        outbox = Outbox(root: tempDir.appendingPathComponent("outbox"))
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubURLProtocol.self]
        let client = APIClient(baseURL: URL(string: "https://snitch.example.com")!, ingestKey: key, configuration: config) {
            "ios/\(SnitchVersion.current)"
        }
        uploader = Uploader(outbox: outbox, client: client)
        uploader.now = { [unowned self] in self.clock }
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tempDir)
    }

    // MARK: - Helpers

    private func json(_ object: Any) -> Data {
        (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
    }

    private func created(stored: [String] = []) -> StubURLProtocol.Response {
        StubURLProtocol.Response(status: 201, headers: ["Content-Type": "application/json"], body: json([
            "reportId": "01JA2Z8Y6Q3K4M5N6P7R8S9T0V",
            "ticket": "MOCH-42",
            "number": 42,
            "state": "pending",
            "attachments": [["name": "screenshot", "state": stored.contains("screenshot") ? "stored" : "missing"]],
        ]))
    }

    private func apiError(_ status: Int, _ code: String, details: Any? = nil, headers: [String: String] = [:]) -> StubURLProtocol.Response {
        var inner: [String: Any] = ["code": code, "message": code]
        if let d = details { inner["details"] = d }
        return StubURLProtocol.Response(status: status, headers: headers, body: json(["error": inner]))
    }

    /// A committed report with one screenshot attachment.
    private func enqueueReport() throws -> PendingReport {
        let jpeg = try XCTUnwrap(makeJPEG(width: 20, height: 40))
        let context = ReportContext(
            clientReportId: ReportBuilder.newReportId(),
            reportedAt: Date(),
            trigger: "api",
            typeId: "bug",
            description: "upload test",
            app: AppInfo(id: "io.github.monjar.snitch.tests", name: nil, version: "1.0", build: "1", releaseType: "debug"),
            device: DeviceInfo(platform: "ios", osVersion: "18.0", model: "iPhone16,2", manufacturer: nil, locale: nil,
                               timeZone: nil, screen: nil, memory: nil, thermal: nil, lowPower: nil, battery: nil,
                               charging: nil, network: nil, darkMode: nil, screenReader: nil, fontScale: nil),
            user: UserContext.User(),
            email: nil,
            custom: [:],
            wrapper: nil,
            stats: nil,
            logText: nil
        )
        try ReportBuilder.write(context: context, screenshot: Screenshot(jpeg: jpeg, width: 20, height: 40, thumbnail: nil), video: nil, to: outbox)
        return try XCTUnwrap(outbox.pendingReports().first { $0.id == context.clientReportId })
    }

    private func upload(_ report: PendingReport) -> Uploader.Outcome {
        let box = Locked<Uploader.Outcome?>(nil)
        let done = expectation(description: "upload")
        let uploader = self.uploader!
        DispatchQueue.global().async {
            box.set(uploader.upload(report))
            done.fulfill()
        }
        wait(for: [done], timeout: 20)
        return box.get() ?? .dropped(status: -1, code: "timeout")
    }

    private func exists(_ report: PendingReport) -> Bool {
        FileManager.default.fileExists(atPath: report.dir.path)
    }

    // MARK: - Tests

    func testCreatePutComplete() throws {
        let report = try enqueueReport()
        StubURLProtocol.setHandler { req in
            switch (req.httpMethod ?? "", req.url?.path ?? "") {
            case ("POST", "/api/v1/reports"): return self.created()
            case ("PUT", "/api/v1/reports/01JA2Z8Y6Q3K4M5N6P7R8S9T0V/attachments/screenshot"):
                return StubURLProtocol.Response(status: 201, body: self.json(["name": "screenshot", "state": "stored", "sizeBytes": 10]))
            case ("POST", "/api/v1/reports/01JA2Z8Y6Q3K4M5N6P7R8S9T0V/complete"):
                return StubURLProtocol.Response(status: 200, body: self.json(["reportId": "01JA2Z8Y6Q3K4M5N6P7R8S9T0V", "ticket": "MOCH-42", "state": "complete"]))
            default: return StubURLProtocol.Response(status: 500)
            }
        }
        XCTAssertEqual(upload(report), .sent(ticket: "MOCH-42"))
        XCTAssertEqual(StubURLProtocol.log, [
            "POST /api/v1/reports",
            "PUT /api/v1/reports/01JA2Z8Y6Q3K4M5N6P7R8S9T0V/attachments/screenshot",
            "POST /api/v1/reports/01JA2Z8Y6Q3K4M5N6P7R8S9T0V/complete",
        ])
        XCTAssertFalse(exists(report), "a completed report is deleted")

        let put = StubURLProtocol.requests[1]
        XCTAssertEqual(put.value(forHTTPHeaderField: "Content-Type"), "image/jpeg")
        XCTAssertEqual(put.value(forHTTPHeaderField: "X-Content-SHA256")?.count, 64)
        for r in StubURLProtocol.requests {
            XCTAssertEqual(r.value(forHTTPHeaderField: "X-Snitch-Key"), key)
            XCTAssertEqual(r.value(forHTTPHeaderField: "X-Snitch-SDK"), "ios/\(SnitchVersion.current)")
            XCTAssertEqual(r.value(forHTTPHeaderField: "User-Agent"), "Snitch/\(SnitchVersion.current) (ios)")
        }
    }

    func testAlreadyStoredAttachmentIsSkipped() throws {
        let report = try enqueueReport()
        StubURLProtocol.setHandler { req in
            if req.url?.path == "/api/v1/reports" { return self.created(stored: ["screenshot"]) }
            if req.url?.path.hasSuffix("/complete") == true { return StubURLProtocol.Response(status: 200, body: self.json(["ticket": "MOCH-42"])) }
            return StubURLProtocol.Response(status: 500)
        }
        XCTAssertEqual(upload(report), .sent(ticket: "MOCH-42"))
        XCTAssertEqual(StubURLProtocol.log.count, 2)
    }

    func testAttachmentsMissingGoesBackToPut() throws {
        let report = try enqueueReport()
        var completes = 0
        StubURLProtocol.setHandler { req in
            let path = req.url?.path ?? ""
            if path == "/api/v1/reports" { return self.created() }
            if path.hasSuffix("/attachments/screenshot") { return StubURLProtocol.Response(status: 201) }
            if path.hasSuffix("/complete") {
                completes += 1
                if completes == 1 { return self.apiError(409, "attachments_missing", details: ["missing": ["screenshot"]]) }
                return StubURLProtocol.Response(status: 200)
            }
            return StubURLProtocol.Response(status: 500)
        }
        XCTAssertEqual(upload(report), .sent(ticket: "MOCH-42"))
        XCTAssertEqual(StubURLProtocol.log.filter { $0.hasPrefix("PUT") }.count, 2)
        XCTAssertFalse(exists(report))
    }

    func testUnauthorizedDropsTheReport() throws {
        let report = try enqueueReport()
        StubURLProtocol.setHandler { _ in self.apiError(401, "unauthorized") }
        XCTAssertEqual(upload(report), .dropped(status: 401, code: "unauthorized"))
        XCTAssertFalse(exists(report))
        XCTAssertEqual(StubURLProtocol.log.count, 1)
    }

    func testValidationErrorDropsTheReport() throws {
        let report = try enqueueReport()
        StubURLProtocol.setHandler { _ in self.apiError(422, "invalid_request") }
        XCTAssertEqual(upload(report), .dropped(status: 422, code: "invalid_request"))
        XCTAssertFalse(exists(report))
    }

    func testServiceUnavailableBacksOffHonouringRetryAfter() throws {
        let report = try enqueueReport()
        StubURLProtocol.setHandler { _ in self.apiError(503, "internal", headers: ["Retry-After": "120"]) }
        let outcome = upload(report)
        XCTAssertEqual(outcome, .retryLater(nextAttemptAt: clock.addingTimeInterval(120), offline: false))
        XCTAssertTrue(exists(report), "a retryable failure keeps the report")
        let state = outbox.loadState(in: report.dir)
        XCTAssertEqual(state.attempts, 1)
        XCTAssertEqual(state.nextAttemptAt, clock.timeIntervalSince1970 + 120, accuracy: 0.001)
        XCTAssertNil(state.reportId)
    }

    func testBackoffDoublesAndCaps() throws {
        let report = try enqueueReport()
        StubURLProtocol.setHandler { _ in StubURLProtocol.Response(status: 500) }
        XCTAssertEqual(upload(report), .retryLater(nextAttemptAt: clock.addingTimeInterval(30), offline: false))
        XCTAssertEqual(upload(report), .retryLater(nextAttemptAt: clock.addingTimeInterval(60), offline: false))
        XCTAssertEqual(outbox.loadState(in: report.dir).attempts, 2)
        XCTAssertEqual(Uploader.backoffDelay(attempts: 3, retryAfter: nil), 120)
        XCTAssertEqual(Uploader.backoffDelay(attempts: 20, retryAfter: nil), 3600)
        XCTAssertEqual(Uploader.backoffDelay(attempts: 1, retryAfter: 5), 30)
    }

    func testNetworkErrorIsRetryableAndOffline() throws {
        let report = try enqueueReport()
        StubURLProtocol.setHandler { _ in StubURLProtocol.Response(status: 0) }
        XCTAssertEqual(upload(report), .retryLater(nextAttemptAt: clock.addingTimeInterval(30), offline: true))
        XCTAssertTrue(exists(report))
    }

    func testNotFoundOnPutRestartsAtCreate() throws {
        let report = try enqueueReport()
        var creates = 0
        var puts = 0
        StubURLProtocol.setHandler { req in
            let path = req.url?.path ?? ""
            if path == "/api/v1/reports" {
                creates += 1
                return self.created()
            }
            if path.hasSuffix("/attachments/screenshot") {
                puts += 1
                return puts == 1 ? self.apiError(404, "not_found") : StubURLProtocol.Response(status: 201)
            }
            if path.hasSuffix("/complete") { return StubURLProtocol.Response(status: 200) }
            return StubURLProtocol.Response(status: 500)
        }
        XCTAssertEqual(upload(report), .sent(ticket: "MOCH-42"))
        XCTAssertEqual(creates, 2)
        XCTAssertEqual(puts, 2)
    }

    func testResumesFromPersistedState() throws {
        let report = try enqueueReport()
        // First run: create succeeds, the upload fails.
        StubURLProtocol.setHandler { req in
            req.url?.path == "/api/v1/reports" ? self.created() : StubURLProtocol.Response(status: 503)
        }
        _ = upload(report)
        XCTAssertEqual(outbox.loadState(in: report.dir).reportId, "01JA2Z8Y6Q3K4M5N6P7R8S9T0V")
        // Second run: no new POST /reports.
        StubURLProtocol.setHandler { req in
            if req.url?.path == "/api/v1/reports" { return StubURLProtocol.Response(status: 500) }
            return StubURLProtocol.Response(status: 200)
        }
        XCTAssertEqual(upload(report), .sent(ticket: "MOCH-42"))
        XCTAssertFalse(StubURLProtocol.log.contains("POST /api/v1/reports"))
    }

    func testRetryAfterParsing() {
        let seconds = HTTPResponse(status: 429, data: Data(), headers: ["retry-after": "7"], errorCode: nil, transportError: nil)
        XCTAssertEqual(seconds.retryAfterSeconds, 7)
        let none = HTTPResponse(status: 429, data: Data(), headers: [:], errorCode: nil, transportError: nil)
        XCTAssertNil(none.retryAfterSeconds)
        XCTAssertTrue(APIErrorEnvelope.isRetryable(status: 409, code: "attachments_missing"))
        XCTAssertFalse(APIErrorEnvelope.isRetryable(status: 409, code: "report_completed"))
        XCTAssertTrue(APIErrorEnvelope.isRetryable(status: 0, code: nil))
        XCTAssertFalse(APIErrorEnvelope.isRetryable(status: 413, code: "payload_too_large"))
    }
}
