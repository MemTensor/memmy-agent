import AppKit
import ApplicationServices
import XCTest
@testable import MemmyComputerUseKit

final class ObservationIdentityTests: XCTestCase {
    private final class Fixture {
        var dispatchedCommands: [FixtureCommand] = []
        var loadCount = 0
        var transform: (AppSnapshot) -> AppSnapshot = { $0 }
        let service: ComputerUseService

        init(snapshotWindowID: CGWindowID? = 101) {
            let app = RunningAppDescriptor(name: "Observation Fixture", bundleIdentifier: "test.observation",
                pid: 500, runningApplication: NSRunningApplication.current)
            var commands: ((FixtureCommand) -> Void)?
            var snapshotHook: ((AppSnapshot) -> AppSnapshot)?
            service = ComputerUseService(lockScreenState: { .unlocked }, appResolver: { _ in app },
                snapshotLoader: { app, windowID, _, limits, _, _ in
                    let identifier = limits.maxNodeCount == 1 ? "B control" : "A control"
                    let record = ElementRecord(index: 1, identifier: identifier, element: nil,
                        localFrame: nil, role: kAXButtonRole as String, rawActions: [], prettyActions: [])
                    let snapshot = AppSnapshot(app: app, windowTitle: "Document", windowBounds: nil,
                        targetWindowID: windowID ?? snapshotWindowID, targetWindowLayer: 0, screenshotPNGData: nil,
                        mode: .fixture, treeLines: ["1 button \(identifier)"], focusedSummary: nil,
                        focusedElement: nil, selectedText: nil, elements: [1: record], observationNote: nil)
                    return snapshotHook?(snapshot) ?? snapshot
                }, appIsRunning: { _ in true }, fixtureCommandPoster: { command in commands?(command) })
            commands = { [weak self] command in self?.dispatchedCommands.append(command) }
            snapshotHook = { [weak self] snapshot in
                self?.loadCount += 1
                return self?.transform(snapshot) ?? snapshot
            }
        }
    }

    private func meta(_ result: ToolCallResult) throws -> [String: Any] {
        try XCTUnwrap(result.metadata?["memmyComputerUse"] as? [String: Any])
    }

    private func token(_ result: ToolCallResult) throws -> String {
        try XCTUnwrap(try meta(result)["observationID"] as? String)
    }

    func testRelatedWindowProofSurvivesObservationNotesAndUsesBoundedNativeMetadata() throws {
        let fixture = Fixture()
        fixture.transform = { snapshot in
            var related = snapshot
            related.relatedWindowIDs = [0, 101, 202, 202, 203]
            return related.withObservationNote("Refresh required")
        }
        let state = try fixture.service.getAppState(app: "test.observation", windowID: 101)
        XCTAssertEqual(try meta(state)["relatedWindowIDs"] as? [Int], [202, 203])
        fixture.transform = { snapshot in
            var related = snapshot
            related.relatedWindowIDs = Array(CGWindowID(200)...CGWindowID(299))
            return related
        }
        let bounded = try fixture.service.getAppState(app: "test.observation", windowID: 101)
        XCTAssertEqual((try meta(bounded)["relatedWindowIDs"] as? [Int])?.count, 64)
    }

    func testOlderRetainedObservationResolvesItsOwnIndicesAfterAnotherRead() throws {
        let fixture = Fixture()
        let a = try fixture.service.getAppState(app: "test.observation", windowID: 101)
        let aToken = try token(a)
        let b = try fixture.service.getAppState(app: "test.observation", windowID: 101,
            treeLimits: AccessibilityTreeLimits.defaults.replacing(maxNodeCount: 1, maxDepth: nil))
        XCTAssertNotEqual(aToken, try token(b))
        let result = ComputerUseToolDispatcher(service: fixture.service).callToolAsResult(name: "click",
            arguments: ["app": "test.observation", "window_id": 101, "observation_id": aToken, "element_index": "1"])
        XCTAssertFalse(result.isError)
        XCTAssertNil(try meta(result)["noActionDispatched"])
        XCTAssertEqual(fixture.dispatchedCommands.map(\.identifier), ["A control"])
        XCTAssertNotEqual(try token(result), aToken)
    }

    func testActionsBatchedFromOneObservationAllResolveInThatObservation() throws {
        let fixture = Fixture()
        let state = try fixture.service.getAppState(app: "test.observation", windowID: 101)
        let dispatcher = ComputerUseToolDispatcher(service: fixture.service)
        for (name, arguments) in [("click", ["element_index": "1"]), ("type_text", ["text": "你"]),
                                  ("type_text", ["text": "好"]), ("click", ["element_index": "1"])] {
            var request: [String: Any] = arguments
            request["app"] = "test.observation"
            request["window_id"] = 101
            request["observation_id"] = try token(state)
            let result = dispatcher.callToolAsResult(name: name, arguments: request)
            XCTAssertFalse(result.isError, name)
            XCTAssertNil(try meta(result)["noActionDispatched"], name)
        }
        XCTAssertEqual(fixture.dispatchedCommands.map(\.kind), ["click", "type_text", "type_text", "click"])
        XCTAssertEqual(fixture.dispatchedCommands.compactMap(\.value), ["你", "好"])
    }

    func testEveryMutatingToolRejectsAnObservationNoLongerRetained() throws {
        let fixture = Fixture()
        let dispatcher = ComputerUseToolDispatcher(service: fixture.service)
        let mutations: [(String, [String: Any])] = [
            ("click", ["element_index": "1"]), ("drag", ["from_x": 1, "from_y": 1, "to_x": 2, "to_y": 2]),
            ("perform_secondary_action", ["element_index": "1", "action": "Raise"]),
            ("press_key", ["key": "Return"]), ("scroll", ["element_index": "1", "direction": "down"]),
            ("set_value", ["element_index": "1", "value": "new"]), ("type_text", ["text": "new"]),
        ]
        for (name, arguments) in mutations {
            let modelState = try fixture.service.getAppState(app: "test.observation", windowID: 101)
            for _ in 0..<4 { _ = try fixture.service.getAppState(app: "test.observation", windowID: 101) }
            for staleToken in [try token(modelState), "never-issued"] {
                var request = arguments
                request["app"] = "test.observation"
                request["window_id"] = 101
                request["observation_id"] = staleToken
                let result = dispatcher.callToolAsResult(name: name, arguments: request)
                XCTAssertFalse(result.isError, name)
                XCTAssertEqual(try meta(result)["noActionDispatched"] as? Bool, true, name)
                XCTAssertEqual(try meta(result)["stateChanged"] as? Bool, true, name)
                XCTAssertTrue(result.primaryText?.contains("No action was dispatched") == true, name)
                XCTAssertNotEqual(try token(result), staleToken, name)
            }
        }
        XCTAssertTrue(fixture.dispatchedCommands.isEmpty)
    }

    func testUnchangedCurrentTokenDispatchesExactlyOneCommandAndReturnsNewObservation() throws {
        let fixture = Fixture()
        let initial = try fixture.service.getAppState(app: "test.observation", windowID: 101)
        let dispatcher = ComputerUseToolDispatcher(service: fixture.service)
        let result = dispatcher.callToolAsResult(name: "type_text", arguments: ["app": "test.observation",
            "window_id": 101, "observation_id": try token(initial), "text": "hello"])
        XCTAssertFalse(result.isError)
        XCTAssertEqual(fixture.dispatchedCommands.count, 1)
        XCTAssertEqual(fixture.dispatchedCommands.first?.kind, "type_text")
        XCTAssertEqual(fixture.dispatchedCommands.first?.value, "hello")
        XCTAssertNotEqual(try token(initial), try token(result))
        XCTAssertTrue(result.primaryText?.contains("Observation ID=") == true)
        XCTAssertEqual(fixture.loadCount, 3, "initial observation, pre-dispatch bound refresh, action feedback")
    }

    private func changing(_ snapshot: AppSnapshot, tree: [String]? = nil, selection: String? = nil,
                          focus: String? = nil, bounds: CGRect? = nil, frame: CGRect? = nil,
                          screenshot: Data? = nil, title: String? = nil,
                          additionalElement: ElementRecord? = nil) -> AppSnapshot {
        let record = snapshot.elements[1]!
        var elements = frame.map { frame in
            [1: ElementRecord(index: record.index, identifier: record.identifier, element: record.element,
                localFrame: frame, role: record.role, rawActions: record.rawActions, prettyActions: record.prettyActions)]
        } ?? snapshot.elements
        if let additionalElement { elements[additionalElement.index] = additionalElement }
        return AppSnapshot(app: snapshot.app, windowTitle: title ?? snapshot.windowTitle,
            windowBounds: bounds ?? snapshot.windowBounds, targetWindowID: snapshot.targetWindowID,
            targetWindowLayer: snapshot.targetWindowLayer, screenshotPNGData: screenshot ?? snapshot.screenshotPNGData,
            mode: snapshot.mode, treeLines: tree ?? snapshot.treeLines, focusedSummary: focus ?? snapshot.focusedSummary,
            focusedElement: snapshot.focusedElement, selectedText: selection ?? snapshot.selectedText,
            elements: elements, observationNote: snapshot.observationNote)
    }

    func testUnrelatedContentSelectionFocusAndGeometryChangesDoNotBlockAnElementAction() throws {
        let changes: [(String, (AppSnapshot) -> AppSnapshot)] = [
            ("content", { self.changing($0, tree: ["1 button Updated by user"]) }),
            ("selection", { self.changing($0, selection: "User selected text") }),
            ("focus", { self.changing($0, focus: "2 text field") }),
            ("window geometry", { self.changing($0, bounds: CGRect(x: 10, y: 10, width: 700, height: 400)) }),
            ("element geometry", { self.changing($0, frame: CGRect(x: 100, y: 200, width: 40, height: 20)) }),
        ]
        for (name, change) in changes {
            let fixture = Fixture()
            let initial = try fixture.service.getAppState(app: "test.observation", windowID: 101)
            fixture.transform = change
            let dispatcher = ComputerUseToolDispatcher(service: fixture.service)
            let result = dispatcher.callToolAsResult(name: "click", arguments: ["app": "test.observation",
                "window_id": 101, "observation_id": try token(initial), "element_index": "1"])
            XCTAssertFalse(result.isError, name)
            XCTAssertEqual(fixture.dispatchedCommands.map(\.identifier), ["A control"], name)
            XCTAssertNil(try meta(result)["noActionDispatched"], name)
            XCTAssertEqual(fixture.loadCount, 3, name)
        }
    }

    func testMetadataAndScreenshotOnlyChangesDoNotBlockSemanticAction() throws {
        let fixture = Fixture()
        let initial = try fixture.service.getAppState(app: "test.observation", windowID: 101)
        fixture.transform = { snapshot in
            var changed = self.changing(snapshot, screenshot: Data([1, 2, 3]))
            changed.availableWindows = [ObservedAppWindow(windowID: 202, title: "Other window", isFocused: true)]
            changed.observationID = "different-before-service-stamp"
            return changed
        }
        let dispatcher = ComputerUseToolDispatcher(service: fixture.service)
        let result = dispatcher.callToolAsResult(name: "click", arguments: ["app": "test.observation",
            "window_id": 101, "observation_id": try token(initial), "element_index": "1"])
        XCTAssertFalse(result.isError)
        XCTAssertEqual(fixture.dispatchedCommands.count, 1)
        XCTAssertNil(try meta(result)["noActionDispatched"])
    }

    func testPreDispatchReadPreservesNonDefaultTreeLimitsInsteadOfReindexing() throws {
        let fixture = Fixture()
        let state = try fixture.service.getAppState(app: "test.observation", windowID: 101,
            textLimit: .max, treeLimits: AccessibilityTreeLimits.defaults.replacing(maxNodeCount: 1, maxDepth: 1))
        let dispatcher = ComputerUseToolDispatcher(service: fixture.service)
        let result = dispatcher.callToolAsResult(name: "click", arguments: ["app": "test.observation",
            "window_id": 101, "observation_id": try token(state), "element_index": "1"])
        XCTAssertFalse(result.isError)
        XCTAssertEqual(fixture.dispatchedCommands.map(\.identifier), ["B control"])
        XCTAssertNil(try meta(result)["noActionDispatched"])
    }

    func testObservationIDInputRequiresAnOpaqueNonEmptyString() throws {
        XCTAssertNil(try normalizedObservationIDArgument(nil))
        XCTAssertEqual(try normalizedObservationIDArgument("opaque-token"), "opaque-token")
        let invalidValues: [Any] = ["", 123, true, String(repeating: "x", count: 129)]
        for invalid in invalidValues {
            XCTAssertThrowsError(try normalizedObservationIDArgument(invalid))
        }
    }

    private func cover(_ point: CGPoint) -> CGRect {
        CGRect(x: point.x - 8, y: point.y - 8, width: 16, height: 16)
    }

    func testCoordinateClickComparesTheActualPNGPatchBeforeProductionDispatch() throws {
        let baseline = try regionSafetyTestPNG()
        let frame = CGRect(x: 0, y: 0, width: 128, height: 128)
        for (changedPoint, shouldDispatch) in [(CGPoint(x: 20, y: 20), false),
                                               (CGPoint(x: 120, y: 120), true)] {
            let fixture = Fixture()
            fixture.transform = { self.changing($0, frame: frame, screenshot: baseline) }
            let state = try fixture.service.getAppState(app: "test.observation", windowID: 101)
            let updated = try regionSafetyTestPNG(changedRects: [cover(changedPoint)])
            fixture.transform = { self.changing($0, frame: frame, screenshot: updated) }
            let result = ComputerUseToolDispatcher(service: fixture.service).callToolAsResult(name: "click",
                arguments: ["app": "test.observation", "window_id": 101,
                            "observation_id": try token(state), "x": 20, "y": 20])
            XCTAssertFalse(result.isError)
            XCTAssertEqual(fixture.dispatchedCommands.count, shouldDispatch ? 1 : 0)
            XCTAssertEqual(try meta(result)["noActionDispatched"] as? Bool, shouldDispatch ? nil : true)
            if shouldDispatch {
                XCTAssertEqual(fixture.dispatchedCommands.first?.kind, "click")
                XCTAssertEqual(fixture.dispatchedCommands.first?.x, 20)
                XCTAssertEqual(fixture.dispatchedCommands.first?.y, 20)
            }
        }
    }

    func testCoordinateClickAndDragIgnoreDistantPixelsAndUnrelatedAccessibilityChurn() throws {
        let baseline = try regionSafetyTestPNG()
        let changed = try regionSafetyTestPNG(changedPixels: [CGPoint(x: 120, y: 120)])
        let frame = CGRect(x: 0, y: 0, width: 128, height: 128)
        for (tool, action) in [("click", ["x": 20, "y": 20]),
                               ("drag", ["from_x": 10, "from_y": 10, "to_x": 40, "to_y": 40])] {
            let fixture = Fixture()
            fixture.transform = { self.changing($0, frame: frame, screenshot: baseline) }
            let state = try fixture.service.getAppState(app: "test.observation", windowID: 101)
            fixture.transform = {
                self.changing($0, tree: ["1 button A control", "2 static text New carousel caption"],
                    frame: frame, screenshot: changed, additionalElement: ElementRecord(index: 2,
                        identifier: "carousel", element: nil,
                        localFrame: CGRect(x: 110, y: 110, width: 18, height: 18),
                        role: kAXStaticTextRole as String, rawActions: [], prettyActions: []))
            }
            var arguments: [String: Any] = action
            arguments["app"] = "test.observation"
            arguments["window_id"] = 101
            arguments["observation_id"] = try token(state)
            let result = ComputerUseToolDispatcher(service: fixture.service).callToolAsResult(name: tool, arguments: arguments)
            XCTAssertFalse(result.isError, tool)
            XCTAssertEqual(fixture.dispatchedCommands.count, 1, tool)
            XCTAssertNil(try meta(result)["noActionDispatched"], tool)
        }
    }

    private func coordinateClick(after change: @escaping (AppSnapshot) -> AppSnapshot,
                                 bounds: CGRect? = nil) throws -> (fixture: Fixture, result: ToolCallResult) {
        let baseline = try regionSafetyTestPNG()
        let frame = CGRect(x: 0, y: 0, width: 128, height: 128)
        let fixture = Fixture()
        fixture.transform = { self.changing($0, bounds: bounds, frame: frame, screenshot: baseline) }
        let state = try fixture.service.getAppState(app: "test.observation", windowID: 101)
        fixture.transform = { change(self.changing($0, bounds: bounds, frame: frame, screenshot: baseline)) }
        let result = ComputerUseToolDispatcher(service: fixture.service).callToolAsResult(name: "click",
            arguments: ["app": "test.observation", "window_id": 101,
                        "observation_id": try token(state), "x": 20, "y": 20])
        return (fixture, result)
    }

    func testCoordinateActionIgnoresTitleFocusSelectionMovesAndOwnedPopupsElsewhere() throws {
        let elsewhere = try regionSafetyTestPNG(changedRects: [CGRect(x: 90, y: 90, width: 38, height: 38)])
        let window = CGRect(x: 0, y: 0, width: 128, height: 128)
        let changes: [(String, CGRect?, (AppSnapshot) -> AppSnapshot)] = [
            ("title", nil, { self.changing($0, title: "Other page") }),
            ("selection", nil, { self.changing($0, selection: "User selected text") }),
            ("focus", nil, { self.changing($0, focus: "2 text field") }),
            ("moved window", window, { self.changing($0, bounds: window.offsetBy(dx: 40, dy: 30)) }),
            ("owned popup elsewhere", nil, { snapshot in
                var changed = self.changing(snapshot, screenshot: elsewhere)
                changed.relatedWindowIDs = [202]
                return changed
            }),
        ]
        for (name, bounds, change) in changes {
            let (fixture, result) = try coordinateClick(after: change, bounds: bounds)
            XCTAssertFalse(result.isError, name)
            XCTAssertEqual(fixture.dispatchedCommands.count, 1, name)
            XCTAssertNil(try meta(result)["noActionDispatched"], name)
        }
    }

    func testCoordinateActionRejectsAResizedWindowOrACoveredTarget() throws {
        let covered = try regionSafetyTestPNG(changedRects: [cover(CGPoint(x: 20, y: 20))])
        let window = CGRect(x: 0, y: 0, width: 128, height: 128)
        let changes: [(String, CGRect?, (AppSnapshot) -> AppSnapshot)] = [
            ("resized window", window, { self.changing($0, bounds: CGRect(x: 0, y: 0, width: 100, height: 128)) }),
            ("covered target", nil, { self.changing($0, screenshot: covered) }),
        ]
        for (name, bounds, change) in changes {
            let (fixture, result) = try coordinateClick(after: change, bounds: bounds)
            XCTAssertFalse(result.isError, name)
            XCTAssertTrue(fixture.dispatchedCommands.isEmpty, name)
            XCTAssertEqual(try meta(result)["noActionDispatched"] as? Bool, true, name)
        }
    }

    func testAnimatedCoordinateTargetIsSentWhenChosenAgainFromTheReturnedState() throws {
        let baseline = try regionSafetyTestPNG()
        let animated = [try regionSafetyTestPNG(changedRects: [CGRect(x: 0, y: 0, width: 128, height: 64)]), baseline]
        let frame = CGRect(x: 0, y: 0, width: 128, height: 128)
        for (retryX, shouldDispatch) in [(24, true), (60, false)] {
            let fixture = Fixture()
            fixture.transform = { self.changing($0, frame: frame, screenshot: baseline) }
            let initial = try fixture.service.getAppState(app: "test.observation", windowID: 101)
            var frameNumber = 0
            fixture.transform = { snapshot in
                frameNumber += 1
                return self.changing(snapshot, frame: frame, screenshot: animated[(frameNumber - 1) % 2])
            }
            let dispatcher = ComputerUseToolDispatcher(service: fixture.service)
            func click(_ x: Int, _ token: String) -> ToolCallResult {
                dispatcher.callToolAsResult(name: "click", arguments: ["app": "test.observation", "window_id": 101,
                    "observation_id": token, "x": x, "y": 20])
            }
            let withheld = click(20, try token(initial))
            XCTAssertEqual(try meta(withheld)["noActionDispatched"] as? Bool, true)
            XCTAssertTrue(withheld.primaryText?.contains("send it again with this observation_id") == true)
            XCTAssertTrue(fixture.dispatchedCommands.isEmpty)

            let retry = click(retryX, try token(withheld))
            XCTAssertFalse(retry.isError)
            XCTAssertEqual(fixture.dispatchedCommands.count, shouldDispatch ? 1 : 0, "retry x=\(retryX)")
            XCTAssertEqual(try meta(retry)["noActionDispatched"] as? Bool, shouldDispatch ? nil : true, "retry x=\(retryX)")
        }
    }

    func testElementAndKeyboardActionsIgnoreUnrelatedTreeChurn() throws {
        for (tool, action) in [("click", ["element_index": "1"]),
                               ("press_key", ["key": "Return"]), ("type_text", ["text": "hello"])] {
            let fixture = Fixture()
            let state = try fixture.service.getAppState(app: "test.observation", windowID: 101)
            fixture.transform = { self.changing($0, tree: ["1 button A control", "2 dynamic caption"]) }
            var arguments: [String: Any] = action
            arguments["app"] = "test.observation"
            arguments["window_id"] = 101
            arguments["observation_id"] = try token(state)
            let result = ComputerUseToolDispatcher(service: fixture.service).callToolAsResult(name: tool, arguments: arguments)
            XCTAssertFalse(result.isError, tool)
            XCTAssertNil(try meta(result)["noActionDispatched"], tool)
            XCTAssertEqual(fixture.dispatchedCommands.count, 1, tool)
        }
    }

    func testCoordinateScrollChecksTargetImageBeforeDispatch() throws {
        let baseline = try regionSafetyTestPNG()
        let updated = try regionSafetyTestPNG(changedRects: [cover(CGPoint(x: 20, y: 20))])
        let frame = CGRect(x: 0, y: 0, width: 128, height: 128)
        let fixture = Fixture()
        fixture.transform = { self.changing($0, frame: frame, screenshot: baseline) }
        let state = try fixture.service.getAppState(app: "test.observation", windowID: 101)
        fixture.transform = { self.changing($0, frame: frame, screenshot: updated) }
        let result = ComputerUseToolDispatcher(service: fixture.service).callToolAsResult(name: "scroll",
            arguments: ["app": "test.observation", "window_id": 101,
                        "observation_id": try token(state), "x": 20, "y": 20,
                        "direction": "down", "pages": 1])
        XCTAssertFalse(result.isError)
        XCTAssertTrue(fixture.dispatchedCommands.isEmpty)
        XCTAssertEqual(try meta(result)["noActionDispatched"] as? Bool, true)
        XCTAssertTrue(result.primaryText?.contains("covers the coordinate target") == true)
    }

    func testDragComparesPathPNGPatchesBeforeProductionDispatch() throws {
        let baseline = try regionSafetyTestPNG()
        for (changedRect, shouldDispatch) in [(cover(CGPoint(x: 60, y: 60)), false),
                                              (CGRect(x: 116, y: 0, width: 12, height: 10), true)] {
            let fixture = Fixture()
            fixture.transform = { self.changing($0, screenshot: baseline) }
            let state = try fixture.service.getAppState(app: "test.observation", windowID: 101)
            let updated = try regionSafetyTestPNG(changedRects: [changedRect])
            fixture.transform = { self.changing($0, screenshot: updated) }
            let result = ComputerUseToolDispatcher(service: fixture.service).callToolAsResult(name: "drag",
                arguments: ["app": "test.observation", "window_id": 101,
                            "observation_id": try token(state), "from_x": 10, "from_y": 10,
                            "to_x": 110, "to_y": 110])
            XCTAssertFalse(result.isError)
            XCTAssertEqual(fixture.dispatchedCommands.count, shouldDispatch ? 1 : 0)
            XCTAssertEqual(try meta(result)["noActionDispatched"] as? Bool, shouldDispatch ? nil : true)
            if shouldDispatch { XCTAssertEqual(fixture.dispatchedCommands.first?.kind, "drag") }
        }
    }

    func testMissingOrResizedPNGNeverDispatchesPreviouslyObservedCoordinates() throws {
        let baseline = try regionSafetyTestPNG()
        let smaller = try regionSafetyTestPNG(width: 64, height: 64)
        let frame = CGRect(x: 0, y: 0, width: 128, height: 128)
        for updated in [nil, smaller] as [Data?] {
            let fixture = Fixture()
            fixture.transform = { self.changing($0, frame: frame, screenshot: baseline) }
            let state = try fixture.service.getAppState(app: "test.observation", windowID: 101)
            fixture.transform = { self.changing($0, frame: frame, screenshot: updated) }
            let result = ComputerUseToolDispatcher(service: fixture.service).callToolAsResult(name: "click",
                arguments: ["app": "test.observation", "window_id": 101,
                            "observation_id": try token(state), "x": 20, "y": 20])
            XCTAssertTrue(fixture.dispatchedCommands.isEmpty)
            XCTAssertEqual(try meta(result)["noActionDispatched"] as? Bool, true)
        }
    }

    func testEvictedWindowObservationReturnsFreshStateWithoutDispatch() throws {
        let fixture = Fixture()
        let first = try fixture.service.getAppState(app: "test.observation", windowID: 101)
        for windowID in CGWindowID(102)...CGWindowID(165) {
            _ = try fixture.service.getAppState(app: "test.observation", windowID: windowID)
        }
        let result = ComputerUseToolDispatcher(service: fixture.service).callToolAsResult(name: "click",
            arguments: ["app": "test.observation", "window_id": 101,
                        "observation_id": try token(first), "element_index": "1"])
        XCTAssertTrue(fixture.dispatchedCommands.isEmpty)
        XCTAssertFalse(result.isError)
        XCTAssertEqual(try meta(result)["noActionDispatched"] as? Bool, true)
        XCTAssertEqual(try meta(result)["targetWindowID"] as? Int, 101)
        XCTAssertTrue(result.primaryText?.contains("evicted") == true)
        XCTAssertNotEqual(try token(result), try token(first))
    }

    func testCommandOnlyFixtureWithoutCGWindowIDKeepsItsObservationTokensInBoundedHistory() throws {
        let fixture = Fixture(snapshotWindowID: nil)
        let state = try fixture.service.getAppState(app: "test.observation")
        XCTAssertNil(try meta(state)["targetWindowID"])
        let dispatcher = ComputerUseToolDispatcher(service: fixture.service)
        func click() -> ToolCallResult {
            dispatcher.callToolAsResult(name: "click", arguments: ["app": "test.observation",
                "observation_id": (try? token(state)) ?? "", "element_index": "1"])
        }
        let result = click()
        XCTAssertFalse(result.isError)
        XCTAssertNil(try meta(result)["noActionDispatched"])
        XCTAssertNil(try meta(click())["noActionDispatched"])
        XCTAssertEqual(fixture.dispatchedCommands.count, 2)
        for _ in 0..<4 { _ = try fixture.service.getAppState(app: "test.observation") }
        let stale = click()
        XCTAssertEqual(fixture.dispatchedCommands.count, 2)
        XCTAssertEqual(try meta(stale)["noActionDispatched"] as? Bool, true)
    }
}
