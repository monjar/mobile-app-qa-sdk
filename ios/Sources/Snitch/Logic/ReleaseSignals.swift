// The signals summary every check-in carries (spec §3.1), so a misdetected build
// can be diagnosed from the dashboard and turned into a release-type vector:
//
//   sim=0|1;profile=none|dev|adhoc|enterprise|other|unreadable;devices=<n>;
//   receipt=none|sandboxReceipt|receipt;at=none|pending|sandbox|production|xcode|failed
//
// `profile` follows the classifier's order (get-task-allow → dev, ProvisionsAllDevices
// → enterprise, a device list → adhoc, else other); `at` is the AppTransaction state.

import Foundation

/// Where the StoreKit AppTransaction read stands.
enum AppTransactionState: String {
    /// Not needed (something else decided) or not available (iOS 15). Wire value "none";
    /// not named `none` to stay clear of Optional.none.
    case notNeeded = "none"
    /// Being read or retried.
    case pending
    case sandbox
    case production
    case xcode
    /// Every attempt failed.
    case failed

    /// The state for an answered read ("sandbox" / "production" / "xcode").
    init(environment: String) {
        self = AppTransactionState(rawValue: environment) ?? .failed
    }
}

enum ReleaseSignalsSummary {
    static func ios(_ s: IosReleaseSignals, appTransaction: AppTransactionState) -> String {
        let profile: String
        if let p = s.profile {
            if !p.readable {
                profile = "unreadable"
            } else if p.getTaskAllow {
                profile = "dev"
            } else if p.provisionsAllDevices {
                profile = "enterprise"
            } else if p.provisionedDeviceCount > 0 {
                profile = "adhoc"
            } else {
                profile = "other"
            }
        } else {
            profile = "none"
        }
        let receipt = s.receipt == "sandboxReceipt" || s.receipt == "receipt" ? (s.receipt ?? "none") : "none"
        return [
            "sim=\(s.isSimulator ? 1 : 0)",
            "profile=\(profile)",
            "devices=\(max(0, s.profile?.provisionedDeviceCount ?? 0))",
            "receipt=\(receipt)",
            "at=\(appTransaction.rawValue)",
        ].joined(separator: ";")
    }
}
