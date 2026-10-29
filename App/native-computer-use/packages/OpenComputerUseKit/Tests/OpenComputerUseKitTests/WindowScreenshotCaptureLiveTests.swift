import AppKit
import CoreGraphics
import Foundation
import XCTest
@testable import MemmyComputerUseKit

// Opt-in fixture for the production SCScreenshotManager path. It never touches
// another application's window, requests TCC, or restores/changes foreground.
@MainActor
final class WindowScreenshotCaptureLiveTests: XCTestCase {
    private struct Pixels {
        var red = 0
        var blue = 0
        var yellow = 0
        var green = 0
    }

    func testExactWindowGroupScreenshotIncludesAssociatedMenusAndExcludesOtherDocument() async throws {
        guard ProcessInfo.processInfo.environment["MEMMY_RUN_WINDOW_SCREENSHOT_LIVE_TEST"] == "1" else {
            throw XCTSkip("Set MEMMY_RUN_WINDOW_SCREENSHOT_LIVE_TEST=1 for the own-window screenshot fixture")
        }
        guard CGPreflightScreenCaptureAccess() else {
            throw XCTSkip("Screen Recording unavailable; no windows created or permission requested")
        }
        guard #available(macOS 14.2, *) else { throw XCTSkip("Child-including display capture requires macOS 14.2") }
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        let pid = ProcessInfo.processInfo.processIdentifier
        XCTAssertNotEqual(NSWorkspace.shared.frontmostApplication?.processIdentifier, pid)
        let screen = try XCTUnwrap(NSScreen.screens.first).visibleFrame
        let root = panel(NSRect(x: screen.minX + 100, y: screen.minY + 100, width: 400, height: 280), color: .red)
        let unrelated = panel(NSRect(x: root.frame.minX + 20, y: root.frame.minY + 20, width: 80, height: 80), color: .green)
        let child = panel(NSRect(x: root.frame.minX + 110, y: root.frame.minY + 180, width: 70, height: 60), color: .yellow)
        root.addChildWindow(child, ordered: .above)
        let popup = panel(NSRect(x: root.frame.minX + 200, y: root.frame.minY + 130, width: 140, height: 100), color: .blue)
        defer {
            root.removeChildWindow(child)
            child.close(); popup.close(); unrelated.close(); root.close()
        }
        let rootID = CGWindowID(root.windowNumber)
        let popupID = CGWindowID(popup.windowNumber)
        let childID = CGWindowID(child.windowNumber)
        try await settle()
        let control = try await capture(rootID, pid: pid, related: [], stage: "root-only")
        XCTAssertEqual(control.blue, 0)
        XCTAssertEqual(control.green, 0)
        let auto = try await capture(rootID, pid: pid, related: [popupID], stage: "automatic-child-probe")
        XCTAssertGreaterThan(auto.blue, 500)
        XCTAssertEqual(auto.green, 0)
        print("WINDOW-SCREENSHOT automatic-child-supplement=\(auto.yellow > 500 ? "present" : "absent")")
        let associations: Set<CGWindowID> = [popupID, childID]
        try await assertGroup(rootID, pid: pid, related: associations, stage: "explicit-associated-group")
        root.setFrameOrigin(NSPoint(x: root.frame.minX + 30, y: root.frame.minY + 20))
        try await settle()
        try await assertGroup(rootID, pid: pid, related: associations, stage: "moved-root")
        var frame = root.frame
        frame.size = NSSize(width: 450, height: 320)
        root.setFrame(frame, display: true)
        child.setFrameOrigin(NSPoint(x: root.frame.minX + 110, y: root.frame.minY + 180))
        child.order(.above, relativeTo: root.windowNumber)
        try await settle()
        try await assertGroup(rootID, pid: pid, related: associations, stage: "resized-root")
        try await assertGroup(rootID, pid: pid, related: associations, stage: "repeated-capture")
        XCTAssertNotEqual(NSWorkspace.shared.frontmostApplication?.processIdentifier, pid)
        print("WINDOW-SCREENSHOT PASS foreground-not-fixture")
    }

    private func panel(_ frame: NSRect, color: NSColor) -> NSPanel {
        let window = NSPanel(contentRect: frame, styleMask: .nonactivatingPanel, backing: .buffered, defer: false)
        window.backgroundColor = color
        window.isOpaque = true
        window.hasShadow = false
        window.hidesOnDeactivate = false
        window.isReleasedWhenClosed = false
        window.orderFrontRegardless()
        return window
    }

    private func settle() async throws { try await Task.sleep(for: .milliseconds(200)) }

    private func assertGroup(_ id: CGWindowID, pid: pid_t, related: Set<CGWindowID>, stage: String) async throws {
        let pixels = try await capture(id, pid: pid, related: related, stage: stage)
        XCTAssertGreaterThan(pixels.blue, 500, stage)
        XCTAssertGreaterThan(pixels.yellow, 500, stage)
        XCTAssertEqual(pixels.green, 0, stage)
    }

    private func capture(_ id: CGWindowID, pid: pid_t, related: Set<CGWindowID>, stage: String) async throws -> Pixels {
        let raw = CGWindowListCopyWindowInfo(.optionIncludingWindow, id) as? [[String: Any]] ?? []
        let record = try XCTUnwrap(raw.first { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == id })
        let dictionary = try XCTUnwrap(record[kCGWindowBounds as String] as? NSDictionary)
        let bounds = try XCTUnwrap(CGRect(dictionaryRepresentation: dictionary))
        let image: CGImage
        if stage == "repeated-capture" {
            // Exercise the synchronous bridge used by SnapshotBuilder too.
            image = try BlockingAsyncBridge.run(timeout: screenshotCaptureTimeout) {
                try await captureVerifiedWindowScreenshot(windowID: id, pid: pid, bounds: bounds, relatedWindowIDs: related)
            }
        } else {
            image = try await captureVerifiedWindowScreenshot(windowID: id, pid: pid, bounds: bounds, relatedWindowIDs: related)
        }
        let count = image.width * image.height
        var rgba = [UInt8](repeating: 0, count: count * 4)
        let color = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
        let pixels = try rgba.withUnsafeMutableBytes { buffer -> Pixels in
            let context = try XCTUnwrap(CGContext(data: buffer.baseAddress, width: image.width, height: image.height,
                bitsPerComponent: 8, bytesPerRow: image.width * 4, space: color,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue))
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
            var result = Pixels()
            let bytes = buffer.bindMemory(to: UInt8.self)
            for offset in stride(from: 0, to: buffer.count, by: 4) {
                if bytes[offset] > 200 && bytes[offset + 1] < 40 && bytes[offset + 2] < 40 { result.red += 1 }
                if bytes[offset + 2] > 200 && bytes[offset] < 40 && bytes[offset + 1] < 40 { result.blue += 1 }
                if bytes[offset] > 200 && bytes[offset + 1] > 200 && bytes[offset + 2] < 40 { result.yellow += 1 }
                if bytes[offset + 1] > 200 && bytes[offset] < 40 && bytes[offset + 2] < 40 { result.green += 1 }
            }
            return result
        }
        XCTAssertGreaterThan(pixels.red, count / 2, stage)
        XCTAssertNotEqual(NSWorkspace.shared.frontmostApplication?.processIdentifier, pid)
        print("WINDOW-SCREENSHOT \(stage) size=\(image.width)x\(image.height) cg=\(Int(bounds.width))x\(Int(bounds.height)) red=\(pixels.red) blue=\(pixels.blue) yellow=\(pixels.yellow) green=\(pixels.green)")
        return pixels
    }
}
