// swift-tools-version:5.9
//
// Snitch iOS SDK. The manifest lives at the repository root because SwiftPM
// consumers add the package by git URL; the sources live under ios/.
// The same sources are also compiled inside the React Native CocoaPod, so the
// code never references `Bundle.module` — the privacy manifest is the only resource.

import PackageDescription

let package = Package(
    name: "Snitch",
    platforms: [.iOS("15.1")],
    products: [
        .library(name: "Snitch", targets: ["Snitch"]),
    ],
    targets: [
        .target(
            name: "Snitch",
            path: "ios/Sources/Snitch",
            resources: [.process("Resources/PrivacyInfo.xcprivacy")]
        ),
        .testTarget(
            name: "SnitchTests",
            dependencies: ["Snitch"],
            path: "ios/Tests/SnitchTests"
        ),
    ]
)
