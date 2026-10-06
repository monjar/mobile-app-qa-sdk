// Puts one WindowTouchRecognizer on every app window — those that exist at start
// and every later one (UIWindow.didBecomeVisibleNotification) — skipping Snitch's
// own windows and the system keyboard windows. Also answers "which windows make up
// the screen right now" for capture. Main thread only.

import UIKit

enum AppWindows {
    static func isKeyboardWindow(_ window: UIWindow) -> Bool {
        let name = NSStringFromClass(type(of: window))
        return name.contains("UIRemoteKeyboardWindow") || name.contains("UITextEffectsWindow")
    }

    static func isAppWindow(_ window: UIWindow) -> Bool {
        !(window is SnitchWindow) && !isKeyboardWindow(window)
    }

    static var windowScenes: [UIWindowScene] {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    }

    /// The scene the user is looking at: foreground-active first, then foreground-inactive.
    static func activeScene() -> UIWindowScene? {
        let scenes = windowScenes
        return scenes.first { $0.activationState == .foregroundActive }
            ?? scenes.first { $0.activationState == .foregroundInactive }
            ?? scenes.first
    }

    static func allAppWindows() -> [UIWindow] {
        windowScenes.flatMap { $0.windows }.filter(isAppWindow)
    }

    /// Visible app windows of the active scene, back to front.
    static func visibleWindows(in scene: UIWindowScene? = activeScene()) -> [UIWindow] {
        guard let scene = scene else { return [] }
        var candidates: [(index: Int, window: UIWindow)] = []
        for (index, w) in scene.windows.enumerated()
            where isAppWindow(w) && !w.isHidden && w.alpha >= 0.01 && w.bounds.width > 0 && w.bounds.height > 0 {
            candidates.append((index: index, window: w))
        }
        // Stable sort by window level, keeping the scene's order within a level.
        candidates.sort { a, b in
            let la = a.window.windowLevel.rawValue
            let lb = b.window.windowLevel.rawValue
            return la == lb ? a.index < b.index : la < lb
        }
        return candidates.map { $0.window }
    }

    static func keyWindow(in scene: UIWindowScene? = activeScene()) -> UIWindow? {
        guard let scene = scene else { return nil }
        return scene.windows.first { $0.isKeyWindow && isAppWindow($0) } ?? visibleWindows(in: scene).last
    }
}

final class WindowTracker {
    private var observer: NSObjectProtocol?
    private var recognizers: [ObjectIdentifier: WeakRecognizer] = [:]
    private let makeRecognizer: () -> WindowTouchRecognizer

    private struct WeakRecognizer {
        weak var recognizer: WindowTouchRecognizer?
        weak var window: UIWindow?
    }

    init(makeRecognizer: @escaping () -> WindowTouchRecognizer) {
        self.makeRecognizer = makeRecognizer
    }

    var isRunning: Bool {
        observer != nil
    }

    func start() {
        dispatchPrecondition(condition: .onQueue(.main))
        guard observer == nil else { return }
        observer = NotificationCenter.default.addObserver(
            forName: UIWindow.didBecomeVisibleNotification, object: nil, queue: .main
        ) { [weak self] note in
            guard let window = note.object as? UIWindow else { return }
            self?.attach(to: window)
        }
        for window in AppWindows.allAppWindows() { attach(to: window) }
    }

    func stop() {
        dispatchPrecondition(condition: .onQueue(.main))
        if let o = observer { NotificationCenter.default.removeObserver(o) }
        observer = nil
        for entry in recognizers.values {
            if let r = entry.recognizer { entry.window?.removeGestureRecognizer(r) }
        }
        recognizers = [:]
    }

    /// Every live recognizer (e.g. to push a config change).
    var activeRecognizers: [WindowTouchRecognizer] {
        recognizers.values.compactMap { $0.recognizer }
    }

    private func attach(to window: UIWindow) {
        guard AppWindows.isAppWindow(window) else { return }
        if window.gestureRecognizers?.contains(where: { $0 is WindowTouchRecognizer }) == true { return }
        recognizers = recognizers.filter { $0.value.window != nil }
        let recognizer = makeRecognizer()
        window.addGestureRecognizer(recognizer)
        recognizers[ObjectIdentifier(window)] = WeakRecognizer(recognizer: recognizer, window: window)
    }
}
