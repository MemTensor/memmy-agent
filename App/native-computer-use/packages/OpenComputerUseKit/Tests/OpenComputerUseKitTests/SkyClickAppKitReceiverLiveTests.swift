import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import IOKit
import XCTest
@testable import MemmyComputerUseKit

/// Opt-in probe of actual AppKit receipt, rather than a mocked event recipe.
/// It launches only its own nonactivating panel. It never activates an app,
/// requests permissions, posts a global event, or restores another app.
@MainActor
final class SkyClickAppKitReceiverLiveTests: XCTestCase {
    func testOwnBackgroundPanelReceivesOneClickWithoutChangingPhysicalForeground() throws {
        guard ProcessInfo.processInfo.environment["OPEN_COMPUTER_USE_RUN_APPKIT_RECEIVER_LIVE_TEST"] == "1" else {
            throw XCTSkip("Set OPEN_COMPUTER_USE_RUN_APPKIT_RECEIVER_LIVE_TEST=1 for the self-owned background receiver probe")
        }
        let reportURL = ProcessInfo.processInfo.environment["OPEN_COMPUTER_USE_APPKIT_RECEIVER_REPORT"].map {
            URL(fileURLWithPath: $0)
        }
        var report: [String: Any] = ["probe": "self-owned-nonactivating-AppKit-panel", "primer": false]
        func saveReport() throws {
            guard let reportURL else { return }
            try FileManager.default.createDirectory(at: reportURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
                .write(to: reportURL)
        }
        guard CGPreflightPostEventAccess() else {
            report["status"] = "blocked"
            report["reason"] = "The sender does not already have event-posting permission; no permission request was made."
            try saveReport()
            throw XCTSkip(report["reason"] as? String)
        }
        guard SkyLightSPI.shared.capability.isAvailable else {
            report["status"] = "blocked"
            report["reason"] = SkyLightSPI.shared.capability.unavailableReason
            try saveReport()
            throw XCTSkip(report["reason"] as? String)
        }
        let originalPID = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let scratch = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("memmy-appkit-receiver-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: scratch) }
        let source = scratch.appendingPathComponent("Receiver.swift")
        let executable = scratch.appendingPathComponent("Receiver")
        let stateURL = scratch.appendingPathComponent("state.json")
        try Self.receiverSource.write(to: source, atomically: false, encoding: .utf8)
        let compiler = Process()
        compiler.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
        compiler.arguments = ["swiftc", "-swift-version", "5", "-parse-as-library", source.path, "-o", executable.path]
        compiler.standardOutput = FileHandle.nullDevice
        let compilerErrors = Pipe()
        compiler.standardError = compilerErrors
        try compiler.run()
        compiler.waitUntilExit()
        guard compiler.terminationStatus == 0 else {
            throw ComputerUseError.message("Self-owned receiver compilation failed: \(String(decoding: compilerErrors.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self))")
        }
        let receiver = Process()
        receiver.executableURL = executable
        receiver.arguments = [stateURL.path]
        receiver.standardOutput = FileHandle.nullDevice
        receiver.standardError = FileHandle.nullDevice
        try receiver.run()
        defer {
            if receiver.isRunning { receiver.terminate() }
            let deadline = Date().addingTimeInterval(3)
            while receiver.isRunning && Date() < deadline {
                RunLoop.current.run(until: Date().addingTimeInterval(0.02))
            }
        }
        func readState() -> [String: Any]? {
            guard let data = try? Data(contentsOf: stateURL) else { return nil }
            return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        }
        let readyDeadline = Date().addingTimeInterval(5)
        var ready: [String: Any]?
        while ready == nil, Date() < readyDeadline, receiver.isRunning {
            ready = readState()
            RunLoop.current.run(until: Date().addingTimeInterval(0.02))
        }
        guard let ready, let id = ready["windowID"] as? NSNumber,
              let info = (CGWindowListCopyWindowInfo([.optionIncludingWindow], id.uint32Value) as? [[String: Any]])?
                .first(where: { ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == receiver.processIdentifier }),
              let boundsDictionary = info[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: boundsDictionary),
              skyClickWindowMatchesTarget(windowInfo: [info], windowID: id.uint32Value, pid: receiver.processIdentifier) else {
            report["status"] = "blocked"
            report["reason"] = "A self-owned on-screen WindowServer window was unavailable."
            try saveReport()
            throw XCTSkip(report["reason"] as? String)
        }
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == originalPID,
              originalPID != receiver.processIdentifier else {
            report["status"] = "blocked"
            report["reason"] = "The foreground changed while creating the nonactivating receiver; no input was sent."
            try saveReport()
            throw XCTSkip(report["reason"] as? String)
        }
        // A short sample records whether the HID clock was already being reset.
        var baseline: [[String: Any]] = []
        for _ in 0..<5 {
            baseline.append(Self.physicalState())
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        let before = Self.physicalState()
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == originalPID else {
            report["status"] = "blocked"
            report["reason"] = "The user changed foreground before dispatch; no input was sent."
            try saveReport()
            throw XCTSkip(report["reason"] as? String)
        }
        report["targetPID"] = receiver.processIdentifier
        report["targetWindowID"] = id.uint32Value
        report["baseline"] = baseline
        report["before"] = before
        let point = CGPoint(x: bounds.midX, y: bounds.midY)
        var dispatchError: String?
        do {
            try SkyClickDispatcher.click(target: SkyClickTarget(screenPoint: point,
                windowPoint: CGPoint(x: bounds.width / 2, y: bounds.height / 2),
                windowBounds: bounds, windowID: id.uint32Value, pid: receiver.processIdentifier),
                clickCount: 1, includePrimer: false)
        } catch { dispatchError = error.localizedDescription }
        report["immediatelyAfter"] = Self.physicalState()
        RunLoop.current.run(until: Date().addingTimeInterval(0.4))
        let received = try XCTUnwrap(readState(), "Receiver did not publish its final counts")
        let after = Self.physicalState()
        report["receiver"] = received
        report["after"] = after
        if let dispatchError { report["dispatchError"] = dispatchError }
        let down = (received["monitorDown"] as? NSNumber)?.intValue ?? 0
        let up = (received["monitorUp"] as? NSNumber)?.intValue ?? 0
        report["status"] = down == 0 && up == 0 ? "blocked-no-receipt" : "received"
        report["hidInterpretation"] = "Read-only HID samples are evidence of observed clock behavior. Concurrent human keyboard input cannot be excluded by this probe; a reset alone does not prove its cause."
        try saveReport()
        guard down > 0 || up > 0 else {
            throw XCTSkip("No native event receipt despite preflight permission; recorded as blocked, without a global fallback")
        }
        XCTAssertNil(dispatchError)
        XCTAssertEqual(down, 1, "One requested click must produce one AppKit mouse-down")
        XCTAssertEqual(up, 1, "One requested click must produce one AppKit mouse-up")
        XCTAssertEqual((received["viewDown"] as? NSNumber)?.intValue, 1)
        XCTAssertEqual((received["viewUp"] as? NSNumber)?.intValue, 1)
        XCTAssertEqual(after["frontmostPID"] as? Int, before["frontmostPID"] as? Int)
        if let beforeX = before["cursorX"] as? Double, let beforeY = before["cursorY"] as? Double,
           let afterX = after["cursorX"] as? Double, let afterY = after["cursorY"] as? Double {
            XCTAssertLessThan(hypot(afterX - beforeX, afterY - beforeY), 0.5)
        }
    }

    private static func physicalState() -> [String: Any] {
        var state: [String: Any] = ["uptime": ProcessInfo.processInfo.systemUptime]
        if let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier { state["frontmostPID"] = Int(pid) }
        if let location = CGEvent(source: nil)?.location { state["cursorX"] = location.x; state["cursorY"] = location.y }
        if let event = CGEventType(rawValue: UInt32.max) {
            state["cgHIDIdleSeconds"] = CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: event)
        }
        let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOHIDSystem"))
        if service != 0 {
            defer { IOObjectRelease(service) }
            if let value = IORegistryEntryCreateCFProperty(service, "HIDIdleTime" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? NSNumber {
                state["ioHIDIdleSeconds"] = value.doubleValue / 1_000_000_000
            }
        }
        return state
    }

    private static let receiverSource = #"""
    import AppKit
    import Foundation
    final class Panel: NSPanel {
        override var canBecomeKey: Bool { false }
        override var canBecomeMain: Bool { false }
    }
    final class ReceiverView: NSView {
        var down = 0; var up = 0
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
        override func mouseDown(with event: NSEvent) { down += 1 }
        override func mouseUp(with event: NSEvent) { up += 1 }
    }
    @main struct Receiver {
        static func main() {
            let app = NSApplication.shared
            app.setActivationPolicy(.accessory)
            let output = URL(fileURLWithPath: CommandLine.arguments[1])
            let panel = Panel(contentRect: NSRect(x: 40, y: 40, width: 220, height: 140),
                styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            panel.isReleasedWhenClosed = false
            panel.hidesOnDeactivate = false
            panel.collectionBehavior = [.transient, .ignoresCycle]
            panel.title = "Memmy self-owned event receiver"
            let view = ReceiverView(frame: NSRect(x: 0, y: 0, width: 220, height: 140))
            panel.contentView = view
            var downs = 0; var ups = 0; var moves = 0
            var receipts: [[String: Any]] = []
            let monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .leftMouseUp, .mouseMoved]) { event in
                if event.windowNumber == panel.windowNumber {
                    switch event.type {
                    case .leftMouseDown: downs += 1
                    case .leftMouseUp: ups += 1
                    case .mouseMoved: moves += 1
                    default: break
                    }
                    receipts.append(["type": event.type.rawValue, "windowID": event.windowNumber,
                        "timestamp": event.timestamp, "eventNumber": event.eventNumber, "clickCount": event.clickCount])
                }
                return event
            }
            func publish() {
                let value: [String: Any] = ["pid": ProcessInfo.processInfo.processIdentifier,
                    "windowID": panel.windowNumber, "monitorDown": downs, "monitorUp": ups,
                    "monitorMoved": moves, "viewDown": view.down, "viewUp": view.up,
                    "isActive": app.isActive, "isKeyWindow": panel.isKeyWindow, "receipts": receipts]
                if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
                    try? data.write(to: output, options: .atomic)
                }
            }
            panel.orderBack(nil)
            publish()
            let timer = Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { _ in MainActor.assumeIsolated { publish() } }
            app.run()
            timer.invalidate()
            if let monitor { NSEvent.removeMonitor(monitor) }
            panel.close()
        }
    }
    """#
}
