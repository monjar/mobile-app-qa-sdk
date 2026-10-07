// The example screen, built to exercise the SDK:
// - a list whose 600 ms long-press bumps a visible counter (proves that the
//   trigger cancels touches: the counter must not move when Snitch fires)
// - a text field (masked in screenshots and video)
// - an MTKView clearing to magenta (shows whether Metal content is captured)
// - a Report button calling Snitch.show()

import MetalKit
import Snitch
import UIKit

final class MainViewController: UIViewController, UITableViewDataSource {
    private let counterLabel = UILabel()
    private let tableView = UITableView(frame: .zero, style: .insetGrouped)
    private let metalRenderer = MagentaRenderer()
    private var longPresses = 0 {
        didSet { counterLabel.text = "long presses: \(longPresses)" }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Snitch Example"
        view.backgroundColor = .systemGroupedBackground

        counterLabel.text = "long presses: 0"
        counterLabel.font = .preferredFont(forTextStyle: .headline)
        counterLabel.adjustsFontForContentSizeCategory = true
        counterLabel.accessibilityIdentifier = "longPressLabel"

        let field = UITextField()
        field.placeholder = "Secret (masked in reports)"
        field.borderStyle = .roundedRect
        field.accessibilityIdentifier = "secretField"

        let metalView = MTKView(frame: .zero, device: metalRenderer.device)
        metalView.accessibilityIdentifier = "metalView"
        metalView.backgroundColor = .magenta // only visible when Metal is unavailable
        metalRenderer.attach(to: metalView)
        metalView.heightAnchor.constraint(equalToConstant: 56).isActive = true

        let reportButton = UIButton(type: .system)
        reportButton.setTitle("Report", for: .normal)
        reportButton.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        reportButton.accessibilityIdentifier = "reportButton"
        reportButton.addTarget(self, action: #selector(reportTapped), for: .touchUpInside)

        let header = UIStackView(arrangedSubviews: [counterLabel, field, metalView, reportButton])
        header.axis = .vertical
        header.spacing = 12
        header.translatesAutoresizingMaskIntoConstraints = false

        tableView.dataSource = self
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "cell")
        tableView.accessibilityIdentifier = "list"
        tableView.translatesAutoresizingMaskIntoConstraints = false
        let longPress = UILongPressGestureRecognizer(target: self, action: #selector(longPressed(_:)))
        longPress.minimumPressDuration = 0.6
        tableView.addGestureRecognizer(longPress)

        view.addSubview(header)
        view.addSubview(tableView)
        let guide = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            header.topAnchor.constraint(equalTo: guide.topAnchor, constant: 12),
            header.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 20),
            header.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -20),
            tableView.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 8),
            tableView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            tableView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            tableView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
    }

    @objc private func longPressed(_ recognizer: UILongPressGestureRecognizer) {
        guard recognizer.state == .began else { return }
        longPresses += 1
        Snitch.log("Long press #\(longPresses)")
    }

    @objc private func reportTapped() {
        Snitch.show()
    }

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        40
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "cell", for: indexPath)
        var content = cell.defaultContentConfiguration()
        content.text = "Row \(indexPath.row + 1) — long-press me"
        cell.contentConfiguration = content
        cell.accessibilityIdentifier = "row-\(indexPath.row)"
        return cell
    }
}

/// Clears an MTKView to solid magenta a few times a second.
final class MagentaRenderer: NSObject, MTKViewDelegate {
    let device: MTLDevice? = MTLCreateSystemDefaultDevice()
    private lazy var queue: MTLCommandQueue? = device?.makeCommandQueue()

    func attach(to view: MTKView) {
        view.clearColor = MTLClearColor(red: 1, green: 0, blue: 1, alpha: 1)
        view.colorPixelFormat = .bgra8Unorm
        view.preferredFramesPerSecond = 10
        view.delegate = self
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    func draw(in view: MTKView) {
        guard let pass = view.currentRenderPassDescriptor,
              let drawable = view.currentDrawable,
              let buffer = queue?.makeCommandBuffer(),
              let encoder = buffer.makeRenderCommandEncoder(descriptor: pass) else { return }
        encoder.endEncoding()
        buffer.present(drawable)
        buffer.commit()
    }
}
