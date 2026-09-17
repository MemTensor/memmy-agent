// swift-tools-version: 6.2
import PackageDescription
let package = Package(name: "MemmyComputerUse", platforms: [.macOS(.v14)], products: [.executable(name: "OpenComputerUse", targets: ["OpenComputerUse"])], targets: [
.target(name: "OpenComputerUseKit", path: "packages/OpenComputerUseKit/Sources/OpenComputerUseKit"),
.executableTarget(name: "OpenComputerUse", dependencies: ["OpenComputerUseKit"], path: "apps/OpenComputerUse/Sources/OpenComputerUse")
])
