// The edge handle (Gesture.edgeHandle): a faded tab on the screen edge that a
// tester pulls to open the report sheet. A visible trigger needs no explaining,
// and pulling (not tapping) means a stray touch near the edge does nothing.
//
// It lives in its own passthrough SnitchWindow (OverlayController.showEdgeHandle),
// so it stays above the app's screens and modals, never blocks touches outside
// its narrow strip, and is skipped by screenshots and video like all Snitch UI.

import UIKit

final class EdgeHandleView: UIView {
    static let hitSize = CGSize(width: 22, height: 88)
    private static let tabSize = CGSize(width: 5, height: 56)
    private static let restingAlpha: CGFloat = 0.35

    private let side: EdgeHandleSide
    private let onPull: () -> Void
    private let tab = UIView()

    init(side: EdgeHandleSide, color: UIColor, onPull: @escaping () -> Void) {
        self.side = side
        self.onPull = onPull
        super.init(frame: CGRect(origin: .zero, size: EdgeHandleView.hitSize))
        backgroundColor = .clear

        tab.backgroundColor = color
        tab.alpha = EdgeHandleView.restingAlpha
        tab.layer.cornerRadius = EdgeHandleView.tabSize.width / 2
        tab.layer.cornerCurve = .continuous
        tab.isUserInteractionEnabled = false
        addSubview(tab)

        isAccessibilityElement = true
        accessibilityLabel = Strings.edgeHandleLabel
        accessibilityHint = Strings.edgeHandleHint
        accessibilityTraits = .button

        let pan = UIPanGestureRecognizer(target: self, action: #selector(panned(_:)))
        pan.delegate = self
        addGestureRecognizer(pan)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override var intrinsicContentSize: CGSize {
        EdgeHandleView.hitSize
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        layoutTab(pull: 0)
    }

    /// The tab hugs its edge, offset towards the centre by `pull`.
    private func layoutTab(pull: Double) {
        let size = EdgeHandleView.tabSize
        let x = side == .right ? bounds.width - size.width - 2 : 2
        let offset = CGFloat(EdgeHandleGeometry.offset(pull: pull, side: side))
        tab.frame = CGRect(x: x + offset, y: (bounds.height - size.height) / 2, width: size.width, height: size.height)
        let progress = CGFloat(EdgeHandleGeometry.progress(pull: pull))
        tab.alpha = EdgeHandleView.restingAlpha + (1 - EdgeHandleView.restingAlpha) * progress
    }

    @objc private func panned(_ pan: UIPanGestureRecognizer) {
        let dx = Double(pan.translation(in: self).x)
        switch pan.state {
        case .changed:
            layoutTab(pull: EdgeHandleGeometry.pull(translationX: dx, side: side))
        case .ended:
            let opens = EdgeHandleGeometry.opens(translationX: dx, side: side)
            springBack()
            if opens {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                onPull()
            }
        case .cancelled, .failed:
            springBack()
        default:
            break
        }
    }

    private func springBack() {
        UIView.animate(
            withDuration: 0.35, delay: 0, usingSpringWithDamping: 0.75, initialSpringVelocity: 0,
            options: [.allowUserInteraction, .beginFromCurrentState]
        ) { self.layoutTab(pull: 0) }
    }

    override func accessibilityActivate() -> Bool {
        onPull()
        return true
    }

    /// Hex option → colour; the system tint when unset or malformed.
    static func color(hex: String?) -> UIColor {
        guard let c = EdgeHandleGeometry.rgba(hex: hex) else { return .systemBlue }
        return UIColor(red: CGFloat(c.r), green: CGFloat(c.g), blue: CGFloat(c.b), alpha: CGFloat(c.a))
    }
}

extension EdgeHandleView: UIGestureRecognizerDelegate {
    /// Only a mostly horizontal drag away from the edge claims the touch; anything else is ignored.
    override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return true }
        let v = pan.velocity(in: self)
        let away = side == .right ? -v.x : v.x
        return away > 0 && abs(v.x) > abs(v.y)
    }
}
