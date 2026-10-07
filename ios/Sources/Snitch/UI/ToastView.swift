// The small status toast at the top ("Sending…", "Sent · MOCH-42"). UIKit
// rather than SwiftUI so it sizes to its text and the passthrough window can
// hit-test around it precisely.

import UIKit

final class ToastView: UIView {
    private let label = UILabel()
    private let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemThickMaterial))

    var text: String {
        get { label.text ?? "" }
        set {
            label.text = newValue
            accessibilityLabel = newValue
        }
    }

    init(text: String) {
        super.init(frame: .zero)
        isAccessibilityElement = true
        accessibilityTraits = .staticText

        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = 0.15
        layer.shadowRadius = Theme.shadowRadius
        layer.shadowOffset = CGSize(width: 0, height: 4)

        blur.translatesAutoresizingMaskIntoConstraints = false
        blur.layer.cornerRadius = 18
        blur.layer.cornerCurve = .continuous
        blur.clipsToBounds = true
        addSubview(blur)

        label.translatesAutoresizingMaskIntoConstraints = false
        label.font = UIFont.preferredFont(forTextStyle: .subheadline)
        label.adjustsFontForContentSizeCategory = true
        label.textColor = .label
        label.numberOfLines = 2
        label.textAlignment = .center
        blur.contentView.addSubview(label)

        NSLayoutConstraint.activate([
            blur.topAnchor.constraint(equalTo: topAnchor),
            blur.bottomAnchor.constraint(equalTo: bottomAnchor),
            blur.leadingAnchor.constraint(equalTo: leadingAnchor),
            blur.trailingAnchor.constraint(equalTo: trailingAnchor),
            label.topAnchor.constraint(equalTo: blur.contentView.topAnchor, constant: 10),
            label.bottomAnchor.constraint(equalTo: blur.contentView.bottomAnchor, constant: -10),
            label.leadingAnchor.constraint(equalTo: blur.contentView.leadingAnchor, constant: 18),
            label.trailingAnchor.constraint(equalTo: blur.contentView.trailingAnchor, constant: -18),
            heightAnchor.constraint(greaterThanOrEqualToConstant: 36),
        ])
        self.text = text
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func animateIn() {
        alpha = 0
        transform = CGAffineTransform(translationX: 0, y: -12)
        UIView.animate(withDuration: 0.25, delay: 0, options: [.curveEaseOut, .allowUserInteraction]) {
            self.alpha = 1
            self.transform = .identity
        }
    }

    func animateOut(completion: @escaping () -> Void) {
        UIView.animate(withDuration: 0.2, delay: 0, options: [.curveEaseIn], animations: {
            self.alpha = 0
            self.transform = CGAffineTransform(translationX: 0, y: -12)
        }, completion: { _ in
            completion()
        })
    }
}
