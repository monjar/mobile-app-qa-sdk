// "Report this screen?" pill shown for 4 s after a system screenshot (spec §4.3).

import UIKit

final class ScreenshotPromptPill: UIControl {
    private let onTap: () -> Void
    private let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemThickMaterial))
    private let label = UILabel()
    private let icon = UIImageView(image: UIImage(systemName: "exclamationmark.bubble.fill"))

    init(title: String, onTap: @escaping () -> Void) {
        self.onTap = onTap
        super.init(frame: .zero)
        isAccessibilityElement = true
        accessibilityLabel = title
        accessibilityTraits = .button

        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = 0.15
        layer.shadowRadius = Theme.shadowRadius
        layer.shadowOffset = CGSize(width: 0, height: 4)

        blur.translatesAutoresizingMaskIntoConstraints = false
        blur.isUserInteractionEnabled = false
        blur.layer.cornerRadius = Theme.pillHeight / 2
        blur.layer.cornerCurve = .continuous
        blur.clipsToBounds = true
        addSubview(blur)

        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.tintColor = .systemBlue
        icon.contentMode = .scaleAspectFit
        label.translatesAutoresizingMaskIntoConstraints = false
        label.text = title
        label.font = UIFont.preferredFont(forTextStyle: .subheadline)
        label.adjustsFontForContentSizeCategory = true
        label.textColor = .label
        blur.contentView.addSubview(icon)
        blur.contentView.addSubview(label)

        NSLayoutConstraint.activate([
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
            label.trailingAnchor.constraint(equalTo: blur.contentView.trailingAnchor, constant: -18),
            label.topAnchor.constraint(equalTo: blur.contentView.topAnchor, constant: 10),
            label.bottomAnchor.constraint(equalTo: blur.contentView.bottomAnchor, constant: -10),
        ])
        addTarget(self, action: #selector(tapped), for: .touchUpInside)
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
}
