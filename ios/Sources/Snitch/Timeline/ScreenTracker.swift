// Screen names for the timeline (spec §11.6) when the app doesn't name its
// screens with Snitch.setScreen: on touch-down and on foreground, the top view
// controller of the key app window — presented → navigation visible → tab
// selected → last child — named by `title`, else `navigationItem.title`, else its
// class name without the module prefix or generic arguments. The recorder keeps a
// name only when it changes, and stops taking inferred names for good once the
// app called setScreen. Main thread only; a hierarchy walk costs microseconds.

import UIKit

enum ScreenNaming {
    /// The view controller the user is looking at, starting from a window's root.
    static func topViewController(from root: UIViewController?) -> UIViewController? {
        var current = root
        var depth = 0
        while let vc = current, depth < 64 {
            depth += 1
            if let presented = vc.presentedViewController, !presented.isBeingDismissed {
                current = presented
            } else if let nav = vc as? UINavigationController, let visible = nav.visibleViewController, visible !== nav {
                current = visible
            } else if let tabs = vc as? UITabBarController, let selected = tabs.selectedViewController {
                current = selected
            } else if let child = vc.children.last {
                current = child
            } else {
                return vc
            }
        }
        return current
    }

    static func name(of vc: UIViewController) -> String {
        if let title = vc.title.nonEmpty { return title }
        if let title = vc.navigationItem.title.nonEmpty { return title }
        return className(String(describing: type(of: vc)))
    }

    /// "MyApp.SettingsViewController" → "SettingsViewController";
    /// "UIHostingController<ModifiedContent<…>>" → "UIHostingController".
    static func className(_ raw: String) -> String {
        var name = raw
        if let generic = name.firstIndex(of: "<") { name = String(name[..<generic]) }
        if let dot = name.lastIndex(of: ".") { name = String(name[name.index(after: dot)...]) }
        return name.isEmpty ? raw : name
    }
}

final class ScreenTracker {
    private let recorder: TimelineRecorder

    init(recorder: TimelineRecorder) {
        self.recorder = recorder
    }

    func infer() {
        dispatchPrecondition(condition: .onQueue(.main))
        guard recorder.acceptsInferredScreens,
              let root = AppWindows.keyWindow()?.rootViewController,
              let top = ScreenNaming.topViewController(from: root) else { return }
        recorder.inferredScreen(ScreenNaming.name(of: top))
    }
}
