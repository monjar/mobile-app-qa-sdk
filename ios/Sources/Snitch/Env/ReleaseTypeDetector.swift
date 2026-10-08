// Gathers the iOS release-type signals (spec §3) and hands them to the pure
// ReleaseTypeClassifier.
//
// - simulator: compile-time
// - embedded.mobileprovision: CMS-signed; we only need the XML plist inside it,
//   so we cut out the `<?xml … </plist>` byte range instead of verifying the CMS
// - App Store receipt file name (sandboxReceipt / receipt), read via KVC because
//   `appStoreReceiptURL` is deprecated
// - StoreKit 2 AppTransaction (iOS 16+), only when nothing else decided; until it
//   answers the type is `unknown` and the SDK stays inert
//
// TestFlight installs usually have NO receipt file (Apple only installs one for
// production App Store downloads, or after a sandbox purchase), so on TestFlight
// AppTransaction is the deciding signal. It can take several seconds on a cold
// launch and throws while offline. It used to get one try with a 3 s timeout and
// a late answer was dropped, which left TestFlight builds silently inert. Now a
// late answer is used whenever it arrives, and a failed read is retried
// (AppTransactionRetry). The answer is deliberately not cached across launches:
// the same build number can later be installed from the App Store, and a stale
// "sandbox" must never switch Snitch on there.

import Foundation
import StoreKit

enum ProvisioningProfileParser {
    /// Parses the plist embedded in a provisioning profile. A profile that exists but can't
    /// be parsed yields all-false signals, which classify as `unknown` (fail closed).
    static func parse(_ data: Data) -> ProvisioningProfileSignals {
        let unreadable = ProvisioningProfileSignals(getTaskAllow: false, provisionsAllDevices: false, provisionedDeviceCount: 0)
        guard let start = data.range(of: Data("<?xml".utf8)),
              let end = data.range(of: Data("</plist>".utf8), options: [], in: start.lowerBound..<data.endIndex)
        else { return unreadable }
        let plistData = data.subdata(in: start.lowerBound..<end.upperBound)
        guard let plist = (try? PropertyListSerialization.propertyList(from: plistData, options: [], format: nil)) as? [String: Any]
        else { return unreadable }
        let entitlements = plist["Entitlements"] as? [String: Any]
        return ProvisioningProfileSignals(
            getTaskAllow: (entitlements?["get-task-allow"] as? Bool) ?? false,
            provisionsAllDevices: (plist["ProvisionsAllDevices"] as? Bool) ?? false,
            provisionedDeviceCount: (plist["ProvisionedDevices"] as? [Any])?.count ?? 0
        )
    }
}

enum ReleaseTypeDetector {
    static func collectSignals(bundle: Bundle = .main) -> IosReleaseSignals {
        #if targetEnvironment(simulator)
        let isSimulator = true
        #else
        let isSimulator = false
        #endif

        var profile: ProvisioningProfileSignals?
        if let path = bundle.path(forResource: "embedded", ofType: "mobileprovision") {
            if let data = FileManager.default.contents(atPath: path) {
                profile = ProvisioningProfileParser.parse(data)
            } else {
                profile = ProvisioningProfileParser.parse(Data())
            }
        }

        var receipt: String?
        // KVC raises on unknown keys, so check the selector first in case a future SDK drops it.
        if bundle.responds(to: NSSelectorFromString("appStoreReceiptURL")),
           let url = bundle.value(forKey: "appStoreReceiptURL") as? URL,
           FileManager.default.fileExists(atPath: url.path) {
            let name = url.lastPathComponent
            if name == "sandboxReceipt" || name == "receipt" { receipt = name }
        }

        return IosReleaseSignals(isSimulator: isSimulator, profile: profile, receipt: receipt, appTransactionEnvironment: nil)
    }

    /// Detects the release type. `completion` is called on the main thread once with the
    /// synchronous answer, and possibly a second time when AppTransaction refines `unknown`
    /// (however long that takes; see AppTransactionRetry).
    static func detect(bundle: Bundle = .main, completion: @escaping (SnitchReleaseType) -> Void) {
        let signals = collectSignals(bundle: bundle)
        let first = ReleaseTypeClassifier.classifyIos(signals)
        completion(first)
        guard ReleaseTypeClassifier.awaitsAppTransaction(signals) else { return }
        if #available(iOS 16.0, *) {
            let started = Date()
            AppTransactionRetry.run(
                read: { done in readAppTransactionEnvironment(completion: done) },
                schedule: { delay, work in DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work) }
            ) { env in
                guard let env = env else {
                    SDKLog.warn("Snitch is inactive: no provisioning profile or receipt, and StoreKit's AppTransaction could not be read after \(AppTransactionRetry.defaultDelays.count) attempts")
                    return
                }
                var refined = signals
                refined.appTransactionEnvironment = env
                let type = ReleaseTypeClassifier.classifyIos(refined)
                let seconds = String(format: "%.1f", Date().timeIntervalSince(started))
                SDKLog.info("Release type \(type.rawValue) from AppTransaction (\(env)) after \(seconds) s")
                if type != first { completion(type) }
            }
        }
    }

    /// Calls `completion` on the main thread with "sandbox" / "production" / "xcode", or nil
    /// when AppTransaction could not be read. No timeout: a slow answer is still an answer.
    @available(iOS 16.0, *)
    private static func readAppTransactionEnvironment(completion: @escaping (String?) -> Void) {
        Task.detached(priority: .utility) {
            var env: String?
            do {
                let result = try await AppTransaction.shared
                let transaction: AppTransaction
                switch result {
                case let .verified(t):
                    transaction = t
                case let .unverified(t, _):
                    // The environment of an unverified transaction is still informative for gating a QA tool.
                    transaction = t
                }
                if transaction.environment == .sandbox {
                    env = "sandbox"
                } else if transaction.environment == .production {
                    env = "production"
                } else if transaction.environment == .xcode {
                    env = "xcode"
                }
            } catch {
                env = nil
            }
            DispatchQueue.main.async { completion(env) }
        }
    }
}

/// Reads AppTransaction's environment until it answers: one read now, then a retry after
/// each delay in `delays` while reads fail (nil). Calls `completion` exactly once, with the
/// first answer, or nil when every attempt failed. Pure apart from the injected reader and
/// scheduler, so it is unit-tested without StoreKit.
enum AppTransactionRetry {
    /// Waits before each attempt: the first read is immediate, then about 5 s, 15 s and 45 s.
    static let defaultDelays: [TimeInterval] = [0, 5, 15, 45]

    static func run(
        delays: [TimeInterval] = defaultDelays,
        read: @escaping (@escaping (String?) -> Void) -> Void,
        schedule: @escaping (TimeInterval, @escaping () -> Void) -> Void,
        completion: @escaping (String?) -> Void
    ) {
        func attempt(_ i: Int) {
            guard i < delays.count else {
                completion(nil)
                return
            }
            schedule(delays[i]) {
                read { env in
                    if let env = env { completion(env) } else { attempt(i + 1) }
                }
            }
        }
        attempt(0)
    }
}
