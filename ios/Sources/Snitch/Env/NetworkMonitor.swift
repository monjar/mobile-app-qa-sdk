// Network reachability via NWPathMonitor: the `device.network` field of a report,
// and a nudge for the upload queue when the path becomes satisfied.
// Started only once the SDK is active (a store build never creates one).

import Foundation
import Network

final class NetworkMonitor {
    enum Kind: String {
        case wifi, cellular, ethernet, other, unknown
        /// Wire value "none"; not named `none` to stay clear of Optional.none.
        case offline = "none"
    }

    /// A cancelled NWPathMonitor can't be restarted, so each start makes a new one.
    private var monitor: NWPathMonitor?
    private let queue = DispatchQueue(label: "io.github.monjar.snitch.network", qos: .utility)
    private let state = Locked<Kind>(.unknown)

    /// Called on the main thread when the path goes from unsatisfied/unknown to satisfied.
    var onBecameSatisfied: (() -> Void)?

    var current: Kind {
        state.get()
    }

    func start() {
        guard monitor == nil else { return }
        let monitor = NWPathMonitor()
        self.monitor = monitor
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self = self else { return }
            let kind = NetworkMonitor.kind(of: path)
            let previous = self.state.get()
            self.state.set(kind)
            let wasSatisfied = previous != .offline && previous != .unknown
            let isSatisfied = kind != .offline && kind != .unknown
            if isSatisfied && !wasSatisfied {
                DispatchQueue.main.async { self.onBecameSatisfied?() }
            }
        }
        monitor.start(queue: queue)
    }

    func stop() {
        monitor?.cancel()
        monitor = nil
    }

    private static func kind(of path: NWPath) -> Kind {
        guard path.status == .satisfied else { return .offline }
        if path.usesInterfaceType(.wifi) { return .wifi }
        if path.usesInterfaceType(.cellular) { return .cellular }
        if path.usesInterfaceType(.wiredEthernet) { return .ethernet }
        return .other
    }
}
