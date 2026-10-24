import AppKit
import ApplicationServices
import CoreGraphics
import XCTest
@testable import MemmyComputerUseKit

final class ForegroundClickTests: XCTestCase {
    private static let userApp: pid_t = 10
    private static let userWindow: CGWindowID = 1
    private static let target: pid_t = 20
    private static let targetWindow: CGWindowID = 5
    private static let otherTargetWindow: CGWindowID = 7
    private static let thirdApp: pid_t = 30
    private static let bounds = CGRect(x: 100, y: 80, width: 800, height: 600)

    /// A desktop whose clock only advances when the session sleeps, so each
    /// scenario is exact and instant.
    private final class Desktop {
        var time: TimeInterval = 1_000
        var frontmost: pid_t? = ForegroundClickTests.userApp
        var focused: [pid_t: CGWindowID] = [
            ForegroundClickTests.userApp: ForegroundClickTests.userWindow,
            ForegroundClickTests.target: ForegroundClickTests.otherTargetWindow,
        ]
        var windowBounds: [CGWindowID: CGRect] = [ForegroundClickTests.targetWindow: ForegroundClickTests.bounds]
        var lastInput: TimeInterval = 0
        var lastKey: TimeInterval = 0
        var lastButton: TimeInterval = 0
        var activations: [(pid: pid_t, windowID: CGWindowID?)] = []
        /// Runs after every bring-to-front request; the default honors it.
        var honorActivation: (Desktop, ForegroundOwner) -> Void = { desktop, owner in
            desktop.frontmost = owner.pid
            if let windowID = owner.windowID { desktop.focused[owner.pid] = windowID }
        }
        var onAdvance: [(Desktop) -> Void] = []

        func type() { lastInput = time; lastKey = time }
        func pressButton() { lastInput = time; lastButton = time }

        var system: ForegroundClickSystem {
            ForegroundClickSystem(
                now: { self.time },
                sleep: { duration in
                    self.time += duration
                    for action in self.onAdvance { action(self) }
                },
                frontmostPID: { self.frontmost },
                focusedWindow: { (self.focused[$0], nil) },
                windowBounds: { _, windowID in self.windowBounds[windowID] },
                hidIdle: { self.time - self.lastInput },
                keyboardIdle: { self.time - self.lastKey },
                buttonIdle: { self.time - self.lastButton },
                bringToFront: { owner in
                    self.activations.append((owner.pid, owner.windowID))
                    self.honorActivation(self, owner)
                }
            )
        }

        func begin() throws -> ForegroundClickSession {
            try ForegroundClickSession.begin(
                targetPID: ForegroundClickTests.target,
                targetWindowID: ForegroundClickTests.targetWindow,
                targetWindow: nil,
                observedBounds: ForegroundClickTests.bounds,
                system: system
            )
        }
    }

    private func activatedPIDs(_ desktop: Desktop) -> [pid_t] {
        desktop.activations.map { $0.pid }
    }

    private func assertYieldedWithoutDispatch(_ error: Error, file: StaticString = #filePath, line: UInt = #line) {
        guard let yield = error as? InputSimulation.UserInputYield else {
            return XCTFail("Expected a user-input yield, got \(error)", file: file, line: line)
        }
        XCTAssertFalse(yield.dispatched, file: file, line: line)
        XCTAssertTrue(yield.activeElsewhere, file: file, line: line)
        XCTAssertTrue(yield.localizedDescription.hasPrefix("MAC_FOCUS_GUARD_YIELD_BEFORE_DISPATCH: "), file: file, line: line)
    }

    func testIdleUserGetsOneActivationOneClickAndTheirAppBack() throws {
        let desktop = Desktop()
        let session = try desktop.begin()
        XCTAssertEqual(desktop.frontmost, Self.target)
        XCTAssertNoThrow(try session.requireReady())
        session.markClickSent()

        XCTAssertEqual(session.end(), .returned)
        XCTAssertEqual(desktop.frontmost, Self.userApp)
        XCTAssertEqual(activatedPIDs(desktop), [Self.target, Self.userApp])
        XCTAssertEqual(desktop.activations.last?.windowID, Self.userWindow)
    }

    func testUserWhoKeepsTypingIsNeverInterrupted() {
        let desktop = Desktop()
        desktop.type()
        desktop.onAdvance.append { $0.type() }

        XCTAssertThrowsError(try desktop.begin()) { assertYieldedWithoutDispatch($0) }
        XCTAssertTrue(desktop.activations.isEmpty)
        XCTAssertEqual(desktop.frontmost, Self.userApp)
        XCTAssertEqual(desktop.time - 1_000, foregroundClickInputPauseWait, accuracy: 0.001)
    }

    func testActivationWaitsForAPauseInTyping() throws {
        let desktop = Desktop()
        let stopsTyping = desktop.time + 1.5
        desktop.type()
        desktop.onAdvance.append { if $0.time < stopsTyping { $0.type() } }

        _ = try desktop.begin()
        XCTAssertEqual(activatedPIDs(desktop), [Self.target])
        XCTAssertGreaterThanOrEqual(desktop.time, stopsTyping + foregroundClickInputPause - 0.3)
    }

    func testUserSwitchingToAnotherAppDuringActivationWinsAndNothingIsSent() {
        let desktop = Desktop()
        desktop.honorActivation = { desktop, owner in
            guard owner.pid == ForegroundClickTests.target else {
                desktop.frontmost = owner.pid
                return
            }
            // The user brings another app forward before the target becomes active.
            desktop.frontmost = ForegroundClickTests.thirdApp
            desktop.type()
        }

        XCTAssertThrowsError(try desktop.begin()) { assertYieldedWithoutDispatch($0) }
        XCTAssertEqual(activatedPIDs(desktop), [Self.target])
        XCTAssertEqual(desktop.frontmost, Self.thirdApp)
    }

    func testAnotherAppTakingTheForegroundWithoutInputAlsoStopsTheClick() {
        let desktop = Desktop()
        desktop.honorActivation = { desktop, _ in desktop.frontmost = ForegroundClickTests.thirdApp }

        XCTAssertThrowsError(try desktop.begin()) { assertYieldedWithoutDispatch($0) }
        XCTAssertEqual(activatedPIDs(desktop), [Self.target])
        XCTAssertEqual(desktop.frontmost, Self.thirdApp)
    }

    func testTypingAfterActivationStopsTheClickAndReturnsTheKeyboardToTheUser() throws {
        let desktop = Desktop()
        let session = try desktop.begin()
        desktop.time += 0.05
        desktop.type()

        XCTAssertThrowsError(try session.requireReady()) { assertYieldedWithoutDispatch($0) }
        XCTAssertEqual(session.end(), .returned)
        XCTAssertEqual(activatedPIDs(desktop), [Self.target, Self.userApp])
        XCTAssertEqual(desktop.frontmost, Self.userApp)
    }

    func testClickingTheTargetDuringActivationLeavesItWithTheUser() throws {
        let desktop = Desktop()
        let session = try desktop.begin()
        desktop.time += 0.05
        desktop.pressButton()

        XCTAssertThrowsError(try session.requireReady()) { assertYieldedWithoutDispatch($0) }
        XCTAssertEqual(session.end(), .keptForUser)
        XCTAssertEqual(activatedPIDs(desktop), [Self.target])
        XCTAssertEqual(desktop.frontmost, Self.target)
    }

    func testOwnClickDoesNotCountAsTheUserClickingTheTarget() throws {
        let desktop = Desktop()
        let session = try desktop.begin()
        desktop.time += 0.05
        // The helper's own button event may reach the button clock.
        desktop.lastButton = desktop.time
        desktop.time += 0.01
        session.markClickSent()

        XCTAssertEqual(session.end(), .returned)
        XCTAssertEqual(desktop.frontmost, Self.userApp)
    }

    func testDeclinedActivationSendsNothing() {
        let desktop = Desktop()
        desktop.honorActivation = { _, _ in }

        XCTAssertThrowsError(try desktop.begin()) { error in
            XCTAssertTrue(error.localizedDescription.contains("could not be made the active window"))
            XCTAssertTrue(error.localizedDescription.contains("No click was sent"))
        }
        XCTAssertEqual(activatedPIDs(desktop), [Self.target])
        XCTAssertEqual(desktop.frontmost, Self.userApp)
    }

    func testWindowMovedByActivationSendsNothingAndReturnsTheForeground() {
        let desktop = Desktop()
        let honor = desktop.honorActivation
        desktop.honorActivation = { desktop, owner in
            honor(desktop, owner)
            if owner.pid == ForegroundClickTests.target {
                desktop.windowBounds[ForegroundClickTests.targetWindow] = ForegroundClickTests.bounds.offsetBy(dx: 120, dy: 0)
            }
        }

        XCTAssertThrowsError(try desktop.begin()) { error in
            XCTAssertTrue(error.localizedDescription.contains("moved or closed"))
        }
        XCTAssertEqual(activatedPIDs(desktop), [Self.target, Self.userApp])
        XCTAssertEqual(desktop.frontmost, Self.userApp)
    }

    func testAlreadyActiveWindowNeedsNoActivationOrHandBack() throws {
        let desktop = Desktop()
        desktop.frontmost = Self.target
        desktop.focused[Self.target] = Self.targetWindow

        let session = try desktop.begin()
        XCTAssertNoThrow(try session.requireReady())
        session.markClickSent()
        XCTAssertEqual(session.end(), .notNeeded)
        XCTAssertTrue(desktop.activations.isEmpty)
    }

    func testTargetReactivatingItselfAfterTheClickIsReturnedOnceMore() throws {
        let desktop = Desktop()
        let session = try desktop.begin()
        session.markClickSent()
        // The click opens a document window, which brings the target forward
        // again just after the foreground was handed back.
        var reactivated = false
        desktop.onAdvance.append { desktop in
            guard !reactivated, desktop.activations.count == 2,
                  desktop.frontmost == ForegroundClickTests.userApp else { return }
            reactivated = true
            desktop.frontmost = ForegroundClickTests.target
            desktop.focused[ForegroundClickTests.target] = 9
        }

        XCTAssertEqual(session.end(), .returned)
        XCTAssertTrue(reactivated)
        XCTAssertEqual(activatedPIDs(desktop), [Self.target, Self.userApp, Self.userApp])
        XCTAssertEqual(desktop.frontmost, Self.userApp)
    }

    func testTargetThatKeepsTakingTheForegroundIsNotFoughtIndefinitely() throws {
        let desktop = Desktop()
        let session = try desktop.begin()
        session.markClickSent()
        desktop.onAdvance.append { desktop in
            desktop.frontmost = ForegroundClickTests.target
            desktop.focused[ForegroundClickTests.target] = ForegroundClickTests.targetWindow
        }

        XCTAssertEqual(session.end(), .notReturned)
        XCTAssertEqual(activatedPIDs(desktop), [Self.target, Self.userApp, Self.userApp])
    }

    func testAnotherWindowOfTheSameAppIsHandedBackToThatWindow() throws {
        let desktop = Desktop()
        desktop.frontmost = Self.target
        desktop.focused[Self.target] = Self.otherTargetWindow

        let session = try desktop.begin()
        XCTAssertEqual(desktop.focused[Self.target], Self.targetWindow)
        session.markClickSent()

        XCTAssertEqual(session.end(), .returned)
        XCTAssertEqual(desktop.focused[Self.target], Self.otherTargetWindow)
        XCTAssertEqual(desktop.activations.map { $0.windowID }, [Self.targetWindow, Self.otherTargetWindow])
    }

    func testPauseWaitGivesUpWhenTheInputClockIsUnavailable() {
        var slept: TimeInterval = 0
        XCTAssertFalse(waitForForegroundClickPause(inputIdle: { nil }, now: { slept }, sleep: { slept += $0 }))
        XCTAssertEqual(slept, 0)
    }

    func testInputSinceActivationSeparatesKeysButtonsAndTheHelpersOwnClick() {
        XCTAssertEqual(
            foregroundClickInput(elapsed: 0.5, sinceClickSent: nil, hidIdle: 1.5, keyboardIdle: 9, buttonIdle: 9),
            ForegroundClickInput()
        )
        XCTAssertEqual(
            foregroundClickInput(elapsed: 0.5, sinceClickSent: nil, hidIdle: 0.1, keyboardIdle: 0.1, buttonIdle: 9),
            ForegroundClickInput(any: true, keyboard: true, button: false)
        )
        XCTAssertEqual(
            foregroundClickInput(elapsed: 0.5, sinceClickSent: 0.2, hidIdle: 0.3, keyboardIdle: 9, buttonIdle: 0.3),
            ForegroundClickInput(any: true, keyboard: false, button: false)
        )
        XCTAssertEqual(
            foregroundClickInput(elapsed: 0.5, sinceClickSent: 0.2, hidIdle: 0.1, keyboardIdle: 9, buttonIdle: 0.1),
            ForegroundClickInput(any: true, keyboard: false, button: true)
        )
        XCTAssertTrue(
            foregroundClickInput(elapsed: 0.5, sinceClickSent: nil, hidIdle: nil, keyboardIdle: 9, buttonIdle: 9).any
        )
    }

    func testReturnDecisionKeepsOnlyTheUsersOwnChoice() {
        let previous = ForegroundOwner(pid: Self.userApp, windowID: Self.userWindow)
        func decide(frontmost: pid_t?, input: ForegroundClickInput = ForegroundClickInput()) -> ForegroundClickReturnDecision {
            foregroundClickReturnDecision(frontmostPID: frontmost, focusedWindowID: Self.targetWindow,
                                          targetPID: Self.target, previous: previous, input: input)
        }

        XCTAssertEqual(decide(frontmost: Self.target), .restore)
        XCTAssertEqual(decide(frontmost: Self.target, input: ForegroundClickInput(any: true, keyboard: true)), .restore)
        XCTAssertEqual(decide(frontmost: Self.target, input: ForegroundClickInput(any: true)), .restore)
        XCTAssertEqual(decide(frontmost: Self.target, input: ForegroundClickInput(any: true, button: true)), .leaveForUser)
        XCTAssertEqual(decide(frontmost: Self.thirdApp), .leaveForUser)
        XCTAssertEqual(decide(frontmost: Self.userApp), .alreadyReturned)
        XCTAssertEqual(
            foregroundClickReturnDecision(frontmostPID: Self.target, focusedWindowID: Self.targetWindow,
                                          targetPID: Self.target, previous: nil, input: ForegroundClickInput()),
            .leaveForUser
        )
    }

    func testForegroundRequiresAPointerClickMethod() {
        for method in [ClickMethod.auto, .appPost, .skyClick] {
            XCTAssertNoThrow(try validateForegroundClick(foreground: true, method: method))
        }
        for method in [ClickMethod.accessibility, .global] {
            XCTAssertThrowsError(try validateForegroundClick(foreground: true, method: method)) { error in
                XCTAssertEqual(
                    (error as? ComputerUseError)?.errorDescription,
                    "foreground=true sends a pointer click; use click_method auto, app_post, or sky_click"
                )
            }
            XCTAssertNoThrow(try validateForegroundClick(foreground: false, method: method))
        }
    }

    func testBackgroundClickNotesNeverSuggestTheForeground() {
        // Nearly every background click targets an inactive window, and one
        // that only places a caret changes nothing visible there.
        let unchanged = clickObservationNote(surfaceChanged: false, onlyScreenshotChanged: false, foreground: nil)
        XCTAssertEqual(unchanged, unchangedClickObservation)
        XCTAssertTrue(unchangedClickObservation.contains("does not mean the click was ignored"))
        XCTAssertEqual(
            clickObservationNote(surfaceChanged: true, onlyScreenshotChanged: true, foreground: nil),
            screenshotOnlyClickObservation
        )
        XCTAssertNil(clickObservationNote(surfaceChanged: true, onlyScreenshotChanged: false, foreground: nil))
        for note in [unchangedClickObservation, screenshotOnlyClickObservation, unchangedTypeTextObservation] {
            XCTAssertFalse(note.contains("foreground"), note)
        }
    }

    func testAClickThatOpensADialogPointsToItsWindowInsteadOfScreenshotPixels() throws {
        let note = try XCTUnwrap(clickObservationNote(surfaceChanged: true, onlyScreenshotChanged: true,
                                                      foreground: nil, openedWindowIDs: [19833]))
        XCTAssertTrue(note.hasPrefix("The click opened window_id=19833."))
        XCTAssertFalse(note.contains(screenshotOnlyClickObservation))
        XCTAssertEqual(clickObservationNote(surfaceChanged: true, onlyScreenshotChanged: true, foreground: nil,
                                            openedWindowIDs: []), screenshotOnlyClickObservation)
    }

    func testForegroundClickNotesNeverSuggestAnotherForegroundClick() throws {
        let unchanged = try XCTUnwrap(clickObservationNote(surfaceChanged: false, onlyScreenshotChanged: false,
                                                           foreground: .returned))
        XCTAssertTrue(unchanged.hasPrefix(foregroundUnchangedClickObservation))
        XCTAssertTrue(unchanged.contains("previously active app is in front again"))

        XCTAssertEqual(
            clickObservationNote(surfaceChanged: true, onlyScreenshotChanged: false, foreground: .keptForUser),
            "The user took over the foreground during this click, so it was left as they set it."
        )
        XCTAssertNil(clickObservationNote(surfaceChanged: true, onlyScreenshotChanged: false, foreground: .notNeeded))
    }

    func testClickSchemaDescribesWhatAForegroundClickCosts() throws {
        let click = try XCTUnwrap(ToolDefinitions.all.first { $0.name == "click" })
        let properties = try XCTUnwrap(click.inputSchema["properties"] as? [String: [String: Any]])
        XCTAssertEqual(properties["foreground"]?["type"] as? String, "boolean")
        let description = try XCTUnwrap(properties["foreground"]?["description"] as? String)
        XCTAssertTrue(description.contains("briefly takes the user's foreground"))
        XCTAssertTrue(description.contains("an unchanged background click may still have landed"))
    }

    func testDispatcherRequiresABooleanForegroundAndSendsNothingToAFixtureApp() throws {
        final class Commands { var sent: [FixtureCommand] = [] }
        let commands = Commands()
        let app = RunningAppDescriptor(name: "Foreground Fixture", bundleIdentifier: "test.foreground",
            pid: 501, runningApplication: NSRunningApplication.current)
        let service = ComputerUseService(lockScreenState: { .unlocked }, appResolver: { _ in app },
            snapshotLoader: { app, windowID, _, _, _, _ in
                let record = ElementRecord(index: 1, identifier: "Card", element: nil, localFrame: nil,
                    role: kAXButtonRole as String, rawActions: [], prettyActions: [])
                return AppSnapshot(app: app, windowTitle: "Document", windowBounds: nil,
                    targetWindowID: windowID ?? 101, targetWindowLayer: 0, screenshotPNGData: nil,
                    mode: .fixture, treeLines: ["1 button Card"], focusedSummary: nil, focusedElement: nil,
                    selectedText: nil, elements: [1: record], observationNote: nil)
            }, appIsRunning: { _ in true }, fixtureCommandPoster: { commands.sent.append($0) })
        let dispatcher = ComputerUseToolDispatcher(service: service)
        _ = try service.getAppState(app: "test.foreground", windowID: 101)

        let notBoolean = dispatcher.callToolAsResult(name: "click", arguments: [
            "app": "test.foreground", "window_id": 101, "element_index": "1", "foreground": "yes",
        ])
        XCTAssertTrue(notBoolean.isError)
        XCTAssertEqual(notBoolean.primaryText, "invalidArguments(\"foreground must be a boolean\")")

        let fixture = dispatcher.callToolAsResult(name: "click", arguments: [
            "app": "test.foreground", "window_id": 101, "element_index": "1", "foreground": true,
        ])
        XCTAssertTrue(fixture.isError)
        XCTAssertEqual(fixture.primaryText, "click_method 'auto' with foreground=true is not supported for fixture apps")
        XCTAssertTrue(commands.sent.isEmpty)

        let pasteNotBoolean = dispatcher.callToolAsResult(name: "type_text", arguments: [
            "app": "test.foreground", "window_id": 101, "text": "a", "paste": "yes",
        ])
        XCTAssertTrue(pasteNotBoolean.isError)
        XCTAssertEqual(pasteNotBoolean.primaryText, "invalidArguments(\"paste must be a boolean\")")
        XCTAssertTrue(commands.sent.isEmpty)
    }
}
