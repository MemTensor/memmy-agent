import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit

struct WindowScreenshotDisplay {
    let id: CGDirectDisplayID
    let bounds: CGRect
    let scale: CGFloat
}

struct WindowScreenshotIdentity {
    let id: CGWindowID
    let pid: pid_t
    let onScreen: Bool
}

struct WindowScreenshotPlan {
    let displayID: CGDirectDisplayID?
    let sourceRect: CGRect
    let scale: CGFloat
    let relatedWindowIDs: [CGWindowID]
}

struct WindowScreenshotOverlay: Equatable {
    let windowID: CGWindowID
    let bounds: CGRect
}

private func validScreenshotBounds(_ bounds: CGRect) -> Bool {
    [bounds.minX, bounds.minY, bounds.width, bounds.height].allSatisfy(\.isFinite)
        && bounds.width > 0 && bounds.height > 0
}

// Some applications (including WPS's layer-24 New panel) create standalone
// elevated windows without an AX or WindowServer child association. Discover
// only visible elevated surfaces over the foremost normal window of this PID.
// Normal document windows never gain membership through overlap or same PID.
// This is an application-overlay fallback, not proof of AX root ancestry.
func discoveredWindowScreenshotOverlays(windowID: CGWindowID, pid: pid_t, bounds: CGRect,
                                       windowInfo: [[String: Any]]) -> [WindowScreenshotOverlay] {
    guard verifiedScreenshotWindow(windowID: windowID, pid: pid, bounds: bounds, windowInfo: windowInfo) == true,
          let rootIndex = windowInfo.firstIndex(where: {
              ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == windowID
          }),
          (windowInfo[rootIndex][kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
          ((windowInfo[rootIndex][kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1) > 0 else { return [] }
    let ownedVisible: (Int) -> Bool = { index in
        let record = windowInfo[index]
        return (record[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid
            && (record[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue == true
            && ((record[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1) > 0
    }
    guard !(0..<rootIndex).contains(where: {
        ownedVisible($0) && (windowInfo[$0][kCGWindowLayer as String] as? NSNumber)?.intValue == 0
    }) else { return [] }
    let counts = Dictionary(grouping: windowInfo.compactMap {
        ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value
    }, by: { $0 }).mapValues(\.count)
    // Reverse CG's front-to-back order for the independent composition fallback.
    return (0..<rootIndex).reversed().compactMap { index in
        let record = windowInfo[index]
        guard ownedVisible(index),
              let id = (record[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
              id > 0, counts[id] == 1,
              let layer = (record[kCGWindowLayer as String] as? NSNumber)?.intValue,
              (1...25).contains(layer) || layer == 101,
              let dictionary = record[kCGWindowBounds as String] as? NSDictionary,
              let overlayBounds = CGRect(dictionaryRepresentation: dictionary), validScreenshotBounds(overlayBounds),
              !bounds.intersection(overlayBounds).isEmpty else { return nil }
        return WindowScreenshotOverlay(windowID: id, bounds: overlayBounds)
    }
}

// CG bounds are the model's top-left coordinate origin, not SCWindow.frame
// (which may exclude the rounded edge of an AppKit window).
func verifiedScreenshotWindow(windowID: CGWindowID, pid: pid_t, bounds: CGRect,
                              windowInfo: [[String: Any]]) -> Bool? {
    guard windowID > 0, pid > 0, validScreenshotBounds(bounds) else { return nil }
    let matches = windowInfo.filter {
        ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == windowID
    }
    guard matches.count == 1, let record = matches.first,
          (record[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
          let dictionary = record[kCGWindowBounds as String] as? NSDictionary,
          let current = CGRect(dictionaryRepresentation: dictionary), current == bounds,
          let onScreen = record[kCGWindowIsOnscreen as String] as? NSNumber else { return nil }
    return onScreen.boolValue
}

func windowScreenshotPlan(windowID: CGWindowID, pid: pid_t, bounds: CGRect, onScreen: Bool,
                          supportsChildren: Bool, displays: [WindowScreenshotDisplay],
                          available: [WindowScreenshotIdentity], relatedWindowIDs: Set<CGWindowID>,
                          requiredWindowIDs: Set<CGWindowID> = [],
                          fallbackScale: CGFloat) -> WindowScreenshotPlan? {
    guard windowID > 0, pid > 0, validScreenshotBounds(bounds) else { return nil }
    let roots = available.filter { $0.id == windowID }
    guard roots.count == 1, roots.first?.pid == pid else { return nil }
    let containing = displays.filter {
        $0.id > 0 && validScreenshotBounds($0.bounds) && $0.scale.isFinite && $0.scale > 0
            && $0.bounds.contains(bounds)
    }
    let display = containing.count == 1 ? containing.first : nil
    let useGroup = supportsChildren && onScreen && roots.first?.onScreen == true && display != nil
    let related = relatedWindowIDs.sorted().prefix(64).filter { id in
        guard id > 0, id != windowID else { return false }
        let matches = available.filter { $0.id == id }
        return matches.count == 1 && matches.first?.pid == pid && matches.first?.onScreen == true
    }
    guard requiredWindowIDs.isSubset(of: Set(related)) else { return nil }
    let scale = display?.scale ?? (fallbackScale.isFinite && fallbackScale > 0 ? fallbackScale : 1)
    return WindowScreenshotPlan(displayID: useGroup ? display?.id : nil,
        sourceRect: useGroup ? bounds.offsetBy(dx: -display!.bounds.minX, dy: -display!.bounds.minY) : .zero,
        scale: scale, relatedWindowIDs: related)
}

enum WindowScreenshotCaptureError: Error {
    case targetChanged
    case overlayUnavailable
}

private func currentScreenshotWindow(windowID: CGWindowID, pid: pid_t, bounds: CGRect) -> Bool? {
    let info = CGWindowListCopyWindowInfo(.optionIncludingWindow, windowID) as? [[String: Any]] ?? []
    return verifiedScreenshotWindow(windowID: windowID, pid: pid, bounds: bounds, windowInfo: info)
}

private func screenshotConfiguration(bounds: CGRect, scale: CGFloat) -> SCStreamConfiguration {
    let configuration = SCStreamConfiguration()
    configuration.width = max(1, Int(round(bounds.width * scale)))
    configuration.height = max(1, Int(round(bounds.height * scale)))
    configuration.showsCursor = false
    configuration.scalesToFit = false
    return configuration
}

// Use the exact root's display crop with verified AX associations and elevated
// app surfaces discovered above. Other normal documents never gain membership
// from matching PID or overlap. WindowServer children supplement the group.
func captureVerifiedWindowScreenshot(windowID: CGWindowID, pid: pid_t, bounds: CGRect,
    relatedWindowIDs: Set<CGWindowID>,
    fallbackOverlays: [(windowID: CGWindowID, bounds: CGRect)] = []) async throws -> CGImage {
    guard let onScreen = currentScreenshotWindow(windowID: windowID, pid: pid, bounds: bounds) else {
        throw WindowScreenshotCaptureError.targetChanged
    }
    let windowInfo = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? []
    let discovered = discoveredWindowScreenshotOverlays(windowID: windowID, pid: pid, bounds: bounds,
                                                        windowInfo: windowInfo)
    let captureWindowIDs = relatedWindowIDs.union(discovered.map(\.windowID))
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
    let windows = content.windows
    let available = windows.map { WindowScreenshotIdentity(id: $0.windowID,
        pid: $0.owningApplication?.processID ?? 0, onScreen: $0.isOnScreen) }
    var supportsChildren = false
    if #available(macOS 14.2, *) { supportsChildren = true }
    guard let plan = windowScreenshotPlan(windowID: windowID, pid: pid, bounds: bounds, onScreen: onScreen,
        supportsChildren: supportsChildren, displays: content.displays.map {
            WindowScreenshotDisplay(id: $0.displayID, bounds: $0.frame,
                scale: $0.frame.width > 0 ? CGFloat($0.width) / $0.frame.width : 0)
        }, available: available, relatedWindowIDs: captureWindowIDs, requiredWindowIDs: Set(discovered.map(\.windowID)),
        fallbackScale: NSScreen.main?.backingScaleFactor ?? 1),
        let root = windows.first(where: { $0.windowID == windowID && $0.owningApplication?.processID == pid }),
        currentScreenshotWindow(windowID: windowID, pid: pid, bounds: bounds) == onScreen else {
        throw WindowScreenshotCaptureError.targetChanged
    }
    let configuration = screenshotConfiguration(bounds: bounds, scale: plan.scale)
    let filter: SCContentFilter
    if #available(macOS 14.2, *), let displayID = plan.displayID,
       let display = content.displays.first(where: { $0.displayID == displayID }) {
        let related = Set(plan.relatedWindowIDs)
        filter = SCContentFilter(display: display, including: [root] + windows.filter { related.contains($0.windowID) })
        configuration.includeChildWindows = true
        configuration.ignoreShadowsDisplay = true
        configuration.sourceRect = plan.sourceRect
    } else {
        filter = SCContentFilter(desktopIndependentWindow: root)
        configuration.ignoreShadowsSingleWindow = true
    }
    var image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
    // Preserve the exact-ID composition fallback for old OS / spanning roots,
    // supplementing it with the independently discovered elevated surfaces.
    if plan.displayID == nil {
        let related = Set(plan.relatedWindowIDs)
        let explicit = fallbackOverlays.filter { overlay in !discovered.contains { $0.windowID == overlay.windowID } }
        let overlays = explicit + discovered.map { (windowID: $0.windowID, bounds: $0.bounds) }
        for overlay in overlays where related.contains(overlay.windowID) {
            guard currentScreenshotWindow(windowID: overlay.windowID, pid: pid, bounds: overlay.bounds) == true,
                  let window = windows.first(where: { $0.windowID == overlay.windowID }),
                  let overlayImage = try? await captureIndependentScreenshot(window, bounds: overlay.bounds, scale: plan.scale),
                  let composed = compositeWindowScreenshot(base: image, baseBounds: bounds,
                      overlay: overlayImage, overlayBounds: overlay.bounds) else {
                if discovered.contains(where: { $0.windowID == overlay.windowID }) {
                    throw WindowScreenshotCaptureError.overlayUnavailable
                }
                continue
            }
            image = composed
        }
    }
    guard currentScreenshotWindow(windowID: windowID, pid: pid, bounds: bounds) == onScreen else {
        throw WindowScreenshotCaptureError.targetChanged
    }
    let finalWindowInfo = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? []
    guard discoveredWindowScreenshotOverlays(windowID: windowID, pid: pid, bounds: bounds,
                                            windowInfo: finalWindowInfo) == discovered else {
        throw WindowScreenshotCaptureError.targetChanged
    }
    return image
}

private func captureIndependentScreenshot(_ window: SCWindow, bounds: CGRect, scale: CGFloat) async throws -> CGImage {
    let configuration = screenshotConfiguration(bounds: bounds, scale: scale)
    configuration.ignoreShadowsSingleWindow = true
    return try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: window),
        configuration: configuration)
}
