// swift-tools-version:5.9
// Strata Tune's macOS worker: the Metal bench (AI Models page) and the audit's load kernels.
// Built by scripts/mac/build-collector.sh (swift build -c release); no dependencies.
import PackageDescription

let package = Package(
    name: "strata-tune-mac-worker",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "strata-tune-mac-worker",
            path: "Sources/strata-tune-mac-worker",
            linkerSettings: [.linkedFramework("Metal"), .linkedFramework("MetalPerformanceShaders"), .linkedFramework("Foundation")]
        )
    ]
)
