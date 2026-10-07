// State the app sets through the public API, possibly before `start()` and from
// any thread: reporter identity, custom metadata, the log provider and the RN
// wrapper name. Lock-protected; read when a report is built.

import Foundation

final class UserContext {
    static let shared = UserContext()

    static let maxCustomKeys = 50

    struct User: Equatable {
        var id: String?
        var email: String?
        var name: String?
    }

    struct Wrapper: Equatable {
        var name: String
        var version: String
    }

    private let lock = NSLock()
    private var _user = User()
    private var _metadata: [String: String] = [:]
    private var _logProvider: (() -> String?)?
    private var _wrapper: Wrapper?

    func setUser(id: String?, email: String?, name: String?) {
        lock.lock()
        _user = User(id: id.nonEmpty, email: email.nonEmpty, name: name.nonEmpty)
        lock.unlock()
    }

    func setMetadata(_ key: String, _ value: String?) {
        let k = String(key.prefix(64))
        guard !k.isEmpty else { return }
        lock.lock()
        defer { lock.unlock() }
        if let v = value {
            if _metadata[k] == nil && _metadata.count >= UserContext.maxCustomKeys {
                SDKLog.once("metadata.cap", "setMetadata: at most \(UserContext.maxCustomKeys) keys are kept; ignoring \(k)")
                return
            }
            _metadata[k] = String(v.prefix(1000))
        } else {
            _metadata.removeValue(forKey: k)
        }
    }

    func setLogProvider(_ provider: (() -> String?)?) {
        lock.lock()
        _logProvider = provider
        lock.unlock()
    }

    func setWrapper(name: String, version: String) {
        lock.lock()
        _wrapper = Wrapper(name: String(name.prefix(32)), version: String(version.prefix(32)))
        lock.unlock()
    }

    var user: User {
        lock.lock()
        defer { lock.unlock() }
        return _user
    }

    var metadata: [String: String] {
        lock.lock()
        defer { lock.unlock() }
        return _metadata
    }

    var logProvider: (() -> String?)? {
        lock.lock()
        defer { lock.unlock() }
        return _logProvider
    }

    var wrapper: Wrapper? {
        lock.lock()
        defer { lock.unlock() }
        return _wrapper
    }
}

extension Optional where Wrapped == String {
    /// nil for nil, empty or whitespace-only strings; trimmed otherwise.
    var nonEmpty: String? {
        guard let s = self?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
        return s
    }
}
