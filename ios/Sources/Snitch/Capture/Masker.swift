// Masking (spec §5.5): which parts of the screen never leave the device.
//
// Masked: editable text inputs (UITextField incl. UISearchTextField, editable
// UITextView — React Native's TextInput is one of these) when maskTextInputs is
// on; views registered with Snitch.mask; views whose accessibilityIdentifier starts
// with "snitch-mask". Hidden, transparent and zero-sized subtrees are skipped, and
// a masked view's subtree is not visited. Main thread only.

import UIKit

final class MaskRegistry {
    static let shared = MaskRegistry()

    private let views = NSHashTable<UIView>.weakObjects()

    func add(_ view: UIView) {
        views.add(view)
    }

    func remove(_ view: UIView) {
        views.remove(view)
    }

    func contains(_ view: UIView) -> Bool {
        views.contains(view)
    }

    var isEmpty: Bool {
        views.allObjects.isEmpty
    }
}

enum Masker {
    static let fillColor = UIColor(red: 0x8E / 255.0, green: 0x8E / 255.0, blue: 0x93 / 255.0, alpha: 1)
    static let borderColor = UIColor(red: 0x63 / 255.0, green: 0x63 / 255.0, blue: 0x66 / 255.0, alpha: 1)

    /// Mask rectangles for `windows`, in screen points.
    static func rects(in windows: [UIWindow], maskTextInputs: Bool) -> [CGRect] {
        var out: [CGRect] = []
        for window in windows {
            let origin = window.frame.origin
            for r in rects(in: window, maskTextInputs: maskTextInputs) {
                out.append(r.offsetBy(dx: origin.x, dy: origin.y))
            }
        }
        return out
    }

    /// Mask rectangles for one window, in that window's coordinates.
    static func rects(in window: UIWindow, maskTextInputs: Bool) -> [CGRect] {
        let registry = MaskRegistry.shared
        let checkRegistry = !registry.isEmpty
        var out: [CGRect] = []
        var stack: [UIView] = [window]
        while let view = stack.popLast() {
            if view.isHidden || view.alpha < 0.01 || view.bounds.width <= 0 || view.bounds.height <= 0 {
                // A zero-sized container can still show overflowing subviews, so only skip its own rect.
                if view.isHidden || view.alpha < 0.01 { continue }
                stack.append(contentsOf: view.subviews)
                continue
            }
            if shouldMask(view, maskTextInputs: maskTextInputs, checkRegistry: checkRegistry, registry: registry) {
                let r = view.convert(view.bounds, to: window)
                if !r.isEmpty && !r.isNull && !r.isInfinite { out.append(r) }
                continue
            }
            stack.append(contentsOf: view.subviews)
        }
        return out
    }

    private static func shouldMask(_ view: UIView, maskTextInputs: Bool, checkRegistry: Bool, registry: MaskRegistry) -> Bool {
        if checkRegistry && registry.contains(view) { return true }
        if let id = view.accessibilityIdentifier, id.hasPrefix("snitch-mask") { return true }
        if maskTextInputs {
            if view is UITextField { return true }
            if let textView = view as? UITextView, textView.isEditable { return true }
        }
        return false
    }

    /// Fills `rects` (in the context's current user space) with the mask color and a 1 px darker border.
    static func draw(_ rects: [CGRect], in ctx: CGContext, pixelsPerPoint: CGFloat) {
        guard !rects.isEmpty else { return }
        let line = 1 / max(pixelsPerPoint, 0.01)
        ctx.saveGState()
        ctx.setFillColor(fillColor.cgColor)
        ctx.setStrokeColor(borderColor.cgColor)
        ctx.setLineWidth(line)
        for r in rects {
            ctx.fill(r)
            ctx.stroke(r.insetBy(dx: line / 2, dy: line / 2))
        }
        ctx.restoreGState()
    }
}
