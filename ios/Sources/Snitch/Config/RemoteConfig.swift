// Remote configuration fetch and cache (spec §2.2).
//
// GET {ServerURL}/api/v1/sdk/config with If-None-Match when an ETag is cached.
// The cache (config + ETag + fetchedAt) lives in UserDefaults under
// `snitch.remoteConfig`. A 304 refreshes fetchedAt; any failure keeps the cache.
// Main-thread confined except for the network round trip.

import Foundation

struct RemoteConfigQuery: Equatable {
    var releaseType: String
    var appVersion: String
    var build: String
    var os: String
    var health: String

    var queryItems: [URLQueryItem] {
        [
            URLQueryItem(name: "platform", value: "ios"),
            URLQueryItem(name: "releaseType", value: releaseType),
            URLQueryItem(name: "appVersion", value: String(appVersion.prefix(64))),
            URLQueryItem(name: "build", value: String(build.prefix(64))),
            URLQueryItem(name: "os", value: String(os.prefix(32))),
            URLQueryItem(name: "health", value: health),
        ]
    }
}

final class RemoteConfigStore {
    struct Cached: Codable, Equatable {
        var config: SdkConfig
        var etag: String?
        var fetchedAt: Date
    }

    private let defaults: UserDefaults
    private(set) var cached: Cached?
    private var inFlight = false

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let data = defaults.data(forKey: DefaultsKey.remoteConfig) {
            cached = try? JSONDecoder().decode(Cached.self, from: data)
        }
    }

    var config: SdkConfig? {
        cached?.config
    }

    func isStale(now: Date = Date()) -> Bool {
        guard let c = cached else { return true }
        return now.timeIntervalSince(c.fetchedAt) >= Double(max(60, c.config.ttlSeconds))
    }

    /// Fetches once (concurrent calls coalesce). `completion(changed)` runs on the main thread;
    /// `changed` is true when a new config was stored. `succeeded` is true for 200 and 304.
    func fetch(client: APIClient, query: RemoteConfigQuery, completion: @escaping (_ changed: Bool, _ succeeded: Bool) -> Void) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard !inFlight else { return }
        var headers: [String: String] = [:]
        if let etag = cached?.etag { headers["If-None-Match"] = etag }
        guard let request = client.makeRequest(method: "GET", path: "/api/v1/sdk/config", query: query.queryItems, headers: headers) else {
            completion(false, false)
            return
        }
        inFlight = true
        client.send(request) { [weak self] response in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.inFlight = false
                let outcome = self.apply(response, now: Date())
                completion(outcome.changed, outcome.succeeded)
            }
        }
    }

    /// Applies a response to the cache. Separate from `fetch` so tests can drive it directly.
    func apply(_ response: HTTPResponse, now: Date) -> (changed: Bool, succeeded: Bool) {
        switch response.status {
        case 200:
            guard let config = try? JSONDecoder().decode(SdkConfig.self, from: response.data) else {
                SDKLog.once("remoteConfig.decode", "Remote config could not be decoded; keeping the cached copy")
                return (false, false)
            }
            let changed = config != cached?.config
            cached = Cached(config: config, etag: response.header("etag"), fetchedAt: now)
            persist()
            return (changed, true)
        case 304:
            if var c = cached {
                c.fetchedAt = now
                cached = c
                persist()
            }
            return (false, true)
        default:
            if response.status == 401 || response.status == 403 {
                SDKLog.once("remoteConfig.\(response.status)", "Remote config refused (\(response.status) \(response.errorCode ?? "")); check IngestKey")
            }
            return (false, false)
        }
    }

    private func persist() {
        guard let c = cached, let data = try? JSONEncoder().encode(c) else { return }
        defaults.set(data, forKey: DefaultsKey.remoteConfig)
    }
}
