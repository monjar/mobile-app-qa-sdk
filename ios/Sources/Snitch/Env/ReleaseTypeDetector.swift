// Gathers the iOS release-type signals (spec §3) and hands them to the pure
// ReleaseTypeClassifier.
//
// - simulator: compile-time
// - embedded.mobileprovision: CMS-signed; we only need the XML plist inside it,
//   so we cut out the `<?xml … </plist>` byte range instead of verifying the CMS
// - App Store receipt file name (sandboxReceipt / receipt), read via KVC because
//   `appStoreReceiptURL` is deprecated
// - StoreKit 2 AppTransaction (iOS 16+), only when nothing else decided, with a
//   3 s timeout; until it answers the type is `unknown` and the SDK stays inert

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
    /// synchronous answer, and possibly a second time when AppTransaction refines `unknown`.
    static func detect(bundle: Bundle = .main, completion: @escaping (SnitchReleaseType) -> Void) {
        let signals = collectSignals(bundle: bundle)
        let first = ReleaseTypeClassifier.classifyIos(signals)
        completion(first)
        guard ReleaseTypeClassifier.awaitsAppTransaction(signals) else { return }
        if #available(iOS 16.0, *) {
            readAppTransactionEnvironment(timeout: 3) { env in
                guard let env = env else { return }
                var refined = signals
                refined.appTransactionEnvironment = env
                let type = ReleaseTypeClassifier.classifyIos(refined)
                if type != first { completion(type) }
            }
        }
    }

    /// Calls `completion` on the main thread with "sandbox" / "production" / "xcode", or nil
    /// on error or after `timeout` seconds (a late answer is ignored).
    @available(iOS 16.0, *)
    private static func readAppTransactionEnvironment(timeout: TimeInterval, completion: @escaping (String?) -> Void) {
        let done = Locked(false)
        let finish: (String?) -> Void = { value in
            DispatchQueue.main.async {
                let first = done.mutate { (d: inout Bool) -> Bool in
                    if d { return false }
                    d = true
                    return true
                }
                if first { completion(value) }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { finish(nil) }
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
            finish(env)
        }
    }
}
