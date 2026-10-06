// Twin of classifyIos in contract/src/logic/releaseType.ts.
// Vectors: contract/vectors/release-type.json (`ios` section).
//
// Fails closed: anything ambiguous is `unknown`, which no default enables.
// The signals are gathered by Env/ReleaseTypeDetector; this file stays pure.

import Foundation

struct ProvisioningProfileSignals: Equatable {
    var getTaskAllow: Bool
    var provisionsAllDevices: Bool
    var provisionedDeviceCount: Int
}

struct IosReleaseSignals: Equatable {
    var isSimulator: Bool
    /// Parsed embedded.mobileprovision, or nil when the app has none (store-signed).
    var profile: ProvisioningProfileSignals?
    /// Last path component of appStoreReceiptURL if a receipt file exists: "sandboxReceipt" or "receipt".
    var receipt: String?
    /// StoreKit 2 AppTransaction.environment when it could be read: "sandbox", "production" or "xcode".
    var appTransactionEnvironment: String?
}

enum ReleaseTypeClassifier {
    static func classifyIos(_ s: IosReleaseSignals) -> SnitchReleaseType {
        if s.isSimulator { return .debug }
        if let p = s.profile {
            if p.getTaskAllow { return .debug }
            if p.provisionsAllDevices { return .enterprise }
            if p.provisionedDeviceCount > 0 { return .adhoc }
            return .unknown
        }
        if s.receipt == "sandboxReceipt" { return .testflight }
        if s.receipt == "receipt" { return .appstore }
        switch s.appTransactionEnvironment ?? "" {
        case "sandbox":
            return .testflight
        case "production":
            return .appstore
        case "xcode":
            return .debug
        default:
            return .unknown
        }
    }

    /// Whether `classifyIos` could still change its answer once AppTransaction replies.
    static func awaitsAppTransaction(_ s: IosReleaseSignals) -> Bool {
        !s.isSimulator && s.profile == nil && s.receipt != "sandboxReceipt" && s.receipt != "receipt"
            && s.appTransactionEnvironment == nil
    }
}
