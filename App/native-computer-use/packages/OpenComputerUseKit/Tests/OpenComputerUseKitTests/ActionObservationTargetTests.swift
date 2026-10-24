import AppKit
import ApplicationServices
import XCTest
@testable import MemmyComputerUseKit

final class ActionObservationTargetTests: XCTestCase {
    private final class State {
        var index = 1
        var identifier = "target"
        var label = "Search"
        var remoteText = "banner one"
        var title = "Same title"
        var focus = "1 input"
        var selection: String? = nil
        var relatedWindowIDs: [CGWindowID] = []
        var duplicate = false
        var commands: [FixtureCommand] = []
    }

    private struct Fixture {
        let state = State()
        let service: ComputerUseService

        init() {
            let state = self.state
            let app = RunningAppDescriptor(name: "Scoped Fixture", bundleIdentifier: "test.scoped", pid: 500,
                runningApplication: NSRunningApplication.current)
            service = ComputerUseService(lockScreenState: { .unlocked }, appResolver: { _ in app },
                snapshotLoader: { app, windowID, _, _, _, _ in
                    Self.snapshot(app: app, windowID: windowID ?? 101, state: state)
                }, appIsRunning: { _ in true }, fixtureCommandPoster: { state.commands.append($0) })
        }

        static func snapshot(app: RunningAppDescriptor, windowID: CGWindowID, state: State) -> AppSnapshot {
            let target = ElementRecord(index: state.index, identifier: state.identifier, element: nil,
                localFrame: CGRect(x: 10, y: 10, width: 60, height: 30), role: "AXButton",
                rawActions: ["AXPress", "AXScrollDownByPage"], prettyActions: [])
            var elements = [state.index: target]
            if state.index != 1 {
                elements[1] = ElementRecord(index: 1, identifier: "other", element: nil,
                    localFrame: nil, role: "AXButton", rawActions: [], prettyActions: [])
            }
            if state.duplicate {
                elements[99] = ElementRecord(index: 99, identifier: state.identifier, element: nil,
                    localFrame: target.localFrame, role: target.role, rawActions: target.rawActions, prettyActions: [])
            }
            var snapshot = AppSnapshot(app: app, windowTitle: state.title, windowBounds: nil,
                targetWindowID: windowID, targetWindowLayer: 0, screenshotPNGData: nil,
                mode: .fixture, treeLines: ["\(state.index) button \(state.label)", "100 text \(state.remoteText)"],
                focusedSummary: state.focus, focusedElement: nil, selectedText: state.selection,
                elements: elements, observationNote: nil)
            snapshot.relatedWindowIDs = state.relatedWindowIDs
            return snapshot
        }
    }

    private func metadata(_ result: ToolCallResult) throws -> [String: Any] {
        try XCTUnwrap(result.metadata?["memmyComputerUse"] as? [String: Any])
    }

    private func observe(_ fixture: Fixture) throws -> String {
        try XCTUnwrap(try metadata(fixture.service.getAppState(app: "test.scoped", windowID: 101))["observationID"] as? String)
    }

    private func act(_ fixture: Fixture, token: String, tool: String = "click", arguments: [String: Any] = ["element_index": "1"]) -> ToolCallResult {
        var args = arguments
        args["app"] = "test.scoped"
        args["window_id"] = 101
        args["observation_id"] = token
        return ComputerUseToolDispatcher(service: fixture.service).callToolAsResult(name: tool, arguments: args)
    }

    private let liveAppChurn: [(String, (State) -> Void)] = [
        ("remote text", { $0.remoteText = "banner changed and a node was inserted" }),
        ("target label", { $0.label = "Search (2)" }),
        ("window title", { $0.title = "Same title - Saved" }),
        ("focus", { $0.focus = "7 other input" }),
        ("selection", { $0.selection = "user selection" }),
        ("recreated helper window", { $0.relatedWindowIDs = [11002] }),
    ]

    func testEveryElementToolIgnoresLiveAppChurnAndSafelyRemapsTheObservedTarget() throws {
        for (tool, args) in [("click", ["element_index": "1"]),
                             ("set_value", ["element_index": "1", "value": "new"]),
                             ("scroll", ["element_index": "1", "direction": "down"]),
                             ("perform_secondary_action", ["element_index": "1", "action": "Raise"])] {
            for (name, change) in liveAppChurn {
                let fixture = Fixture()
                let token = try observe(fixture)
                fixture.state.index = 5
                change(fixture.state)
                let result = act(fixture, token: token, tool: tool, arguments: args)
                XCTAssertFalse(result.isError, "\(tool) \(name)")
                XCTAssertNil(try metadata(result)["noActionDispatched"], "\(tool) \(name)")
                if tool != "perform_secondary_action" {
                    XCTAssertEqual(fixture.state.commands.map(\.identifier), ["target"], "\(tool) \(name)")
                }
            }
        }
    }

    func testKeyboardToolsAreSentAcrossLiveAppChurn() throws {
        for (tool, args) in [("type_text", ["text": "你"]), ("press_key", ["key": "Return"])] {
            for (name, change) in liveAppChurn {
                let fixture = Fixture()
                let token = try observe(fixture)
                change(fixture.state)
                let result = act(fixture, token: token, tool: tool, arguments: args)
                XCTAssertFalse(result.isError, "\(tool) \(name)")
                XCTAssertNil(try metadata(result)["noActionDispatched"], "\(tool) \(name)")
                XCTAssertEqual(fixture.state.commands.count, 1, "\(tool) \(name)")
            }
        }
    }

    func testReplacedOrAmbiguousTargetReturnsFreshStateWithoutDispatch() throws {
        let changes: [(String, (State) -> Void)] = [
            ("replacement", { $0.identifier = "replacement" }),
            ("ambiguous identity", { $0.duplicate = true }),
        ]
        for (name, change) in changes {
            let fixture = Fixture()
            let token = try observe(fixture)
            change(fixture.state)
            let result = act(fixture, token: token)
            XCTAssertFalse(result.isError, name)
            XCTAssertEqual(try metadata(result)["noActionDispatched"] as? Bool, true, name)
            XCTAssertNotEqual(try metadata(result)["observationID"] as? String, token, name)
            XCTAssertTrue(fixture.state.commands.isEmpty, name)
        }
    }

    private func nativeSnapshot(records: [ElementRecord], bounds: CGRect? = nil) -> AppSnapshot {
        let app = RunningAppDescriptor(name: "Native", bundleIdentifier: "test.native", pid: 500,
            runningApplication: NSRunningApplication.current)
        return AppSnapshot(app: app, windowTitle: "Document", windowBounds: bounds, targetWindowID: 101,
            targetWindowLayer: 0, screenshotPNGData: nil, mode: .accessibility, treeLines: [],
            focusedSummary: nil, focusedElement: nil, selectedText: nil,
            elements: Dictionary(uniqueKeysWithValues: records.map { ($0.index, $0) }), observationNote: nil)
    }

    private func record(_ index: Int, _ element: AXUIElement, role: String = "AXButton") -> ElementRecord {
        ElementRecord(index: index, identifier: "Save", element: element,
            localFrame: CGRect(x: 10, y: 10, width: 60, height: 30), role: role,
            rawActions: ["AXPress"], prettyActions: [])
    }

    func testSameNameGeometryAndIndexCannotSubstituteADifferentNativeObject() {
        let old = nativeSnapshot(records: [record(1, AXUIElementCreateApplication(800))])
        let fresh = nativeSnapshot(records: [record(1, AXUIElementCreateApplication(801))])
        XCTAssertEqual(validateActionObservation(observed: old, fresh: fresh, intent: .element("1")), .changed)
    }

    func testNativeObjectIsFollowedToItsNewIndexEvenWhenRepeatedButNotAcrossARoleChange() {
        let element = AXUIElementCreateApplication(800)
        let old = nativeSnapshot(records: [record(1, element)])
        let moved = nativeSnapshot(records: [record(1, AXUIElementCreateApplication(801)), record(7, element), record(9, element)])
        XCTAssertEqual(validateActionObservation(observed: old, fresh: moved, intent: .element("1")),
            .unchanged(remappedElementIndex: 7))
        let changedRole = nativeSnapshot(records: [record(1, element, role: "AXStaticText")])
        XCTAssertEqual(validateActionObservation(observed: old, fresh: changedRole, intent: .element("1")), .changed)
        XCTAssertEqual(validateActionObservation(observed: old, fresh: old, intent: .element("2")), .changed)
    }

    func testCoordinatesSurviveAWindowMoveButNotAResize() {
        let observed = nativeSnapshot(records: [], bounds: CGRect(x: 0, y: 0, width: 800, height: 600))
        let moved = nativeSnapshot(records: [], bounds: CGRect(x: 120, y: 80, width: 800, height: 600))
        let resized = nativeSnapshot(records: [], bounds: CGRect(x: 0, y: 0, width: 640, height: 600))
        let intent = ActionObservationIntent.coordinate(.click(CGPoint(x: 20, y: 20)))
        XCTAssertEqual(validateActionObservation(observed: observed, fresh: moved, intent: intent),
            .unchanged(remappedElementIndex: nil))
        XCTAssertEqual(validateActionObservation(observed: observed, fresh: resized, intent: intent), .changed)
    }

    func testAnotherWindowOrProcessNeverValidatesAnObservation() {
        let observed = nativeSnapshot(records: [])
        let otherWindow = AppSnapshot(app: observed.app, windowTitle: observed.windowTitle, windowBounds: nil,
            targetWindowID: 202, targetWindowLayer: 0, screenshotPNGData: nil, mode: .accessibility,
            treeLines: [], focusedSummary: nil, focusedElement: nil, selectedText: nil, elements: [:], observationNote: nil)
        let otherApp = AppSnapshot(app: RunningAppDescriptor(name: "Other", bundleIdentifier: "test.other", pid: 600,
            runningApplication: NSRunningApplication.current), windowTitle: observed.windowTitle, windowBounds: nil,
            targetWindowID: 101, targetWindowLayer: 0, screenshotPNGData: nil, mode: .accessibility,
            treeLines: [], focusedSummary: nil, focusedElement: nil, selectedText: nil, elements: [:], observationNote: nil)
        for fresh in [otherWindow, otherApp] {
            XCTAssertEqual(validateActionObservation(observed: observed, fresh: fresh, intent: .focusedInput), .changed)
        }
    }
}
