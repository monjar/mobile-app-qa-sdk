// The prompt pills at the top of the screen: "Report this screen?" for 4 s after
// a system screenshot (spec §4.3), and "The app closed unexpectedly. Report it?"
// after a crash (spec §11.8), which also has a dismiss button — dismissing it is
// an answer (the pending crash is forgotten), unlike letting it time out.

import UIKit

final class PromptPill: UIControl {
    private let onTap: () -> Void
    private let onClose: (() -> Void)?
    private let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemThickMaterial))
    private let label = UILabel()
    private let icon: UIImageView

    init(title: String, iconName: String, onTap: @escaping () -> Void, onClose: (() -> Void)? = nil) {
        self.onTap = onTap
        self.onClose = onClose
        icon = UIImageView(image: UIImage(systemName: iconName))
        super.init(frame: .zero)
        isAccessibilityElement = onClose == nil
        accessibilityLabel = title
        accessibilityTraits = .button

        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = 0.15
        layer.shadowRadius = Theme.shadowRadius
        layer.shadowOffset = CGSize(width: 0, height: 4)

        blur.translatesAutoresizingMaskIntoConstraints = false
        blur.isUserInteractionEnabled = onClose != nil
        blur.layer.cornerRadius = Theme.pillHeight / 2
        blur.layer.cornerCurve = .continuous
        blur.clipsToBounds = true
        addSubview(blur)

        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.tintColor = .systemBlue
        icon.contentMode = .scaleAspectFit
        icon.isUserInteractionEnabled = false
        label.translatesAutoresizingMaskIntoConstraints = false
        label.text = title
        label.font = UIFont.preferredFont(forTextStyle: .subheadline)
        label.adjustsFontForContentSizeCategory = true
        label.textColor = .label
        label.numberOfLines = 2
        label.isUserInteractionEnabled = false
        blur.contentView.addSubview(icon)
        blur.contentView.addSubview(label)

        var constraints = [
            blur.topAnchor.constraint(equalTo: topAnchor),
            blur.bottomAnchor.constraint(equalTo: bottomAnchor),
            blur.leadingAnchor.constraint(equalTo: leadingAnchor),
            blur.trailingAnchor.constraint(equalTo: trailingAnchor),
            heightAnchor.constraint(greaterThanOrEqualToConstant: Theme.pillHeight),
            icon.leadingAnchor.constraint(equalTo: blur.contentView.leadingAnchor, constant: 16),
            icon.centerYAnchor.constraint(equalTo: blur.contentView.centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 20),
            icon.heightAnchor.constraint(equalToConstant: 20),
            label.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 8),
            label.topAnchor.constraint(equalTo: blur.contentView.topAnchor, constant: 10),
            label.bottomAnchor.constraint(equalTo: blur.contentView.bottomAnchor, constant: -10),
        ]

        if onClose != nil {
            // The text half opens the report; the close button is its own accessible element.
            let open = UIButton(type: .custom)
            open.translatesAutoresizingMaskIntoConstraints = false
            open.accessibilityLabel = title
            open.addTarget(self, action: #selector(tapped), for: .touchUpInside)
            let close = UIButton(type: .system)
            close.translatesAutoresizingMaskIntoConstraints = false
            close.setImage(UIImage(systemName: "xmark"), for: .normal)
            close.tintColor = .secondaryLabel
            close.accessibilityLabel = Strings.dismiss
            close.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
            blur.contentView.addSubview(open)
            blur.contentView.addSubview(close)
            constraints += [
                open.topAnchor.constraint(equalTo: blur.contentView.topAnchor),
                open.bottomAnchor.constraint(equalTo: blur.contentView.bottomAnchor),
                open.leadingAnchor.constraint(equalTo: blur.contentView.leadingAnchor),
                open.trailingAnchor.constraint(equalTo: close.leadingAnchor),
                close.leadingAnchor.constraint(equalTo: label.trailingAnchor, constant: 4),
                close.trailingAnchor.constraint(equalTo: blur.contentView.trailingAnchor, constant: -6),
                close.centerYAnchor.constraint(equalTo: blur.contentView.centerYAnchor),
                close.widthAnchor.constraint(equalToConstant: 44),
                close.heightAnchor.constraint(equalToConstant: 44),
            ]
        } else {
            constraints.append(label.trailingAnchor.constraint(equalTo: blur.contentView.trailingAnchor, constant: -18))
            addTarget(self, action: #selector(tapped), for: .touchUpInside)
        }
        NSLayoutConstraint.activate(constraints)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override var isHighlighted: Bool {
        didSet { alpha = isHighlighted ? 0.7 : 1 }
    }

    @objc private func tapped() {
        onTap()
    }

    @objc private func closeTapped() {
        onClose?()
    }
}
