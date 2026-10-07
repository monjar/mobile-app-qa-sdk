// HTTP to the Snitch server: URLSession with an ephemeral configuration (no
// cookies, no cache, nothing on disk), 30 s request timeout, 120 s for uploads.
// Every request carries X-Snitch-Key, X-Snitch-SDK and a Snitch User-Agent.
//
// `sendSync` exists for the uploader, which runs one report at a time on its own
// serial queue and reads far better as straight-line code; never call it on main.

import Foundation

struct HTTPResponse {
    /// 0 for a transport error (offline, timeout, TLS…).
    var status: Int
    var data: Data
    /// Header names lowercased.
    var headers: [String: String]
    /// `error.code` from the server's ApiError envelope, if any.
    var errorCode: String?
    var transportError: Error?

    func header(_ name: String) -> String? {
        headers[name.lowercased()]
    }

    var isSuccess: Bool {
        (200..<300).contains(status)
    }

    /// Seconds from Retry-After (delta-seconds or HTTP-date), if present and sane.
    var retryAfterSeconds: Double? {
        guard let raw = header("retry-after")?.trimmingCharacters(in: .whitespaces), !raw.isEmpty else { return nil }
        if let s = Double(raw) { return s >= 0 ? s : nil }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "GMT")
        f.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        guard let date = f.date(from: raw) else { return nil }
        return max(0, date.timeIntervalSinceNow)
    }
}

final class APIClient {
    static let requestTimeout: TimeInterval = 30
    static let uploadTimeout: TimeInterval = 120

    let baseURL: URL
    let ingestKey: String
    private let session: URLSession
    private let sdkHeader: () -> String

    init(baseURL: URL, ingestKey: String, configuration: URLSessionConfiguration? = nil, sdkHeader: @escaping () -> String) {
        self.baseURL = baseURL
        self.ingestKey = ingestKey
        self.sdkHeader = sdkHeader
        let config = configuration ?? URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = APIClient.requestTimeout
        config.timeoutIntervalForResource = 600
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.urlCache = nil
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.waitsForConnectivity = false
        session = URLSession(configuration: config)
    }

    deinit {
        session.finishTasksAndInvalidate()
    }

    /// `X-Snitch-SDK` value: `ios/0.1.0`, or `rn-ios/0.1.0` under the React Native wrapper.
    static func sdkHeaderValue(wrapper: String?) -> String {
        let prefix = wrapper == "react-native" ? "rn-ios" : "ios"
        return "\(prefix)/\(SnitchVersion.current)"
    }

    func makeRequest(
        method: String,
        path: String,
        query: [URLQueryItem] = [],
        headers: [String: String] = [:],
        body: Data? = nil,
        timeout: TimeInterval = APIClient.requestTimeout
    ) -> URLRequest? {
        guard var comps = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else { return nil }
        let basePath = comps.path.hasSuffix("/") ? String(comps.path.dropLast()) : comps.path
        comps.path = basePath + path
        if !query.isEmpty { comps.queryItems = query }
        guard let url = comps.url else { return nil }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        req.httpMethod = method
        req.setValue(ingestKey, forHTTPHeaderField: "X-Snitch-Key")
        req.setValue(sdkHeader(), forHTTPHeaderField: "X-Snitch-SDK")
        req.setValue("Snitch/\(SnitchVersion.current) (ios)", forHTTPHeaderField: "User-Agent")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        if let body = body { req.httpBody = body }
        return req
    }

    /// Sends `request`; with `file`, uploads that file as the body.
    func send(_ request: URLRequest, file: URL? = nil, completion: @escaping (HTTPResponse) -> Void) {
        let handler: (Data?, URLResponse?, Error?) -> Void = { data, response, error in
            completion(APIClient.makeResponse(data: data, response: response, error: error))
        }
        let task: URLSessionTask
        if let file = file {
            task = session.uploadTask(with: request, fromFile: file, completionHandler: handler)
        } else {
            task = session.dataTask(with: request, completionHandler: handler)
        }
        task.resume()
    }

    /// Blocking variant for the uploader's serial background queue.
    func sendSync(_ request: URLRequest, file: URL? = nil) -> HTTPResponse {
        precondition(!Thread.isMainThread, "sendSync must not block the main thread")
        let semaphore = DispatchSemaphore(value: 0)
        let box = Locked(HTTPResponse(status: 0, data: Data(), headers: [:], errorCode: nil, transportError: nil))
        send(request, file: file) { response in
            box.set(response)
            semaphore.signal()
        }
        semaphore.wait()
        return box.get()
    }

    static func makeResponse(data: Data?, response: URLResponse?, error: Error?) -> HTTPResponse {
        guard let http = response as? HTTPURLResponse, error == nil else {
            return HTTPResponse(status: 0, data: data ?? Data(), headers: [:], errorCode: nil, transportError: error)
        }
        var headers: [String: String] = [:]
        for (k, v) in http.allHeaderFields {
            if let key = k as? String { headers[key.lowercased()] = "\(v)" }
        }
        let body = data ?? Data()
        return HTTPResponse(
            status: http.statusCode,
            data: body,
            headers: headers,
            errorCode: http.statusCode >= 400 ? APIErrorEnvelope.code(from: body) : nil,
            transportError: nil
        )
    }
}

/// `{ "error": { "code", "message", "details"? } }`
enum APIErrorEnvelope {
    private struct Envelope: Decodable {
        struct Inner: Decodable {
            var code: String
            var details: Details?

            private enum CodingKeys: String, CodingKey {
                case code, details
            }

            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                code = try c.decode(String.self, forKey: .code)
                // `details` is free-form; only the attachments_missing shape matters here.
                details = try? c.decodeIfPresent(Details.self, forKey: .details)
            }
        }

        struct Details: Decodable {
            var missing: [String]?
        }

        var error: Inner
    }

    static func code(from data: Data) -> String? {
        (try? JSONDecoder().decode(Envelope.self, from: data))?.error.code
    }

    /// `details.missing` of an `attachments_missing` error.
    static func missingAttachments(from data: Data) -> [String]? {
        (try? JSONDecoder().decode(Envelope.self, from: data))?.error.details?.missing
    }

    /// Mirror of `isRetryable` in contract/src/ingest.ts.
    static func isRetryable(status: Int, code: String?) -> Bool {
        if status == 429 || status >= 500 || status == 0 { return true }
        if code == "attachments_missing" { return true }
        return false
    }
}
