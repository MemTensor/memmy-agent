import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// AppKit gives an inactive window's first click to the hit view only when that
// view accepts first mouse; most views, embedded Chromium pages among them,
// spend it on activating the window. A background click never makes the
// window really active, so each one is spent that way. A foreground click
// makes the observed window active for one click, then hands the foreground
// back unless the user has taken it.
let foregroundClickInputPause: TimeInterval = 1.0
let foregroundClickInputPauseWait: TimeInterval = 4.0
let foregroundClickActivationTimeout: TimeInterval = 0.8
let foregroundClickHold: TimeInterval = 0.2
let foregroundClickReturnTimeout: TimeInterval = 0.5
let foregroundClickReturnRetryGap: TimeInterval = 0.25
private let foregroundClickPollInterval: TimeInterval = 0.03
private let foregroundClickClockTolerance: TimeInterval = 0.02

struct ForegroundOwner {
    let pid: pid_t
    let windowID: CGWindowID?
    var window: AXUIElement? = nil
}

/// Physical input since the foreground was taken.
struct ForegroundClickInput: Equatable {
    var any = false
    var keyboard = false
    var button = false
}

/// The HID idle clock counts physical input only. The keyboard and button
/// clocks can include this helper's own events, so button presses count only
/// after its click was sent.
func foregroundClickInput(
    elapsed: TimeInterval,
    sinceClickSent: TimeInterval?,
    hidIdle: TimeInterval?,
    keyboardIdle: TimeInterval,
    buttonIdle: TimeInterval
) -> ForegroundClickInput {
    ForegroundClickInput(
        any: hidIdle.map { $0 + foregroundClickClockTolerance < elapsed } ?? true,
        keyboard: keyboardIdle + foregroundClickClockTolerance < elapsed,
        button: buttonIdle + foregroundClickClockTolerance < (sinceClickSent ?? elapsed)
    )
}

/// Taking the foreground in the middle of a burst of typing would split it
/// between two apps, so wait for a pause instead.
func waitForForegroundClickPause(
    inputIdle: () -> TimeInterval?,
    now: () -> TimeInterval,
    sleep: (TimeInterval) -> Void,
    pause: TimeInterval = foregroundClickInputPause,
    maxWait: TimeInterval = foregroundClickInputPauseWait
) -> Bool {
    let deadline = now() + maxWait
    while let idle = inputIdle() {
        if idle >= pause { return true }
        let remaining = deadline - now()
        guard remaining > 0 else { return false }
        sleep(min(pause - idle, remaining, 0.25))
    }
    return false
}

enum ForegroundClickReadiness: Equatable {
    case ready
    case waiting
    case userInput
    case foregroundTaken
    case windowChanged
}

func foregroundClickReadiness(
    frontmostPID: pid_t?,
    focusedWindowID: CGWindowID?,
    targetPID: pid_t,
    targetWindowID: CGWindowID,
    previousPID: pid_t?,
    observedBounds: CGRect,
    currentBounds: CGRect?,
    input: ForegroundClickInput
) -> ForegroundClickReadiness {
    if input.any { return .userInput }
    guard let currentBounds, foregroundClickBoundsMatch(observedBounds, currentBounds) else {
        return .windowChanged
    }
    guard frontmostPID == targetPID else {
        return frontmostPID == nil || frontmostPID == previousPID ? .waiting : .foregroundTaken
    }
    return focusedWindowID == targetWindowID ? .ready : .waiting
}

private func foregroundClickBoundsMatch(_ a: CGRect, _ b: CGRect) -> Bool {
    abs(a.minX - b.minX) <= 1 && abs(a.minY - b.minY) <= 1
        && abs(a.width - b.width) <= 1 && abs(a.height - b.height) <= 1
}

enum ForegroundClickReturnDecision: Equatable {
    case restore
    case alreadyReturned
    case leaveForUser
}

/// Typing or moving the pointer does not choose the target, so the user's
/// app comes back. A button press on the target, or another app now in
/// front, is the user's choice and stays.
func foregroundClickReturnDecision(
    frontmostPID: pid_t?,
    focusedWindowID: CGWindowID?,
    targetPID: pid_t,
    previous: ForegroundOwner?,
    input: ForegroundClickInput
) -> ForegroundClickReturnDecision {
    guard let previous, previous.pid > 0 else { return .leaveForUser }
    if frontmostPID == previous.pid,
       previous.pid != targetPID || previous.windowID == nil || focusedWindowID == previous.windowID {
        return .alreadyReturned
    }
    guard frontmostPID == targetPID, !input.button else { return .leaveForUser }
    return .restore
}

enum ForegroundClickHandBack: Equatable {
    case notNeeded
    case returned
    case keptForUser
    case notReturned
}

struct ForegroundClickSystem {
    var now: () -> TimeInterval
    var sleep: (TimeInterval) -> Void
    var frontmostPID: () -> pid_t?
    var focusedWindow: (pid_t) -> (id: CGWindowID?, element: AXUIElement?)
    var windowBounds: (pid_t, CGWindowID) -> CGRect?
    var hidIdle: () -> TimeInterval?
    var keyboardIdle: () -> TimeInterval
    var buttonIdle: () -> TimeInterval
    var bringToFront: (ForegroundOwner) -> Void

    static var live: ForegroundClickSystem {
        ForegroundClickSystem(
            now: { ProcessInfo.processInfo.systemUptime },
            sleep: { Thread.sleep(forTimeInterval: $0) },
            frontmostPID: { NSWorkspace.shared.frontmostApplication?.processIdentifier },
            focusedWindow: { pid in
                guard let window = AXWindowIdentity.copyElement(
                    AXUIElementCreateApplication(pid), attribute: kAXFocusedWindowAttribute
                ) else { return (nil, nil) }
                return (AXWindowIdentity.windowID(of: window), window)
            },
            windowBounds: { pid, windowID in
                let info = CGWindowListCopyWindowInfo([.optionIncludingWindow], windowID) as? [[String: Any]] ?? []
                guard skyClickWindowMatchesTarget(windowInfo: info, windowID: windowID, pid: pid),
                      let bounds = info.first?[kCGWindowBounds as String] as? NSDictionary else { return nil }
                return CGRect(dictionaryRepresentation: bounds)
            },
            hidIdle: { InputSimulation.hidInputIdle() },
            keyboardIdle: { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: .keyDown) },
            buttonIdle: {
                [CGEventType.leftMouseDown, .rightMouseDown, .otherMouseDown]
                    .map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) }
                    .min() ?? .infinity
            },
            bringToFront: { ForegroundWindowActivation.bringToFront($0) }
        )
    }
}

enum ForegroundWindowActivation {
    static func bringToFront(_ owner: ForegroundOwner, spi: SkyLightSPI = .shared) {
        if let window = owner.window {
            _ = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
            _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        }
        let activated = spi.canSetFrontProcess
            && (try? spi.setFrontProcess(pid: owner.pid, windowID: owner.windowID)) != nil
        if !activated {
            _ = NSRunningApplication(processIdentifier: owner.pid)?.activate(options: [])
        }
        if let window = owner.window {
            _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
            _ = AXUIElementSetAttributeValue(
                AXUIElementCreateApplication(owner.pid), kAXFocusedWindowAttribute as CFString, window
            )
        }
    }
}

/// One activation of the observed window, one click, and one hand-back.
final class ForegroundClickSession {
    let targetPID: pid_t
    let targetWindowID: CGWindowID
    let previous: ForegroundOwner?
    private let observedBounds: CGRect
    private let system: ForegroundClickSystem
    /// Nil when the target was already the active window.
    private let activatedAt: TimeInterval?
    private var clickSentAt: TimeInterval?

    private init(targetPID: pid_t, targetWindowID: CGWindowID, previous: ForegroundOwner?,
                 observedBounds: CGRect, system: ForegroundClickSystem, activatedAt: TimeInterval?) {
        self.targetPID = targetPID
        self.targetWindowID = targetWindowID
        self.previous = previous
        self.observedBounds = observedBounds
        self.system = system
        self.activatedAt = activatedAt
    }

    /// Nothing has been sent to the target when this throws, and any
    /// foreground it took has been handed back.
    static func begin(
        targetPID: pid_t,
        targetWindowID: CGWindowID,
        targetWindow: AXUIElement?,
        observedBounds: CGRect,
        system: ForegroundClickSystem = .live
    ) throws -> ForegroundClickSession {
        let previous = system.frontmostPID().map { pid in
            let window = system.focusedWindow(pid)
            return ForegroundOwner(pid: pid, windowID: window.id, window: window.element)
        }
        if let previous, previous.pid == targetPID, previous.windowID == targetWindowID {
            return ForegroundClickSession(targetPID: targetPID, targetWindowID: targetWindowID, previous: previous,
                                          observedBounds: observedBounds, system: system, activatedAt: nil)
        }
        guard waitForForegroundClickPause(inputIdle: system.hidIdle, now: system.now, sleep: system.sleep) else {
            throw InputSimulation.UserInputYield(dispatched: false, activeElsewhere: true)
        }

        let session = ForegroundClickSession(targetPID: targetPID, targetWindowID: targetWindowID, previous: previous,
                                             observedBounds: observedBounds, system: system, activatedAt: system.now())
        system.bringToFront(ForegroundOwner(pid: targetPID, windowID: targetWindowID, window: targetWindow))
        let deadline = system.now() + foregroundClickActivationTimeout
        while true {
            let readiness = session.readiness()
            if readiness == .ready { return session }
            if readiness == .waiting && system.now() < deadline {
                system.sleep(foregroundClickPollInterval)
                continue
            }
            session.end()
            throw session.notReadyError(readiness)
        }
    }

    /// Checked again immediately before the mouse-down.
    func requireReady() throws {
        guard activatedAt != nil else { return }
        let readiness = readiness()
        guard readiness == .ready else { throw notReadyError(readiness) }
    }

    func markClickSent() {
        clickSentAt = system.now()
    }

    /// Lets the target handle the click while it is active, then returns the
    /// foreground. A click that opens a window can bring the target forward
    /// again on its own, so a sent click is watched for the whole return
    /// window and handed back at most twice.
    @discardableResult
    func end() -> ForegroundClickHandBack {
        guard activatedAt != nil else { return .notNeeded }
        let clicked = clickSentAt != nil
        if clicked { system.sleep(foregroundClickHold) }
        let deadline = system.now() + foregroundClickReturnTimeout
        var attempts = 0
        var lastAttempt = -TimeInterval.infinity
        while true {
            let decision = returnDecision()
            if decision == .leaveForUser { return .keptForUser }
            let now = system.now()
            if decision == .alreadyReturned, !clicked || now >= deadline { return .returned }
            if now >= deadline { return .notReturned }
            if decision == .restore, let previous, attempts < 2,
               now - lastAttempt >= foregroundClickReturnRetryGap {
                system.bringToFront(previous)
                attempts += 1
                lastAttempt = now
            }
            system.sleep(foregroundClickPollInterval)
        }
    }

    private func returnDecision() -> ForegroundClickReturnDecision {
        let frontmost = system.frontmostPID()
        return foregroundClickReturnDecision(
            frontmostPID: frontmost,
            focusedWindowID: frontmost == targetPID ? system.focusedWindow(targetPID).id : nil,
            targetPID: targetPID,
            previous: previous,
            input: input()
        )
    }

    private func readiness() -> ForegroundClickReadiness {
        let frontmost = system.frontmostPID()
        return foregroundClickReadiness(
            frontmostPID: frontmost,
            focusedWindowID: frontmost == targetPID ? system.focusedWindow(targetPID).id : nil,
            targetPID: targetPID,
            targetWindowID: targetWindowID,
            previousPID: previous?.pid,
            observedBounds: observedBounds,
            currentBounds: system.windowBounds(targetPID, targetWindowID),
            input: input()
        )
    }

    private func input() -> ForegroundClickInput {
        guard let activatedAt else { return ForegroundClickInput() }
        let now = system.now()
        return foregroundClickInput(
            elapsed: now - activatedAt,
            sinceClickSent: clickSentAt.map { now - $0 },
            hidIdle: system.hidIdle(),
            keyboardIdle: system.keyboardIdle(),
            buttonIdle: system.buttonIdle()
        )
    }

    private func notReadyError(_ readiness: ForegroundClickReadiness) -> Error {
        switch readiness {
        case .userInput, .foregroundTaken:
            return InputSimulation.UserInputYield(dispatched: false, activeElsewhere: true)
        case .windowChanged:
            return ComputerUseError.stateUnavailable(
                "The target window moved or closed when it was brought to the front. No click was sent. Run get_app_state again."
            )
        case .ready, .waiting:
            return ComputerUseError.stateUnavailable(
                "The target window could not be made the active window. No click was sent. Run get_app_state before another action."
            )
        }
    }
}
