import AppKit
import ApplicationServices
import CoreGraphics
import XCTest
@testable import MemmyComputerUseKit

final class WindowTargetBindingTests: XCTestCase {
    private struct Window {
        let name: String
        let id: CGWindowID?
        let frame: CGRect
        let title: String
    }

    private let bounds = CGRect(x: 100, y: 70, width: 1000, height: 700)

    private func capture(_ id: CGWindowID, title: String, order: Int = 0,
                         frame: CGRect? = nil) -> WindowCaptureCandidate {
        let frame = frame ?? bounds
        return WindowCaptureCandidate(windowID: id, layer: 0, bounds: frame, title: title,
                                      area: Int(frame.width * frame.height), frontToBackIndex: order)
    }

    private func resolve(_ id: CGWindowID?, focus: Window?, windows: [Window],
                         captures: [WindowCaptureCandidate]) -> (element: Window, capture: WindowCaptureCandidate)? {
        resolveBoundWindow(requestedWindowID: id, focusedWindow: focus, windows: windows,
            candidates: captures, windowID: { $0.id }, frame: { $0.frame }, title: { $0.title })
    }

    func testReadAndAfterActionKeepAXRootAndCaptureOnObservedWindowWhenUserFocusesOverlappingDocument() {
        let a = Window(name: "AI document", id: 101, frame: bounds, title: "Untitled")
        let b = Window(name: "User document", id: 202, frame: bounds, title: "Untitled")
        let captures = [capture(202, title: "Untitled", order: 0), capture(101, title: "Untitled", order: 1)]
        for focus in [a, b] {
            let observed = resolve(101, focus: focus, windows: [b, a], captures: captures)
            XCTAssertEqual(observed?.element.name, "AI document")
            XCTAssertEqual(observed?.capture.windowID, 101)
        }
    }

    func testInitialReadResolvesFocusedAXWindowIDRatherThanAnotherFrontmostWindowWithSameTitle() {
        let a = Window(name: "focused", id: 101, frame: bounds, title: "Untitled")
        let b = Window(name: "frontmost", id: 202, frame: bounds, title: "Untitled")
        let observed = resolve(nil, focus: a, windows: [a, b],
            captures: [capture(202, title: "Untitled"), capture(101, title: "Untitled", order: 1)])
        XCTAssertEqual(observed?.element.name, "focused")
        XCTAssertEqual(observed?.capture.windowID, 101)
    }

    func testNewDocumentIsAvailableButDoesNotRetargetExistingWindowUntilExplicitRead() {
        let home = Window(name: "template", id: 101, frame: bounds, title: "Templates")
        let document = Window(name: "new document", id: 303, frame: bounds, title: "Presentation 1")
        let captures = [capture(303, title: document.title), capture(101, title: home.title, order: 1)]
        let afterAction = resolve(101, focus: document, windows: [home, document], captures: captures)
        XCTAssertEqual(afterAction?.element.name, "template")
        let explicitlyObserved = resolve(303, focus: document, windows: [home, document], captures: captures)
        XCTAssertEqual(explicitlyObserved?.element.name, "new document")
        let inventory = [ObservedAppWindow(windowID: 101, title: home.title, isFocused: false),
                         ObservedAppWindow(windowID: 303, title: document.title, isFocused: true)]
        let text = renderedAvailableWindows(inventory, targetWindowID: 101)
        XCTAssertTrue(text.contains("window_id=303 Presentation 1 [focused]"))
        XCTAssertTrue(text.contains("get_app_state"))
    }

    func testClosedTargetNeverFallsBackToAnotherAppWindowAndReturnsStructuredChoices() throws {
        let other = Window(name: "other", id: 202, frame: bounds, title: "User document")
        XCTAssertNil(resolve(101, focus: other, windows: [other], captures: [capture(202, title: other.title)]))
        let result = TargetWindowUnavailable(windowID: 101, pid: 500,
            availableWindows: [ObservedAppWindow(windowID: 202, title: other.title, isFocused: true)]).toolResult
        let meta = try XCTUnwrap(result.metadata?["memmyComputerUse"] as? [String: Any])
        XCTAssertTrue(result.isError)
        XCTAssertEqual(meta["targetWindowUnavailable"] as? Bool, true)
        XCTAssertEqual(meta["requestedWindowID"] as? Int, 101)
        XCTAssertNil(meta["targetWindowID"])
        XCTAssertEqual((meta["availableWindows"] as? [[String: Any]])?.first?["windowID"] as? Int, 202)
        XCTAssertTrue(result.primaryText?.contains("window_id=202") == true)
    }

    func testUnavailableNativeIdentifierCannotBeRemappedByMatchingTitleAndBounds() {
        let stale = Window(name: "closed", id: 101, frame: bounds, title: "Untitled")
        XCTAssertNil(resolve(101, focus: stale, windows: [stale], captures: [capture(202, title: "Untitled")]))
    }

    func testAssociatedMenuCannotBeReplacedByAnOverlappingUnrelatedDocument() {
        let menu = capture(303, title: "Menu")
        let document = capture(202, title: "Menu")
        XCTAssertNil(exactRelatedWindowCaptureID(windowID: nil, candidates: [document]))
        XCTAssertNil(exactRelatedWindowCaptureID(windowID: 303, candidates: [document]))
        XCTAssertEqual(exactRelatedWindowCaptureID(windowID: 303, candidates: [document, menu]), 303)
    }

    func testGeometryFallbackRequiresUniqueEvidenceForAXWindowWithoutNativeID() {
        let window = Window(name: "AX fallback", id: nil, frame: bounds, title: "Untitled")
        XCTAssertEqual(resolve(101, focus: window, windows: [window],
            captures: [capture(101, title: "Untitled")])?.capture.windowID, 101)
        XCTAssertNil(resolve(101, focus: window, windows: [window],
            captures: [capture(202, title: "Untitled"), capture(101, title: "Untitled")]))
        XCTAssertNil(resolve(101, focus: window, windows: [window],
            captures: [capture(101, title: "Untitled", frame: bounds.offsetBy(dx: 3, dy: 0))]))
    }

    func testWindowInventoryFiltersAnotherPIDBeforeResolvingAnIdenticallyNamedWindow() {
        func info(_ id: UInt32, pid: Int32) -> [String: Any] {
            [kCGWindowNumber as String: NSNumber(value: id), kCGWindowOwnerPID as String: NSNumber(value: pid),
             kCGWindowLayer as String: 0, kCGWindowName as String: "Untitled",
             kCGWindowBounds as String: bounds.dictionaryRepresentation]
        }
        let inventory = windowCaptureCandidates(pid: 500, windowInfo: [info(101, pid: 500), info(202, pid: 600)])
        XCTAssertEqual(inventory.map(\.windowID), [101])
    }

    func testGeometryFallbackDoesNotUseDifferentTitlesToChooseBetweenOverlappingCGWindows() {
        let window = Window(name: "AX fallback", id: nil, frame: bounds, title: "AI document")
        XCTAssertNil(resolve(101, focus: window, windows: [window],
            captures: [capture(101, title: "AI document"), capture(202, title: "User document")]))
    }

    func testGeometryFallbackDoesNotChooseBetweenTwoOverlappingUnknownAXWindowIDs() {
        let a = Window(name: "AI document", id: nil, frame: bounds, title: "AI document")
        let b = Window(name: "User document", id: nil, frame: bounds, title: "User document")
        XCTAssertNil(resolve(101, focus: a, windows: [a, b], captures: [capture(101, title: "AI document")]))
        XCTAssertNil(resolve(nil, focus: a, windows: [a, b], captures: [capture(101, title: "AI document")]))
    }

    func testInterleavedAppWindowsKeepTheirPreviouslyObservedElementIndices() throws {
        struct Snapshot { let elements: [Int: String] }
        var store = WindowSnapshotStore<Snapshot>()
        store.store(Snapshot(elements: [4: "A Save"]), pid: 500, windowID: 101)
        store.store(Snapshot(elements: [4: "B Close"]), pid: 500, windowID: 202)
        store.store(Snapshot(elements: [4: "Other app"]), pid: 600, windowID: 101)
        XCTAssertEqual(try XCTUnwrap(store.snapshot(pid: 500, windowID: 101)).elements[4], "A Save")
        XCTAssertEqual(try XCTUnwrap(store.snapshot(pid: 500, windowID: 202)).elements[4], "B Close")
    }

    func testPIDOnlyInputRequiresAppKeyWindowToMatchObservedWindow() {
        XCTAssertTrue(pidInputMatchesBoundWindow(boundWindowID: 101, focusedWindowID: 101))
        XCTAssertFalse(pidInputMatchesBoundWindow(boundWindowID: 101, focusedWindowID: 202))
        XCTAssertFalse(pidInputMatchesBoundWindow(boundWindowID: 101, focusedWindowID: nil))
        XCTAssertFalse(pidInputMatchesBoundWindow(boundWindowID: nil, focusedWindowID: 101))
    }

    func testSnapshotCacheEvictsOldestWindowAndUpdatesMoveAnExistingWindowToNewest() {
        var store = WindowSnapshotStore<String>(capacity: 2)
        store.store("A first observation", pid: 500, windowID: 101)
        store.store("B observation", pid: 500, windowID: 202)
        store.store("A latest observation", pid: 500, windowID: 101)
        store.store("C observation", pid: 500, windowID: 303)
        XCTAssertNil(store.snapshot(pid: 500, windowID: 202))
        XCTAssertEqual(store.snapshot(pid: 500, windowID: 101), "A latest observation")
        XCTAssertEqual(store.snapshot(pid: 500, windowID: 303), "C observation")
    }

    func testWindowIDParsingRejectsBooleansFractionsZeroOverflowAndStrings() throws {
        XCTAssertNil(try normalizedWindowIDArgument(nil))
        XCTAssertEqual(try normalizedWindowIDArgument(101), 101)
        XCTAssertEqual(try normalizedWindowIDArgument(NSNumber(value: UInt32.max)), UInt32.max)
        let invalidValues: [Any] = [true, 0, -1, 1.5, Double.infinity, Double.nan, UInt64(UInt32.max) + 1, "101"]
        for value in invalidValues {
            XCTAssertThrowsError(try normalizedWindowIDArgument(value))
        }
    }

    func testEveryAppToolAcceptsWindowIDWithoutRequiringItForFirstObservation() throws {
        for tool in ToolDefinitions.all where tool.name != "list_apps" {
            let properties = try XCTUnwrap(tool.inputSchema["properties"] as? [String: Any])
            XCTAssertEqual((properties["window_id"] as? [String: Any])?["type"] as? String, "integer", tool.name)
            XCTAssertFalse((tool.inputSchema["required"] as? [String] ?? []).contains("window_id"), tool.name)
        }
    }
}
