// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "MemmyComputerUse",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "MemmyComputerUse", targets: ["MemmyComputerUse"])],
    targets: [
        .target(name: "MemmyComputerUseKit", path: "packages/OpenComputerUseKit/Sources/OpenComputerUseKit"),
        .target(name: "MemmyComputerHistoryKit", path: "apps/OpenComputerUse/Sources/MemmyComputerHistoryKit", swiftSettings: [.define("MEMMY_COMPUTER_USE_APP"), .swiftLanguageMode(.v5)]),
        .executableTarget(name: "MemmyComputerUse", dependencies: ["MemmyComputerUseKit", "MemmyComputerHistoryKit"], path: "apps/OpenComputerUse/Sources/OpenComputerUse"),
        .testTarget(name: "MemmyComputerUseKitTests", dependencies: ["MemmyComputerUseKit"], path: "packages/OpenComputerUseKit/Tests/OpenComputerUseKitTests"),
    ]
)
