// Check-in (spec §11.1): every remote-config fetch also tells the server which
// install is asking, so it can list devices on the project's Devices page.
//
// - installId: a random UUID v4 created on first activation and kept in
//   UserDefaults (`snitch.installId`). Not derived from any device identifier; a
//   reinstall gets a new one. Reports carry the same id.
// - The fetch adds installId, appId, sdkVersion, wrapper (when wrapped), model, the
//   release-type signals summary (§3.1) and active=1; servers without the `checkin`
//   feature ignore unknown parameters.
// - The opt-in `CheckInWhenInactive` ping (active=0) is sent by the runtime once per
//   launch when the final release type is `unknown`; its answer is ignored.

import Foundation

enum InstallId {
    /// The stored id, created (and stored) the first time it is needed.
    static func current(defaults: UserDefaults = .standard) -> String {
        if let stored = defaults.string(forKey: DefaultsKey.installId), isValid(stored) {
            return stored
        }
        let id = UUID().uuidString.lowercased()
        defaults.set(id, forKey: DefaultsKey.installId)
        return id
    }

    /// A lowercase UUID string, as the contract's `z.uuid()` and the dashboard expect.
    static func isValid(_ s: String) -> Bool {
        s == s.lowercased() && UUID(uuidString: s) != nil
    }
}

/// The check-in half of a config query (SdkConfigQuery in contract/src/ingest.ts).
struct CheckInFields: Equatable {
    var installId: String
    var appId: String
    var sdkVersion: String
    var wrapper: String?
    var model: String
    var signals: String
    /// false only for the CheckInWhenInactive ping.
    var active: Bool

    var queryItems: [URLQueryItem] {
        var items = [
            URLQueryItem(name: "installId", value: installId),
            URLQueryItem(name: "appId", value: String(appId.prefix(255))),
            URLQueryItem(name: "sdkVersion", value: String(sdkVersion.prefix(32))),
        ]
        if let wrapper = wrapper.nonEmpty {
            items.append(URLQueryItem(name: "wrapper", value: String(wrapper.prefix(32))))
        }
        items.append(URLQueryItem(name: "model", value: String(model.prefix(64))))
        items.append(URLQueryItem(name: "signals", value: String(signals.prefix(300))))
        items.append(URLQueryItem(name: "active", value: active ? "1" : "0"))
        return items
    }
}
