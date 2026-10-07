// A UIKit background task that ends exactly once — on `end()` or on expiry,
// whichever comes first. Main thread only.

import UIKit

final class BackgroundTask {
    private var identifier: UIBackgroundTaskIdentifier = .invalid

    static func begin(_ name: String) -> BackgroundTask {
        let task = BackgroundTask()
        // Strong capture: the expiry handler must be able to end the task even if the owner let go.
        task.identifier = UIApplication.shared.beginBackgroundTask(withName: name) {
            task.end()
        }
        return task
    }

    func end() {
        guard identifier != .invalid else { return }
        let id = identifier
        identifier = .invalid
        UIApplication.shared.endBackgroundTask(id)
    }
}
