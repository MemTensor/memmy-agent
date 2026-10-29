import AppKit
import ApplicationServices
import Foundation
import ImageIO

struct VisualCursorTarget: Equatable {
    let point: CGPoint
    let window: CursorTargetWindow?
}

public enum ClickMethod: String, CaseIterable, Sendable {
    case auto
    case accessibility
    case appPost = "app_post"
    case skyClick = "sky_click"
    case global
}

func clickActionSnapshotRecoveryPolicy(for method: ClickMethod) -> SnapshotRecoveryPolicy {
    method == .global ? .allowActivation : .readOnly
}

/// A background refresh must not steal focus while the target window is already on screen.
/// An off-screen or minimized window of that same app still has to be raised, or the action
/// cannot run and the model tries to click the Dock instead.
func shouldRecoverMissingTargetWindow(recoveryPolicy: SnapshotRecoveryPolicy, appHasOnScreenWindow: Bool) -> Bool {
    recoveryPolicy == .allowActivation || !appHasOnScreenWindow
}

func shouldReuseCachedAppSnapshot(isFixture: Bool, targetWindowOnScreen: Bool) -> Bool {
    isFixture || targetWindowOnScreen
}

func shouldRestoreFrontmostApp(previousPID: pid_t?, currentPID: pid_t?, targetPID: pid_t,
                              inputIdle: TimeInterval? = nil) -> Bool {
    guard let previousPID, previousPID > 0, previousPID != targetPID else {
        return false
    }
    guard let currentPID, currentPID == targetPID, currentPID != previousPID else {
        return false
    }
    // A human may have brought the target forward during dispatch. Restoring
    // the previous app then would take focus away from that explicit choice.
    if let inputIdle, !inputIdle.isFinite || inputIdle < 0.45 {
        return false
    }
    return true
}

struct FrontmostAppLease {
    let previousPID: pid_t?

    static func capture() -> FrontmostAppLease {
        FrontmostAppLease(previousPID: NSWorkspace.shared.frontmostApplication?.processIdentifier)
    }

    func restoreIfStolen(by targetPID: pid_t) {
        let currentPID = NSWorkspace.shared.frontmostApplication?.processIdentifier
        guard let anyEvent = CGEventType(rawValue: UInt32.max) else { return }
        let idle = CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: anyEvent)
        guard shouldRestoreFrontmostApp(previousPID: previousPID, currentPID: currentPID,
                                       targetPID: targetPID, inputIdle: idle),
              let previousPID,
              let application = NSRunningApplication(processIdentifier: previousPID) else {
            return
        }
        _ = application.activate(options: [])
    }
}

let clickSettleDelay: TimeInterval = 0.4

let unchangedClickObservation = "The last click did not change the window or the accessibility tree. A background window does not draw its text cursor or focus ring, so this alone does not mean the click was ignored: if it was meant to place the cursor or focus a field, continue with the next step, such as type_text, and check that result. Otherwise do not send the same single click again. If a menu or popup is visible in the screenshot but missing from the tree, click it with x and y in these screenshot pixels and do not rescale. To edit text inside an object on a canvas, such as a slide placeholder, use click_count 2 on it."

let screenshotOnlyClickObservation = "The accessibility tree did not change, but the screenshot did. Use the screenshot; a menu or popup may be visible there and missing from the tree. Click it with x and y in these screenshot pixels and do not rescale."

let foregroundUnchangedClickObservation = "The foreground click did not change the window either; the app's menu bar or a keyboard shortcut may reach the same command."

func foregroundClickHandBackObservation(_ handBack: ForegroundClickHandBack) -> String? {
    switch handBack {
    case .notNeeded:
        return nil
    case .returned:
        return "The window was made active for this click, and the previously active app is in front again."
    case .keptForUser:
        return "The user took over the foreground during this click, so it was left as they set it."
    case .notReturned:
        return "The previously active app could not be brought back to the front."
    }
}

/// A dialog or popover is its own window. Input routed through the window
/// behind it, even at pixels where it shows in that window's screenshot,
/// reaches the window behind.
func openedWindowObservation(_ windowIDs: [CGWindowID]) -> String? {
    guard !windowIDs.isEmpty else { return nil }
    let ids = windowIDs.map { "window_id=\($0)" }.joined(separator: ", ")
    return "The click opened \(ids). A dialog or popup is its own window: call get_app_state with that window_id and act there, not through this window's screenshot."
}

func clickObservationNote(
    surfaceChanged: Bool,
    onlyScreenshotChanged: Bool,
    foreground: ForegroundClickHandBack?,
    openedWindowIDs: [CGWindowID] = []
) -> String? {
    var notes: [String] = []
    if let opened = openedWindowObservation(openedWindowIDs) {
        notes.append(opened)
    } else if !surfaceChanged {
        notes.append(foreground == nil ? unchangedClickObservation : foregroundUnchangedClickObservation)
    } else if onlyScreenshotChanged {
        notes.append(screenshotOnlyClickObservation)
    }
    if let foreground, let handBack = foregroundClickHandBackObservation(foreground) {
        notes.append(handBack)
    }
    return notes.isEmpty ? nil : notes.joined(separator: " ")
}

struct ClickSurfaceFingerprint: Equatable {
    var windowID: UInt32
    var windowTitle: String
    var tree: String
    var screenshot: Data
}

func clickSurfaceFingerprint(_ snapshot: AppSnapshot) -> ClickSurfaceFingerprint {
    ClickSurfaceFingerprint(
        windowID: snapshot.targetWindowID ?? 0,
        windowTitle: snapshot.windowTitle ?? "",
        tree: snapshot.treeLines.joined(separator: "\n"),
        screenshot: snapshot.screenshotPNGData ?? Data()
    )
}

func clickSurfaceChanged(_ before: ClickSurfaceFingerprint, _ after: ClickSurfaceFingerprint) -> Bool {
    before != after
}

/// An accepted click can start an asynchronous transition. Reobserve once if
/// its first frame is unchanged; never use that absence of change to dispatch
/// another mutation through a different input channel.
func observeClickTransition<State>(
    observe: () throws -> State,
    hasChanged: (State) -> Bool
) rethrows -> State {
    let first = try observe()
    return hasChanged(first) ? first : try observe()
}

func clickCandidateMatchesRequestedPoint(
    role: String?, frame: CGRect?, requestedWindowPoint: CGPoint?
) -> Bool {
    // An element-index request may deliberately identify a container. Preserve
    // that semantic path; coordinate requests must stay at their exact point.
    guard let requestedWindowPoint else { return true }
    guard role != kAXWindowRole as String, role != kAXApplicationRole as String,
          let frame, !frame.isEmpty, !frame.isNull else { return false }
    return frame.contains(requestedWindowPoint)
}

func performFirstPointMatchedClick<Candidate>(
    _ candidates: [Candidate],
    requestedWindowPoint: CGPoint?,
    geometry: (Candidate) -> (role: String?, frame: CGRect?),
    click: (Candidate) throws -> Bool
) rethrows -> Bool {
    for candidate in candidates {
        let bounds = geometry(candidate)
        guard clickCandidateMatchesRequestedPoint(role: bounds.role, frame: bounds.frame,
                                                 requestedWindowPoint: requestedWindowPoint) else { continue }
        if try click(candidate) { return true }
    }
    return false
}

func globalPointForWindowPoint(_ point: CGPoint, windowBounds: CGRect) -> CGPoint {
    CGPoint(x: windowBounds.minX + point.x, y: windowBounds.minY + point.y)
}

struct AccessibilityActionUncertain: LocalizedError {
    let action: String
    let result: AXError

    var errorDescription: String? {
        "Accessibility action \(action) may already have executed (AX error \(result.rawValue)). Its result is uncertain and the action was not replayed. Do not repeat it. Run get_app_state to observe the current state before continuing."
    }
}

func performAccessibilityActionSequence(
    action: String,
    repeatCount: Int,
    perform: () -> AXError,
    pause: (TimeInterval) -> Void = { Thread.sleep(forTimeInterval: $0) }
) throws -> Bool {
    let attempts = max(repeatCount, 1)
    var accepted = false
    for index in 0..<attempts {
        let result = perform()
        guard result == .success else {
            // A later failure cannot undo an earlier accepted action. AX
            // cannotComplete is also ambiguous on the first attempt: the app
            // may have consumed the request before its response was lost.
            if accepted || result == .cannotComplete {
                throw AccessibilityActionUncertain(action: action, result: result)
            }
            switch result {
            case .failure, .actionUnsupported, .attributeUnsupported, .noValue, .invalidUIElement, .illegalArgument:
                return false
            default:
                throw ComputerUseError.message("AXUIElementPerformAction(\(action)) failed with \(result.rawValue)")
            }
        }
        accepted = true
        if index < attempts - 1 { pause(0.05) }
    }
    return true
}

func parseClickMethod(_ rawValue: String?) throws -> ClickMethod {
    let normalized = rawValue?
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased() ?? ClickMethod.auto.rawValue

    guard let method = ClickMethod(rawValue: normalized) else {
        let expected = ClickMethod.allCases.map(\.rawValue).joined(separator: ", ")
        throw ComputerUseError.message(
            "Invalid click_method '\(rawValue ?? "")'. Expected one of: \(expected)"
        )
    }

    return method
}

func validateClickMethod(
    _ method: ClickMethod,
    hasElementIndex: Bool,
    environment: [String: String]
) throws {
    if method == .accessibility, !hasElementIndex {
        throw ComputerUseError.message("click_method 'accessibility' requires element_index")
    }

    if method == .global, !globalPointerFallbacksEnabled(environment: environment) {
        throw ComputerUseError.message(
            "click_method 'global' requires OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS=1 because it may move the system pointer and change foreground focus"
        )
    }
}

func validateForegroundClick(foreground: Bool, method: ClickMethod) throws {
    guard foreground, method == .accessibility || method == .global else {
        return
    }

    throw ComputerUseError.message(
        "foreground=true sends a pointer click; use click_method auto, app_post, or sky_click"
    )
}

func validateSkyClickArguments(
    method: ClickMethod,
    mouseButton: String,
    clickCount: Int
) throws {
    guard method == .skyClick else {
        return
    }

    guard mouseButton.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == MouseButtonKind.left.rawValue else {
        throw ComputerUseError.message(
            "click_method 'sky_click' only supports mouse_button 'left'"
        )
    }

    guard (1...2).contains(clickCount) else {
        throw ComputerUseError.message(
            "click_method 'sky_click' supports click_count 1 or 2"
        )
    }
}

struct VisualCursorScreenMapping: Equatable {
    let screenStateFrame: CGRect
    let appKitFrame: CGRect
}

func currentVisualCursorScreenMappings() -> [VisualCursorScreenMapping] {
    NSScreen.screens.compactMap { screen in
        guard let screenNumber = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else {
            return nil
        }

        return VisualCursorScreenMapping(
            screenStateFrame: CGDisplayBounds(CGDirectDisplayID(screenNumber.uint32Value)),
            appKitFrame: screen.frame
        )
    }
}

func screenStatePointToAppKitGlobalPoint(
    fromScreenStatePoint point: CGPoint,
    screenMappings: [VisualCursorScreenMapping] = currentVisualCursorScreenMappings()
) -> CGPoint {
    guard let mapping = screenMappings.first(where: { $0.screenStateFrame.contains(point) }) else {
        return point
    }

    let localX = point.x - mapping.screenStateFrame.minX
    let localY = point.y - mapping.screenStateFrame.minY

    return CGPoint(
        x: mapping.appKitFrame.minX + localX,
        y: mapping.appKitFrame.maxY - localY
    )
}

func visualCursorAppKitPoint(
    fromScreenStatePoint point: CGPoint,
    screenMappings: [VisualCursorScreenMapping] = currentVisualCursorScreenMappings()
) -> CGPoint {
    screenStatePointToAppKitGlobalPoint(
        fromScreenStatePoint: point,
        screenMappings: screenMappings
    )
}

func inputEventPoint(
    fromScreenStatePoint point: CGPoint,
    screenMappings: [VisualCursorScreenMapping] = currentVisualCursorScreenMappings()
) -> CGPoint {
    point
}

func makeVisualCursorTarget(
    at point: CGPoint,
    targetWindowID: CGWindowID?,
    targetWindowLayer: Int?,
    screenMappings: [VisualCursorScreenMapping] = currentVisualCursorScreenMappings()
) -> VisualCursorTarget {
    VisualCursorTarget(
        point: screenStatePointToAppKitGlobalPoint(
            fromScreenStatePoint: point,
            screenMappings: screenMappings
        ),
        window: targetWindowID.map { CursorTargetWindow(windowID: $0, layer: targetWindowLayer ?? 0) }
    )
}

func makeVisualCursorTarget(
    localFrame: CGRect?,
    windowBounds: CGRect?,
    targetWindowID: CGWindowID?,
    targetWindowLayer: Int?,
    screenMappings: [VisualCursorScreenMapping] = currentVisualCursorScreenMappings()
) -> VisualCursorTarget? {
    guard let localFrame, let windowBounds else {
        return nil
    }

    let point = CGPoint(
        x: windowBounds.minX + localFrame.midX,
        y: windowBounds.minY + localFrame.midY
    )
    return makeVisualCursorTarget(
        at: point,
        targetWindowID: targetWindowID,
        targetWindowLayer: targetWindowLayer,
        screenMappings: screenMappings
    )
}

func inputFallbackDebugEnabled(environment: [String: String]) -> Bool {
    guard let rawValue = environment["OPEN_COMPUTER_USE_DEBUG_INPUT_FALLBACKS"]?
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased()
    else {
        return false
    }

    return ["1", "true", "yes", "on"].contains(rawValue)
}

func globalPointerFallbacksEnabled(environment: [String: String]) -> Bool {
    guard let rawValue = environment["OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS"]?
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased()
    else {
        return false
    }

    return ["1", "true", "yes", "on"].contains(rawValue)
}

/// How a `drag` is delivered. `drag` has no method argument; the path is decided
/// by the same process-level gate that authorizes `click_method=global`.
enum DragDeliveryPath: String, CaseIterable {
    /// `CGEvent.postToPid`: never moves the system pointer, but the events do not
    /// pass through the window server, so window-server drag sessions (window
    /// moves, text selection, Finder drag-and-drop) are not driven.
    case appPost = "app_post"
    /// `.cghidEventTap`: drives window-server drag sessions and may move the
    /// real pointer or change foreground focus.
    case global
}

func dragDeliveryPath(environment: [String: String]) -> DragDeliveryPath {
    globalPointerFallbacksEnabled(environment: environment) ? .global : .appPost
}

func dragDeliveryNote(for path: DragDeliveryPath) -> String {
    switch path {
    case .appPost:
        return "Drag delivered via app_post: mouse events were posted directly to the target process and the system pointer did not move. This path cannot drive window-server drag sessions such as window moves, text selection, or Finder drag-and-drop. If the drag had no effect, set OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS=1 in the server process environment to use the global pointer path, which may move the real pointer and change foreground focus."
    case .global:
        return "Drag delivered via global pointer path: OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS is enabled, so the real pointer may have moved and foreground focus may have changed."
    }
}

/// Inserts the delivery note after the snapshot text and before any screenshot,
/// so `primaryText` remains the snapshot for existing consumers.
func appendingDragDeliveryNote(to result: ToolCallResult, path: DragDeliveryPath) -> ToolCallResult {
    var content = result.content
    let insertIndex = content.firstIndex { $0.dictionary["type"] as? String == "image" } ?? content.endIndex
    content.insert(.text(dragDeliveryNote(for: path)), at: insertIndex)
    return ToolCallResult(content: content, isError: result.isError, metadata: result.metadata)
}

func screenshotPixelScale(
    screenshotPixelSize: CGSize?,
    windowBounds: CGRect?
) -> CGSize {
    guard
        let screenshotPixelSize,
        let windowBounds,
        windowBounds.width > 0,
        windowBounds.height > 0,
        screenshotPixelSize.width > 0,
        screenshotPixelSize.height > 0
    else {
        return CGSize(width: 1, height: 1)
    }

    return CGSize(
        width: screenshotPixelSize.width / windowBounds.width,
        height: screenshotPixelSize.height / windowBounds.height
    )
}

func screenshotPixelToWindowPoint(
    _ point: CGPoint,
    screenshotPixelSize: CGSize?,
    windowBounds: CGRect?
) -> CGPoint {
    let scale = screenshotPixelScale(
        screenshotPixelSize: screenshotPixelSize,
        windowBounds: windowBounds
    )
    return CGPoint(
        x: point.x / scale.width,
        y: point.y / scale.height
    )
}

func coordinateActionScreenshotError(hasScreenshot: Bool, screenRecordingGranted: Bool) -> ComputerUseError? {
    if !screenRecordingGranted {
        return .permissionDenied("Screen Recording permission is required. Grant access to Memmy in System Settings.")
    }
    if !hasScreenshot {
        return .stateUnavailable("Pixel coordinates require a current app screenshot. Call get_app_state with require_screenshot=true, then use coordinates from that image.")
    }
    return nil
}

let nonSettableSetValueErrorMessage = "Cannot set a value for an element that is not settable"

func setValueAttributeIsSettable(result: AXError, settable: Bool, attribute: String) throws -> Bool {
    guard result == .success else {
        throw ComputerUseError.message("AXUIElementIsAttributeSettable(\(attribute)) failed with \(result.rawValue)")
    }

    return settable
}

func invalidSecondaryActionErrorMessage(action: String, elementIndex: Int) -> String {
    "\(action) is not a valid secondary action for \(elementIndex)"
}

func localClickActionPoints(frame: CGRect, isSyntheticText: Bool) -> [CGPoint] {
    let center = CGPoint(x: frame.midX, y: frame.midY)
    let leading = CGPoint(
        x: frame.minX + min(max(frame.width * 0.3, 20), max(frame.width - 4, 20)),
        y: frame.midY
    )

    if isSyntheticText {
        return [leading]
    }

    if abs(leading.x - center.x) < 1 {
        return [center]
    }

    return [center, leading]
}

func isLikelySyntheticSideActionCandidate(
    parentFrame: CGRect?,
    candidateFrame: CGRect?,
    hasPrimaryAction: Bool,
    labels: [String]
) -> Bool {
    let hasSideActionLabel = labels.contains { label in
        let normalized = label.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !normalized.isEmpty else {
            return false
        }

        if normalized == "完成" || normalized == "done" || normalized == "complete" || normalized == "archive" {
            return true
        }

        if normalized.count <= 24 {
            if normalized.contains("完成") {
                return true
            }

            if normalized.contains("mark") && (normalized.contains("done") || normalized.contains("complete")) {
                return true
            }
        }

        return false
    }

    guard let parentFrame, let candidateFrame else {
        return false
    }

    let trailingBandWidth = min(max(parentFrame.width * 0.22, 56), 140)
    let isTrailing = candidateFrame.midX >= parentFrame.maxX - trailingBandWidth
    let compactWidth = candidateFrame.width <= max(88, parentFrame.width * 0.18)
    let compactHeight = candidateFrame.height <= max(44, parentFrame.height * 1.2)
    let isCompact = compactWidth && compactHeight

    if hasSideActionLabel && hasPrimaryAction && isCompact {
        return true
    }

    return isTrailing && isCompact && (hasPrimaryAction || hasSideActionLabel)
}

func shouldScanDescendantsOfHitRecord(originalFrame: CGRect?, hitFrame: CGRect?) -> Bool {
    guard let originalFrame, let hitFrame else {
        return true
    }

    let originalArea = max(originalFrame.width * originalFrame.height, 1)
    let hitArea = hitFrame.width * hitFrame.height
    if hitArea > max(originalArea * 12, 20_000) {
        return false
    }

    if hitFrame.height > max(originalFrame.height * 4, 96),
       hitFrame.width > max(originalFrame.width * 2, 240)
    {
        return false
    }

    return true
}

func isLikelyContainingRowActionFrame(
    targetFrame: CGRect,
    candidateFrame: CGRect?,
    hasPrimaryAction: Bool
) -> Bool {
    let targetCenter = CGPoint(x: targetFrame.midX, y: targetFrame.midY)
    guard
        hasPrimaryAction,
        let candidateFrame,
        candidateFrame.insetBy(dx: -2, dy: -2).contains(targetCenter),
        candidateFrame.width >= targetFrame.width,
        candidateFrame.height >= targetFrame.height,
        candidateFrame.height <= max(targetFrame.height + 32, targetFrame.height * 2)
    else {
        return false
    }

    return true
}

func canUseActivationOnlyClickFallback(role: String?) -> Bool {
    guard let role else {
        return false
    }

    return role == kAXWindowRole as String
}

/// A hit test at an element's point may reach something drawn over it, such
/// as a floating bar over a list. Only the element, its contents or one of its
/// containers stands for it there.
func hitElement(_ hit: AXUIElement, standsFor element: AXUIElement) -> Bool {
    CFEqual(hit, element) || AXWindowIdentity.contains(hit, in: element) || AXWindowIdentity.contains(element, in: hit)
}

let unchangedTypeTextObservation = "The window and the accessibility tree have not changed yet. Some apps redraw a background window late, so the text may already be there: call get_app_state again and check before typing anything again. If it is still missing, the focus may not be the intended text position (a slide placeholder takes text after click_count 2), or the focus may drop keystrokes, as a PowerPoint slide in the background does; type_text with paste: true enters text there."

func isElectronScopedWebRowClickOptimizationTarget(appName: String, bundleIdentifier: String?) -> Bool {
    let normalizedBundleIdentifier = bundleIdentifier?
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased()
    let normalizedName = appName
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased()

    if let normalizedBundleIdentifier,
       normalizedBundleIdentifier.hasPrefix("com.electron.")
            || normalizedBundleIdentifier.contains(".electron.")
            || normalizedBundleIdentifier.contains("lark")
            || normalizedBundleIdentifier.contains("feishu")
    {
        return true
    }

    return normalizedName == "lark" || normalizedName == "feishu" || normalizedName == "飞书"
}

func shouldPreferContainingWebRowAXClickCandidate(
    role: String?,
    isSyntheticText: Bool,
    hasWebAreaAncestor: Bool,
    appName: String,
    bundleIdentifier: String?
) -> Bool {
    guard hasWebAreaAncestor,
          isElectronScopedWebRowClickOptimizationTarget(
            appName: appName,
            bundleIdentifier: bundleIdentifier
          )
    else {
        return false
    }

    guard let role else {
        return isSyntheticText
    }

    return role == kAXStaticTextRole as String || role == kAXGroupRole as String || isSyntheticText
}

public final class ComputerUseService {
    // Aliases identify the last observed window without retaining evicted AX
    // objects or PNGs outside the bounded per-window snapshot store.
    private var snapshotsByApp: [String: (app: RunningAppDescriptor, targetWindowID: CGWindowID?)] = [:]
    private var snapshotsByWindow = WindowSnapshotStore<AppSnapshot>()
    private var confirmedCoordinateRetry: (observationID: String, intent: CoordinateObservationIntent)?
    typealias SnapshotLoader = (RunningAppDescriptor, CGWindowID?, SnapshotTextLimit, AccessibilityTreeLimits, SnapshotRecoveryPolicy, Bool) throws -> AppSnapshot
    private let lockScreenState: () -> LockScreenState
    private let appResolver: (String) throws -> RunningAppDescriptor
    private let snapshotLoader: SnapshotLoader
    private let fixtureCommandPoster: (FixtureCommand) throws -> Void
    private let appIsRunning: (RunningAppDescriptor) -> Bool

    public init(lockScreenState: @escaping () -> LockScreenState = LockScreenState.current) {
        self.lockScreenState = lockScreenState
        self.appResolver = AppDiscovery.resolve
        self.snapshotLoader = { app, windowID, textLimit, treeLimits, recoveryPolicy, requireScreenshot in
            try SnapshotBuilder.build(for: app, windowID: windowID, textLimit: textLimit, treeLimits: treeLimits,
                                      recoveryPolicy: recoveryPolicy, requireScreenshot: requireScreenshot)
        }
        self.fixtureCommandPoster = FixtureBridge.post
        self.appIsRunning = { !$0.runningApplication.isTerminated }
    }

    // Exercise the actual service dispatch boundary without opening apps or
    // posting fixture commands to another process in source regression tests.
    init(lockScreenState: @escaping () -> LockScreenState,
         appResolver: @escaping (String) throws -> RunningAppDescriptor,
         snapshotLoader: @escaping SnapshotLoader,
         appIsRunning: @escaping (RunningAppDescriptor) -> Bool,
         fixtureCommandPoster: @escaping (FixtureCommand) throws -> Void) {
        self.lockScreenState = lockScreenState
        self.appResolver = appResolver
        self.snapshotLoader = snapshotLoader
        self.fixtureCommandPoster = fixtureCommandPoster
        self.appIsRunning = appIsRunning
    }

    public func listApps() -> ToolCallResult {
        ToolCallResult.text(
            AppDiscovery.listCatalog()
                .map(\.renderedLine)
                .joined(separator: "\n")
        )
    }

    public func getAppState(
        app query: String,
        windowID: CGWindowID? = nil,
        textLimit: SnapshotTextLimit = .defaults,
        treeLimits: AccessibilityTreeLimits = .defaults,
        requireScreenshot: Bool = false
    ) throws -> ToolCallResult {
        let snapshot = try refreshSnapshot(for: query, windowID: windowID, textLimit: textLimit, treeLimits: treeLimits,
                                           requireScreenshot: requireScreenshot)
        if requireScreenshot && snapshot.screenshotPNGData == nil {
            throw ComputerUseError.stateUnavailable("The app screenshot is unavailable for this target.")
        }
        return snapshotResult(for: snapshot, style: .fullState)
    }

    public func click(
        app query: String,
        windowID: CGWindowID? = nil,
        observationID: String? = nil,
        elementIndex: String?,
        x: Double?,
        y: Double?,
        clickCount: Int,
        mouseButton: String,
        clickMethod: ClickMethod = .auto,
        foreground: Bool = false
    ) throws -> ToolCallResult {
        try validateClickMethod(
            clickMethod,
            hasElementIndex: elementIndex != nil,
            environment: ProcessInfo.processInfo.environment
        )
        try validateSkyClickArguments(
            method: clickMethod,
            mouseButton: mouseButton,
            clickCount: clickCount
        )
        try validateForegroundClick(foreground: foreground, method: clickMethod)

        let coordinateIntent: CoordinateObservationIntent? = elementIndex == nil ? x.flatMap { x in y.map { .click(CGPoint(x: x, y: $0)) } } : nil
        let snapshot = try currentSnapshot(for: query, windowID: windowID, observationID: observationID,
            actionIntent: elementIndex.map(ActionObservationIntent.element)
                ?? coordinateIntent.map(ActionObservationIntent.coordinate) ?? .window)
        var foregroundHandBack: ForegroundClickHandBack?
        let frontmost = FrontmostAppLease.capture()
        defer {
            // A foreground session decides the hand-back itself; after it has
            // returned the foreground, this still catches a later steal.
            if !foreground || foregroundHandBack == .returned { frontmost.restoreIfStolen(by: snapshot.app.pid) }
        }
        let button = MouseButtonKind(rawValue: mouseButton.lowercased()) ?? .left
        if snapshot.mode == .fixture {
            guard clickMethod == .auto, !foreground else {
                throw ComputerUseError.message(
                    "click_method '\(clickMethod.rawValue)'\(foreground ? " with foreground=true" : "") is not supported for fixture apps"
                )
            }

            let cursorTarget: VisualCursorTarget?
            if let elementIndex {
                let record = try lookupElement(snapshot: snapshot, index: elementIndex)
                guard let identifier = record.identifier else {
                    throw ComputerUseError.invalidArguments("fixture click requires an identifier-backed element")
                }
                cursorTarget = visualCursorTarget(for: record, snapshot: snapshot)
                moveVisualCursor(to: cursorTarget)
                try fixtureCommandPoster(FixtureCommand(kind: "click", identifier: identifier))
            } else if let x, let y {
                let identifier = try fixtureIdentifier(at: CGPoint(x: x, y: y), snapshot: snapshot)
                cursorTarget = fixtureVisualCursorTarget(identifier: identifier, snapshot: snapshot)
                moveVisualCursor(to: cursorTarget)
                try fixtureCommandPoster(FixtureCommand(kind: "click", identifier: identifier, x: x, y: y))
            } else {
                throw ComputerUseError.invalidArguments("click requires either element_index or x/y")
            }

            Thread.sleep(forTimeInterval: 0.15)
            pulseVisualCursor(at: cursorTarget, clickCount: clickCount, mouseButton: button)
            return snapshotResult(for: try refreshAfterAction(for: query, snapshot: snapshot), style: .actionResult)
        }

        try InputSimulation.stopIfUserIsOperatingTarget(pid: snapshot.app.pid)
        if let elementIndex {
            let record = try lookupElement(snapshot: snapshot, index: elementIndex)
            guard let windowPoint = clickPoint(for: record, snapshot: snapshot) else {
                throw ComputerUseError.stateUnavailable("element \(elementIndex) has no clickable frame")
            }
            let targetPoint = try windowPointToGlobalPoint(snapshot: snapshot, point: windowPoint)
            let cursorTarget = makeVisualCursorTarget(
                at: targetPoint,
                targetWindowID: snapshot.targetWindowID,
                targetWindowLayer: snapshot.targetWindowLayer
            )

            moveVisualCursor(to: cursorTarget)

            do {
                switch clickMethod {
                case _ where foreground:
                    try requireUncoveredPointerTarget(record, elementIndex: elementIndex, at: windowPoint, in: snapshot)
                    foregroundHandBack = try performForegroundClick(
                        method: clickMethod,
                        at: targetPoint,
                        windowPoint: windowPoint,
                        button: button,
                        clickCount: clickCount,
                        targetDescription: "element_index=\(elementIndex)",
                        snapshot: snapshot
                    )
                case .auto:
                    if !(try performAXClickSequence(
                        on: record,
                        snapshot: snapshot,
                        button: button,
                        clickCount: clickCount,
                        includeNearbyHitTesting: true,
                        allowActivationFallback: false
                    )) {
                        try requireUncoveredPointerTarget(record, elementIndex: elementIndex, at: windowPoint, in: snapshot)
                        try performNonAXClickFallback(
                            at: targetPoint,
                            button: button,
                            clickCount: clickCount,
                            targetDescription: "element_index=\(elementIndex)",
                            snapshot: snapshot
                        )
                    }
                case .accessibility:
                    guard try performAXClickSequence(
                        on: record,
                        snapshot: snapshot,
                        button: button,
                        clickCount: clickCount,
                        includeNearbyHitTesting: true,
                        allowActivationFallback: false
                    ) else {
                        throw ComputerUseError.message(
                            "click_method 'accessibility' could not click element_index=\(elementIndex)"
                        )
                    }
                case .appPost, .skyClick, .global:
                    try requireUncoveredPointerTarget(record, elementIndex: elementIndex, at: windowPoint, in: snapshot)
                    try performExplicitMouseClick(
                        method: clickMethod,
                        at: targetPoint,
                        windowPoint: windowPoint,
                        button: button,
                        clickCount: clickCount,
                        targetDescription: "element_index=\(elementIndex)",
                        snapshot: snapshot
                    )
                }
            } catch let error as InputSimulation.UserInputYield {
                settleVisualCursor(at: cursorTarget)
                // Auto may have attempted an AX action before reaching the
                // guarded pointer fallback. Never call the whole tool unsent.
                throw foreground ? error : InputSimulation.UserInputYield(dispatched: error.dispatched || clickMethod == .auto)
            } catch {
                settleVisualCursor(at: cursorTarget)
                throw error
            }

            pulseVisualCursor(at: cursorTarget, clickCount: clickCount, mouseButton: button)
        } else if let x, let y {
            if let error = coordinateActionScreenshotError(
                hasScreenshot: snapshot.screenshotPNGData != nil,
                screenRecordingGranted: PermissionDiagnostics.current().screenCaptureGranted
            ) {
                throw error
            }
            let screenshotPoint = CGPoint(x: x, y: y)
            let point = screenshotPixelToWindowPointInSnapshot(snapshot: snapshot, point: screenshotPoint)
            let targetPoint = try windowPointToGlobalPoint(snapshot: snapshot, point: point)
            let cursorTarget = makeVisualCursorTarget(
                at: targetPoint,
                targetWindowID: snapshot.targetWindowID,
                targetWindowLayer: snapshot.targetWindowLayer
            )

            moveVisualCursor(to: cursorTarget)

            do {
                switch clickMethod {
                case _ where foreground:
                    foregroundHandBack = try performForegroundClick(
                        method: clickMethod,
                        at: targetPoint,
                        windowPoint: point,
                        button: button,
                        clickCount: clickCount,
                        targetDescription: "x=\(Int(screenshotPoint.x)) y=\(Int(screenshotPoint.y))",
                        snapshot: snapshot
                    )
                case .auto:
                    let candidates = try clickCandidates(at: point, in: snapshot)
                    let handled = try performFirstPointMatchedClick(candidates,
                        requestedWindowPoint: point, geometry: { ($0.role, $0.localFrame) }, click: { record in
                        try performAXClickSequence(
                            on: record,
                            snapshot: snapshot,
                            button: button,
                            clickCount: clickCount,
                            includeNearbyHitTesting: false,
                            allowActivationFallback: false,
                            requestedWindowPoint: point
                        )
                    })

                    if !handled {
                        try performNonAXClickFallback(
                            at: targetPoint,
                            button: button,
                            clickCount: clickCount,
                            targetDescription: "x=\(Int(screenshotPoint.x)) y=\(Int(screenshotPoint.y))",
                            snapshot: snapshot
                        )
                    }
                case .accessibility:
                    throw ComputerUseError.message("click_method 'accessibility' requires element_index")
                case .appPost, .skyClick, .global:
                    try performExplicitMouseClick(
                        method: clickMethod,
                        at: targetPoint,
                        windowPoint: point,
                        button: button,
                        clickCount: clickCount,
                        targetDescription: "x=\(Int(screenshotPoint.x)) y=\(Int(screenshotPoint.y))",
                        snapshot: snapshot
                    )
                }
            } catch let error as InputSimulation.UserInputYield {
                settleVisualCursor(at: cursorTarget)
                throw foreground ? error : InputSimulation.UserInputYield(dispatched: error.dispatched || clickMethod == .auto)
            } catch {
                settleVisualCursor(at: cursorTarget)
                throw error
            }

            pulseVisualCursor(at: cursorTarget, clickCount: clickCount, mouseButton: button)
        } else {
            throw ComputerUseError.invalidArguments("click requires either element_index or x/y")
        }

        let before = clickSurfaceFingerprint(snapshot)
        var observed = try observeClickTransition(
            observe: { try captureSettledClickSnapshot(for: query, snapshot: snapshot, clickMethod: clickMethod) },
            hasChanged: { clickSurfaceChanged(before, clickSurfaceFingerprint($0)) }
        )
        let after = clickSurfaceFingerprint(observed)
        let surfaceChanged = clickSurfaceChanged(before, after)
        let onlyScreenshotChanged = surfaceChanged && before.windowID == after.windowID
            && before.windowTitle == after.windowTitle && before.tree == after.tree
        let knownWindowIDs = Set(snapshot.availableWindows.map(\.windowID))
        if let note = clickObservationNote(
            surfaceChanged: surfaceChanged,
            onlyScreenshotChanged: onlyScreenshotChanged,
            foreground: foregroundHandBack,
            openedWindowIDs: knownWindowIDs.isEmpty ? [] : observed.availableWindows.map(\.windowID)
                .filter { !knownWindowIDs.contains($0) && $0 != observed.targetWindowID }
        ) {
            observed = observed.withObservationNote(note)
        }
        return snapshotResult(for: observed, style: .actionResult)
    }

    private func captureSettledClickSnapshot(for query: String, snapshot: AppSnapshot, clickMethod: ClickMethod) throws -> AppSnapshot {
        Thread.sleep(forTimeInterval: clickSettleDelay)
        return try refreshAfterAction(for: query, snapshot: snapshot,
                                      recoveryPolicy: clickActionSnapshotRecoveryPolicy(for: clickMethod))
    }

    private func refreshAfterAction(for query: String, snapshot: AppSnapshot,
                                    recoveryPolicy: SnapshotRecoveryPolicy = .readOnly) throws -> AppSnapshot {
        do {
            return try refreshSnapshot(for: query, windowID: snapshot.targetWindowID, expectedApp: snapshot.app,
                                       recoveryPolicy: recoveryPolicy)
        } catch var error as TargetWindowUnavailable {
            error.closedAfterAction = true
            throw error
        }
    }

    public func performSecondaryAction(app query: String, windowID: CGWindowID? = nil, observationID: String? = nil, elementIndex: String, action: String) throws -> ToolCallResult {
        let snapshot = try currentSnapshot(for: query, windowID: windowID, observationID: observationID,
            actionIntent: .element(elementIndex))
        let record = try lookupElement(snapshot: snapshot, index: elementIndex)

        if snapshot.mode == .fixture {
            guard action.caseInsensitiveCompare("Raise") == .orderedSame else {
                throw ComputerUseError.message(invalidSecondaryActionMessage(action: action, record: record))
            }

            return snapshotResult(for: try refreshAfterAction(for: query, snapshot: snapshot), style: .actionResult)
        }

        guard let rawAction = matchingAction(requested: action, record: record) else {
            throw ComputerUseError.message(invalidSecondaryActionMessage(action: action, record: record))
        }

        guard let element = record.element else {
            throw ComputerUseError.stateUnavailable("element \(elementIndex) has no backing accessibility object")
        }

        try InputSimulation.stopIfUserIsOperatingTarget(pid: snapshot.app.pid)
        let result = AXUIElementPerformAction(element, rawAction as CFString)
        guard result == .success else {
            throw ComputerUseError.message("AXUIElementPerformAction failed with \(result.rawValue)")
        }

        Thread.sleep(forTimeInterval: 0.15)
        return snapshotResult(for: try refreshAfterAction(for: query, snapshot: snapshot), style: .actionResult)
    }

    public func scroll(app query: String, windowID: CGWindowID? = nil, observationID: String? = nil, direction: String, elementIndex: String?, x: Double?, y: Double?, pages: Double) throws -> ToolCallResult {
        let normalized = direction.lowercased()
        guard ["up", "down", "left", "right"].contains(normalized) else {
            throw ComputerUseError.message("Invalid scroll direction: \(direction)")
        }
        guard pages.isFinite, pages > 0 else {
            throw ComputerUseError.message("pages must be > 0")
        }

        guard x == nil && y == nil || (x != nil && y != nil) else {
            throw ComputerUseError.invalidArguments("scroll requires both x and y")
        }
        guard elementIndex != nil || x != nil else {
            throw ComputerUseError.invalidArguments("scroll requires either element_index or x/y")
        }
        guard elementIndex == nil || (x == nil && y == nil) else {
            throw ComputerUseError.invalidArguments("scroll accepts either element_index or x/y, not both")
        }
        let coordinateIntent: CoordinateObservationIntent? = elementIndex == nil ? x.flatMap { x in y.map { .click(CGPoint(x: x, y: $0)) } } : nil
        let snapshot = try currentSnapshot(for: query, windowID: windowID, observationID: observationID,
            actionIntent: elementIndex.map(ActionObservationIntent.element)
                ?? coordinateIntent.map(ActionObservationIntent.coordinate) ?? .window)
        let frontmost = FrontmostAppLease.capture()
        defer { frontmost.restoreIfStolen(by: snapshot.app.pid) }

        if snapshot.mode != .fixture {
            try InputSimulation.stopIfUserIsOperatingTarget(pid: snapshot.app.pid)
        }

        if elementIndex == nil, let x, let y {
            guard x.isFinite, y.isFinite, x >= 0, y >= 0,
                  let screenshotSize = screenshotPixelSize(snapshot: snapshot),
                  x < screenshotSize.width, y < screenshotSize.height else {
                throw ComputerUseError.stateUnavailable("scroll coordinates are outside the current app screenshot")
            }
            guard snapshot.mode != .fixture else {
                throw ComputerUseError.invalidArguments("fixture scroll requires element_index")
            }
            let point = try screenshotToGlobalPoint(snapshot: snapshot, x: x, y: y)
            // PiP coordinate scrolling must remain targeted even if a diagnostic global fallback is enabled.
            try requirePIDInputTarget(snapshot)
            try InputSimulation.scrollTargeted(at: inputEventPoint(fromScreenStatePoint: point),
                                               direction: normalized, pages: pages, pid: snapshot.app.pid)
            return snapshotResult(for: try refreshAfterAction(for: query, snapshot: snapshot), style: .actionResult)
        }

        let index = elementIndex!
        let record = try lookupElement(snapshot: snapshot, index: index)

        if snapshot.mode == .fixture {
            guard let identifier = record.identifier else {
                throw ComputerUseError.invalidArguments("fixture scroll requires an identifier-backed element")
            }
            try fixtureCommandPoster(FixtureCommand(kind: "scroll", identifier: identifier, direction: normalized, pages: pages))
            Thread.sleep(forTimeInterval: 0.15)
            return snapshotResult(for: try refreshAfterAction(for: query, snapshot: snapshot), style: .actionResult)
        }

        if let repeatCount = integralScrollPageCount(pages),
           let rawAction = record.rawActions.first(where: { $0.caseInsensitiveCompare("AXScroll\(normalized.capitalized)ByPage") == .orderedSame }),
           let element = record.element {
            for _ in 0..<repeatCount {
                _ = AXUIElementPerformAction(element, rawAction as CFString)
                Thread.sleep(forTimeInterval: 0.05)
            }
        } else if let point = try globalPoint(for: record, snapshot: snapshot) {
            try performScrollEvent(
                at: point,
                direction: normalized,
                pages: pages,
                targetDescription: "element_index=\(index)",
                snapshot: snapshot
            )
        } else {
            throw ComputerUseError.stateUnavailable("element \(index) has no scrollable frame")
        }

        return snapshotResult(for: try refreshAfterAction(for: query, snapshot: snapshot), style: .actionResult)
    }

    public func drag(app query: String, windowID: CGWindowID? = nil, observationID: String? = nil, fromX: Double, fromY: Double, toX: Double, toY: Double) throws -> ToolCallResult {
        let snapshot = try currentSnapshot(for: query, windowID: windowID, observationID: observationID,
            actionIntent: .coordinate(.drag(CGPoint(x: fromX, y: fromY), CGPoint(x: toX, y: toY))))
        let frontmost = FrontmostAppLease.capture()
        defer { frontmost.restoreIfStolen(by: snapshot.app.pid) }
        if snapshot.mode == .fixture {
            try fixtureCommandPoster(FixtureCommand(kind: "drag", identifier: "fixture-drag-pad", x: fromX, y: fromY, toX: toX, toY: toY))
            Thread.sleep(forTimeInterval: 0.15)
            return snapshotResult(for: try refreshAfterAction(for: query, snapshot: snapshot), style: .actionResult)
        }

        if let error = coordinateActionScreenshotError(
            hasScreenshot: snapshot.screenshotPNGData != nil,
            screenRecordingGranted: PermissionDiagnostics.current().screenCaptureGranted
        ) {
            throw error
        }

        let start = try screenshotToGlobalPoint(snapshot: snapshot, x: fromX, y: fromY)
        let end = try screenshotToGlobalPoint(snapshot: snapshot, x: toX, y: toY)
        let path = try performDragEvent(
            from: start,
            to: end,
            targetDescription: "from=(\(Int(fromX)), \(Int(fromY))) to=(\(Int(toX)), \(Int(toY)))",
            snapshot: snapshot
        )
        return appendingDragDeliveryNote(
            to: snapshotResult(for: try refreshAfterAction(for: query, snapshot: snapshot), style: .actionResult),
            path: path
        )
    }

    public func typeText(app query: String, windowID: CGWindowID? = nil, observationID: String? = nil, text: String,
                         paste: Bool = false) throws -> ToolCallResult {
        let snapshot = try currentSnapshot(for: query, windowID: windowID, observationID: observationID,
            actionIntent: .focusedInput)
        let frontmost = FrontmostAppLease.capture()
        defer { frontmost.restoreIfStolen(by: snapshot.app.pid) }
        if snapshot.mode == .fixture {
            try fixtureCommandPoster(FixtureCommand(kind: "type_text", identifier: "fixture-input", value: text))
            Thread.sleep(forTimeInterval: 0.15)
            return snapshotResult(for: try refreshAfterAction(for: query, snapshot: snapshot), style: .actionResult)
        }

        try InputSimulation.stopIfUserIsOperatingTarget(pid: snapshot.app.pid)
        let before = clickSurfaceFingerprint(snapshot)
        let observeTyping = { () throws -> AppSnapshot in
            let first = try self.refreshAfterAction(for: query, snapshot: snapshot)
            guard !clickSurfaceChanged(before, clickSurfaceFingerprint(first)) else { return first }
            Thread.sleep(forTimeInterval: clickSettleDelay)
            return try self.refreshAfterAction(for: query, snapshot: snapshot)
        }
        if !paste, try typeTextBySettingFocusedValueIfAvailable(text, in: snapshot) {
            Thread.sleep(forTimeInterval: 0.1)
            return snapshotResult(for: try observeTyping(), style: .actionResult)
        }

        try requirePIDInputTarget(snapshot)
        if paste {
            try InputSimulation.pasteText(text, pid: snapshot.app.pid, windowID: snapshot.targetWindowID)
        } else {
            try InputSimulation.typeText(text, pid: snapshot.app.pid, windowID: snapshot.targetWindowID)
        }
        let observed = try observeTyping()
        return snapshotResult(for: clickSurfaceChanged(before, clickSurfaceFingerprint(observed))
            ? observed : observed.withObservationNote(unchangedTypeTextObservation), style: .actionResult)
    }

    public func pressKey(app query: String, windowID: CGWindowID? = nil, observationID: String? = nil, key: String) throws -> ToolCallResult {
        let snapshot = try currentSnapshot(for: query, windowID: windowID, observationID: observationID,
            actionIntent: .focusedInput)
        let frontmost = FrontmostAppLease.capture()
        defer { frontmost.restoreIfStolen(by: snapshot.app.pid) }
        if snapshot.mode == .fixture {
            try fixtureCommandPoster(FixtureCommand(kind: "press_key", identifier: "fixture-key-capture", value: key))
            Thread.sleep(forTimeInterval: 0.15)
            return snapshotResult(for: try refreshAfterAction(for: query, snapshot: snapshot), style: .actionResult)
        }

        try requirePIDInputTarget(snapshot)
        try InputSimulation.pressKey(key, pid: snapshot.app.pid, windowID: snapshot.targetWindowID)
        return snapshotResult(for: try refreshAfterAction(for: query, snapshot: snapshot), style: .actionResult)
    }

    public func setValue(app query: String, windowID: CGWindowID? = nil, observationID: String? = nil, elementIndex: String, value: String) throws -> ToolCallResult {
        let snapshot = try currentSnapshot(for: query, windowID: windowID, observationID: observationID,
            actionIntent: .element(elementIndex))
        let record = try lookupElement(snapshot: snapshot, index: elementIndex)

        if snapshot.mode == .fixture {
            guard let identifier = record.identifier else {
                throw ComputerUseError.invalidArguments("fixture set_value requires a known element identifier")
            }

            let cursorTarget = visualCursorTarget(for: record, snapshot: snapshot)
            moveVisualCursor(to: cursorTarget)
            try fixtureCommandPoster(FixtureCommand(kind: "set_value", identifier: identifier, value: value))
            Thread.sleep(forTimeInterval: 0.15)
            settleVisualCursor(at: cursorTarget)
            return snapshotResult(for: try refreshAfterAction(for: query, snapshot: snapshot), style: .actionResult)
        }

        guard let element = record.element else {
            throw ComputerUseError.stateUnavailable("element \(elementIndex) has no backing accessibility object")
        }

        guard try isSettableForSetValue(element: element, attribute: kAXValueAttribute) else {
            throw ComputerUseError.message(nonSettableSetValueErrorMessage)
        }

        let cursorTarget = visualCursorTarget(for: record, snapshot: snapshot)
        moveVisualCursor(to: cursorTarget)

        do {
            try InputSimulation.stopIfUserIsOperatingTarget(pid: snapshot.app.pid)
            let result = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFString)
            guard result == .success else {
                throw ComputerUseError.message("AXUIElementSetAttributeValue failed with \(result.rawValue)")
            }

            Thread.sleep(forTimeInterval: 0.1)
        } catch {
            settleVisualCursor(at: cursorTarget)
            throw error
        }

        settleVisualCursor(at: cursorTarget)
        return snapshotResult(for: try refreshAfterAction(for: query, snapshot: snapshot), style: .actionResult)
    }

    private func currentSnapshot(for query: String, windowID: CGWindowID? = nil, observationID: String? = nil,
                                 actionIntent: ActionObservationIntent = .window) throws -> AppSnapshot {
        try lockScreenState().requireUnlocked()
        let last = snapshotsByApp[query.lowercased()]
        let targetID = windowID ?? last?.targetWindowID
        let app = try last?.app ?? appResolver(query)
        // The command-only development fixture has no CG window identifier.
        // Its internal zero key stays bounded; public window_id never accepts 0.
        let storeID = targetID ?? 0
        let latest = snapshotsByWindow.snapshot(pid: app.pid, windowID: storeID)
        let confirmedRetry = confirmedCoordinateRetry
        confirmedCoordinateRetry = nil
        func observationChanged(_ fresh: AppSnapshot, _ note: String) -> ObservationChanged {
            retain(fresh, query: query)
            return ObservationChanged(toolResult: snapshotResult(for: fresh.withObservationNote(note),
                style: .fullState, stateChanged: true))
        }
        if let targetID, latest?.targetWindowID != targetID {
            throw observationChanged(try refreshSnapshot(for: query, windowID: targetID, expectedApp: app, retain: false),
                "This window has no retained observation, or its observation was evicted. No action was dispatched. Use this fresh state and observation_id for your next action.")
        }
        guard let cached = observationID.map({
            snapshotsByWindow.snapshot(pid: app.pid, windowID: storeID, observationID: $0)
        }) ?? latest else {
            throw observationChanged(try refreshSnapshot(for: query, windowID: targetID, expectedApp: app, retain: false),
                "The observation used for this request is no longer retained. No action was dispatched. Use this fresh state and observation_id for your next action.")
        }
        // Validate before every mutation, even after the user has left the
        // target app or its five-second input-idle guard has expired. Preserve
        // the observed rendering limits so truncation alone cannot change IDs.
        // The model never sees this read unless the action is withheld, so it
        // must not displace observations that queued actions still refer to.
        var fresh = try refreshSnapshot(for: query, windowID: targetID, expectedApp: app,
            textLimit: cached.renderTextLimit, treeLimits: cached.renderTreeLimits, retain: false)
        let validation = validateActionObservation(observed: cached, fresh: fresh, intent: actionIntent)
        if validation == .changed {
            throw observationChanged(fresh,
                "The requested element is no longer present, or the window was resized, since the observation. No action was dispatched. Use this fresh state and observation_id for your next action.")
        }
        if case .coordinate(let coordinateIntent) = actionIntent,
           fresh.mode != .fixture || cached.screenshotPNGData != nil || fresh.screenshotPNGData != nil {
            let imageValidation = validateScreenshotRegions(observed: ScreenshotPixels.decode(cached.screenshotPNGData),
                fresh: ScreenshotPixels.decode(fresh.screenshotPNGData), intent: coordinateIntent)
            // After one withheld frame, choosing the same target again from the
            // returned state confirms it; an animated target must stay reachable.
            let confirmed = imageValidation == .changed && observationID != nil
                && confirmedRetry?.observationID == observationID
                && confirmedRetry?.intent.isNear(coordinateIntent) == true
            if imageValidation != .unchanged && !confirmed {
                let error = observationChanged(fresh,
                    "Something new now covers the coordinate target, or its screenshot is unavailable or resized. No action was dispatched. Check this fresh state; if the same target is still intended, send it again with this observation_id.")
                if imageValidation == .changed, let freshID = fresh.observationID {
                    confirmedCoordinateRetry = (freshID, coordinateIntent)
                }
                throw error
            }
        }
        if case .element(let requested) = actionIntent, let index = Int(requested),
           case .unchanged(let remapped) = validation, let remapped {
            fresh.actionElementIndexRemapping[index] = remapped
        }
        return fresh
    }

    @discardableResult
    private func refreshSnapshot(
        for query: String,
        windowID: CGWindowID? = nil,
        expectedApp: RunningAppDescriptor? = nil,
        textLimit: SnapshotTextLimit = .defaults,
        treeLimits: AccessibilityTreeLimits = .defaults,
        recoveryPolicy: SnapshotRecoveryPolicy = .readOnly,
        requireScreenshot: Bool = false,
        retain shouldRetain: Bool = true
    ) throws -> AppSnapshot {
        try lockScreenState().requireUnlocked()
        let app = try expectedApp ?? appResolver(query)
        if let windowID, !appIsRunning(app) {
            throw TargetWindowUnavailable(windowID: windowID, pid: app.pid, availableWindows: [])
        }
        var snapshot = try snapshotLoader(app, windowID, textLimit, treeLimits, recoveryPolicy, requireScreenshot)
        snapshot.observationID = UUID().uuidString
        snapshot.renderTextLimit = textLimit
        snapshot.renderTreeLimits = treeLimits
        if shouldRetain { retain(snapshot, query: query) }
        return snapshot
    }

    private func retain(_ snapshot: AppSnapshot, query: String) {
        let app = snapshot.app
        let keys = Set([query.lowercased(), app.name.lowercased(), (app.bundleIdentifier ?? "").lowercased()]
            .filter { !$0.isEmpty })
        for key in keys { snapshotsByApp[key] = (snapshot.app, snapshot.targetWindowID) }
        if let id = snapshot.targetWindowID {
            snapshotsByWindow.store(snapshot, pid: app.pid, windowID: id, observationID: snapshot.observationID)
        } else if snapshot.mode == .fixture {
            snapshotsByWindow.store(snapshot, pid: app.pid, windowID: 0, observationID: snapshot.observationID)
        }
    }

    // These event channels target a PID, not an individual window. Reading a
    // pinned tree does not make those channels safe after another window is key.
    private func requirePIDInputTarget(_ snapshot: AppSnapshot) throws {
        guard snapshot.mode != .fixture else { return }
        let focusedID = SnapshotBuilder.focusedWindowID(for: snapshot.app)
        guard pidInputMatchesBoundWindow(boundWindowID: snapshot.targetWindowID, focusedWindowID: focusedID) else {
            throw ComputerUseError.stateUnavailable("The app's key window differs from the observed target. No PID-only input was sent. Observe the desired window with get_app_state(window_id), or use an accessibility/window-targeted action.")
        }
    }

    private func lookupElement(snapshot: AppSnapshot, index: String) throws -> ElementRecord {
        guard let parsedIndex = Int(index),
              let record = snapshot.elements[snapshot.actionElementIndexRemapping[parsedIndex] ?? parsedIndex] else {
            throw ComputerUseError.invalidArguments("unknown element_index '\(index)'")
        }

        try requireAXInputTarget(record, in: snapshot)
        return record
    }

    private func requireAXInputTarget(_ record: ElementRecord, in snapshot: AppSnapshot) throws {
        guard let element = record.element, let root = snapshot.targetWindowElement else { return }
        // The app menu bar remains useful in the tree, but its commands act on
        // the app's key window rather than the pinned document's AX root.
        if !AXWindowIdentity.contains(element, in: root) { try requirePIDInputTarget(snapshot) }
    }

    func matchingAction(requested: String, record: ElementRecord) -> String? {
        if let exact = record.rawActions.first(where: { $0.caseInsensitiveCompare(requested) == .orderedSame }) {
            return exact
        }
        let visibleActions = record.role.map { meaningfulRawActions(record.rawActions, role: $0) } ?? record.rawActions
        let matches = visibleActions.filter { rawAction in
            secondaryActionNamesEquivalent(requested, secondaryActionDisplayName(rawAction))
        }
        return matches.count == 1 ? matches[0] : nil
    }

    private func invalidSecondaryActionMessage(action: String, record: ElementRecord) -> String {
        invalidSecondaryActionErrorMessage(action: action, elementIndex: record.index)
    }

    private func performPreferredClick(on record: ElementRecord, button: MouseButtonKind, clickCount: Int) throws -> Bool {
        guard let element = record.element else {
            return false
        }

        switch button {
        case .left:
            if try performAction(named: kAXPressAction as String, on: element, availableActions: record.rawActions, repeatCount: clickCount) {
                return true
            }

            if try performAction(named: kAXConfirmAction as String, on: element, availableActions: record.rawActions, repeatCount: clickCount) {
                return true
            }

            if try performAction(named: "AXOpen", on: element, availableActions: record.rawActions, repeatCount: clickCount) {
                return true
            }

            if clickCount <= 1,
               !hasAncestorRole("AXWebArea", of: element),
               try selectContainingListItem(for: element)
            {
                return true
            }
        case .right:
            if try performAction(named: kAXShowMenuAction as String, on: element, availableActions: record.rawActions, repeatCount: clickCount) {
                return true
            }
        case .middle:
            break
        }

        return false
    }

    private func clickCandidates(at point: CGPoint, in snapshot: AppSnapshot) throws -> [ElementRecord] {
        var candidates: [ElementRecord] = []

        if let bestRecord = bestElement(containing: point, in: snapshot, coordinateClick: true) {
            candidates.append(bestRecord)
        }

        if let hitRecord = try hitTestElement(at: point, in: snapshot),
           clickCandidateMatchesRequestedPoint(role: hitRecord.role, frame: hitRecord.localFrame,
                                              requestedWindowPoint: point) {
            candidates.append(hitRecord)
        }

        return candidates.reduce(into: []) { uniqueCandidates, candidate in
            if !uniqueCandidates.contains(where: { sameElement($0.element, candidate.element) }) {
                uniqueCandidates.append(candidate)
            }
        }
    }

    private func sameElement(_ lhs: AXUIElement?, _ rhs: AXUIElement?) -> Bool {
        guard let lhs, let rhs else {
            return false
        }

        return CFEqual(lhs, rhs)
    }

    private func selectContainingListItem(for element: AXUIElement) throws -> Bool {
        guard let target = selectableListItem(containing: element) else {
            return false
        }

        let result = AXUIElementSetAttributeValue(
            target.list,
            kAXSelectedChildrenAttribute as CFString,
            [target.item] as CFArray
        )

        switch result {
        case .success:
            Thread.sleep(forTimeInterval: 0.15)
            return true
        case .cannotComplete:
            throw AccessibilityActionUncertain(action: kAXSelectedChildrenAttribute as String, result: result)
        case .failure, .attributeUnsupported, .actionUnsupported, .noValue, .invalidUIElement, .illegalArgument:
            return false
        default:
            throw ComputerUseError.message("AXUIElementSetAttributeValue(\(kAXSelectedChildrenAttribute)) failed with \(result.rawValue)")
        }
    }

    private func selectableListItem(containing element: AXUIElement) -> (list: AXUIElement, item: AXUIElement)? {
        var current = element
        var directChild = element

        for _ in 0..<8 {
            guard let parent = copyParent(of: current) else {
                return nil
            }

            if stringValue(of: parent, attribute: kAXRoleAttribute) == kAXListRole as String,
               isSettable(element: parent, attribute: kAXSelectedChildrenAttribute)
            {
                return (parent, directChild)
            }

            directChild = parent
            current = parent
        }

        return nil
    }

    private func performAXClickSequence(
        on record: ElementRecord,
        snapshot: AppSnapshot,
        button: MouseButtonKind,
        clickCount: Int,
        includeNearbyHitTesting: Bool,
        allowActivationFallback: Bool,
        requestedWindowPoint: CGPoint? = nil
    ) throws -> Bool {
        guard clickCandidateMatchesRequestedPoint(role: record.role, frame: record.localFrame,
                                                 requestedWindowPoint: requestedWindowPoint) else { return false }
        try requireAXInputTarget(record, in: snapshot)
        let preferContainingWebRowAXClick = shouldPreferContainingWebRowAXClick(record, in: snapshot)
        debugClickDecision("record=\(clickDebugDescription(record)) preferContainingWebRowAXClick=\(preferContainingWebRowAXClick)")

        if preferContainingWebRowAXClick,
           try performContainingWebRowClick(for: record, snapshot: snapshot, button: button, clickCount: clickCount,
                                          requestedWindowPoint: requestedWindowPoint)
        {
            Thread.sleep(forTimeInterval: 0.15)
            return true
        }

        if !preferContainingWebRowAXClick {
            if try performPreferredClick(on: record, button: button, clickCount: clickCount) {
                debugClickDecision("handled by preferred target \(clickDebugDescription(record))")
                Thread.sleep(forTimeInterval: 0.15)
                return true
            }

            if try performFirstPointMatchedClick(
                descendantClickCandidates(for: record, snapshot: snapshot,
                                          requestedWindowPoint: requestedWindowPoint),
                requestedWindowPoint: requestedWindowPoint,
                geometry: { ($0.role, $0.localFrame) }, click: { candidate in
                let handled = try performPreferredClick(on: candidate, button: button, clickCount: clickCount)
                if handled {
                    debugClickDecision("handled by descendant \(clickDebugDescription(candidate))")
                }
                return handled
            }) {
                Thread.sleep(forTimeInterval: 0.15)
                return true
            }

            if includeNearbyHitTesting {
                for localPoint in clickActionPoints(for: record, snapshot: snapshot) {
                    guard let hitRecord = try hitTestElement(at: localPoint, in: snapshot) ?? bestElement(containing: localPoint, in: snapshot) else {
                        continue
                    }
                    if let element = record.element, let hit = hitRecord.element, !hitElement(hit, standsFor: element) {
                        debugClickDecision("skipped covering hit record \(clickDebugDescription(hitRecord))")
                        continue
                    }

                    if !isLikelySyntheticSideAction(hitRecord, in: record),
                       try performPreferredClick(on: hitRecord, button: button, clickCount: clickCount)
                    {
                        debugClickDecision("handled by hit record \(clickDebugDescription(hitRecord))")
                        Thread.sleep(forTimeInterval: 0.15)
                        return true
                    }

                    if shouldScanDescendantsOfHitRecord(
                        originalFrame: clickFrame(for: record, snapshot: snapshot),
                        hitFrame: hitRecord.localFrame
                    ) {
                        for candidate in descendantClickCandidates(
                            for: hitRecord,
                            snapshot: snapshot,
                            sideActionScope: record,
                            requestedWindowPoint: requestedWindowPoint
                        ) {
                            if try performPreferredClick(on: candidate, button: button, clickCount: clickCount) {
                                debugClickDecision("handled by hit descendant \(clickDebugDescription(candidate))")
                                Thread.sleep(forTimeInterval: 0.15)
                                return true
                            }
                        }
                    }
                }
            }
        }

        guard
            allowActivationFallback,
            !record.isSyntheticText,
            button == .left,
            let element = record.element,
            canUseActivationOnlyClickFallback(role: stringValue(of: element, attribute: kAXRoleAttribute))
        else {
            return false
        }

        if try activateClickTarget(element: element, availableActions: record.rawActions) {
            debugClickDecision("handled by activation fallback \(clickDebugDescription(record))")
            Thread.sleep(forTimeInterval: 0.15)
            return true
        }

        return false
    }

    private func performAction(named action: String, on element: AXUIElement, availableActions: [String], repeatCount: Int = 1) throws -> Bool {
        guard availableActions.contains(where: { $0.caseInsensitiveCompare(action) == .orderedSame }) else {
            return false
        }

        return try performAccessibilityActionSequence(action: action, repeatCount: repeatCount,
            perform: { AXUIElementPerformAction(element, action as CFString) })
    }

    private func activateClickTarget(element: AXUIElement, availableActions: [String]) throws -> Bool {
        var activated = false

        if try performAction(named: kAXRaiseAction as String, on: element, availableActions: availableActions) {
            activated = true
        }

        if try setBoolAttribute(named: kAXMainAttribute, on: element) {
            activated = true
        }

        if try setBoolAttribute(named: kAXFocusedAttribute, on: element) {
            activated = true
        }

        return activated
    }

    private func setBoolAttribute(named attribute: String, on element: AXUIElement) throws -> Bool {
        let result = AXUIElementSetAttributeValue(element, attribute as CFString, kCFBooleanTrue)
        switch result {
        case .success:
            return true
        case .failure, .attributeUnsupported, .actionUnsupported, .cannotComplete, .noValue, .invalidUIElement, .illegalArgument:
            return false
        default:
            throw ComputerUseError.message("AXUIElementSetAttributeValue(\(attribute)) failed with \(result.rawValue)")
        }
    }

    private func isSettable(element: AXUIElement, attribute: String) -> Bool {
        var settable: DarwinBoolean = false
        let result = AXUIElementIsAttributeSettable(element, attribute as CFString, &settable)
        return result == .success && settable.boolValue
    }

    private func isSettableForSetValue(element: AXUIElement, attribute: String) throws -> Bool {
        var settable = DarwinBoolean(false)
        let result = AXUIElementIsAttributeSettable(element, attribute as CFString, &settable)
        return try setValueAttributeIsSettable(
            result: result,
            settable: settable.boolValue,
            attribute: attribute
        )
    }

    private func bestElement(containing point: CGPoint, in snapshot: AppSnapshot,
                             coordinateClick: Bool = false) -> ElementRecord? {
        snapshot.elements.values
            .filter { $0.localFrame?.contains(point) ?? false }
            .filter { !coordinateClick || clickCandidateMatchesRequestedPoint(role: $0.role, frame: $0.localFrame,
                                                                             requestedWindowPoint: point) }
            .sorted { lhs, rhs in
                // Prefer the precise node under a coordinate over a broad
                // actionable ancestor whose descendants may be unrelated.
                if coordinateClick, frameArea(of: lhs) != frameArea(of: rhs) {
                    return frameArea(of: lhs) < frameArea(of: rhs)
                }
                let lhsPriority = clickPriority(for: lhs)
                let rhsPriority = clickPriority(for: rhs)
                if lhsPriority != rhsPriority {
                    return lhsPriority < rhsPriority
                }

                return frameArea(of: lhs) < frameArea(of: rhs)
            }
            .first
    }

    /// A pointer click at a covered element reaches whatever covers it.
    private func requireUncoveredPointerTarget(_ record: ElementRecord, elementIndex: String,
                                               at windowPoint: CGPoint, in snapshot: AppSnapshot) throws {
        guard snapshot.mode != .fixture, let element = record.element,
              let hit = try hitTestElement(at: windowPoint, in: snapshot), let hitAX = hit.element,
              !hitElement(hitAX, standsFor: element) else { return }
        let label = [kAXTitleAttribute, kAXDescriptionAttribute]
            .compactMap { stringValue(of: hitAX, attribute: $0) }
            .first { !$0.isEmpty }
        let name = [hit.role, label].compactMap { $0 }.joined(separator: " ")
        throw ComputerUseError.stateUnavailable(
            "element_index=\(elementIndex) is covered at its click point by another element (\(name)). No input was sent. Scroll it into view, or click a visible part of it with x and y in screenshot pixels."
        )
    }

    private func hitTestElement(at point: CGPoint, in snapshot: AppSnapshot) throws -> ElementRecord? {
        let appElement = AXUIElementCreateApplication(snapshot.app.pid)
        // Both callers already supply window points. Scaling screenshot pixels
        // here again moves Retina hit testing to a different control.
        let globalPoint = try windowPointToGlobalPoint(snapshot: snapshot, point: point)
        var hitElement: AXUIElement?
        let result = AXUIElementCopyElementAtPosition(appElement, Float(globalPoint.x), Float(globalPoint.y), &hitElement)
        guard result == .success, let hitElement,
              let root = snapshot.targetWindowElement, AXWindowIdentity.contains(hitElement, in: root) else {
            return nil
        }

        let rawActions = copyActions(for: hitElement) ?? []
        return ElementRecord(
            index: -1,
            identifier: nil,
            element: hitElement,
            localFrame: localFrame(of: hitElement, windowBounds: snapshot.windowBounds),
            role: stringValue(of: hitElement, attribute: kAXRoleAttribute),
            rawActions: rawActions,
            prettyActions: rawActions
        )
    }

    private func clickPriority(for record: ElementRecord) -> Int {
        if record.rawActions.contains(where: {
            $0.caseInsensitiveCompare(kAXPressAction as String) == .orderedSame ||
            $0.caseInsensitiveCompare(kAXConfirmAction as String) == .orderedSame ||
            $0.caseInsensitiveCompare(kAXShowMenuAction as String) == .orderedSame ||
            $0.caseInsensitiveCompare(kAXRaiseAction as String) == .orderedSame
        }) {
            return 0
        }

        if let element = record.element,
           isSettable(element: element, attribute: kAXMainAttribute) ||
           isSettable(element: element, attribute: kAXFocusedAttribute) {
            return 1
        }

        return 2
    }

    private func frameArea(of record: ElementRecord) -> CGFloat {
        guard let frame = record.localFrame else {
            return .greatestFiniteMagnitude
        }

        return frame.width * frame.height
    }

    private func localCenter(for record: ElementRecord) -> CGPoint? {
        guard let frame = record.localFrame else {
            return nil
        }

        return CGPoint(x: frame.midX, y: frame.midY)
    }

    private func clickActionPoints(for record: ElementRecord, snapshot: AppSnapshot) -> [CGPoint] {
        guard let frame = clickFrame(for: record, snapshot: snapshot) else {
            return []
        }

        return localClickActionPoints(frame: frame, isSyntheticText: record.isSyntheticText)
    }

    private func descendantClickCandidates(
        for record: ElementRecord,
        snapshot: AppSnapshot,
        sideActionScope: ElementRecord? = nil,
        requestedWindowPoint: CGPoint? = nil
    ) -> [ElementRecord] {
        guard let element = record.element else {
            return []
        }

        let sideActionParent = sideActionScope ?? record
        return descendantClickCandidates(of: element, windowBounds: snapshot.windowBounds)
            .filter { candidate in
                clickCandidateMatchesRequestedPoint(role: candidate.role, frame: candidate.localFrame,
                                                   requestedWindowPoint: requestedWindowPoint)
                    && !isLikelySyntheticSideAction(candidate, in: sideActionParent)
            }
            .sorted { lhs, rhs in
                let lhsPriority = clickPriority(for: lhs)
                let rhsPriority = clickPriority(for: rhs)
                if lhsPriority != rhsPriority {
                    return lhsPriority < rhsPriority
                }

                return frameArea(of: lhs) < frameArea(of: rhs)
            }
    }

    private func descendantClickCandidates(of element: AXUIElement, windowBounds: CGRect?, depth: Int = 0) -> [ElementRecord] {
        guard depth < 3 else {
            return []
        }

        var results: [ElementRecord] = []
        for child in copyChildren(of: element) {
            let rawActions = copyActions(for: child) ?? []
            results.append(
                ElementRecord(
                    index: -1,
                    identifier: nil,
                    element: child,
                    localFrame: localFrame(of: child, windowBounds: windowBounds),
                    role: stringValue(of: child, attribute: kAXRoleAttribute),
                    rawActions: rawActions,
                    prettyActions: rawActions
                )
            )
            results.append(contentsOf: descendantClickCandidates(of: child, windowBounds: windowBounds, depth: depth + 1))
        }

        return results
    }

    private func isLikelySyntheticSideAction(_ candidate: ElementRecord, in parent: ElementRecord) -> Bool {
        isLikelySyntheticSideActionCandidate(
            parentFrame: parent.localFrame,
            candidateFrame: candidate.localFrame,
            hasPrimaryAction: hasPrimaryClickAction(candidate),
            labels: accessibilityLabels(for: candidate.element)
        )
    }

    private func hasPrimaryClickAction(_ record: ElementRecord) -> Bool {
        record.rawActions.contains { action in
            action.caseInsensitiveCompare(kAXPressAction as String) == .orderedSame ||
                action.caseInsensitiveCompare(kAXConfirmAction as String) == .orderedSame ||
                action.caseInsensitiveCompare("AXOpen") == .orderedSame ||
                action.caseInsensitiveCompare(kAXShowMenuAction as String) == .orderedSame
        }
    }

    private func shouldPreferContainingWebRowAXClick(_ record: ElementRecord, in snapshot: AppSnapshot) -> Bool {
        guard
            let element = record.element
        else {
            return false
        }

        return shouldPreferContainingWebRowAXClickCandidate(
            role: stringValue(of: element, attribute: kAXRoleAttribute),
            isSyntheticText: record.isSyntheticText,
            hasWebAreaAncestor: hasAncestorRole("AXWebArea", of: element),
            appName: snapshot.app.name,
            bundleIdentifier: snapshot.app.bundleIdentifier
        )
    }

    private func performContainingWebRowClick(
        for record: ElementRecord,
        snapshot: AppSnapshot,
        button: MouseButtonKind,
        clickCount: Int,
        requestedWindowPoint: CGPoint? = nil
    ) throws -> Bool {
        guard
            button == .left,
            clickCount <= 1,
            let element = record.element,
            let targetFrame = record.localFrame
        else {
            return false
        }

        var current = element

        for _ in 0..<6 {
            guard let parent = copyParent(of: current) else {
                return false
            }

            let rawActions = copyActions(for: parent) ?? []
            let candidate = ElementRecord(
                index: -1,
                identifier: nil,
                element: parent,
                localFrame: localFrame(of: parent, windowBounds: snapshot.windowBounds),
                role: stringValue(of: parent, attribute: kAXRoleAttribute),
                rawActions: rawActions,
                prettyActions: rawActions
            )

            if isLikelyContainingWebRowAction(targetFrame: targetFrame, candidate: candidate),
               clickCandidateMatchesRequestedPoint(role: candidate.role, frame: candidate.localFrame,
                                                  requestedWindowPoint: requestedWindowPoint),
               !isLikelySyntheticSideAction(candidate, in: record),
               try performAction(named: kAXPressAction as String, on: parent, availableActions: rawActions)
            {
                debugClickDecision("handled by containing web row \(clickDebugDescription(candidate))")
                return true
            }

            current = parent
        }

        return false
    }

    private func isLikelyContainingWebRowAction(
        targetFrame: CGRect,
        candidate: ElementRecord
    ) -> Bool {
        isLikelyContainingRowActionFrame(
            targetFrame: targetFrame,
            candidateFrame: candidate.localFrame,
            hasPrimaryAction: hasPrimaryClickAction(candidate)
        )
    }

    private func hasAncestorRole(_ role: String, of element: AXUIElement) -> Bool {
        var current = element

        for _ in 0..<12 {
            guard let parent = copyParent(of: current) else {
                return false
            }

            if stringValue(of: parent, attribute: kAXRoleAttribute) == role {
                return true
            }

            current = parent
        }

        return false
    }

    private func accessibilityLabels(for element: AXUIElement?) -> [String] {
        guard let element else {
            return []
        }

        return [
            kAXTitleAttribute as String,
            kAXDescriptionAttribute as String,
            kAXHelpAttribute as String,
            kAXValueAttribute as String,
            "AXIdentifier"
        ].compactMap { attribute in
            stringValue(of: element, attribute: attribute)
        }
    }

    private func typeTextBySettingFocusedValueIfAvailable(_ text: String, in snapshot: AppSnapshot) throws -> Bool {
        guard let element = snapshot.focusedElement else {
            return false
        }

        guard try isSettableForSetValue(element: element, attribute: kAXValueAttribute) else {
            return false
        }

        let baseValue = editableBaseValue(for: element)
        let result = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, (baseValue + text) as CFString)
        switch result {
        case .success:
            return true
        case .failure, .attributeUnsupported, .actionUnsupported, .cannotComplete, .noValue, .invalidUIElement, .illegalArgument:
            return false
        default:
            throw ComputerUseError.message("AXUIElementSetAttributeValue failed with \(result.rawValue)")
        }
    }

    private func editableBaseValue(for element: AXUIElement) -> String {
        let childTextValues = editableDescendantTextValues(in: element)
            .filter { !looksLikeEditablePlaceholder($0) }
        if !childTextValues.isEmpty {
            return childTextValues.joined()
        }

        guard let currentValue = stringValue(of: element, attribute: kAXValueAttribute) else {
            return ""
        }

        let normalizedValue = normalizeEditablePlaceholderText(currentValue)
        if normalizedValue.isEmpty || looksLikeEditablePlaceholder(normalizedValue) {
            return ""
        }

        for attribute in ["AXPlaceholderValue", "AXPlaceholder"] {
            guard let placeholder = stringValue(of: element, attribute: attribute) else {
                continue
            }

            if normalizedValue == normalizeEditablePlaceholderText(placeholder) {
                return ""
            }
        }

        return currentValue
    }

    private func editableDescendantTextValues(in element: AXUIElement, depth: Int = 0) -> [String] {
        guard depth < 4 else {
            return []
        }

        var values: [String] = []
        for child in copyChildren(of: element) {
            if stringValue(of: child, attribute: kAXRoleAttribute) == kAXStaticTextRole as String,
               let value = stringValue(of: child, attribute: kAXValueAttribute)
                    ?? stringValue(of: child, attribute: kAXTitleAttribute)
            {
                let normalized = normalizeEditablePlaceholderText(value)
                if !normalized.isEmpty {
                    values.append(normalized)
                }
            }

            values.append(contentsOf: editableDescendantTextValues(in: child, depth: depth + 1))
        }

        return values
    }

    private func looksLikeEditablePlaceholder(_ value: String) -> Bool {
        let normalized = normalizeEditablePlaceholderText(value)
        return normalized == "沟通时请保持“公开可接受”"
    }

    private func normalizeEditablePlaceholderText(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\u{200B}", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func clickFrame(for record: ElementRecord, snapshot: AppSnapshot) -> CGRect? {
        guard let frame = record.localFrame else {
            return nil
        }

        guard
            !record.isSyntheticText,
            let element = record.element,
            stringValue(of: element, attribute: kAXRoleAttribute) == kAXStaticTextRole as String,
            let rowFrame = containingRowFrame(for: element, textFrame: frame, windowBounds: snapshot.windowBounds)
        else {
            return frame
        }

        return rowFrame
    }

    private func containingRowFrame(for element: AXUIElement, textFrame: CGRect, windowBounds: CGRect?) -> CGRect? {
        let textCenter = CGPoint(x: textFrame.midX, y: textFrame.midY)
        var current = element

        for _ in 0..<4 {
            guard let parent = copyParent(of: current) else {
                return nil
            }

            if let frame = localFrame(of: parent, windowBounds: windowBounds),
               frame.insetBy(dx: -2, dy: -2).contains(textCenter),
               frame.width >= textFrame.width + 40,
               frame.height >= textFrame.height,
               frame.height <= max(textFrame.height * 4, 96)
            {
                return frame
            }

            current = parent
        }

        return nil
    }

    private func copyActions(for element: AXUIElement) -> [String]? {
        var actions: CFArray?
        let result = AXUIElementCopyActionNames(element, &actions)
        guard result == .success else {
            return nil
        }

        return actions as? [String]
    }

    private func copyChildren(of element: AXUIElement) -> [AXUIElement] {
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value)
        guard result == .success, let value else {
            return []
        }

        return value as? [AXUIElement] ?? []
    }

    private func copyParent(of element: AXUIElement) -> AXUIElement? {
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, kAXParentAttribute as CFString, &value)
        guard result == .success, let value else {
            return nil
        }

        return (value as! AXUIElement)
    }

    private func stringValue(of element: AXUIElement, attribute: String) -> String? {
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
        guard result == .success, let value else {
            return nil
        }

        return value as? String
    }

    private func localFrame(of element: AXUIElement, windowBounds: CGRect?) -> CGRect? {
        var positionValue: CFTypeRef?
        var sizeValue: CFTypeRef?
        let positionResult = AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionValue)
        let sizeResult = AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue)

        guard
            positionResult == .success,
            sizeResult == .success,
            let positionValue,
            let sizeValue
        else {
            return nil
        }

        let positionAXValue = positionValue as! AXValue
        let sizeAXValue = sizeValue as! AXValue
        var position = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(positionAXValue, .cgPoint, &position), AXValueGetValue(sizeAXValue, .cgSize, &size) else {
            return nil
        }

        let frame = CGRect(origin: position, size: size)
        guard let windowBounds else {
            return frame
        }

        return windowRelativeFrame(elementFrame: frame, windowBounds: windowBounds)
    }

    private func globalPoint(for record: ElementRecord, snapshot: AppSnapshot) throws -> CGPoint? {
        guard let frame = record.localFrame else {
            return nil
        }

        return try windowPointToGlobalPoint(
            snapshot: snapshot,
            point: CGPoint(x: frame.midX, y: frame.midY)
        )
    }

    private func clickPoint(for record: ElementRecord, snapshot: AppSnapshot) -> CGPoint? {
        clickActionPoints(for: record, snapshot: snapshot).first ?? localCenter(for: record)
    }

    private func screenshotToGlobalPoint(snapshot: AppSnapshot, x: Double, y: Double) throws -> CGPoint {
        try windowPointToGlobalPoint(
            snapshot: snapshot,
            point: screenshotPixelToWindowPointInSnapshot(
                snapshot: snapshot,
                point: CGPoint(x: x, y: y)
            )
        )
    }

    private func screenshotPixelToWindowPointInSnapshot(snapshot: AppSnapshot, point: CGPoint) -> CGPoint {
        screenshotPixelToWindowPoint(
            point,
            screenshotPixelSize: screenshotPixelSize(snapshot: snapshot),
            windowBounds: snapshot.windowBounds
        )
    }

    private func screenshotPixelSize(snapshot: AppSnapshot) -> CGSize? {
        snapshot.screenshotPNGData.flatMap(pngPixelSize)
    }

    private func windowPointToGlobalPoint(snapshot: AppSnapshot, point: CGPoint) throws -> CGPoint {
        guard let windowBounds = snapshot.windowBounds else {
            let appReference = snapshot.app.bundleIdentifier ?? snapshot.app.name
            throw ComputerUseError.stateUnavailable("No window bounds are available for \(appReference). Run get_app_state after bringing the app on screen.")
        }

        return globalPointForWindowPoint(point, windowBounds: windowBounds)
    }

    private func fixtureIdentifier(at point: CGPoint, snapshot: AppSnapshot) throws -> String {
        let candidates = snapshot.elements.values
            .filter { $0.identifier != nil && ($0.localFrame?.contains(point) ?? false) }
            .sorted { lhs, rhs in
                let lhsArea = (lhs.localFrame?.width ?? 0) * (lhs.localFrame?.height ?? 0)
                let rhsArea = (rhs.localFrame?.width ?? 0) * (rhs.localFrame?.height ?? 0)
                return lhsArea < rhsArea
            }

        guard let identifier = candidates.first?.identifier else {
            throw ComputerUseError.invalidArguments("No fixture element contains coordinate (\(Int(point.x)), \(Int(point.y)))")
        }

        return identifier
    }

    private func visualCursorTarget(for record: ElementRecord, snapshot: AppSnapshot) -> VisualCursorTarget? {
        makeVisualCursorTarget(
            localFrame: record.localFrame,
            windowBounds: snapshot.windowBounds,
            targetWindowID: snapshot.targetWindowID,
            targetWindowLayer: snapshot.targetWindowLayer
        )
    }

    private func fixtureVisualCursorTarget(identifier: String, snapshot: AppSnapshot) -> VisualCursorTarget? {
        let record = snapshot.elements.values.first { $0.identifier == identifier }
        return record.flatMap { visualCursorTarget(for: $0, snapshot: snapshot) }
    }

    private func moveVisualCursor(to target: VisualCursorTarget?) {
        guard let target else {
            return
        }

        VisualCursorSupport.performOnMain {
            SoftwareCursorOverlay.moveCursor(to: target.point, in: target.window)
        }
    }

    private func settleVisualCursor(at target: VisualCursorTarget?) {
        guard let target else {
            return
        }

        VisualCursorSupport.performOnMain {
            SoftwareCursorOverlay.settle(at: target.point, in: target.window)
        }
    }

    private func pulseVisualCursor(at target: VisualCursorTarget?, clickCount: Int, mouseButton: MouseButtonKind) {
        guard let target else {
            return
        }

        VisualCursorSupport.performOnMain {
            SoftwareCursorOverlay.pulseClick(
                at: target.point,
                clickCount: clickCount,
                mouseButton: mouseButton,
                in: target.window
            )
        }
    }

    private func debugInputFallback(tool: String, targetDescription: String, snapshot: AppSnapshot) {
        guard inputFallbackDebugEnabled(environment: ProcessInfo.processInfo.environment) else {
            return
        }

        let appReference = snapshot.app.bundleIdentifier ?? snapshot.app.name
        fputs(
            "[memmy-computer-use] global pointer fallback tool=\(tool) app=\(appReference) target=\(targetDescription)\n",
            stderr
        )
    }

    private func debugClickDecision(_ message: String) {
        guard inputFallbackDebugEnabled(environment: ProcessInfo.processInfo.environment) else {
            return
        }

        fputs("[memmy-computer-use] click decision \(message)\n", stderr)
    }

    private func clickDebugDescription(_ record: ElementRecord) -> String {
        let role = record.element.flatMap { stringValue(of: $0, attribute: kAXRoleAttribute) } ?? "nil"
        let actions = record.rawActions.joined(separator: ",")
        let frame = record.localFrame.map { "x=\(Int($0.minX)) y=\(Int($0.minY)) w=\(Int($0.width)) h=\(Int($0.height))" } ?? "nil"
        return "index=\(record.index) role=\(role) synthetic=\(record.isSyntheticText) actions=[\(actions)] frame=\(frame)"
    }

    private func integralScrollPageCount(_ pages: Double) -> Int? {
        let rounded = pages.rounded(.toNearestOrAwayFromZero)
        guard abs(pages - rounded) < 0.000001 else {
            return nil
        }
        return max(Int(rounded), 1)
    }

    private func performScrollEvent(
        at point: CGPoint,
        direction: String,
        pages: Double,
        targetDescription: String,
        snapshot: AppSnapshot
    ) throws {
        if snapshot.mode != .fixture {
            try requireOnScreenTargetWindow(windowID: snapshot.targetWindowID, pid: snapshot.app.pid)
        }
        let eventPoint = inputEventPoint(fromScreenStatePoint: point)

        if globalPointerFallbacksEnabled(environment: ProcessInfo.processInfo.environment) {
            debugInputFallback(
                tool: "scroll",
                targetDescription: targetDescription,
                snapshot: snapshot
            )
            InputSimulation.prepareAppForGlobalPointerInput(snapshot.app)
            try InputSimulation.scrollGlobally(at: eventPoint, direction: direction, pages: pages)
            return
        }

        try requirePIDInputTarget(snapshot)
        try InputSimulation.scrollTargeted(at: eventPoint, direction: direction, pages: pages, pid: snapshot.app.pid)
    }

    private func performDragEvent(
        from start: CGPoint,
        to end: CGPoint,
        targetDescription: String,
        snapshot: AppSnapshot
    ) throws -> DragDeliveryPath {
        if snapshot.mode != .fixture {
            try requireOnScreenTargetWindow(windowID: snapshot.targetWindowID, pid: snapshot.app.pid)
        }
        let eventStart = inputEventPoint(fromScreenStatePoint: start)
        let eventEnd = inputEventPoint(fromScreenStatePoint: end)
        let path = dragDeliveryPath(environment: ProcessInfo.processInfo.environment)

        switch path {
        case .global:
            debugInputFallback(
                tool: "drag",
                targetDescription: targetDescription,
                snapshot: snapshot
            )
            InputSimulation.prepareAppForGlobalPointerInput(snapshot.app)
            try InputSimulation.dragGlobally(from: eventStart, to: eventEnd)
        case .appPost:
            try requirePIDInputTarget(snapshot)
            try InputSimulation.dragTargeted(from: eventStart, to: eventEnd, pid: snapshot.app.pid)
        }

        return path
    }

    private func performNonAXClickFallback(
        at point: CGPoint,
        button: MouseButtonKind,
        clickCount: Int,
        targetDescription: String,
        snapshot: AppSnapshot
    ) throws {
        if snapshot.mode != .fixture {
            try requireOnScreenTargetWindow(windowID: snapshot.targetWindowID, pid: snapshot.app.pid)
        }
        let eventPoint = inputEventPoint(fromScreenStatePoint: point)

        if button == .left, (1...2).contains(clickCount),
           let windowBounds = snapshot.windowBounds, let windowID = snapshot.targetWindowID {
            let windowPoint = CGPoint(x: eventPoint.x - windowBounds.minX, y: eventPoint.y - windowBounds.minY)
            do {
                try InputSimulation.clickWithSkyLight(
                    at: eventPoint,
                    windowPoint: windowPoint,
                    windowBounds: windowBounds,
                    windowID: windowID,
                    clickCount: clickCount,
                    pid: snapshot.app.pid,
                    includePrimer: ChromiumHostCache.shipsRenderer(snapshot.app)
                )
                return
            } catch let error as InputSimulation.UserInputYield {
                throw error
            } catch let error as SkyClickDispatchFailure {
                // A mouse-down was already sent. Switching channels here can
                // click the newly opened page or close its tab a second time.
                throw error
            } catch {
                debugClickDecision("sky_click fallback failed target=\(targetDescription)")
            }
        }

        if globalPointerFallbacksEnabled(environment: ProcessInfo.processInfo.environment) {
            debugInputFallback(
                tool: "click",
                targetDescription: targetDescription,
                snapshot: snapshot
            )
            InputSimulation.prepareAppForGlobalPointerInput(snapshot.app)
            try InputSimulation.clickGlobally(at: eventPoint, button: button, clickCount: clickCount)
            return
        }

        try requirePIDInputTarget(snapshot)
        do {
            try InputSimulation.clickTargeted(
                at: eventPoint,
                button: button,
                clickCount: clickCount,
                pid: snapshot.app.pid
            )
        } catch let error as InputSimulation.UserInputYield {
            throw error
        } catch {
            guard globalPointerFallbacksEnabled(environment: ProcessInfo.processInfo.environment) else {
                throw ComputerUseError.message(
                    "click could not be handled through accessibility, and global pointer fallback is disabled. Set OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS=1 to allow physical-pointer fallback for this process."
                )
            }
        }
    }

    private func performForegroundClick(
        method: ClickMethod,
        at point: CGPoint,
        windowPoint: CGPoint,
        button: MouseButtonKind,
        clickCount: Int,
        targetDescription: String,
        snapshot: AppSnapshot
    ) throws -> ForegroundClickHandBack {
        try requireOnScreenTargetWindow(windowID: snapshot.targetWindowID, pid: snapshot.app.pid)
        guard let windowBounds = snapshot.windowBounds, let windowID = snapshot.targetWindowID else {
            throw ComputerUseError.stateUnavailable(
                "foreground=true requires a current on-screen target window. Run get_app_state again."
            )
        }
        let eventPoint = inputEventPoint(fromScreenStatePoint: point)
        let session = try ForegroundClickSession.begin(
            targetPID: snapshot.app.pid,
            targetWindowID: windowID,
            targetWindow: snapshot.targetWindowElement,
            observedBounds: windowBounds
        )
        do {
            if method != .appPost, button == .left, (1...2).contains(clickCount) {
                debugClickDecision("requested=foreground executed=skylight_pid_post target=\(targetDescription)")
                try InputSimulation.clickWithSkyLight(
                    at: eventPoint,
                    windowPoint: windowPoint,
                    windowBounds: windowBounds,
                    windowID: windowID,
                    clickCount: clickCount,
                    pid: snapshot.app.pid,
                    beforeFirstMouseDown: session.requireReady
                )
            } else {
                debugClickDecision("requested=foreground executed=pid_post target=\(targetDescription)")
                try session.requireReady()
                try InputSimulation.clickTargeted(
                    at: eventPoint,
                    button: button,
                    clickCount: clickCount,
                    pid: snapshot.app.pid
                )
            }
            session.markClickSent()
        } catch let error as SkyClickDispatchFailure {
            session.markClickSent()
            session.end()
            throw error
        } catch {
            session.end()
            throw error
        }
        return session.end()
    }

    private func performExplicitMouseClick(
        method: ClickMethod,
        at point: CGPoint,
        windowPoint: CGPoint,
        button: MouseButtonKind,
        clickCount: Int,
        targetDescription: String,
        snapshot: AppSnapshot
    ) throws {
        if snapshot.mode != .fixture {
            try requireOnScreenTargetWindow(windowID: snapshot.targetWindowID, pid: snapshot.app.pid)
        }
        let eventPoint = inputEventPoint(fromScreenStatePoint: point)

        switch method {
        case .appPost:
            debugClickDecision("requested=app_post executed=pid_post target=\(targetDescription)")
            try requirePIDInputTarget(snapshot)
            try InputSimulation.clickTargeted(
                at: eventPoint,
                button: button,
                clickCount: clickCount,
                pid: snapshot.app.pid
            )
        case .skyClick:
            guard let windowBounds = snapshot.windowBounds, let windowID = snapshot.targetWindowID else {
                throw ComputerUseError.stateUnavailable(
                    "click_method 'sky_click' requires a current on-screen target window. Run get_app_state again."
                )
            }
            debugClickDecision("requested=sky_click executed=skylight_pid_post target=\(targetDescription)")
            try InputSimulation.clickWithSkyLight(
                at: eventPoint,
                windowPoint: windowPoint,
                windowBounds: windowBounds,
                windowID: windowID,
                clickCount: clickCount,
                pid: snapshot.app.pid,
                includePrimer: ChromiumHostCache.shipsRenderer(snapshot.app)
            )
        case .global:
            guard globalPointerFallbacksEnabled(environment: ProcessInfo.processInfo.environment) else {
                throw ComputerUseError.message(
                    "click_method 'global' requires OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS=1 because it may move the system pointer and change foreground focus"
                )
            }
            debugClickDecision("requested=global executed=global_hid target=\(targetDescription)")
            InputSimulation.prepareAppForGlobalPointerInput(snapshot.app)
            try InputSimulation.clickGlobally(at: eventPoint, button: button, clickCount: clickCount)
        case .auto, .accessibility:
            throw ComputerUseError.message(
                "click_method '\(method.rawValue)' is not a direct mouse event method"
            )
        }
    }

    private func snapshotResult(for snapshot: AppSnapshot, style: SnapshotTextStyle, stateChanged: Bool = false) -> ToolCallResult {
        var content = [ToolResultContentItem.text(snapshot.renderedText(style: style))]
        if let screenshotPNGData = snapshot.screenshotPNGData {
            content.append(.pngImage(screenshotPNGData))
        } else if snapshot.mode == .accessibility && !PermissionDiagnostics.current().screenCaptureGranted {
            content.append(.text("Screenshot omitted: Memmy needs Screen Recording permission for images. The accessibility tree and available actions still work."))
        }
        var stateMetadata: [String: Any] = ["pid": Int(snapshot.app.pid),
            "availableWindows": snapshot.availableWindows.map(\.metadata)]
        if let windowID = snapshot.targetWindowID { stateMetadata["targetWindowID"] = Int(windowID) }
        stateMetadata["relatedWindowIDs"] = Set(snapshot.relatedWindowIDs)
            .filter { $0 != snapshot.targetWindowID && $0 > 0 }.sorted().prefix(64).map { Int($0) }
        if let observationID = snapshot.observationID { stateMetadata["observationID"] = observationID }
        if stateChanged {
            stateMetadata["stateChanged"] = true
            stateMetadata["noActionDispatched"] = true
        }
        return ToolCallResult(content: content, metadata: ["memmyComputerUse": stateMetadata])
    }
}
