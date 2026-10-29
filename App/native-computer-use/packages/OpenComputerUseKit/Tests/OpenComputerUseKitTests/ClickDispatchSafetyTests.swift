import ApplicationServices
import XCTest
@testable import MemmyComputerUseKit

final class ClickDispatchSafetyTests: XCTestCase {
    private struct Candidate {
        let name: String
        let role: String
        let frame: CGRect
    }

    func testTemplateWindowAndFarAwayCloseButtonDoNotDispatchAXBeforePointMouseFallback() throws {
        let point = CGPoint(x: 378, y: 184)
        let candidates = [
            Candidate(name: "window", role: kAXWindowRole as String,
                      frame: CGRect(x: 0, y: 0, width: 1024, height: 720)),
            Candidate(name: "tab-close", role: kAXButtonRole as String,
                      frame: CGRect(x: 268, y: 7, width: 10, height: 10)),
            Candidate(name: "back", role: kAXButtonRole as String,
                      frame: CGRect(x: 20, y: 24, width: 60, height: 30)),
        ]
        var axDispatches: [String] = []
        var mouseDispatches: [CGPoint] = []
        let handled = try performFirstPointMatchedClick(candidates, requestedWindowPoint: point,
            geometry: { ($0.role, $0.frame) }, click: { candidate throws in
                axDispatches.append(candidate.name)
                return true
            })
        if !handled { mouseDispatches.append(point) }
        XCTAssertFalse(handled)
        XCTAssertTrue(axDispatches.isEmpty)
        XCTAssertEqual(mouseDispatches, [point])
    }

    func testOnlyCardAXDispatchesWhenCardAndSmallerCloseButtonAreCandidates() throws {
        let candidates = [
            Candidate(name: "tab-close", role: kAXButtonRole as String,
                      frame: CGRect(x: 268, y: 7, width: 10, height: 10)),
            Candidate(name: "blank-card", role: kAXButtonRole as String,
                      frame: CGRect(x: 300, y: 150, width: 150, height: 120)),
        ]
        var dispatches: [String] = []
        let handled = try performFirstPointMatchedClick(candidates,
            requestedWindowPoint: CGPoint(x: 378, y: 184), geometry: { ($0.role, $0.frame) }, click: { candidate throws in
                dispatches.append(candidate.name)
                return true
            })
        XCTAssertTrue(handled)
        XCTAssertEqual(dispatches, ["blank-card"])
    }

    func testCoordinateCannotUseAnUnresolvedFrameOrAnApplicationContainer() {
        let point = CGPoint(x: 50, y: 50)
        for frame in [nil, CGRect.zero, CGRect.null] {
            XCTAssertFalse(clickCandidateMatchesRequestedPoint(role: kAXButtonRole as String,
                                                               frame: frame, requestedWindowPoint: point))
        }
        XCTAssertFalse(clickCandidateMatchesRequestedPoint(role: kAXApplicationRole as String,
            frame: CGRect(x: 0, y: 0, width: 100, height: 100), requestedWindowPoint: point))
    }

    func testElementIndexRequestsPreserveContainerAndDescendantSemantics() {
        XCTAssertTrue(clickCandidateMatchesRequestedPoint(role: kAXWindowRole as String,
            frame: CGRect(x: 0, y: 0, width: 1024, height: 720), requestedWindowPoint: nil))
        XCTAssertTrue(clickCandidateMatchesRequestedPoint(role: kAXButtonRole as String,
            frame: nil, requestedWindowPoint: nil))
    }

    func testRetinaScreenshotCoordinatesAreScaledOnlyBeforeWindowHitTesting() {
        let bounds = CGRect(x: 1938, y: 236, width: 1024, height: 633)
        let local = screenshotPixelToWindowPoint(CGPoint(x: 1060, y: 790),
            screenshotPixelSize: CGSize(width: 2048, height: 1266), windowBounds: bounds)
        let hitTest = globalPointForWindowPoint(local, windowBounds: bounds)
        XCTAssertEqual(local, CGPoint(x: 530, y: 395))
        XCTAssertEqual(hitTest, CGPoint(x: 2468, y: 631))
        XCTAssertNotEqual(hitTest, CGPoint(x: 2203, y: 433.5))
    }

    func testWindowHitTestingDoesNotRescalePointsForDownsampledScreenshots() {
        let bounds = CGRect(x: -1100, y: 80, width: 1000, height: 600)
        let local = screenshotPixelToWindowPoint(CGPoint(x: 250, y: 150),
            screenshotPixelSize: CGSize(width: 500, height: 300), windowBounds: bounds)
        XCTAssertEqual(globalPointForWindowPoint(local, windowBounds: bounds), CGPoint(x: -600, y: 380))
    }

    func testUnchangedFirstObservationWaitsForDelayedTransitionWithoutAnotherDispatchChannel() throws {
        var observations = 0
        let result = try observeClickTransition(observe: { () throws -> String in
            observations += 1
            return observations == 1 ? "template-list" : "new-presentation"
        }, hasChanged: { $0 != "template-list" })
        XCTAssertEqual(result, "new-presentation")
        XCTAssertEqual(observations, 2)
    }

    func testChangedFirstObservationDoesNotWaitOrDispatchAgain() {
        var observations = 0
        let result = observeClickTransition(observe: {
            observations += 1
            return "new-presentation"
        }, hasChanged: { $0 != "template-list" })
        XCTAssertEqual(result, "new-presentation")
        XCTAssertEqual(observations, 1)
    }

    func testPermanentlyUnchangedClickHasOnlyTwoReadOnlyObservations() {
        var observations = 0
        let result = observeClickTransition(observe: {
            observations += 1
            return "template-list"
        }, hasChanged: { $0 != "template-list" })
        XCTAssertEqual(result, "template-list")
        XCTAssertEqual(observations, 2)
    }

    func testObservationErrorPropagatesWithoutRetrying() {
        enum ObservationError: Error { case unavailable }
        var observations = 0
        XCTAssertThrowsError(try observeClickTransition(observe: { () throws -> String in
            observations += 1
            throw ObservationError.unavailable
        }, hasChanged: { _ in false })) { error in
            XCTAssertTrue(error is ObservationError)
        }
        XCTAssertEqual(observations, 1)
    }

    func testSecondAXAttemptFailureCannotFallThroughToMouseFallback() {
        for (action, failure) in [("AXPress", AXError.failure), ("AXOpen", AXError.attributeUnsupported)] {
            var calls = 0
            var fallbackCalls = 0
            XCTAssertThrowsError(try {
                let handled = try performAccessibilityActionSequence(action: action, repeatCount: 2,
                    perform: {
                        calls += 1
                        return calls == 1 ? .success : failure
                    }, pause: { _ in })
                if !handled { fallbackCalls += 1 }
            }()) { error in
                XCTAssertTrue(error is AccessibilityActionUncertain)
                XCTAssertTrue(error.localizedDescription.contains("Run get_app_state"))
            }
            XCTAssertEqual(calls, 2)
            XCTAssertEqual(fallbackCalls, 0)
        }
    }

    func testFirstAXCannotCompleteDoesNotTryAnotherActionOrMouseFallback() {
        var calls = 0
        var nextActionOrFallbackCalls = 0
        XCTAssertThrowsError(try {
            let handled = try performAccessibilityActionSequence(action: "AXPress", repeatCount: 2,
                perform: { calls += 1; return .cannotComplete }, pause: { _ in })
            if !handled { nextActionOrFallbackCalls += 1 }
        }()) { error in
            XCTAssertTrue(error is AccessibilityActionUncertain)
        }
        XCTAssertEqual(calls, 1)
        XCTAssertEqual(nextActionOrFallbackCalls, 0)
    }
}
