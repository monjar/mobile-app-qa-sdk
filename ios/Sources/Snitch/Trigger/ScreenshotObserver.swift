// "Report this screen?" after a system screenshot (spec §4.3). The system
// screenshot itself isn't readable, so tapping the pill takes a fresh one.

import UIKit

final class ScreenshotObserver {
    private var observer: NSObjectProtocol?

    /// Called on the main thread for every system screenshot while running.
    var onScreenshot: (() -> Void)?

    func start() {
        guard observer == nil else { return }
        observer = NotificationCenter.default.addObserver(
            forName: UIApplication.userDidTakeScreenshotNotification, object: nil, queue: .main
        ) { [weak self] _ in
            self?.onScreenshot?()
        }
    }

    func stop() {
        if let o = observer { NotificationCenter.default.removeObserver(o) }
        observer = nil
    }
}
