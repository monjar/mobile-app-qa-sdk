// The upload state machine (spec §7.3) against a URLProtocol stub:
// create → put → complete, 409 attachments_missing, 401 drop, 503 backoff with
// Retry-After, 404 restart. Uploads run on a background queue as in the SDK.
// Chunked, resumable upload (spec §11.2): Content-Range chunks read from disk,
// 202/201, range_mismatch resync and its per-pass limit, chunk vs whole-file hash
// mismatches, 404 restarts, offsets persisted after every chunk, the debug cap,
// and the whole-file path for small files and servers without resumable upload.

import XCTest
@testable import Snitch

final class StubURLProtocol: URLProtocol {
    struct Response {
        var status: Int
        var headers: [String: String] = [:]
        var body: Data = Data()
        /// Deliver the body in two `didLoad` calls (streaming).
        var split = false
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
        if (300..<400).contains(r.status), let location = r.headers["Location"], let target = URL(string: location, relativeTo: url) {
            // Like the HTTP loader: report the redirect and let the loading system take over.
            client?.urlProtocol(self, wasRedirectedTo: URLRequest(url: target.absoluteURL), redirectResponse: response)
            return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if r.split && r.body.count > 1 {
            let half = r.body.count / 2
            client?.urlProtocol(self, didLoad: r.body.prefix(half))
            client?.urlProtocol(self, didLoad: r.body.suffix(from: half))
        } else {
            client?.urlProtocol(self, didLoad: r.body)
        }
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
        let context = makeContext(id: ReportBuilder.newReportId())
        try ReportBuilder.write(context: context, screenshot: Screenshot(jpeg: jpeg, width: 20, height: 40, thumbnail: nil), video: nil, to: outbox)
        return try XCTUnwrap(outbox.pendingReports().first { $0.id == context.clientReportId })
    }

    /// A committed report whose only attachment, `video`, is `size` deterministic bytes.
    private func enqueueLargeReport(size: Int) throws -> (report: PendingReport, data: Data) {
        let data = Data((0..<size).map { UInt8(truncatingIfNeeded: $0 &* 31 &+ ($0 >> 9)) })
        let id = ReportBuilder.newReportId()
        let dir = try outbox.createReportDirectory(id: id)
        try outbox.write(data, to: dir.appendingPathComponent(Outbox.fileName(for: "video")))
        let declaration = AttachmentDeclaration(
            name: "video", contentType: "video/mp4", sizeBytes: data.count,
            sha256: Hashing.sha256Hex(data), width: 2, height: 2, durationMs: 1000
        )
        try outbox.commit(ReportBuilder.makeReport(context: makeContext(id: id), attachments: [declaration], stats: nil), in: dir)
        return (try XCTUnwrap(outbox.pendingReports().first { $0.id == id }), data)
    }

    private func makeContext(id: String) -> ReportContext {
        ReportContext(
            clientReportId: id,
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
    }

    /// The create answer of a resumable server for the `video` attachment.
    private func createdResumable(chunkBytes: Int = ChunkPlan.minBytes, receivedBytes: Int = 0) -> StubURLProtocol.Response {
        StubURLProtocol.Response(status: 201, headers: ["Content-Type": "application/json"], body: json([
            "reportId": "01JA2Z8Y6Q3K4M5N6P7R8S9T0V",
            "ticket": "MOCH-42",
            "number": 42,
            "state": "pending",
            "attachments": [["name": "video", "state": "missing", "receivedBytes": receivedBytes]],
            "upload": ["resumable": true, "chunkBytes": chunkBytes],
        ]))
    }

    private func contentRange(_ request: URLRequest) -> (start: Int, end: Int, total: Int)? {
        guard let header = request.value(forHTTPHeaderField: "Content-Range"), header.hasPrefix("bytes ") else { return nil }
        let numbers = header.dropFirst(6).split { $0 == "-" || $0 == "/" }.compactMap { Int($0) }
        guard numbers.count == 3 else { return nil }
        return (numbers[0], numbers[1], numbers[2])
    }

    private var puts: [URLRequest] {
        StubURLProtocol.requests.filter { $0.httpMethod == "PUT" }
    }

    /// Answers chunks like the real server: 202 with the new offset, 201 at the end, and
    /// 409 range_mismatch when a chunk doesn't start at its offset. `first` can answer before it.
    private func chunkServer(
        startOffset: Int = 0,
        first: ((URLRequest, inout Int) -> StubURLProtocol.Response?)? = nil
    ) -> (URLRequest) -> StubURLProtocol.Response {
        var offset = startOffset
        return { req in
            if let answer = first?(req, &offset) { return answer }
            let path = req.url?.path ?? ""
            if path == "/api/v1/reports" { return self.createdResumable(receivedBytes: startOffset) }
            if path.hasSuffix("/complete") { return StubURLProtocol.Response(status: 200, body: self.json(["ticket": "MOCH-42"])) }
            guard let range = self.contentRange(req) else {
                return StubURLProtocol.Response(status: 201, body: self.json(["name": "video", "state": "stored", "sizeBytes": 1]))
            }
            guard range.start == offset else {
                return self.apiError(409, "range_mismatch", details: ["receivedBytes": offset])
            }
            offset = range.end + 1
            if offset == range.total {
                return StubURLProtocol.Response(status: 201, body: self.json(["name": "video", "state": "stored", "sizeBytes": offset]))
            }
            return StubURLProtocol.Response(status: 202, body: self.json(["name": "video", "state": "partial", "receivedBytes": offset]))
        }
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

    // MARK: - Chunked, resumable upload (spec §11.2)

    func testLargeFileGoesUpInChunksReadFromDisk() throws {
        let (report, data) = try enqueueLargeReport(size: 200_000)
        StubURLProtocol.setHandler(chunkServer())
        XCTAssertEqual(upload(report), .sent(ticket: "MOCH-42"))
        XCTAssertFalse(exists(report))

        let chunk = ChunkPlan.minBytes
        XCTAssertEqual(puts.map { $0.value(forHTTPHeaderField: "Content-Range") }, [
            "bytes 0-\(chunk - 1)/200000",
            "bytes \(chunk)-\(2 * chunk - 1)/200000",
            "bytes \(2 * chunk)-\(3 * chunk - 1)/200000",
            "bytes \(3 * chunk)-199999/200000",
        ])
        let wholeHash = Hashing.sha256Hex(data)
        for put in puts {
            let range = try XCTUnwrap(contentRange(put))
            let slice = data.subdata(in: range.start..<(range.end + 1))
            XCTAssertEqual(put.value(forHTTPHeaderField: "Content-Length"), String(slice.count))
            XCTAssertEqual(put.value(forHTTPHeaderField: "X-Content-SHA256"), wholeHash, "every chunk carries the whole file's hash")
            XCTAssertEqual(put.value(forHTTPHeaderField: "X-Chunk-SHA256"), Hashing.sha256Hex(slice), "and its own")
            XCTAssertEqual(put.value(forHTTPHeaderField: "Content-Type"), "video/mp4")
        }
        XCTAssertEqual(StubURLProtocol.log.last, "POST /api/v1/reports/01JA2Z8Y6Q3K4M5N6P7R8S9T0V/complete")
    }

    func testResumesFromTheCreateAnswersReceivedBytes() throws {
        let (report, _) = try enqueueLargeReport(size: 200_000)
        StubURLProtocol.setHandler(chunkServer(startOffset: 2 * ChunkPlan.minBytes))
        XCTAssertEqual(upload(report), .sent(ticket: "MOCH-42"))
        XCTAssertEqual(puts.count, 2)
        XCTAssertEqual(contentRange(puts[0])?.start, 2 * ChunkPlan.minBytes, "bytes the server has are not sent again")
    }

    func testRangeMismatchResumesFromTheServersOffset() throws {
        let (report, _) = try enqueueLargeReport(size: 200_000)
        // The create answer claims one chunk arrived, but the server actually has nothing.
        var claimed = true
        StubURLProtocol.setHandler(chunkServer(startOffset: 0) { req, _ in
            if req.url?.path == "/api/v1/reports" && claimed {
                claimed = false
                return self.createdResumable(receivedBytes: ChunkPlan.minBytes)
            }
            return nil
        })
        XCTAssertEqual(upload(report), .sent(ticket: "MOCH-42"))
        XCTAssertEqual(puts.compactMap { contentRange($0)?.start }, [ChunkPlan.minBytes, 0, ChunkPlan.minBytes, 2 * ChunkPlan.minBytes, 3 * ChunkPlan.minBytes])
    }

    func testRepeatedRangeMismatchesBackOff() throws {
        let (report, _) = try enqueueLargeReport(size: 200_000)
        StubURLProtocol.setHandler { req in
            if req.url?.path == "/api/v1/reports" { return self.createdResumable() }
            // A confused server that never accepts any offset.
            return self.apiError(409, "range_mismatch", details: ["receivedBytes": 4096])
        }
        XCTAssertEqual(upload(report), .retryLater(nextAttemptAt: clock.addingTimeInterval(30), offline: false))
        XCTAssertEqual(puts.count, Uploader.maxRangeMismatchesPerPass)
        let state = outbox.loadState(in: report.dir)
        XCTAssertEqual(state.offsets["video"], 4096, "the server's offset is persisted for the next pass")
        XCTAssertEqual(state.attempts, 1)
    }

    func testChunkHashMismatchBacksOffAndResendsThatChunkNextPass() throws {
        let (report, _) = try enqueueLargeReport(size: 200_000)
        var rejectOnce = true
        let server = chunkServer { req, _ in
            guard self.contentRange(req)?.start == ChunkPlan.minBytes, rejectOnce else { return nil }
            rejectOnce = false
            return self.apiError(422, "hash_mismatch", details: ["chunk": true])
        }
        StubURLProtocol.setHandler(server)
        XCTAssertEqual(upload(report), .retryLater(nextAttemptAt: clock.addingTimeInterval(30), offline: false))
        XCTAssertTrue(exists(report))
        XCTAssertEqual(outbox.loadState(in: report.dir).offsets["video"], ChunkPlan.minBytes)

        StubURLProtocol.setHandler(server) // same server state, fresh request log
        XCTAssertEqual(upload(report), .sent(ticket: "MOCH-42"))
        XCTAssertFalse(StubURLProtocol.log.contains("POST /api/v1/reports"), "the report is not created again")
        XCTAssertEqual(contentRange(puts[0])?.start, ChunkPlan.minBytes, "the rejected chunk goes again")
    }

    func testWholeFileHashMismatchRestartsOnceThenDrops() throws {
        let (report, _) = try enqueueLargeReport(size: 200_000)
        StubURLProtocol.setHandler(chunkServer { req, offset in
            guard let range = self.contentRange(req), range.start == offset, range.end + 1 == range.total else { return nil }
            // The last chunk arrives, but the assembled file fails verification: discarded.
            offset = 0
            return self.apiError(422, "hash_mismatch")
        })
        XCTAssertEqual(upload(report), .dropped(status: 422, code: "hash_mismatch"))
        XCTAssertFalse(exists(report))
        let starts = puts.compactMap { contentRange($0)?.start }
        XCTAssertEqual(starts.filter { $0 == 0 }.count, 2, "one restart from 0, then the report is dropped")
    }

    func testNotFoundDuringChunksRestartsWithoutOffsets() throws {
        let (report, _) = try enqueueLargeReport(size: 200_000)
        var creates = 0
        var forgotten = false
        StubURLProtocol.setHandler(chunkServer { req, offset in
            if req.url?.path == "/api/v1/reports" {
                creates += 1
                return self.createdResumable()
            }
            if !forgotten, self.contentRange(req)?.start == ChunkPlan.minBytes {
                forgotten = true
                offset = 0
                return self.apiError(404, "not_found")
            }
            return nil
        })
        XCTAssertEqual(upload(report), .sent(ticket: "MOCH-42"))
        XCTAssertEqual(creates, 2)
        XCTAssertEqual(puts.compactMap { contentRange($0)?.start }, [0, ChunkPlan.minBytes, 0, ChunkPlan.minBytes, 2 * ChunkPlan.minBytes, 3 * ChunkPlan.minBytes])
    }

    func testOffsetsArePersistedAfterEveryChunk() throws {
        let (report, _) = try enqueueLargeReport(size: 200_000)
        StubURLProtocol.setHandler(chunkServer { req, _ in
            self.contentRange(req)?.start == ChunkPlan.minBytes ? StubURLProtocol.Response(status: 503) : nil
        })
        XCTAssertEqual(upload(report), .retryLater(nextAttemptAt: clock.addingTimeInterval(30), offline: false))
        let state = outbox.loadState(in: report.dir)
        XCTAssertTrue(state.resumable)
        XCTAssertEqual(state.chunkBytes, ChunkPlan.minBytes)
        XCTAssertEqual(state.offsets["video"], ChunkPlan.minBytes)
        XCTAssertEqual(state.reportId, "01JA2Z8Y6Q3K4M5N6P7R8S9T0V")
    }

    func testSmallFilesAndOldServersUseOneWholePut() throws {
        // Resumable server, but the screenshot fits in one chunk.
        let small = try enqueueReport()
        StubURLProtocol.setHandler { req in
            if req.url?.path == "/api/v1/reports" { return self.createdResumable() }
            return StubURLProtocol.Response(status: req.httpMethod == "PUT" ? 201 : 200)
        }
        XCTAssertEqual(upload(small), .sent(ticket: "MOCH-42"))
        XCTAssertEqual(puts.count, 1)
        XCTAssertNil(puts[0].value(forHTTPHeaderField: "Content-Range"))

        // A 0.2 server (no `upload` in the create answer) gets the large file whole.
        let (large, data) = try enqueueLargeReport(size: 200_000)
        StubURLProtocol.setHandler { req in
            if req.url?.path == "/api/v1/reports" { return self.created() }
            return StubURLProtocol.Response(status: req.httpMethod == "PUT" ? 201 : 200)
        }
        XCTAssertEqual(upload(large), .sent(ticket: "MOCH-42"))
        XCTAssertEqual(puts.count, 1)
        XCTAssertNil(puts[0].value(forHTTPHeaderField: "Content-Range"))
        XCTAssertNil(puts[0].value(forHTTPHeaderField: "X-Chunk-SHA256"))
        XCTAssertEqual(puts[0].value(forHTTPHeaderField: "Content-Length"), String(data.count))
    }

    func testDebugCapShrinksChunksButNotBelowTheMinimum() throws {
        let (report, _) = try enqueueLargeReport(size: 200_000)
        uploader.chunkBytesCap = 70_000
        StubURLProtocol.setHandler(chunkServer { req, _ in
            req.url?.path == "/api/v1/reports" ? self.createdResumable(chunkBytes: ChunkPlan.defaultBytes) : nil
        })
        XCTAssertEqual(upload(report), .sent(ticket: "MOCH-42"))
        XCTAssertEqual(puts.compactMap { contentRange($0)?.end }, [69_999, 139_999, 199_999])

        XCTAssertEqual(ChunkPlan.chunkBytes(server: ChunkPlan.defaultBytes, debugCap: 1000), ChunkPlan.minBytes)
        XCTAssertEqual(ChunkPlan.chunkBytes(server: ChunkPlan.defaultBytes, debugCap: nil), ChunkPlan.defaultBytes)
    }

    func testStateFilesFrom02StillLoad() throws {
        let report = try enqueueReport()
        let old = #"{"reportId":"01JA2Z8Y6Q3K4M5N6P7R8S9T0V","ticket":"MOCH-42","attempts":2,"nextAttemptAt":0,"uploaded":["screenshot"]}"#
        try Data(old.utf8).write(to: report.dir.appendingPathComponent(Outbox.stateFile))
        let state = outbox.loadState(in: report.dir)
        XCTAssertEqual(state.reportId, "01JA2Z8Y6Q3K4M5N6P7R8S9T0V")
        XCTAssertEqual(state.attempts, 2)
        XCTAssertEqual(state.uploaded, ["screenshot"])
        XCTAssertFalse(state.resumable)
        XCTAssertEqual(state.chunkBytes, 0)
        XCTAssertEqual(state.offsets, [:])
        XCTAssertEqual(state.restarts, 0)
    }

    func testResumableCreateFixtureDecodes() throws {
        let created = try JSONDecoder().decode(ReportCreated.self, from: Contract.fixture("report.created.resumable.json"))
        XCTAssertEqual(created.upload, ReportCreated.Upload(resumable: true, chunkBytes: 1_048_576))
        XCTAssertEqual(created.attachments?.first { $0.name == "video" }?.receivedBytes, 1_048_576)
        XCTAssertNil(try JSONDecoder().decode(ReportCreated.self, from: Contract.fixture("report.created.json")).upload)
    }

    func testChunkPlan() throws {
        XCTAssertEqual(ChunkPlan.chunkBytes(server: nil, debugCap: nil), 1024 * 1024)
        XCTAssertEqual(ChunkPlan.chunkBytes(server: 10, debugCap: nil), 64 * 1024, "clamped to CHUNK_BYTES_MIN")
        XCTAssertEqual(ChunkPlan.chunkBytes(server: 100 * 1024 * 1024, debugCap: nil), 8 * 1024 * 1024, "and to CHUNK_BYTES_MAX")
        XCTAssertTrue(ChunkPlan.isChunked(resumable: true, size: 70_000, chunkBytes: 65_536))
        XCTAssertFalse(ChunkPlan.isChunked(resumable: true, size: 65_536, chunkBytes: 65_536))
        XCTAssertFalse(ChunkPlan.isChunked(resumable: false, size: 1_000_000, chunkBytes: 65_536))
        XCTAssertEqual(ChunkPlan.nextRange(offset: 0, size: 100, chunkBytes: 40), 0...39)
        XCTAssertEqual(ChunkPlan.nextRange(offset: 80, size: 100, chunkBytes: 40), 80...99)
        XCTAssertNil(ChunkPlan.nextRange(offset: 100, size: 100, chunkBytes: 40))
        XCTAssertNil(ChunkPlan.nextRange(offset: -1, size: 100, chunkBytes: 40))
        XCTAssertEqual(ChunkPlan.contentRange(80...99, total: 100), "bytes 80-99/100")

        let file = tempDir.appendingPathComponent("range.bin")
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        try Data((0..<200).map { UInt8($0) }).write(to: file)
        XCTAssertEqual(try Uploader.read(10...19, of: file), Data((10..<20).map { UInt8($0) }))
        XCTAssertEqual(try Uploader.read(190...209, of: file).count, 10, "a short file reads short")
    }

    func testRetryAfterParsing() {
        let seconds = HTTPResponse(status: 429, data: Data(), headers: ["retry-after": "7"], errorCode: nil, transportError: nil)
        XCTAssertEqual(seconds.retryAfterSeconds, 7)
        let none = HTTPResponse(status: 429, data: Data(), headers: [:], errorCode: nil, transportError: nil)
        XCTAssertNil(none.retryAfterSeconds)
        XCTAssertTrue(APIErrorEnvelope.isRetryable(status: 409, code: "attachments_missing"))
        XCTAssertTrue(APIErrorEnvelope.isRetryable(status: 409, code: "range_mismatch"))
        XCTAssertFalse(APIErrorEnvelope.isRetryable(status: 409, code: "report_completed"))
        XCTAssertTrue(APIErrorEnvelope.isRetryable(status: 0, code: nil))
        XCTAssertFalse(APIErrorEnvelope.isRetryable(status: 413, code: "payload_too_large"))
    }
}
