import AppKit
import ApplicationServices
import Foundation
import XCTest
@testable import MemmyComputerUseKit

final class MCPObservationResultTests: XCTestCase {
    private final class FixtureState {
        var elementReplaced = false
        var windowUnavailable = false
        var dispatchedCommands: [FixtureCommand] = []
    }

    private struct Fixture {
        let state = FixtureState()
        let server: StdioMCPServer
        let screenshot: Data

        init() throws {
            screenshot = try regionSafetyTestPNG()
            let state = self.state
            let screenshot = self.screenshot
            let app = RunningAppDescriptor(name: "MCP Observation Fixture",
                bundleIdentifier: "test.mcp.observation", pid: 500,
                runningApplication: NSRunningApplication.current)
            let service = ComputerUseService(lockScreenState: { .unlocked }, appResolver: { _ in app },
                snapshotLoader: { app, windowID, _, _, _, _ in
                    if state.windowUnavailable {
                        throw TargetWindowUnavailable(windowID: windowID ?? 101, pid: app.pid,
                            availableWindows: [ObservedAppWindow(windowID: 202, title: "Other document", isFocused: true)])
                    }
                    let identifier = state.elementReplaced ? "B control" : "A control"
                    let record = ElementRecord(index: 1, identifier: identifier, element: nil,
                        localFrame: nil, role: kAXButtonRole as String, rawActions: [], prettyActions: [])
                    return AppSnapshot(app: app, windowTitle: "Document", windowBounds: nil,
                        targetWindowID: windowID ?? 101, targetWindowLayer: 0, screenshotPNGData: screenshot,
                        mode: .fixture, treeLines: ["1 button \(identifier)"],
                        focusedSummary: nil, focusedElement: nil, selectedText: nil,
                        elements: [1: record], observationNote: nil)
                }, appIsRunning: { _ in true }, fixtureCommandPoster: { state.dispatchedCommands.append($0) })
            server = StdioMCPServer(service: service)
        }
    }

    private func call(_ server: StdioMCPServer, name: String, arguments: [String: Any], id: Int = 1) throws -> [String: Any] {
        let request: [String: Any] = ["jsonrpc": "2.0", "id": id, "method": "tools/call",
            "params": ["name": name, "arguments": arguments]]
        let requestData = try JSONSerialization.data(withJSONObject: request)
        let response = try XCTUnwrap(server.handle(line: String(decoding: requestData, as: UTF8.self)))
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(response.utf8)) as? [String: Any])
        XCTAssertEqual(payload["id"] as? Int, id)
        XCTAssertNil(payload["error"])
        return try XCTUnwrap(payload["result"] as? [String: Any])
    }

    private func metadata(_ result: [String: Any]) throws -> [String: Any] {
        let meta = try XCTUnwrap(result["_meta"] as? [String: Any])
        return try XCTUnwrap(meta["memmyComputerUse"] as? [String: Any])
    }

    private func observationID(_ result: [String: Any]) throws -> String {
        try XCTUnwrap(try metadata(result)["observationID"] as? String)
    }

    private func assertStructuredScreenshot(_ result: [String: Any], screenshot: Data) throws {
        let content = try XCTUnwrap(result["content"] as? [[String: Any]])
        let image = try XCTUnwrap(content.first { $0["type"] as? String == "image" })
        XCTAssertEqual(image["mimeType"] as? String, "image/png")
        XCTAssertEqual(image["data"] as? String, screenshot.base64EncodedString())
        let text = try XCTUnwrap(content.first { $0["type"] as? String == "text" }?["text"] as? String)
        XCTAssertFalse(text.contains(screenshot.base64EncodedString()))
        XCTAssertFalse(text.contains("ObservationChanged("))
        XCTAssertFalse(text.contains("ToolCallResult("))
    }

    func testStaleObservationMCPResponseRetainsFreshTokenMetadataAndImageContent() throws {
        for change in ["unknown observation", "replaced element"] {
            let fixture = try Fixture()
            let arguments: [String: Any] = ["app": "test.mcp.observation", "window_id": 101]
            let initial = try call(fixture.server, name: "get_app_state", arguments: arguments)
            XCTAssertEqual(initial["isError"] as? Bool, false)
            try assertStructuredScreenshot(initial, screenshot: fixture.screenshot)
            var oldToken = try observationID(initial)
            if change == "unknown observation" {
                oldToken = "not-an-issued-observation"
            } else {
                fixture.state.elementReplaced = true
            }
            let stale = try call(fixture.server, name: "click", arguments: ["app": "test.mcp.observation",
                "window_id": 101, "observation_id": oldToken, "element_index": "1"], id: 2)
            XCTAssertEqual(stale["isError"] as? Bool, false, change)
            XCTAssertEqual(try metadata(stale)["stateChanged"] as? Bool, true, change)
            XCTAssertEqual(try metadata(stale)["noActionDispatched"] as? Bool, true, change)
            XCTAssertEqual(try metadata(stale)["targetWindowID"] as? Int, 101)
            XCTAssertNotEqual(try observationID(stale), oldToken, change)
            XCTAssertTrue(fixture.state.dispatchedCommands.isEmpty, change)
            try assertStructuredScreenshot(stale, screenshot: fixture.screenshot)

            let recovery = try call(fixture.server, name: "click", arguments: ["app": "test.mcp.observation",
                "window_id": 101, "observation_id": try observationID(stale), "element_index": "1"], id: 3)
            XCTAssertEqual(recovery["isError"] as? Bool, false, change)
            XCTAssertNil(try metadata(recovery)["noActionDispatched"], change)
            XCTAssertEqual(fixture.state.dispatchedCommands.map(\.identifier),
                [fixture.state.elementReplaced ? "B control" : "A control"], change)
            try assertStructuredScreenshot(recovery, screenshot: fixture.screenshot)
        }
    }

    func testUnavailableWindowMCPResponseRetainsTargetAndAvailableWindowMetadata() throws {
        let fixture = try Fixture()
        let initial = try call(fixture.server, name: "get_app_state",
            arguments: ["app": "test.mcp.observation", "window_id": 101])
        fixture.state.windowUnavailable = true
        let result = try call(fixture.server, name: "click", arguments: ["app": "test.mcp.observation",
            "window_id": 101, "observation_id": try observationID(initial), "element_index": "1"])
        XCTAssertEqual(result["isError"] as? Bool, true)
        let meta = try metadata(result)
        XCTAssertEqual(meta["targetWindowUnavailable"] as? Bool, true)
        XCTAssertEqual(meta["requestedWindowID"] as? Int, 101)
        XCTAssertEqual(meta["pid"] as? Int, 500)
        let windows = try XCTUnwrap(meta["availableWindows"] as? [[String: Any]])
        XCTAssertEqual(windows.first?["windowID"] as? Int, 202)
        XCTAssertEqual(windows.first?["title"] as? String, "Other document")
        XCTAssertTrue(fixture.state.dispatchedCommands.isEmpty)
    }
}
