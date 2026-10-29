import Foundation
import XCTest
@testable import MemmyComputerUseKit

final class SkyClickDispatchSafetyTests: XCTestCase {
    private enum InjectedFailure: Error { case transport, cleanup }

    private struct StampedEvent {
        let id: Int
        let kind: SkyClickEventKind
    }

    func testProductionEventBoundarySubmitsEachCreatedEventExactlyOnce() throws {
        for clickCount in [1, 2] {
            let steps = try skyClickEventRecipe(clickCount: clickCount)
            var created: [StampedEvent] = []
            var delivered: [StampedEvent] = []
            var cleanupCount = 0
            try dispatchSkyClickEvents(steps, makeEvent: { step in
                let event = StampedEvent(id: created.count, kind: step.kind)
                created.append(event)
                return event
            }, postToPid: { delivered.append($0) }, delay: { _ in }, finish: { cleanupCount += 1 })
            XCTAssertEqual(created.count, 1 + clickCount * 2)
            XCTAssertEqual(delivered.map(\.id), created.map(\.id), "No duplicate PID submission is allowed")
            XCTAssertEqual(delivered.filter { $0.kind == .down }.count, clickCount)
            XCTAssertEqual(delivered.filter { $0.kind == .up }.count, clickCount)
            XCTAssertEqual(cleanupCount, 1)
        }
    }

    func testProductionTransportFailureAtMouseDownCannotResubmitOrGenerateAnotherPair() throws {
        var created: [SkyClickEventKind] = []
        var delivered: [SkyClickEventKind] = []
        var cleanupCount = 0
        XCTAssertThrowsError(try dispatchSkyClickEvents(skyClickEventRecipe(clickCount: 1), makeEvent: { step in
            created.append(step.kind)
            return StampedEvent(id: created.count, kind: step.kind)
        }, postToPid: { event in
            delivered.append(event.kind)
            if event.kind == .down { throw InjectedFailure.transport }
        }, delay: { _ in }, finish: { cleanupCount += 1 })) { error in
            guard case SkyClickDispatchFailure.afterDispatch = error else {
                return XCTFail("Uncertain transport receipt must forbid fallback: \(error)")
            }
        }
        XCTAssertEqual(created, [.moved, .down])
        XCTAssertEqual(delivered, [.moved, .down])
        XCTAssertEqual(cleanupCount, 1)
    }

    func testProductionUserInterventionStopsBeforeMouseDownCreationAndSubmission() throws {
        var created: [SkyClickEventKind] = []
        var delivered: [SkyClickEventKind] = []
        XCTAssertThrowsError(try dispatchSkyClickEvents(skyClickEventRecipe(clickCount: 1), makeEvent: { step in
            created.append(step.kind)
            return step.kind
        }, postToPid: { delivered.append($0) }, delay: { _ in }, finish: {},
        beforeFirstMouseDown: { throw InputSimulation.UserInputYield(dispatched: false) })) { error in
            XCTAssertTrue(error is InputSimulation.UserInputYield)
        }
        XCTAssertEqual(created, [.moved])
        XCTAssertEqual(delivered, [.moved])
    }

    func testInterventionAfterMouseMoveDoesNotSendMouseDownOrSwitchDeliveryChannels() throws {
        var delivered: [SkyClickEventKind] = []
        var cleanupCount = 0
        XCTAssertThrowsError(try dispatchSkyClickSteps(
            skyClickEventRecipe(clickCount: 1), post: { delivered.append($0.kind) }, delay: { _ in },
            finish: { cleanupCount += 1 },
            beforeFirstMouseDown: { throw InputSimulation.UserInputYield(dispatched: false) }
        )) { error in
            XCTAssertTrue(error is InputSimulation.UserInputYield)
            XCTAssertFalse((error as? InputSimulation.UserInputYield)?.dispatched ?? true)
        }
        XCTAssertEqual(delivered, [.moved])
        XCTAssertEqual(cleanupCount, 1)
    }

    func testDownAndUpRemainPairedAfterTheLastPredispatchCheck() throws {
        var delivered: [SkyClickEventKind] = []
        var checkCount = 0
        try dispatchSkyClickSteps(skyClickEventRecipe(clickCount: 2),
            post: { delivered.append($0.kind) }, delay: { _ in }, finish: {},
            beforeFirstMouseDown: { checkCount += 1 })
        XCTAssertEqual(checkCount, 1)
        XCTAssertEqual(delivered, [.moved, .down, .up, .down, .up])
    }

    func testDefaultSingleClickRecipeDispatchesThreeStepsWithoutPrimer() throws {
        var delivered: [SkyClickEventStep] = []
        var cleanupCount = 0
        try dispatchSkyClickSteps(
            skyClickEventRecipe(clickCount: 1),
            post: { delivered.append($0) },
            delay: { _ in },
            finish: { cleanupCount += 1 }
        )
        XCTAssertEqual(delivered.map(\.kind), [.moved, .down, .up])
        XCTAssertTrue(delivered.allSatisfy { $0.pointKind == .target })
        XCTAssertEqual(cleanupCount, 1)
    }

    func testCleanupFailureAfterMouseUpForbidsAnotherDeliveryAttempt() throws {
        var delivered: [SkyClickEventStep] = []
        var cleanupCount = 0
        XCTAssertThrowsError(try dispatchSkyClickSteps(
            skyClickEventRecipe(clickCount: 1),
            post: { delivered.append($0) },
            delay: { _ in },
            finish: { cleanupCount += 1; throw InjectedFailure.cleanup }
        )) { error in
            guard case SkyClickDispatchFailure.afterDispatch = error else {
                return XCTFail("A completed click must not be eligible for fallback: \(error)")
            }
        }
        XCTAssertEqual(delivered.map(\.kind), [.moved, .down, .up])
        XCTAssertEqual(cleanupCount, 1)
    }

    func testPartialMouseDownFailureIsUncertainAndDoesNotReplay() throws {
        var delivered: [SkyClickEventKind] = []
        var cleanupCount = 0
        XCTAssertThrowsError(try dispatchSkyClickSteps(
            skyClickEventRecipe(clickCount: 1),
            post: {
                delivered.append($0.kind)
                if $0.kind == .down { throw InjectedFailure.transport }
            },
            delay: { _ in },
            finish: { cleanupCount += 1 }
        )) { error in
            guard case SkyClickDispatchFailure.afterDispatch = error else {
                return XCTFail("A possibly delivered mouse-down must not be replayed: \(error)")
            }
        }
        XCTAssertEqual(delivered, [.moved, .down])
        XCTAssertEqual(cleanupCount, 1)
    }

    func testFailureBeforeMouseDownCanStillUseFallback() throws {
        var delivered: [SkyClickEventKind] = []
        var cleanupCount = 0
        XCTAssertThrowsError(try dispatchSkyClickSteps(
            skyClickEventRecipe(clickCount: 1),
            post: { delivered.append($0.kind); throw InjectedFailure.transport },
            delay: { _ in },
            finish: { cleanupCount += 1; throw InjectedFailure.cleanup }
        )) { error in
            XCTAssertTrue(error is InjectedFailure)
        }
        XCTAssertEqual(delivered, [.moved])
        XCTAssertEqual(cleanupCount, 1)
    }
}
