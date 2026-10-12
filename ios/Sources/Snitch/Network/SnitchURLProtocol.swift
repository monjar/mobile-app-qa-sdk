// Network capture for the report timeline (spec §11.5): a forwarding URLProtocol.
//
// It records method, sanitized URL (UrlSanitizer), status, duration, request and
// response byte counts and the error text — never headers or bodies — and
// otherwise stays out of the way:
// - `canInit` is the gate. React Native puts this class into its session
//   configuration at launch, before Snitch may have activated, and an inert SDK
//   (store build) must never touch a request. So it answers true only while
//   Snitch is active with network capture on, for http(s), not for the Snitch
//   server itself, and not for a request it is already forwarding (a marker
//   property set on the forwarded copy).
// - `startLoading` re-issues the request on one shared URLSession of its own
//   (default configuration: the shared cookie storage and URL cache, without this
//   class), and relays the response, each data chunk as it arrives (streaming keeps
//   working), redirects, authentication challenges and errors to its client.
// - URLProtocol requires client callbacks on the thread (and run loop modes) that
//   called `startLoading`; the inner session's delegate queue is not that thread, so
//   every client call is performed on the recorded client thread — the pattern of
//   Apple's CustomHTTPProtocol sample — and none is made after `stopLoading`.
// - Redirects: the inner task stops at the 3xx and the client is told
//   (`wasRedirectedTo`); the loading system asks the app's session delegate, stops
//   this instance and starts a new one for the new request, so each hop is recorded.
// - The relayed response is `.notAllowed` for caching: the inner session already
//   cached it (URLCache.shared) per the request's policy.
//
// Installed by URLProtocol.registerClass on activation (covers URLSession.shared)
// and, for sessions an app creates itself, by Snitch.captureNetwork(in:).

import Foundation
import QuartzCore

/// What canInit decides with; updated by the runtime, read on URLSession threads.
struct NetworkCaptureGate: Equatable {
    var enabled = false
    /// The Snitch server (lowercased host, effective port): its requests are never recorded.
    var serverHost: String?
    var serverPort: Int?
}

final class SnitchURLProtocol: URLProtocol {
    static let gate = Locked(NetworkCaptureGate())
    static let forwardedKey = "io.github.monjar.snitch.forwarded"

    /// Puts this class first in `configuration.protocolClasses` (idempotent).
    static func install(in configuration: URLSessionConfiguration) {
        var classes = configuration.protocolClasses ?? []
        classes.removeAll { ObjectIdentifier($0) == ObjectIdentifier(SnitchURLProtocol.self) }
        classes.insert(SnitchURLProtocol.self, at: 0)
        configuration.protocolClasses = classes
    }

    /// The canInit decision, separated for tests.
    static func shouldHandle(_ request: URLRequest, gate: NetworkCaptureGate) -> Bool {
        guard gate.enabled, let url = request.url, let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else { return false }
        if URLProtocol.property(forKey: forwardedKey, in: request) != nil { return false }
        if let serverHost = gate.serverHost, url.host?.lowercased() == serverHost,
           effectivePort(url) == gate.serverPort {
            return false
        }
        return true
    }

    static func effectivePort(_ url: URL) -> Int? {
        if let port = url.port { return port }
        switch url.scheme?.lowercased() {
        case "http": return 80
        case "https": return 443
        default: return nil
        }
    }

    override class func canInit(with request: URLRequest) -> Bool {
        shouldHandle(request, gate: gate.get())
    }

    /// WebSocket and stream tasks are never forwarded: they aren't request/response loads.
    override class func canInit(with task: URLSessionTask) -> Bool {
        if task is URLSessionWebSocketTask || task is URLSessionStreamTask { return false }
        guard let request = task.currentRequest ?? task.originalRequest else { return false }
        return canInit(with: request)
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    // MARK: - Per-request state (guarded by `lock`: callbacks arrive on the session's
    // delegate queue, startLoading/stopLoading on the client thread)

    private let lock = NSLock()
    private var clientThread: Thread?
    private var runLoopModes: [String] = [RunLoop.Mode.default.rawValue]
    private var innerTask: URLSessionDataTask?
    private var pendingChallenge: ChallengeSender?
    /// The inner request finished, redirected, or the client stopped us.
    private var done = false
    /// `stopLoading` ran: no client calls from here on.
    private var stopped = false
    private var recorded = false
    private var startedWall: Int64 = 0
    private var startedMono: CFTimeInterval = 0
    private var responseBytes = 0

    override func startLoading() {
        var modes = [RunLoop.Mode.default.rawValue]
        if let current = RunLoop.current.currentMode, current != .default {
            modes.append(current.rawValue)
        }
        guard let forwarded = (request as NSURLRequest).mutableCopy() as? NSMutableURLRequest else {
            client?.urlProtocol(self, didFailWithError: URLError(.unknown))
            return
        }
        URLProtocol.setProperty(true, forKey: SnitchURLProtocol.forwardedKey, in: forwarded)
        // A body that reached us as a stream has lost its length; without Content-Length
        // it would go out chunked, which some servers (presigned uploads) refuse.
        if forwarded.httpBody == nil, forwarded.httpBodyStream != nil,
           forwarded.value(forHTTPHeaderField: "Content-Length") == nil,
           let expected = task?.countOfBytesExpectedToSend, expected > 0 {
            forwarded.setValue(String(expected), forHTTPHeaderField: "Content-Length")
        }

        lock.lock()
        clientThread = Thread.current
        runLoopModes = modes
        startedWall = TimelineText.nowMs()
        startedMono = CACurrentMediaTime()
        lock.unlock()

        let inner = ForwardingSession.current.dataTask(with: forwarded as URLRequest, for: self)
        lock.lock()
        let alreadyDone = done
        if !alreadyDone { innerTask = inner }
        lock.unlock()
        if alreadyDone {
            inner.cancel()
        } else {
            inner.resume()
        }
    }

    override func stopLoading() {
        lock.lock()
        let wasDone = done
        done = true
        stopped = true
        let inner = innerTask
        innerTask = nil
        let challenge = pendingChallenge
        pendingChallenge = nil
        lock.unlock()
        challenge?.resolve(.cancelAuthenticationChallenge, nil)
        guard !wasDone else { return }
        // The client went away first (cancelled): no more client calls, just stop and record.
        inner?.cancel()
        record(status: nil, error: URLError(.cancelled), sentBytes: inner?.countOfBytesSent)
    }

    // MARK: - Inner session events (delegate queue)

    fileprivate func innerDidReceive(_ response: URLResponse) {
        guard isLive else { return }
        onClientThread { [self] in
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        }
    }

    fileprivate func innerDidReceive(_ data: Data) {
        lock.lock()
        let live = !done
        if live { responseBytes += data.count }
        lock.unlock()
        guard live else { return }
        onClientThread { [self] in
            client?.urlProtocol(self, didLoad: data)
        }
    }

    fileprivate func innerWillRedirect(_ task: URLSessionTask, response: HTTPURLResponse, to newRequest: URLRequest) {
        lock.lock()
        let live = !done
        done = true
        innerTask = nil
        lock.unlock()
        guard live else { return }
        task.cancel()
        record(status: response.statusCode, error: nil, sentBytes: task.countOfBytesSent)
        // The new request was copied from the forwarded one and carries the marker; without
        // removing it, the protocol instance the loading system starts next would refuse it.
        var next = newRequest
        if let copy = (newRequest as NSURLRequest).mutableCopy() as? NSMutableURLRequest {
            URLProtocol.removeProperty(forKey: SnitchURLProtocol.forwardedKey, in: copy)
            next = copy as URLRequest
        }
        onClientThread { [self] in
            client?.urlProtocol(self, wasRedirectedTo: next, redirectResponse: response)
        }
    }

    fileprivate func innerDidReceive(
        _ challenge: URLAuthenticationChallenge,
        completion: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        let sender = ChallengeSender(completion)
        lock.lock()
        let live = !done
        if live { pendingChallenge = sender }
        lock.unlock()
        guard live else {
            sender.resolve(.cancelAuthenticationChallenge, nil)
            return
        }
        let relayed = URLAuthenticationChallenge(authenticationChallenge: challenge, sender: sender)
        onClientThread { [self] in
            client?.urlProtocol(self, didReceive: relayed)
        }
    }

    fileprivate func innerDidComplete(_ task: URLSessionTask, error: Error?) {
        lock.lock()
        let live = !done
        done = true
        innerTask = nil
        pendingChallenge = nil
        lock.unlock()
        guard live else { return }
        let status = (task.response as? HTTPURLResponse)?.statusCode
        record(status: status, error: error, sentBytes: task.countOfBytesSent)
        onClientThread { [self] in
            if let error = error {
                client?.urlProtocol(self, didFailWithError: error)
            } else {
                client?.urlProtocolDidFinishLoading(self)
            }
        }
    }

    private var isLive: Bool {
        lock.lock()
        defer { lock.unlock() }
        return !done
    }

    // MARK: - Client thread

    private func onClientThread(_ work: @escaping () -> Void) {
        lock.lock()
        let thread = clientThread
        let modes = runLoopModes
        lock.unlock()
        guard let target = thread else { return }
        perform(#selector(runClientWork(_:)), on: target, with: ClientWork(work), waitUntilDone: false, modes: modes)
    }

    /// Runs on the client thread, where stopLoading also runs, so the check can't race it.
    @objc private func runClientWork(_ work: Any) {
        lock.lock()
        let isStopped = stopped
        lock.unlock()
        guard !isStopped, let work = work as? ClientWork else { return }
        work.block()
    }

    // MARK: - Recording

    private func record(status: Int?, error: Error?, sentBytes: Int64?) {
        lock.lock()
        let first = !recorded
        recorded = true
        let wall = startedWall
        let mono = startedMono
        let received = responseBytes
        lock.unlock()
        guard first, let url = request.url else { return }
        var errorText: String?
        if let error = error {
            errorText = (error as? URLError)?.code == .cancelled ? "cancelled" : error.localizedDescription
        }
        TimelineRecorder.shared.network(TimelineNet(
            t: wall,
            method: request.httpMethod ?? "GET",
            url: UrlSanitizer.sanitize(url.absoluteString),
            status: status,
            ms: round1((CACurrentMediaTime() - mono) * 1000),
            reqBytes: sentBytes.map { Int(max(0, $0)) },
            resBytes: received,
            error: errorText
        ))
    }
}

/// A closure carried through `perform(_:on:with:waitUntilDone:modes:)`.
private final class ClientWork: NSObject {
    let block: () -> Void

    init(_ block: @escaping () -> Void) {
        self.block = block
    }
}

/// Answers a relayed challenge: whatever the client decides goes to the inner session's
/// completion handler, exactly once.
final class ChallengeSender: NSObject, URLAuthenticationChallengeSender {
    typealias Handler = (URLSession.AuthChallengeDisposition, URLCredential?) -> Void

    private let completion: Locked<Handler?>

    init(_ completion: @escaping Handler) {
        self.completion = Locked(completion)
    }

    func resolve(_ disposition: URLSession.AuthChallengeDisposition, _ credential: URLCredential?) {
        let handler = completion.mutate { (stored: inout Handler?) -> Handler? in
            let taken = stored
            stored = nil
            return taken
        }
        handler?(disposition, credential)
    }

    func use(_ credential: URLCredential, for challenge: URLAuthenticationChallenge) {
        resolve(.useCredential, credential)
    }

    /// For server trust, "no credential" means the system's own evaluation, not a nil override.
    func continueWithoutCredential(for challenge: URLAuthenticationChallenge) {
        if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust {
            resolve(.performDefaultHandling, nil)
        } else {
            resolve(.useCredential, nil)
        }
    }

    func cancel(_ challenge: URLAuthenticationChallenge) {
        resolve(.cancelAuthenticationChallenge, nil)
    }

    func performDefaultHandling(for challenge: URLAuthenticationChallenge) {
        resolve(.performDefaultHandling, nil)
    }

    func rejectProtectionSpaceAndContinue(with challenge: URLAuthenticationChallenge) {
        resolve(.rejectProtectionSpace, nil)
    }
}

/// The one URLSession forwarded requests run on, and the delegate that routes its
/// task events back to the protocol instance that owns each task.
final class ForwardingSession {
    private static let shared = ForwardingSession(configuration: ForwardingSession.defaultConfiguration())
    private static let replacement = Locked<ForwardingSession?>(nil)

    /// The session in use: the shared one, or a test's replacement.
    static var current: ForwardingSession {
        replacement.get() ?? shared
    }

    /// Tests route forwarded requests to a stub (nil restores the real session).
    static func replace(with session: ForwardingSession?) {
        replacement.set(session)
    }

    /// Default configuration (shared cookies and URL cache) without SnitchURLProtocol.
    static func defaultConfiguration() -> URLSessionConfiguration {
        let config = URLSessionConfiguration.default
        config.protocolClasses = (config.protocolClasses ?? []).filter {
            ObjectIdentifier($0) != ObjectIdentifier(SnitchURLProtocol.self)
        }
        return config
    }

    private let router: ForwardingRouter
    private let session: URLSession

    init(configuration: URLSessionConfiguration) {
        let router = ForwardingRouter()
        self.router = router
        let queue = OperationQueue()
        queue.name = "io.github.monjar.snitch.network"
        queue.maxConcurrentOperationCount = 1
        session = URLSession(configuration: configuration, delegate: router, delegateQueue: queue)
    }

    func dataTask(with request: URLRequest, for owner: SnitchURLProtocol) -> URLSessionDataTask {
        let task = session.dataTask(with: request)
        router.register(owner, for: task)
        return task
    }
}

private final class ForwardingRouter: NSObject, URLSessionDataDelegate {
    private let lock = NSLock()
    private var owners: [Int: SnitchURLProtocol] = [:]

    func register(_ owner: SnitchURLProtocol, for task: URLSessionTask) {
        lock.lock()
        owners[task.taskIdentifier] = owner
        lock.unlock()
    }

    private func owner(of task: URLSessionTask, remove: Bool = false) -> SnitchURLProtocol? {
        lock.lock()
        defer { lock.unlock() }
        return remove ? owners.removeValue(forKey: task.taskIdentifier) : owners[task.taskIdentifier]
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        owner(of: dataTask)?.innerDidReceive(response)
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        owner(of: dataTask)?.innerDidReceive(data)
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        if let owner = owner(of: task) {
            owner.innerWillRedirect(task, response: response, to: request)
            completionHandler(nil)
        } else {
            completionHandler(request)
        }
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard let owner = owner(of: task) else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        owner.innerDidReceive(challenge, completion: completionHandler)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        owner(of: task, remove: true)?.innerDidComplete(task, error: error)
    }
}
