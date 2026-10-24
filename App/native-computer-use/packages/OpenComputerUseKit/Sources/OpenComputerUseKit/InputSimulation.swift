import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import IOKit

enum MouseButtonKind: String {
    case left
    case right
    case middle

    var cgButton: CGMouseButton {
        switch self {
        case .left:
            return .left
        case .right:
            return .right
        case .middle:
            return .center
        }
    }

    var downEvent: CGEventType {
        switch self {
        case .left:
            return .leftMouseDown
        case .right:
            return .rightMouseDown
        case .middle:
            return .otherMouseDown
        }
    }

    var upEvent: CGEventType {
        switch self {
        case .left:
            return .leftMouseUp
        case .right:
            return .rightMouseUp
        case .middle:
            return .otherMouseUp
        }
    }
}

enum InputSimulation {
    static let maxKeyboardUnicodeChunkLength = 64

    /// Only the native executor can issue this marker. The owner must observe
    /// again after yielding rather than replaying an old element or coordinate.
    struct UserInputYield: Error, LocalizedError {
        let dispatched: Bool
        /// The user kept working elsewhere, so a foreground click did not take the foreground.
        var activeElsewhere = false

        var errorDescription: String? {
            if dispatched {
                return "MAC_FOCUS_GUARD_YIELD_AFTER_DISPATCH: The user is using the target app. An earlier action may have been sent; observe again before continuing."
            }
            if activeElsewhere {
                return "MAC_FOCUS_GUARD_YIELD_BEFORE_DISPATCH: The user is using the keyboard or mouse, so the target window was not brought to the front. The action was not sent."
            }
            return "MAC_FOCUS_GUARD_YIELD_BEFORE_DISPATCH: The user is using the target app. The action was not sent."
        }
    }

    static func shouldYieldToUser(targetPID: pid_t, frontmostPID: pid_t?, inputIdle: TimeInterval) -> Bool {
        targetPID > 0 && frontmostPID == targetPID
            && inputIdle.isFinite && inputIdle >= 0 && inputIdle < 0.45
    }

    static func prepareAppForGlobalPointerInput(_ app: RunningAppDescriptor) {
        if raiseAppWindowViaAccessibility(pid: app.pid) {
            Thread.sleep(forTimeInterval: 0.12)
            return
        }

        _ = app.runningApplication.activate(options: [.activateAllWindows])
        Thread.sleep(forTimeInterval: 0.25)
    }

    static func stopIfUserIsOperatingTarget(pid: pid_t) throws {
        guard pid > 0,
              NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else {
            return
        }
        // Use the same IOHID clock as the host guard rather than a CG event
        // source clock that may include the preceding synthesized mouse move.
        guard let idle = hidInputIdle() else {
            throw ComputerUseError.stateUnavailable("The HID input clock is unavailable. No input was sent; observe the target again before continuing.")
        }
        if shouldYieldToUser(targetPID: pid, frontmostPID: pid, inputIdle: idle) {
            // PID-only event channels still need app-wide protection even
            // when accessibility and screenshot observations are window bound.
            throw UserInputYield(dispatched: false)
        }
    }

    static func hidInputIdle() -> TimeInterval? {
        let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOHIDSystem"))
        guard service != 0 else { return nil }
        defer { IOObjectRelease(service) }
        guard let raw = IORegistryEntryCreateCFProperty(service, "HIDIdleTime" as CFString,
            kCFAllocatorDefault, 0)?.takeRetainedValue(), let nanoseconds = raw as? NSNumber else { return nil }
        let seconds = nanoseconds.doubleValue / 1_000_000_000
        return seconds.isFinite && seconds >= 0 ? seconds : nil
    }

    static func clickGlobally(at point: CGPoint, button: MouseButtonKind, clickCount: Int) throws {
        guard let source = CGEventSource(stateID: .hidSystemState) else {
            throw ComputerUseError.message("Failed to create HID event source.")
        }

        for _ in 0..<max(clickCount, 1) {
            try postMouseEvent(type: .mouseMoved, source: source, point: point, button: button.cgButton, clickState: clickCount)
            try postMouseEvent(type: button.downEvent, source: source, point: point, button: button.cgButton, clickState: clickCount)
            try postMouseEvent(type: button.upEvent, source: source, point: point, button: button.cgButton, clickState: clickCount)
        }
    }

    static func clickTargeted(at point: CGPoint, button: MouseButtonKind, clickCount: Int, pid: pid_t) throws {
        try stopIfUserIsOperatingTarget(pid: pid)
        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            throw ComputerUseError.message("Failed to create app-post event source.")
        }

        for _ in 0..<max(clickCount, 1) {
            try postMouseEventToPid(type: .mouseMoved, source: source, point: point, button: button.cgButton, clickState: clickCount, pid: pid)
            try postMouseEventToPid(type: button.downEvent, source: source, point: point, button: button.cgButton, clickState: clickCount, pid: pid)
            try postMouseEventToPid(type: button.upEvent, source: source, point: point, button: button.cgButton, clickState: clickCount, pid: pid)
        }
    }

    static func clickWithSkyLight(
        at screenPoint: CGPoint,
        windowPoint: CGPoint,
        windowBounds: CGRect,
        windowID: CGWindowID,
        clickCount: Int,
        pid: pid_t,
        includePrimer: Bool = false,
        beforeFirstMouseDown: () throws -> Void = {}
    ) throws {
        try stopIfUserIsOperatingTarget(pid: pid)
        try SkyClickDispatcher.click(
            target: SkyClickTarget(
                screenPoint: screenPoint,
                windowPoint: windowPoint,
                windowBounds: windowBounds,
                windowID: windowID,
                pid: pid
            ),
            clickCount: clickCount,
            includePrimer: includePrimer,
            beforeFirstMouseDown: beforeFirstMouseDown
        )
    }

    static func scrollTargeted(at point: CGPoint, direction: String, pages: Double, pid: pid_t) throws {
        try stopIfUserIsOperatingTarget(pid: pid)
        guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: wheel1(direction: direction, pages: pages), wheel2: wheel2(direction: direction, pages: pages), wheel3: 0) else {
            throw ComputerUseError.message("Failed to create scroll event.")
        }

        event.location = point
        event.postToPid(pid)
        Thread.sleep(forTimeInterval: 0.1)
    }

    static func scrollGlobally(at point: CGPoint, direction: String, pages: Double) throws {
        guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: wheel1(direction: direction, pages: pages), wheel2: wheel2(direction: direction, pages: pages), wheel3: 0) else {
            throw ComputerUseError.message("Failed to create scroll event.")
        }

        event.location = point
        event.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.1)
    }

    static func dragTargeted(from start: CGPoint, to end: CGPoint, pid: pid_t) throws {
        try stopIfUserIsOperatingTarget(pid: pid)
        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            throw ComputerUseError.message("Failed to create targeted event source.")
        }

        try postMouseEventToPid(type: .mouseMoved, source: source, point: start, button: .left, clickState: 1, pid: pid)
        try postMouseEventToPid(type: .leftMouseDown, source: source, point: start, button: .left, clickState: 1, pid: pid)

        for step in 1...10 {
            let progress = CGFloat(step) / 10
            let point = CGPoint(
                x: start.x + ((end.x - start.x) * progress),
                y: start.y + ((end.y - start.y) * progress)
            )
            try postMouseEventToPid(type: .leftMouseDragged, source: source, point: point, button: .left, clickState: 1, pid: pid)
        }

        try postMouseEventToPid(type: .leftMouseUp, source: source, point: end, button: .left, clickState: 1, pid: pid)
    }

    static func dragGlobally(from start: CGPoint, to end: CGPoint) throws {
        // A nil (default) event source posted to the HID tap, with per-step deltas and
        // no timestamp override. This is what lets macOS recognize the synthetic
        // sequence as a real window-server drag on current releases.
        let gesture = dragGestureEventNumber()
        try postMouseEvent(type: .mouseMoved, source: nil, point: start, button: .left, clickState: 1)
        try postMouseEvent(type: .leftMouseDown, source: nil, point: start, button: .left, clickState: 1, eventNumber: gesture)
        // Clear the OS drag threshold before motion, or the gesture reads as a click.
        Thread.sleep(forTimeInterval: 0.05)

        var previous = start
        let steps = dragStepCount(from: start, to: end)
        for step in 1...steps {
            let progress = CGFloat(step) / CGFloat(steps)
            let point = CGPoint(
                x: start.x + ((end.x - start.x) * progress),
                y: start.y + ((end.y - start.y) * progress)
            )
            let delta = CGSize(width: point.x - previous.x, height: point.y - previous.y)
            try postMouseEvent(type: .leftMouseDragged, source: nil, point: point, button: .left, clickState: 1, delta: delta, eventNumber: gesture)
            previous = point
        }

        try postMouseEvent(type: .leftMouseUp, source: nil, point: end, button: .left, clickState: 1, eventNumber: gesture)
    }

    /// AppKit delivers key events to the key window, and an app that is not
    /// active has none, so keys posted to it are dropped. The synthetic focus
    /// a background click uses makes the observed window key for this input
    /// without activating the app, raising the window, or taking key status
    /// from the user's window.
    static func withSyntheticWindowFocus<T>(
        pid: pid_t,
        windowID: CGWindowID?,
        focus: SyntheticWindowFocus = .live,
        _ body: () throws -> T
    ) throws -> T {
        guard let windowID, focus.frontmostPID() != pid, let release = focus.begin(pid, windowID) else {
            return try body()
        }
        defer { release() }
        return try body()
    }

    static func typeText(_ text: String, pid: pid_t, windowID: CGWindowID?) throws {
        try stopIfUserIsOperatingTarget(pid: pid)
        try withSyntheticWindowFocus(pid: pid, windowID: windowID) {
            for chunk in keyboardUnicodeChunks(for: text) {
                var mutableChunk = chunk
                guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
                      let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
                    throw ComputerUseError.message("Failed to create keyboard event.")
                }

                mutableChunk.withUnsafeMutableBufferPointer { buffer in
                    guard let baseAddress = buffer.baseAddress else {
                        return
                    }

                    down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: baseAddress)
                    up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: baseAddress)
                }
                down.postToPid(pid)
                up.postToPid(pid)
                Thread.sleep(forTimeInterval: 0.02)
            }
        }
    }

    private final class PastedTextProvider: NSObject, NSPasteboardItemDataProvider {
        private let text: String
        private let read = DispatchSemaphore(value: 0)

        init(text: String) { self.text = text }

        func pasteboard(_ pasteboard: NSPasteboard?, item: NSPasteboardItem,
                        provideDataForType type: NSPasteboard.PasteboardType) {
            item.setString(text, forType: type)
            read.signal()
        }

        func waitUntilRead(timeout: TimeInterval) -> Bool {
            read.wait(timeout: .now() + timeout) == .success
        }
    }

    /// The text is supplied only when the target app reads it, so the user's
    /// clipboard can be put back afterwards without the app pasting that
    /// instead. Clipboard managers are asked not to record the temporary text.
    static func pasteText(_ text: String, pid: pid_t, windowID: CGWindowID?, readTimeout: TimeInterval = 2) throws {
        try stopIfUserIsOperatingTarget(pid: pid)
        let pasteboard = NSPasteboard.general
        let saved = (pasteboard.pasteboardItems ?? []).map { item in
            item.types.compactMap { type in item.data(forType: type).map { (type, $0) } }
        }
        let provider = PastedTextProvider(text: text)
        let item = NSPasteboardItem()
        item.setDataProvider(provider, forTypes: [.string])
        for marker in ["org.nspasteboard.TransientType", "org.nspasteboard.ConcealedType"] {
            item.setData(Data(), forType: NSPasteboard.PasteboardType(marker))
        }
        pasteboard.clearContents()
        guard pasteboard.writeObjects([item]) else {
            throw ComputerUseError.message("The text could not be placed on the clipboard. No text was entered.")
        }
        let temporaryChangeCount = pasteboard.changeCount
        defer {
            // A clipboard the user replaced during the paste stays theirs.
            if pasteboard.changeCount == temporaryChangeCount {
                pasteboard.clearContents()
                pasteboard.writeObjects(saved.map { types in
                    let restored = NSPasteboardItem()
                    for (type, data) in types { restored.setData(data, forType: type) }
                    return restored
                })
            }
        }
        try withSyntheticWindowFocus(pid: pid, windowID: windowID) {
            try postKeyPress("cmd+v", pid: pid)
            guard provider.waitUntilRead(timeout: readTimeout) else {
                throw ComputerUseError.stateUnavailable("The app did not read the pasted text, so no text was entered. Click the intended text position in this window first, then type again.")
            }
            // The pasteboard server forwards the provided data after the callback.
            Thread.sleep(forTimeInterval: 0.1)
        }
    }

    static func keyboardUnicodeChunks(for text: String, maxUTF16Units: Int = maxKeyboardUnicodeChunkLength) -> [[UniChar]] {
        precondition(maxUTF16Units > 0, "maxUTF16Units must be positive")

        var chunks: [[UniChar]] = []
        var current: [UniChar] = []

        for character in text {
            let units = Array(String(character).utf16)
            if !current.isEmpty, current.count + units.count > maxUTF16Units {
                chunks.append(current)
                current.removeAll(keepingCapacity: true)
            }

            current.append(contentsOf: units)
        }

        if !current.isEmpty {
            chunks.append(current)
        }

        return chunks
    }

    static func pressKey(_ specification: String, pid: pid_t, windowID: CGWindowID?) throws {
        try stopIfUserIsOperatingTarget(pid: pid)
        try withSyntheticWindowFocus(pid: pid, windowID: windowID) {
            try postKeyPress(specification, pid: pid)
        }
    }

    private static func postKeyPress(_ specification: String, pid: pid_t) throws {
        let parsed = try KeyPressParser.parse(specification)
        var activeFlags: CGEventFlags = []

        for modifier in parsed.modifiers {
            guard let event = CGEvent(keyboardEventSource: nil, virtualKey: modifier.keyCode, keyDown: true) else {
                throw ComputerUseError.message("Failed to create modifier key down event.")
            }

            activeFlags.insert(modifier.flag)
            event.flags = activeFlags
            event.postToPid(pid)
        }

        guard let keyDown = CGEvent(keyboardEventSource: nil, virtualKey: parsed.keyCode, keyDown: true),
              let keyUp = CGEvent(keyboardEventSource: nil, virtualKey: parsed.keyCode, keyDown: false) else {
            throw ComputerUseError.message("Failed to create key event.")
        }

        keyDown.flags = activeFlags
        keyUp.flags = activeFlags
        keyDown.postToPid(pid)
        keyUp.postToPid(pid)

        for modifier in parsed.modifiers.reversed() {
            guard let event = CGEvent(keyboardEventSource: nil, virtualKey: modifier.keyCode, keyDown: false) else {
                throw ComputerUseError.message("Failed to create modifier key up event.")
            }

            event.flags = activeFlags
            event.postToPid(pid)
            activeFlags.remove(modifier.flag)
        }

        Thread.sleep(forTimeInterval: 0.1)
    }

    private static func postMouseEvent(type: CGEventType, source: CGEventSource?, point: CGPoint, button: CGMouseButton, clickState: Int, delta: CGSize? = nil, eventNumber: Int64? = nil) throws {
        guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button) else {
            throw ComputerUseError.message("Failed to create mouse event \(type.rawValue).")
        }

        event.setIntegerValueField(.mouseEventClickState, value: Int64(clickState))
        applyDragMotionFields(to: event, delta: delta, eventNumber: eventNumber)
        event.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.03)
    }

    /// A synthetic macOS drag registers only when each dragged event carries the
    /// per-step movement delta: macOS reads kCGMouseEventDeltaX/Y (both the integer
    /// and double fields), not the absolute position, to decide the pointer moved.
    /// Applied only to drag events (delta != nil); clicks are unchanged.
    private static func applyDragMotionFields(to event: CGEvent, delta: CGSize?, eventNumber: Int64? = nil) {
        if eventNumber != nil || delta != nil {
            event.flags = []
        }
        if let eventNumber {
            event.setIntegerValueField(.mouseEventNumber, value: eventNumber)
        }
        guard let delta else { return }
        let dx = Int64(delta.width.rounded())
        let dy = Int64(delta.height.rounded())
        event.setIntegerValueField(.mouseEventDeltaX, value: dx)
        event.setIntegerValueField(.mouseEventDeltaY, value: dy)
        event.setDoubleValueField(.mouseEventDeltaX, value: Double(dx))
        event.setDoubleValueField(.mouseEventDeltaY, value: Double(dy))
    }

    /// Whether synthetic drag events need a matching gesture event number. Older
    /// macOS ignores it; recent releases require it (codex#43047 reports 26/27).
    static func needsDragEventNumber(majorVersion: Int) -> Bool { majorVersion >= 26 }

    /// A gesture identity shared by the down/dragged/up sequence, seeded above the
    /// system's last event number so recent macOS treats the sequence as one drag.
    private static func dragGestureEventNumber() -> Int64? {
        guard needsDragEventNumber(majorVersion: ProcessInfo.processInfo.operatingSystemVersion.majorVersion) else { return nil }
        let hid = CGEventSourceStateID.hidSystemState
        let base = Int64(CGEventSource.counterForEventType(hid, eventType: .leftMouseDown))
            + Int64(CGEventSource.counterForEventType(hid, eventType: .rightMouseDown))
            + Int64(CGEventSource.counterForEventType(hid, eventType: .otherMouseDown))
        return base + 1
    }

    /// Coarse interpolation makes large per-event jumps that macOS drag recognition
    /// can miss, so scale step count with distance (~4px/step) within a sane range.
    static func dragStepCount(from start: CGPoint, to end: CGPoint) -> Int {
        let distance = hypot(end.x - start.x, end.y - start.y)
        return min(max(Int((distance / 4).rounded(.up)), 10), 60)
    }

    private static func postMouseEventToPid(type: CGEventType, source: CGEventSource, point: CGPoint, button: CGMouseButton, clickState: Int, pid: pid_t) throws {
        guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button) else {
            throw ComputerUseError.message("Failed to create mouse event \(type.rawValue).")
        }

        event.setIntegerValueField(.mouseEventClickState, value: Int64(clickState))
        event.postToPid(pid)
        Thread.sleep(forTimeInterval: 0.03)
    }

    private static func raiseAppWindowViaAccessibility(pid: pid_t) -> Bool {
        let appElement = AXUIElementCreateApplication(pid)
        guard let window = preferredWindow(for: appElement) else {
            return false
        }

        if performAction(named: kAXRaiseAction as String, on: window) {
            return true
        }

        if setBoolAttribute(named: kAXMainAttribute as String, on: window) {
            return true
        }

        if setBoolAttribute(named: kAXFocusedAttribute as String, on: window) {
            return true
        }

        return false
    }

    private static func preferredWindow(for appElement: AXUIElement) -> AXUIElement? {
        copyElement(appElement, attribute: kAXFocusedWindowAttribute)
            ?? copyArray(appElement, attribute: kAXWindowsAttribute)?.first
    }

    private static func performAction(named action: String, on element: AXUIElement) -> Bool {
        guard availableActions(for: element).contains(where: { $0.caseInsensitiveCompare(action) == .orderedSame }) else {
            return false
        }

        return AXUIElementPerformAction(element, action as CFString) == .success
    }

    private static func setBoolAttribute(named attribute: String, on element: AXUIElement) -> Bool {
        guard isSettable(element: element, attribute: attribute) else {
            return false
        }

        return AXUIElementSetAttributeValue(element, attribute as CFString, kCFBooleanTrue) == .success
    }

    private static func isSettable(element: AXUIElement, attribute: String) -> Bool {
        var settable: DarwinBoolean = false
        let result = AXUIElementIsAttributeSettable(element, attribute as CFString, &settable)
        return result == .success && settable.boolValue
    }

    private static func availableActions(for element: AXUIElement) -> [String] {
        var actions: CFArray?
        let result = AXUIElementCopyActionNames(element, &actions)
        guard result == .success, let actions else {
            return []
        }

        return actions as? [String] ?? []
    }

    private static func copyElement(_ element: AXUIElement, attribute: String) -> AXUIElement? {
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
        guard result == .success, let value else {
            return nil
        }

        return (value as! AXUIElement)
    }

    private static func copyArray(_ element: AXUIElement, attribute: String) -> [AXUIElement]? {
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
        guard result == .success, let value else {
            return nil
        }

        return value as? [AXUIElement]
    }

    private static func wheel1(direction: String, pages: Double) -> Int32 {
        switch direction {
        case "up":
            return scrollWheelDelta(for: pages)
        case "down":
            return -scrollWheelDelta(for: pages)
        default:
            return 0
        }
    }

    private static func wheel2(direction: String, pages: Double) -> Int32 {
        switch direction {
        case "left":
            return scrollWheelDelta(for: pages)
        case "right":
            return -scrollWheelDelta(for: pages)
        default:
            return 0
        }
    }

    private static func scrollWheelDelta(for pages: Double) -> Int32 {
        let rawValue = (12.0 * pages).rounded(.toNearestOrAwayFromZero)
        let clamped = min(Double(Int32.max), max(1, rawValue))
        return Int32(clamped)
    }
}
