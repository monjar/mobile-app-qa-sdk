// Shared metrics for the Snitch UI. System colors and fonts only, so everything
// follows light/dark mode and Dynamic Type without extra work.

import UIKit

enum Theme {
    static let cornerRadius: CGFloat = 20
    static let padding: CGFloat = 16
    static let backdropOpacity: Double = 0.3
    static let thumbnailSize = CGSize(width: 44, height: 88)
    static let chipCornerRadius: CGFloat = 14
    static let toastDuration: TimeInterval = 2.5
    static let promptDuration: TimeInterval = 4
    static let pillHeight: CGFloat = 44
    static let shadowRadius: CGFloat = 12
}
