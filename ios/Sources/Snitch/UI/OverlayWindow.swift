// Snitch's own windows (spec §6): the report sheet, the toast, the screenshot
// pill and the tester notice each live in a dedicated, scene-aware UIWindow above
// the app (`.alert + 1`/`+ 2`). Recognizers and capture skip every SnitchWindow.
//
// Passthrough windows let touches that miss their content fall through to the
// app, so a toast or pill never blocks it. Root view controllers defer status
// bar and orientation decisions to the app's own key window.

import SwiftUI
import UIKit

final class SnitchWindow: UIWindow {
    /// When true, touches that land on nothing but the root view go to the windows below.
    var passthrough = false

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let hit = super.hitTest(point, with: event)
        if passthrough, hit === self || hit === rootViewController?.view {
            return nil
        }
        return hit
    }
}

final class OverlayRootViewController: UIViewController {
    private var appRoot: UIViewController? {
        AppWindows.keyWindow()?.rootViewController
    }

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        appRoot?.supportedInterfaceOrientations ?? .all
    }

    override var preferredStatusBarStyle: UIStatusBarStyle {
        appRoot?.preferredStatusBarStyle ?? .default
    }

    override var prefersStatusBarHidden: Bool {
        appRoot?.prefersStatusBarHidden ?? false
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
    }
}

final class OverlayController {
    private var sheetWindow: SnitchWindow?
    private weak var previousKeyWindow: UIWindow?
    private var toastWindow: SnitchWindow?
    private var toastView: ToastView?
    private var toastHide: DispatchWorkItem?
    private var pillWindow: SnitchWindow?
    private var pillHide: DispatchWorkItem?
    private var noticeWindow: SnitchWindow?

    /// Called on main whenever the sheet appears or disappears.
    var onSheetVisibilityChange: ((Bool) -> Void)?

    var isSheetVisible: Bool {
        sheetWindow != nil
    }

    private static func level(_ offset: CGFloat) -> UIWindow.Level {
        UIWindow.Level(rawValue: UIWindow.Level.alert.rawValue + offset)
    }

    private struct Made {
        var window: SnitchWindow
        var root: OverlayRootViewController
    }

    private func makeWindow(levelOffset: CGFloat, passthrough: Bool) -> Made? {
        guard let scene = AppWindows.activeScene() else { return nil }
        let window = SnitchWindow(windowScene: scene)
        window.windowLevel = OverlayController.level(levelOffset)
        window.passthrough = passthrough
        window.backgroundColor = .clear
        let root = OverlayRootViewController()
        window.rootViewController = root
        return Made(window: window, root: root)
    }

    // MARK: - Sheet

    func presentSheet(model: ReportSheetModel) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard sheetWindow == nil, let made = makeWindow(levelOffset: 1, passthrough: false) else { return }
        let window = made.window
        let root = made.root
        hidePill()
        let host = UIHostingController(rootView: ReportSheet(model: model))
        host.view.backgroundColor = .clear
        root.addChild(host)
        host.view.frame = root.view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        root.view.addSubview(host.view)
        host.didMove(toParent: root)
        previousKeyWindow = window.windowScene?.windows.first { $0.isKeyWindow }
        window.makeKeyAndVisible()
        sheetWindow = window
        onSheetVisibilityChange?(true)
    }

    func dismissSheet() {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let window = sheetWindow else { return }
        window.endEditing(true)
        window.isHidden = true
        window.rootViewController = nil
        sheetWindow = nil
        if let previous = previousKeyWindow, !previous.isHidden {
            previous.makeKey()
        }
        previousKeyWindow = nil
        onSheetVisibilityChange?(false)
    }

    // MARK: - Toast

    /// Shows (or updates) the toast; `duration` nil keeps it until the next call.
    func showToast(_ text: String, duration: TimeInterval?) {
        dispatchPrecondition(condition: .onQueue(.main))
        toastHide?.cancel()
        toastHide = nil
        if let view = toastView, toastWindow != nil {
            view.text = text
        } else {
            guard let made = makeWindow(levelOffset: 2, passthrough: true) else { return }
            let window = made.window
            let root = made.root
            window.isUserInteractionEnabled = false
            let view = ToastView(text: text)
            view.translatesAutoresizingMaskIntoConstraints = false
            root.view.addSubview(view)
            NSLayoutConstraint.activate([
                view.topAnchor.constraint(equalTo: root.view.safeAreaLayoutGuide.topAnchor, constant: 8),
                view.centerXAnchor.constraint(equalTo: root.view.centerXAnchor),
                view.leadingAnchor.constraint(greaterThanOrEqualTo: root.view.leadingAnchor, constant: Theme.padding),
                view.trailingAnchor.constraint(lessThanOrEqualTo: root.view.trailingAnchor, constant: -Theme.padding),
            ])
            window.isHidden = false
            toastWindow = window
            toastView = view
            view.animateIn()
        }
        UIAccessibility.post(notification: .announcement, argument: text)
        if let duration = duration {
            let work = DispatchWorkItem { [weak self] in self?.hideToast() }
            toastHide = work
            DispatchQueue.main.asyncAfter(deadline: .now() + duration, execute: work)
        }
    }

    func hideToast() {
        toastHide?.cancel()
        toastHide = nil
        guard let window = toastWindow, let view = toastView else { return }
        toastWindow = nil
        toastView = nil
        view.animateOut {
            window.isHidden = true
            window.rootViewController = nil
        }
    }

    // MARK: - Screenshot pill

    func showPill(onTap: @escaping () -> Void) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard !isSheetVisible else { return }
        hidePill()
        guard let made = makeWindow(levelOffset: 2, passthrough: true) else { return }
        let window = made.window
        let root = made.root
        let pill = ScreenshotPromptPill(title: Strings.screenshotPrompt) { [weak self] in
            self?.hidePill()
            onTap()
        }
        pill.translatesAutoresizingMaskIntoConstraints = false
        root.view.addSubview(pill)
        NSLayoutConstraint.activate([
            pill.topAnchor.constraint(equalTo: root.view.safeAreaLayoutGuide.topAnchor, constant: 8),
            pill.centerXAnchor.constraint(equalTo: root.view.centerXAnchor),
        ])
        window.isHidden = false
        pillWindow = window
        let work = DispatchWorkItem { [weak self] in self?.hidePill() }
        pillHide = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Theme.promptDuration, execute: work)
    }

    func hidePill() {
        pillHide?.cancel()
        pillHide = nil
        pillWindow?.isHidden = true
        pillWindow?.rootViewController = nil
        pillWindow = nil
    }

    // MARK: - Tester notice

    func showNotice(text: String, onDismiss: @escaping () -> Void) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard noticeWindow == nil, let made = makeWindow(levelOffset: 1, passthrough: true) else { return }
        let window = made.window
        let root = made.root
        let card = NoticeCard(text: text, buttonTitle: Strings.gotIt) { [weak self] in
            self?.hideNotice()
            onDismiss()
        }
        card.translatesAutoresizingMaskIntoConstraints = false
        root.view.addSubview(card)
        NSLayoutConstraint.activate([
            card.leadingAnchor.constraint(equalTo: root.view.safeAreaLayoutGuide.leadingAnchor, constant: Theme.padding),
            card.trailingAnchor.constraint(equalTo: root.view.safeAreaLayoutGuide.trailingAnchor, constant: -Theme.padding),
            card.bottomAnchor.constraint(equalTo: root.view.safeAreaLayoutGuide.bottomAnchor, constant: -Theme.padding),
        ])
        window.isHidden = false
        noticeWindow = window
        UIAccessibility.post(notification: .announcement, argument: text)
    }

    func hideNotice() {
        noticeWindow?.isHidden = true
        noticeWindow?.rootViewController = nil
        noticeWindow = nil
    }

    func hideAll() {
        dismissSheet()
        hideToast()
        hidePill()
        hideNotice()
    }
}
