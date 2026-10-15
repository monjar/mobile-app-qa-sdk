// Network capture (spec §11.5): SnitchURLProtocol's canInit gate, and real
// forwarding through URLSession — an outer session with SnitchURLProtocol in front,
// whose forwarded requests reach StubURLProtocol through a replacement forwarding
// session — checking the relayed response, streamed data, redirects, errors and
// what lands in the timeline (sanitized URL, status, bytes; never the query values).

import XCTest
@testable import Snitch

final class NetworkCaptureTests: XCTestCase {
    private let serverGate = NetworkCaptureGate(enabled: true, serverHost: "snitch.example.com", serverPort: 443)
    private var outer: URLSession!

    override func setUp() {
        super.setUp()
        SnitchURLProtocol.gate.set(serverGate)
        let inner = URLSessionConfiguration.ephemeral
        inner.protocolClasses = [StubURLProtocol.self]
        ForwardingSession.replace(with: ForwardingSession(configuration: inner))
        TimelineRecorder.shared.reset()
        TimelineRecorder.shared.configure(TimelineRecorder.Switches(on: true, console: true, network: true, screens: true))

        let config = URLSessionConfiguration.ephemeral
        Snitch.captureNetwork(in: config)
        outer = URLSession(configuration: config)
    }

    override func tearDown() {
        outer.invalidateAndCancel()
        SnitchURLProtocol.gate.set(NetworkCaptureGate())
        ForwardingSession.replace(with: nil)
        TimelineRecorder.shared.reset()
        super.tearDown()
    }

    // MARK: - Helpers

    private func request(_ url: String, method: String = "GET") throws -> URLRequest {
        var r = URLRequest(url: try XCTUnwrap(URL(string: url)))
        r.httpMethod = method
        return r
    }

    private func load(_ request: URLRequest) -> (data: Data?, response: HTTPURLResponse?, error: Error?) {
        let done = expectation(description: "load")
        var result: (Data?, HTTPURLResponse?, Error?) = (nil, nil, nil)
        outer.dataTask(with: request) { data, response, error in
            result = (data, response as? HTTPURLResponse, error)
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 15)
        return result
    }

    private var networkEvents: [TimelineNet] {
        TimelineRecorder.shared.freeze().events.compactMap { event in
            if case let .net(net) = event { return net }
            return nil
        }
    }

    // MARK: - The gate

    func testCanInitOnlyWhileActiveForHttpAndNotTheSnitchServer() throws {
        let api = try request("https://api.example.com/v1/items")
        XCTAssertTrue(SnitchURLProtocol.shouldHandle(api, gate: serverGate))
        XCTAssertTrue(SnitchURLProtocol.shouldHandle(try request("http://localhost:8080/health"), gate: serverGate))

        var off = serverGate
        off.enabled = false
        XCTAssertFalse(SnitchURLProtocol.shouldHandle(api, gate: off), "an inert SDK never touches a request")
        XCTAssertFalse(SnitchURLProtocol.shouldHandle(api, gate: NetworkCaptureGate()))

        XCTAssertFalse(SnitchURLProtocol.shouldHandle(try request("https://SNITCH.example.com/api/v1/reports"), gate: serverGate))
        XCTAssertFalse(SnitchURLProtocol.shouldHandle(try request("https://snitch.example.com:443/x"), gate: serverGate))
        XCTAssertTrue(SnitchURLProtocol.shouldHandle(try request("https://snitch.example.com:8443/x"), gate: serverGate),
                      "same host, another port is not the Snitch server")
        XCTAssertFalse(SnitchURLProtocol.shouldHandle(try request("ftp://files.example.com/a"), gate: serverGate))
        XCTAssertFalse(SnitchURLProtocol.shouldHandle(try request("file:///tmp/a.json"), gate: serverGate))

        let marked = try XCTUnwrap((api as NSURLRequest).mutableCopy() as? NSMutableURLRequest)
        URLProtocol.setProperty(true, forKey: SnitchURLProtocol.forwardedKey, in: marked)
        XCTAssertFalse(SnitchURLProtocol.shouldHandle(marked as URLRequest, gate: serverGate), "never forwards its own requests")

        XCTAssertTrue(SnitchURLProtocol.canInit(with: api))
        SnitchURLProtocol.gate.set(NetworkCaptureGate())
        XCTAssertFalse(SnitchURLProtocol.canInit(with: api))
    }

    func testInstallPutsTheProtocolFirstOnce() {
        let config = URLSessionConfiguration.ephemeral
        Snitch.captureNetwork(in: config)
        Snitch.captureNetwork(in: config)
        let classes = config.protocolClasses ?? []
        XCTAssertTrue(classes.first.map { ObjectIdentifier($0) == ObjectIdentifier(SnitchURLProtocol.self) } ?? false)
        XCTAssertEqual(classes.filter { ObjectIdentifier($0) == ObjectIdentifier(SnitchURLProtocol.self) }.count, 1)
        XCTAssertTrue(SnitchBridge.networkProtocolClass() == SnitchURLProtocol.self)

        let inner = ForwardingSession.defaultConfiguration().protocolClasses ?? []
        XCTAssertFalse(inner.contains { ObjectIdentifier($0) == ObjectIdentifier(SnitchURLProtocol.self) })
    }

    // MARK: - Forwarding

    func testForwardsAndRecordsWithoutQueryValues() throws {
        StubURLProtocol.setHandler { _ in
            StubURLProtocol.Response(status: 200, headers: ["Content-Type": "text/plain"], body: Data("hello world".utf8), split: true)
        }
        let result = load(try request("https://api.example.com/v1/items?token=secret&page=2"))
        XCTAssertNil(result.error)
        XCTAssertEqual(result.response?.statusCode, 200)
        XCTAssertEqual(result.data.map { String(decoding: $0, as: UTF8.self) }, "hello world", "streamed chunks arrive whole")

        let forwarded = try XCTUnwrap(StubURLProtocol.requests.first)
        XCTAssertNotNil(URLProtocol.property(forKey: SnitchURLProtocol.forwardedKey, in: forwarded), "the inner request is marked")
        XCTAssertEqual(StubURLProtocol.requests.count, 1)

        let net = try XCTUnwrap(networkEvents.first)
        XCTAssertEqual(networkEvents.count, 1)
        XCTAssertEqual(net.method, "GET")
        XCTAssertEqual(net.url, "https://api.example.com/v1/items?token=*&page=*")
        XCTAssertEqual(net.status, 200)
        XCTAssertEqual(net.resBytes, 11)
        XCTAssertNil(net.error)
        XCTAssertGreaterThanOrEqual(net.ms ?? -1, 0)
        XCTAssertGreaterThan(net.t, 1_700_000_000_000, "wall-clock epoch ms")
    }

    func testFailuresAreRelayedAndRecorded() throws {
        StubURLProtocol.setHandler { _ in StubURLProtocol.Response(status: 0) }
        let result = load(try request("https://api.example.com/v1/facts", method: "POST"))
        XCTAssertEqual((result.error as? URLError)?.code, .notConnectedToInternet)

        let net = try XCTUnwrap(networkEvents.first)
        XCTAssertEqual(net.method, "POST")
        XCTAssertNil(net.status)
        XCTAssertNotNil(net.error)
    }

    func testRedirectsAreFollowedHopByHop() throws {
        StubURLProtocol.setHandler { req in
            if req.url?.path == "/start" {
                return StubURLProtocol.Response(status: 302, headers: ["Location": "https://api.example.com/final?x=1"])
            }
            return StubURLProtocol.Response(status: 200, body: Data("done".utf8))
        }
        let result = load(try request("https://api.example.com/start"))
        XCTAssertNil(result.error)
        XCTAssertEqual(result.response?.statusCode, 200)
        XCTAssertEqual(result.response?.url?.path, "/final")
        XCTAssertEqual(result.data.map { String(decoding: $0, as: UTF8.self) }, "done")

        XCTAssertEqual(StubURLProtocol.log, ["GET /start", "GET /final"])
        XCTAssertEqual(networkEvents.map { $0.url }, ["https://api.example.com/start", "https://api.example.com/final?x=*"])
        XCTAssertEqual(networkEvents.map { $0.status }, [302, 200])
    }

    func testARequestStillRunningAtFreezeIsInFlightUntilItEnds() throws {
        StubURLProtocol.setHandler { _ in StubURLProtocol.Response(status: -1) }
        let task = outer.dataTask(with: try request("https://api.example.com/v1/slow?id=7", method: "POST"))
        task.resume()
        let reached = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in !StubURLProtocol.requests.isEmpty }, object: nil)
        wait(for: [reached], timeout: 15)

        let running = try XCTUnwrap(networkEvents.first)
        XCTAssertEqual(networkEvents.count, 1)
        XCTAssertEqual(running.method, "POST")
        XCTAssertEqual(running.url, "https://api.example.com/v1/slow?id=*")
        XCTAssertNil(running.status)
        XCTAssertEqual(running.error, TimelineNet.inFlightError)
        XCTAssertGreaterThanOrEqual(running.ms ?? -1, 0)

        task.cancel()
        let ended = XCTNSPredicateExpectation(
            predicate: NSPredicate { [unowned self] _, _ in self.networkEvents.first?.error == "cancelled" },
            object: nil
        )
        wait(for: [ended], timeout: 15)
        XCTAssertEqual(networkEvents.count, 1, "recorded once, no longer in flight")
    }

    func testNothingIsRecordedWhileNetworkCaptureIsOff() throws {
        StubURLProtocol.setHandler { _ in StubURLProtocol.Response(status: 204) }
        TimelineRecorder.shared.configure(TimelineRecorder.Switches(on: true, console: true, network: false, screens: true))
        // A request that was let through (the gate is still open here) finishes unrecorded.
        let result = load(try request("https://api.example.com/ping"))
        XCTAssertEqual(result.response?.statusCode, 204)
        XCTAssertTrue(networkEvents.isEmpty)
    }
}
