import AppKit
import CoreGraphics
import Foundation

struct SkyClickTarget {
    let screenPoint: CGPoint
    let windowPoint: CGPoint
    let windowBounds: CGRect
    let windowID: CGWindowID
    let pid: pid_t
}

enum SkyClickEventKind: Equatable, Sendable {
    case moved
    case down
    case up

    var cgEventType: CGEventType {
        switch self {
        case .moved:
            return .mouseMoved
        case .down:
            return .leftMouseDown
        case .up:
            return .leftMouseUp
        }
    }
}

enum SkyClickPointKind: Equatable, Sendable {
    case target
    case primer
}

struct SkyClickEventStep: Equatable, Sendable {
    let kind: SkyClickEventKind
    let pointKind: SkyClickPointKind
    let clickState: Int64
    let phase: Int64
    let delayAfter: TimeInterval
}

/// A Chromium page acts on a background click only after its user-activation
/// gate, which an off-window press and release satisfies without reaching the
/// page. Every Chromium host, whether a browser, an Electron app or an app with
/// an embedded engine such as WPS, ships a renderer helper app. Office, which
/// maps the off-window point onto its close button, ships none.
func bundleShipsChromiumRenderer(_ bundleURL: URL, fileManager: FileManager = .default) -> Bool {
    func apps(in directory: URL) -> [URL] {
        ((try? fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.pathExtension == "app" }
    }
    let contents = bundleURL.appendingPathComponent("Contents")
    let frameworks = contents.appendingPathComponent("Frameworks")
    var helpers = apps(in: frameworks) + apps(in: contents.appendingPathComponent("SharedSupport"))
    let embedded = ((try? fileManager.contentsOfDirectory(at: frameworks, includingPropertiesForKeys: nil)) ?? [])
        .filter { $0.pathExtension == "framework" }
    for framework in embedded {
        helpers += apps(in: framework.appendingPathComponent("Helpers"))
        let versions = framework.appendingPathComponent("Versions")
        for version in (try? fileManager.contentsOfDirectory(at: versions, includingPropertiesForKeys: nil)) ?? [] {
            helpers += apps(in: version.appendingPathComponent("Helpers"))
        }
    }
    return helpers.contains { $0.deletingPathExtension().lastPathComponent.hasSuffix("(Renderer)") }
}

enum ChromiumHostCache {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var known: [String: Bool] = [:]

    static func shipsRenderer(_ app: RunningAppDescriptor) -> Bool {
        guard let url = app.runningApplication.bundleURL?.standardizedFileURL else { return false }
        lock.lock()
        defer { lock.unlock() }
        if let cached = known[url.path] { return cached }
        let ships = bundleShipsChromiumRenderer(url)
        known[url.path] = ships
        return ships
    }
}

func skyClickEventRecipe(clickCount: Int, includePrimer: Bool = false) throws -> [SkyClickEventStep] {
    guard (1...2).contains(clickCount) else {
        throw ComputerUseError.message(
            "click_method 'sky_click' supports click_count 1 or 2"
        )
    }

    var steps = [
        SkyClickEventStep(kind: .moved, pointKind: .target, clickState: 0, phase: 2, delayAfter: 0.015),
    ]
    if includePrimer {
        steps.append(SkyClickEventStep(kind: .down, pointKind: .primer, clickState: 1, phase: 1, delayAfter: 0.001))
        steps.append(SkyClickEventStep(kind: .up, pointKind: .primer, clickState: 1, phase: 2, delayAfter: 0.100))
    }

    for pairIndex in 1...clickCount {
        steps.append(
            SkyClickEventStep(
                kind: .down,
                pointKind: .target,
                clickState: Int64(pairIndex),
                phase: 3,
                delayAfter: 0.001
            )
        )
        steps.append(
            SkyClickEventStep(
                kind: .up,
                pointKind: .target,
                clickState: Int64(pairIndex),
                phase: 3,
                delayAfter: pairIndex < clickCount ? 0.080 : 0
            )
        )
    }

    return steps
}

/// Once a mouse-down may have reached the app, another delivery channel must
/// not repeat the click. In particular, focus cleanup can fail after mouse-up.
enum SkyClickDispatchFailure: LocalizedError {
    case afterDispatch(Error)

    var errorDescription: String? {
        switch self {
        case .afterDispatch(let error):
            return "The background click may already have been delivered. It was not repeated. Run get_app_state before another action. \(error.localizedDescription)"
        }
    }
}

func dispatchSkyClickSteps(
    _ steps: [SkyClickEventStep],
    post: (SkyClickEventStep) throws -> Void,
    delay: (TimeInterval) -> Void,
    finish: () throws -> Void,
    beforeFirstMouseDown: () throws -> Void = {}
) throws {
    var mouseDownStarted = false
    do {
        for step in steps {
            // Conservatively mark the attempt before posting: a throwing
            // transport cannot prove that the app did not consume the event.
            if step.kind == .down && !mouseDownStarted {
                try beforeFirstMouseDown()
                mouseDownStarted = true
            }
            try post(step)
            if step.delayAfter > 0 { delay(step.delayAfter) }
        }
    } catch {
        try? finish()
        if mouseDownStarted { throw SkyClickDispatchFailure.afterDispatch(error) }
        throw error
    }

    do {
        try finish()
    } catch {
        if mouseDownStarted { throw SkyClickDispatchFailure.afterDispatch(error) }
        throw error
    }
}

/// Production event creation and delivery share this boundary. Each stamped
/// event is submitted once to the selected PID transport, without a second
/// public submission or a retry after an uncertain mouse-down.
func dispatchSkyClickEvents<Event>(
    _ steps: [SkyClickEventStep],
    makeEvent: (SkyClickEventStep) throws -> Event,
    postToPid: (Event) throws -> Void,
    delay: (TimeInterval) -> Void,
    finish: () throws -> Void,
    beforeFirstMouseDown: () throws -> Void = {}
) throws {
    try dispatchSkyClickSteps(steps, post: { step in
        let event = try makeEvent(step)
        try postToPid(event)
    }, delay: delay, finish: finish, beforeFirstMouseDown: beforeFirstMouseDown)
}

func requireOnScreenTargetWindow(windowID: CGWindowID?, pid: pid_t) throws {
    guard let windowID else {
        return
    }
    let windowInfo = CGWindowListCopyWindowInfo([.optionIncludingWindow], windowID) as? [[String: Any]] ?? []
    guard skyClickWindowMatchesTarget(windowInfo: windowInfo, windowID: windowID, pid: pid) else {
        throw ComputerUseError.stateUnavailable(
            "The target window is stale, off-screen, or no longer owned by the target app. Run get_app_state again."
        )
    }
}

func skyClickWindowMatchesTarget(
    windowInfo: [[String: Any]],
    windowID: CGWindowID,
    pid: pid_t
) -> Bool {
    windowInfo.contains { info in
        guard
            let number = info[kCGWindowNumber as String] as? NSNumber,
            number.uint32Value == windowID,
            let ownerPID = info[kCGWindowOwnerPID as String] as? NSNumber,
            ownerPID.int32Value == pid,
            let onScreen = info[kCGWindowIsOnscreen as String] as? NSNumber
        else {
            return false
        }

        return onScreen.boolValue
    }
}

enum SkyClickDispatcher {
    private static let primerScreenPoint = CGPoint(x: -1, y: -1)
    private static let primerWindowPoint = CGPoint(x: -1, y: -1)
    private static let dispatchLock = NSLock()

    // Raw private event fields used by the Chromium-compatible Cua Driver path.
    private enum EventField {
        static let gesturePhase: UInt32 = 0
        static let clickState: UInt32 = 1
        static let buttonNumber: UInt32 = 3
        static let subtype: UInt32 = 7
        static let targetPID: UInt32 = 40
        static let windowNumber: UInt32 = 51
        static let clickGroupID: UInt32 = 58
        static let windowUnderPointer: UInt32 = 91
        static let handlingWindowUnderPointer: UInt32 = 92
    }

    static func click(
        target: SkyClickTarget,
        clickCount: Int,
        includePrimer: Bool = false,
        spi: SkyLightSPI = .shared,
        beforeFirstMouseDown: () throws -> Void = {}
    ) throws {
        guard spi.capability.isAvailable else {
            throw ComputerUseError.message(
                "click_method 'sky_click' is unavailable: \(spi.capability.unavailableReason)"
            )
        }

        dispatchLock.lock()
        defer {
            dispatchLock.unlock()
        }

        try validate(target: target)
        let recipe = try skyClickEventRecipe(clickCount: clickCount, includePrimer: includePrimer)
        guard let source = CGEventSource(stateID: .hidSystemState) else {
            throw ComputerUseError.message("Failed to create SkyLight HID event source.")
        }

        // Cua uses the nanosecond component of wall-clock time here, which is
        // always below one billion. Keep the same narrow raw-field range;
        // WindowServer does not publish field 58's accepted width.
        let clickGroupID = Int64(DispatchTime.now().uptimeNanoseconds % 1_000_000_000)

        let frontmostPID = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let focusContext: SkyLightSyntheticFocusContext?
        if frontmostPID == target.pid {
            focusContext = nil
        } else {
            focusContext = try spi.beginSyntheticTargetFocus(
                targetPID: target.pid,
                targetWindowID: target.windowID
            )
        }

        try dispatchSkyClickEvents(
            recipe,
            makeEvent: { step in
                let screenPoint = step.pointKind == .target ? target.screenPoint : primerScreenPoint
                let windowPoint = step.pointKind == .target ? target.windowPoint : primerWindowPoint
                guard let event = CGEvent(
                    mouseEventSource: source,
                    mouseType: step.kind.cgEventType,
                    mouseCursorPosition: screenPoint,
                    mouseButton: .left
                ) else {
                    throw ComputerUseError.message(
                        "Failed to create sky_click mouse event \(step.kind.cgEventType.rawValue)."
                    )
                }

                try stamp(
                    event,
                    target: target,
                    windowPoint: windowPoint,
                    clickState: step.clickState,
                    phase: step.phase,
                    clickGroupID: clickGroupID,
                    spi: spi
                )

                return event
            },
            postToPid: { event in try spi.postToPid(event, pid: target.pid) },
            delay: { Thread.sleep(forTimeInterval: $0) },
            finish: {
                if let focusContext {
                    // Delivery is asynchronous; cleanup failures must not cause
                    // the caller to send the completed click a second time.
                    Thread.sleep(forTimeInterval: 0.100)
                    try spi.endSyntheticTargetFocus(focusContext)
                }
            },
            beforeFirstMouseDown: {
                try beforeFirstMouseDown()
                try InputSimulation.stopIfUserIsOperatingTarget(pid: target.pid)
            }
        )
    }

    private static func validate(target: SkyClickTarget) throws {
        guard
            target.screenPoint.x.isFinite,
            target.screenPoint.y.isFinite,
            target.windowPoint.x.isFinite,
            target.windowPoint.y.isFinite,
            target.windowBounds.width > 0,
            target.windowBounds.height > 0
        else {
            throw ComputerUseError.message("sky_click requires finite target coordinates and window bounds")
        }

        let localBounds = CGRect(origin: .zero, size: target.windowBounds.size)
        guard localBounds.contains(target.windowPoint) else {
            throw ComputerUseError.message("sky_click target is outside the snapshot window bounds")
        }

        let windowInfo = CGWindowListCopyWindowInfo(
            [.optionIncludingWindow],
            target.windowID
        ) as? [[String: Any]] ?? []
        guard skyClickWindowMatchesTarget(
            windowInfo: windowInfo,
            windowID: target.windowID,
            pid: target.pid
        ) else {
            throw ComputerUseError.stateUnavailable(
                "sky_click target window is stale, off-screen, or no longer owned by the target app. Run get_app_state again."
            )
        }
    }

    private static func stamp(
        _ event: CGEvent,
        target: SkyClickTarget,
        windowPoint: CGPoint,
        clickState: Int64,
        phase: Int64,
        clickGroupID: Int64,
        spi: SkyLightSPI
    ) throws {
        let windowID = Int64(target.windowID)
        try spi.setIntegerField(event, field: EventField.gesturePhase, value: phase)
        try spi.setIntegerField(event, field: EventField.clickState, value: clickState)
        try spi.setIntegerField(event, field: EventField.buttonNumber, value: 0)
        try spi.setIntegerField(event, field: EventField.subtype, value: 3)
        try spi.setIntegerField(event, field: EventField.targetPID, value: Int64(target.pid))
        try spi.setIntegerField(event, field: EventField.windowNumber, value: windowID)
        try spi.setIntegerField(event, field: EventField.clickGroupID, value: clickGroupID)
        try spi.setIntegerField(event, field: EventField.windowUnderPointer, value: windowID)
        try spi.setIntegerField(event, field: EventField.handlingWindowUnderPointer, value: windowID)
        try spi.setWindowLocation(event, point: windowPoint)
    }

}
