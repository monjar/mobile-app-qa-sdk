// The edge handle's maths: how far a drag has pulled the tab away from its edge,
// whether that opens the report sheet, and the option clamping/parsing. Pure, so
// it is unit-tested without UIKit touches.

import Foundation

enum EdgeHandleGeometry {
    /// How far (pt) the tab must be pulled away from its edge to open the sheet.
    static let openDistance: Double = 44
    /// The tab can't be pulled further than this.
    static let maxPull: Double = 72
    /// Vertical position bounds, as a fraction of the screen height.
    static let positionRange: ClosedRange<Double> = 0.1...0.9

    /// Distance pulled away from the edge (>= 0) for a horizontal drag translation:
    /// leftwards for a right-edge handle, rightwards for a left-edge one. Capped at maxPull.
    static func pull(translationX: Double, side: EdgeHandleSide) -> Double {
        let away = side == .right ? -translationX : translationX
        return min(max(away, 0), maxPull)
    }

    /// True once the drag has pulled far enough to open the sheet.
    static func opens(translationX: Double, side: EdgeHandleSide) -> Bool {
        pull(translationX: translationX, side: side) >= openDistance
    }

    /// The tab's horizontal offset for a pull: towards the screen's centre.
    static func offset(pull: Double, side: EdgeHandleSide) -> Double {
        side == .right ? -pull : pull
    }

    /// 0 at rest, 1 at the open distance (for fading the tab in as it's pulled).
    static func progress(pull: Double) -> Double {
        min(max(pull / openDistance, 0), 1)
    }

    static func clampPosition(_ position: Double) -> Double {
        guard position.isFinite else { return 0.33 }
        return min(max(position, positionRange.lowerBound), positionRange.upperBound)
    }

    static func isValidHexColor(_ s: String?) -> Bool {
        rgba(hex: s) != nil
    }

    /// "#RRGGBB" or "#RRGGBBAA" (the "#" optional) → components in 0...1; nil otherwise.
    static func rgba(hex: String?) -> (r: Double, g: Double, b: Double, a: Double)? {
        guard var s = hex?.trimmingCharacters(in: .whitespacesAndNewlines) else { return nil }
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6 || s.count == 8, s.allSatisfy(\.isHexDigit), let v = UInt64(s, radix: 16) else { return nil }
        if s.count == 6 {
            return (Double((v >> 16) & 0xFF) / 255, Double((v >> 8) & 0xFF) / 255, Double(v & 0xFF) / 255, 1)
        }
        return (Double((v >> 24) & 0xFF) / 255, Double((v >> 16) & 0xFF) / 255, Double((v >> 8) & 0xFF) / 255, Double(v & 0xFF) / 255)
    }
}
