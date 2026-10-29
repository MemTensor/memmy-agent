import XCTest
@testable import MemmyComputerUseKit

final class InputSimulationFocusGuardTests: XCTestCase {
    func testPhysicalInputOnlyYieldsForTheTargetApp() {
        XCTAssertTrue(InputSimulation.shouldYieldToUser(targetPID: 123, frontmostPID: 123, inputIdle: 0.1))
        XCTAssertFalse(InputSimulation.shouldYieldToUser(targetPID: 123, frontmostPID: 456, inputIdle: 0.1))
        XCTAssertFalse(InputSimulation.shouldYieldToUser(targetPID: 123, frontmostPID: nil, inputIdle: 0.1))
        XCTAssertFalse(InputSimulation.shouldYieldToUser(targetPID: 0, frontmostPID: 0, inputIdle: 0.1))
    }

    func testIdleInputReleasesTheTargetAppAndInvalidClocksDoNotImplyActivity() {
        for idle in [0.45, 0.75, 10, -1, .infinity, .nan] {
            XCTAssertFalse(InputSimulation.shouldYieldToUser(targetPID: 123, frontmostPID: 123, inputIdle: idle))
        }
    }

    func testYieldMarkersDistinguishUnsentActionsFromEarlierDispatch() {
        XCTAssertTrue(InputSimulation.UserInputYield(dispatched: false).errorDescription!
            .hasPrefix("MAC_FOCUS_GUARD_YIELD_BEFORE_DISPATCH:"))
        XCTAssertTrue(InputSimulation.UserInputYield(dispatched: true).errorDescription!
            .hasPrefix("MAC_FOCUS_GUARD_YIELD_AFTER_DISPATCH:"))
    }

    func testYieldErrorSerializesAsOneTrustedMCPTextBlock() throws {
        // Dispatcher and MCPServer both preserve LocalizedError descriptions
        // through this result constructor, without an "Error:" prefix.
        let error: Error = InputSimulation.UserInputYield(dispatched: false)
        let message = try XCTUnwrap((error as? LocalizedError)?.errorDescription)
        let wire = ToolCallResult.text(message, isError: true).asDictionary
        let json = try JSONSerialization.data(withJSONObject: wire)
        let parsed = try XCTUnwrap(JSONSerialization.jsonObject(with: json) as? [String: Any])
        let content = try XCTUnwrap(parsed["content"] as? [[String: Any]])
        XCTAssertEqual(parsed["isError"] as? Bool, true)
        XCTAssertEqual(content.count, 1)
        XCTAssertEqual(content[0]["type"] as? String, "text")
        XCTAssertEqual(content[0]["text"] as? String,
            "MAC_FOCUS_GUARD_YIELD_BEFORE_DISPATCH: The user is using the target app. The action was not sent.")
    }

    func testFocusRestorationPreservesAnActiveHumanSwitchToTheTarget() {
        XCTAssertFalse(shouldRestoreFrontmostApp(previousPID: 123, currentPID: 456,
                                                targetPID: 456, inputIdle: 0.1))
        XCTAssertTrue(shouldRestoreFrontmostApp(previousPID: 123, currentPID: 456,
                                               targetPID: 456, inputIdle: 1))
        XCTAssertFalse(shouldRestoreFrontmostApp(previousPID: 123, currentPID: 789,
                                                targetPID: 456, inputIdle: 1))
        XCTAssertFalse(shouldRestoreFrontmostApp(previousPID: 123, currentPID: 456,
                                                targetPID: 456, inputIdle: .nan))
    }
}
