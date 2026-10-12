// Snitch example app. One line starts the SDK; it reads the `Snitch` dictionary
// from Info.plist (ServerURL / IngestKey, CaptureNetwork), which UI tests override
// through the SNITCH_DEBUG_* environment hooks in debug builds.
//
// Once Snitch is active the app logs a line and makes one ordinary URLSession.shared
// request, so a report's timeline shows app, log, network and screen events.

import Snitch
import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    private var activationObserver: NSObjectProtocol?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        Snitch.setMetadata("example", "SnitchExample")
        Snitch.log("App launched")
        // Posted on the main thread right after Snitch activates (never in builds where it stays inert).
        activationObserver = NotificationCenter.default.addObserver(
            forName: Notification.Name(SnitchBridge.didActivateNotification), object: nil, queue: .main
        ) { [weak self] _ in
            Snitch.log("Snitch active; checking the server")
            self?.checkServerHealth()
        }
        Snitch.start()
        return true
    }

    /// GET /health on the Snitch server through URLSession.shared, which Snitch records
    /// (CaptureNetwork). Snitch never records requests to its own server, so this calls the
    /// same local server by its other loopback name (127.0.0.1 ↔ localhost).
    private func checkServerHealth() {
        let plist = Bundle.main.object(forInfoDictionaryKey: "Snitch") as? [String: Any]
        let configured = ProcessInfo.processInfo.environment["SNITCH_DEBUG_SERVER_URL"] ?? (plist?["ServerURL"] as? String)
        guard let base = configured, var components = URLComponents(string: base) else { return }
        switch components.host {
        case "127.0.0.1": components.host = "localhost"
        case "localhost": components.host = "127.0.0.1"
        default: break
        }
        components.path = "/health"
        components.query = nil
        guard let url = components.url else { return }
        URLSession.shared.dataTask(with: url) { _, response, error in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            Snitch.log("Health check: \(status)" + (error.map { " (\($0.localizedDescription))" } ?? ""))
        }.resume()
    }

    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = UINavigationController(rootViewController: MainViewController())
        window.makeKeyAndVisible()
        self.window = window
    }
}
