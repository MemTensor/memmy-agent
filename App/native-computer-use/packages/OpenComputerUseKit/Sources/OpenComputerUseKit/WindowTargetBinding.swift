import ApplicationServices
import CoreGraphics
import Darwin
import Foundation

struct ObservedAppWindow {
    let windowID: CGWindowID
    let title: String?
    let isFocused: Bool

    var metadata: [String: Any] {
        var value: [String: Any] = ["windowID": Int(windowID), "isFocused": isFocused]
        if let title { value["title"] = title }
        return value
    }
}

struct WindowSnapshotStore<Snapshot> {
    private var snapshots: [String: [(observationID: String?, snapshot: Snapshot)]] = [:]
    private var order: [String] = []
    private let capacity: Int
    private let historyDepth: Int

    init(capacity: Int = 64, historyDepth: Int = 4) {
        self.capacity = max(1, capacity)
        self.historyDepth = max(1, historyDepth)
    }

    // A few earlier observations stay addressable so actions generated from
    // one state in the same batch still resolve their indices in that state.
    mutating func store(_ snapshot: Snapshot, pid: pid_t, windowID: CGWindowID, observationID: String? = nil) {
        let key = "\(pid):\(windowID)"
        var history = snapshots[key] ?? []
        history.append((observationID, snapshot))
        if history.count > historyDepth { history.removeFirst(history.count - historyDepth) }
        snapshots[key] = history
        order.removeAll { $0 == key }
        order.append(key)
        while order.count > capacity { snapshots.removeValue(forKey: order.removeFirst()) }
    }

    func snapshot(pid: pid_t, windowID: CGWindowID) -> Snapshot? {
        snapshots["\(pid):\(windowID)"]?.last?.snapshot
    }

    func snapshot(pid: pid_t, windowID: CGWindowID, observationID: String) -> Snapshot? {
        snapshots["\(pid):\(windowID)"]?.last { $0.observationID == observationID }?.snapshot
    }
}

struct ObservationChanged: Error {
    let toolResult: ToolCallResult
}

enum ActionObservationIntent {
    case element(String)
    case focusedInput
    case coordinate(CoordinateObservationIntent)
    case window
}

enum ActionObservationValidation: Equatable {
    case unchanged(remappedElementIndex: Int?)
    case changed
}

private func sameObservedNativeIdentity(_ observed: AXUIElement?, _ fresh: AXUIElement?) -> Bool {
    guard let observed, let fresh else { return false }
    return CFEqual(observed, fresh)
}

// Only a change that would send the input to a different target blocks it.
// Live apps constantly change banners, popups, focus and unrelated nodes; the
// action result shows that state, so it must not prevent the action itself.
func validateActionObservation(observed: AppSnapshot, fresh: AppSnapshot,
                               intent: ActionObservationIntent) -> ActionObservationValidation {
    guard observed.mode == fresh.mode, observed.app.pid == fresh.app.pid,
          observed.targetWindowID == fresh.targetWindowID else { return .changed }

    switch intent {
    case .element(let requestedIndex):
        guard let index = Int(requestedIndex), let before = observed.elements[index] else { return .changed }
        let native = before.element != nil
        let candidates = fresh.elements.values.filter { after in
            guard before.isSyntheticText == after.isSyntheticText, before.role == after.role else { return false }
            if native || after.element != nil { return sameObservedNativeIdentity(before.element, after.element) }
            return observed.mode == .fixture && before.identifier != nil && before.identifier == after.identifier
        }
        // Repeated records of one native object are the same target. Fixture
        // identifiers are labels, so more than one match is ambiguous.
        let target = native ? candidates.min { $0.index < $1.index } : (candidates.count == 1 ? candidates.first : nil)
        guard let target else { return .changed }
        return .unchanged(remappedElementIndex: target.index)
    case .coordinate:
        // Pixels are mapped through the window's current origin. A new size
        // can reflow the content underneath the observed pixels.
        guard observed.windowBounds?.size == fresh.windowBounds?.size else { return .changed }
        return .unchanged(remappedElementIndex: nil)
    case .focusedInput, .window:
        return .unchanged(remappedElementIndex: nil)
    }
}

struct TargetWindowUnavailable: LocalizedError {
    let windowID: CGWindowID
    let pid: pid_t
    let availableWindows: [ObservedAppWindow]
    /// The window closed after the action was sent, as a dialog or popup does
    /// once its command runs; that is a result, not a withheld action.
    var closedAfterAction = false

    var errorDescription: String? {
        let lead = closedAfterAction
            ? "The action was sent, and window \(windowID) then closed, as a dialog or popup does after its command. Do not repeat the action. Call get_app_state with the window_id where its result should appear.\n"
            : "Target window \(windowID) is unavailable. The action was not replayed. Choose an available window and call get_app_state with its window_id.\n"
        return lead + renderedAvailableWindows(availableWindows, targetWindowID: windowID)
    }

    var toolResult: ToolCallResult {
        ToolCallResult(content: [.text(errorDescription!)], isError: !closedAfterAction, metadata: ["memmyComputerUse": [
            "targetWindowUnavailable": true,
            "closedAfterAction": closedAfterAction,
            "requestedWindowID": Int(windowID),
            "pid": Int(pid),
            "availableWindows": availableWindows.map(\.metadata),
        ]])
    }
}

func renderedAvailableWindows(_ windows: [ObservedAppWindow], targetWindowID: CGWindowID?) -> String {
    guard !windows.isEmpty else { return "Available windows: none." }
    return (["Available windows (select with get_app_state app/window_id):"] + windows.map { window in
        let flags = [window.windowID == targetWindowID ? "target" : nil, window.isFocused ? "focused" : nil]
            .compactMap { $0 }.joined(separator: ", ")
        let title = window.title?.replacingOccurrences(of: "\n", with: " ") ?? "Untitled"
        return "- window_id=\(window.windowID) \(title)\(flags.isEmpty ? "" : " [\(flags)]")"
    }).joined(separator: "\n")
}

// A title or z-order alone cannot connect an AX tree to a CG window. Prefer
// the native identifier and only use geometry when it gives a unique match.
private func windowBindingFramesMatch(_ first: CGRect, _ second: CGRect) -> Bool {
    abs(first.minX - second.minX) <= 1 && abs(first.minY - second.minY) <= 1
        && abs(first.width - second.width) <= 1 && abs(first.height - second.height) <= 1
}

func matchedWindowCaptureCandidate(
    windowID: CGWindowID?, frame: CGRect?, title: String?, candidates: [WindowCaptureCandidate]
) -> WindowCaptureCandidate? {
    if let windowID {
        return candidates.first { $0.windowID == windowID }
    }
    guard let frame, !frame.isEmpty else { return nil }
    let matches = candidates.filter { windowBindingFramesMatch($0.bounds, frame) }
    return matches.count == 1 ? matches[0] : nil
}

// Supplemental AX windows cannot use geometry to substitute a missing native ID.
func exactRelatedWindowCaptureID(windowID: CGWindowID?, candidates: [WindowCaptureCandidate]) -> CGWindowID? {
    guard let windowID, windowID > 0 else { return nil }
    return candidates.first { $0.windowID == windowID }?.windowID
}

func resolveBoundWindow<Element>(
    requestedWindowID: CGWindowID?, focusedWindow: Element?, windows: [Element],
    candidates: [WindowCaptureCandidate],
    windowID: (Element) -> CGWindowID?, frame: (Element) -> CGRect?, title: (Element) -> String?
) -> (element: Element, capture: WindowCaptureCandidate)? {
    func resolve(_ element: Element) -> WindowCaptureCandidate? {
        guard let capture = matchedWindowCaptureCandidate(windowID: windowID(element), frame: frame(element),
                                                           title: title(element), candidates: candidates) else { return nil }
        if windowID(element) == nil {
            // Unique CG geometry is insufficient if two AX roots have those
            // same bounds. Neither title nor focus proves which AX root owns it.
            let matchingAXWindows = windows.filter {
                frame($0).map { windowBindingFramesMatch($0, capture.bounds) } ?? false
            }
            guard matchingAXWindows.count == 1 else { return nil }
        }
        return capture
    }
    if let requestedWindowID {
        // Never fall back to the focused or frontmost window for an explicit ID.
        for element in windows {
            if let capture = resolve(element), capture.windowID == requestedWindowID {
                return (element, capture)
            }
        }
        return nil
    }
    if let focusedWindow, let capture = resolve(focusedWindow) { return (focusedWindow, capture) }
    for element in windows {
        if let capture = resolve(element) { return (element, capture) }
    }
    return nil
}

enum AXWindowIdentity {
    private typealias GetWindow = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError

    static func windowID(of window: AXUIElement) -> CGWindowID? {
        guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "_AXUIElementGetWindow") else { return nil }
        let getWindow = unsafeBitCast(symbol, to: GetWindow.self)
        var identifier: CGWindowID = 0
        return getWindow(window, &identifier) == .success && identifier != 0 ? identifier : nil
    }

    static func contains(_ element: AXUIElement, in window: AXUIElement) -> Bool {
        if CFEqual(element, window) { return true }
        if let owner = copyElement(element, attribute: kAXWindowAttribute), CFEqual(owner, window) { return true }
        var current = element
        for _ in 0..<64 {
            guard let parent = copyElement(current, attribute: kAXParentAttribute), !CFEqual(parent, current) else { return false }
            if CFEqual(parent, window) { return true }
            current = parent
        }
        return false
    }

    static func copyElement(_ element: AXUIElement, attribute: String) -> AXUIElement? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
              let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return unsafeDowncast(value, to: AXUIElement.self)
    }
}

func pidInputMatchesBoundWindow(boundWindowID: CGWindowID?, focusedWindowID: CGWindowID?) -> Bool {
    guard let boundWindowID, boundWindowID != 0, let focusedWindowID else { return false }
    return boundWindowID == focusedWindowID
}
