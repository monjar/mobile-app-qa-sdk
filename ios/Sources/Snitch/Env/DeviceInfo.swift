// Collects `device` and `app` for a report (contract DeviceInfo / AppInfo).
// Runs on the main thread at send time (UIScreen, UIDevice and trait reads).

import Darwin
import os
import UIKit

enum DeviceInfoCollector {
    static func app(releaseType: SnitchReleaseType, bundle: Bundle = .main) -> AppInfo {
        let info = bundle.infoDictionary ?? [:]
        let name = (info["CFBundleDisplayName"] as? String) ?? (info["CFBundleName"] as? String)
        return AppInfo(
            id: String((bundle.bundleIdentifier ?? "unknown").prefix(255)),
            name: name.map { String($0.prefix(120)) },
            version: String(((info["CFBundleShortVersionString"] as? String) ?? "0").prefix(64)),
            build: String(((info["CFBundleVersion"] as? String) ?? "0").prefix(64)),
            releaseType: releaseType.rawValue
        )
    }

    static func device(network: NetworkMonitor.Kind, window: UIWindow?) -> DeviceInfo {
        dispatchPrecondition(condition: .onQueue(.main))
        let device = UIDevice.current
        let screen = window?.windowScene?.screen ?? UIScreen.main
        let bounds = screen.bounds
        let interface = window?.windowScene?.interfaceOrientation
        let landscape = interface.map { $0.isLandscape } ?? (bounds.width > bounds.height)

        let wasMonitoring = device.isBatteryMonitoringEnabled
        if !wasMonitoring { device.isBatteryMonitoringEnabled = true }
        let level = device.batteryLevel
        let batteryState = device.batteryState
        if !wasMonitoring { device.isBatteryMonitoringEnabled = false }

        let style = window?.traitCollection.userInterfaceStyle ?? UITraitCollection.current.userInterfaceStyle
        let category = UIApplication.shared.preferredContentSizeCategory
        let scaled = UIFontMetrics.default.scaledValue(for: 17, compatibleWith: UITraitCollection(preferredContentSizeCategory: category))

        return DeviceInfo(
            platform: "ios",
            osVersion: String(device.systemVersion.prefix(32)),
            model: String(hardwareModel().prefix(64)),
            manufacturer: "Apple",
            locale: String(Locale.current.identifier.prefix(35)),
            timeZone: String(TimeZone.current.identifier.prefix(64)),
            screen: DeviceInfo.Screen(
                width: Double(bounds.width),
                height: Double(bounds.height),
                scale: Double(screen.scale),
                orientation: landscape ? "landscape" : "portrait"
            ),
            memory: DeviceInfo.Memory(
                appMB: physFootprintBytes().map { Int($0 / 1_048_576) },
                freeMB: availableMemoryMB(),
                totalMB: Int(ProcessInfo.processInfo.physicalMemory / 1_048_576)
            ),
            thermal: thermalName(ProcessInfo.processInfo.thermalState),
            lowPower: ProcessInfo.processInfo.isLowPowerModeEnabled,
            battery: level >= 0 ? (Double(level) * 100).rounded() / 100 : nil,
            charging: batteryState == .unknown ? nil : (batteryState == .charging || batteryState == .full),
            network: network.rawValue,
            darkMode: style == .dark,
            screenReader: UIAccessibility.isVoiceOverRunning,
            fontScale: (Double(scaled / 17) * 100).rounded() / 100
        )
    }

    static func thermalName(_ state: ProcessInfo.ThermalState) -> String {
        switch state {
        case .nominal: return "nominal"
        case .fair: return "fair"
        case .serious: return "serious"
        case .critical: return "critical"
        @unknown default: return "nominal"
        }
    }

    static func governorThermal(_ state: ProcessInfo.ThermalState) -> GovernorThermalState {
        GovernorThermalState(rawValue: thermalName(state)) ?? .nominal
    }

    /// `utsname.machine`, e.g. "iPhone16,2"; on the simulator, the simulated model.
    static func hardwareModel() -> String {
        if let sim = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"], !sim.isEmpty {
            return sim
        }
        var system = utsname()
        uname(&system)
        let mirror = Mirror(reflecting: system.machine)
        var bytes: [UInt8] = []
        for child in mirror.children {
            guard let value = child.value as? Int8, value != 0 else { break }
            bytes.append(UInt8(bitPattern: value))
        }
        let model = String(decoding: bytes, as: UTF8.self)
        return model.isEmpty ? "unknown" : model
    }

    /// The app's memory footprint as Xcode and jetsam see it (`task_vm_info.phys_footprint`).
    static func physFootprintBytes() -> UInt64? {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let kr = withUnsafeMutablePointer(to: &info) { pointer -> kern_return_t in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { reboundPointer in
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), reboundPointer, &count)
            }
        }
        guard kr == KERN_SUCCESS else { return nil }
        return info.phys_footprint
    }

    /// Memory the app may still allocate before jetsam (iOS 13+).
    static func availableMemoryMB() -> Int? {
        let bytes = os_proc_available_memory()
        return bytes > 0 ? Int(bytes / 1_048_576) : nil
    }
}
