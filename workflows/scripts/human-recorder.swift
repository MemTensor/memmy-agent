import AppKit
import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics
import Foundation

let emitLock = NSLock()

func emit(_ payload: [String: Any]) {
  guard JSONSerialization.isValidJSONObject(payload),
        let data = try? JSONSerialization.data(withJSONObject: payload),
        let line = String(data: data, encoding: .utf8)
  else { return }
  emitLock.lock()
  print(line)
  fflush(stdout)
  emitLock.unlock()
}

func applicationPayload(_ application: NSRunningApplication? = NSWorkspace.shared.frontmostApplication) -> [String: Any] {
  guard let application else { return [:] }
  return [
    "name": application.localizedName ?? "unknown",
    "bundleId": application.bundleIdentifier ?? "unknown",
    "pid": application.processIdentifier,
  ]
}

func timestamp() -> String {
  ISO8601DateFormatter().string(from: Date())
}

func modifierNames(_ flags: CGEventFlags) -> [String] {
  var names: [String] = []
  if flags.contains(.maskCommand) { names.append("cmd") }
  if flags.contains(.maskShift) { names.append("shift") }
  if flags.contains(.maskAlternate) { names.append("option") }
  if flags.contains(.maskControl) { names.append("control") }
  if flags.contains(.maskSecondaryFn) { names.append("fn") }
  return names
}

let keyNames: [CGKeyCode: String] = [
  36: "return", 48: "tab", 49: "space", 51: "backspace", 53: "escape",
  115: "home", 116: "pageup", 117: "forwarddelete", 119: "end",
  121: "pagedown", 123: "left", 124: "right", 125: "down", 126: "up",
]

func characters(from event: CGEvent) -> String {
  var length = 0
  var characters = [UniChar](repeating: 0, count: 16)
  characters.withUnsafeMutableBufferPointer { buffer in
    event.keyboardGetUnicodeString(
      maxStringLength: buffer.count,
      actualStringLength: &length,
      unicodeString: buffer.baseAddress!
    )
  }
  return String(utf16CodeUnits: characters, count: length)
}

func permissionsPayload(request: Bool) -> [String: Any] {
  let inputMonitoring = request ? CGRequestListenEventAccess() : CGPreflightListenEventAccess()
  let screenRecording = request ? CGRequestScreenCaptureAccess() : CGPreflightScreenCaptureAccess()
  let accessibilityOptions = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: request] as CFDictionary
  let accessibility = AXIsProcessTrustedWithOptions(accessibilityOptions)
  let bounds = CGDisplayBounds(CGMainDisplayID())
  return [
    "inputMonitoring": inputMonitoring,
    "screenRecording": screenRecording,
    "accessibility": accessibility,
    "mainDisplayWidth": Int(bounds.width),
    "mainDisplayHeight": Int(bounds.height),
  ]
}

func axElement(_ value: CFTypeRef?) -> AXUIElement? {
  guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
  return (value as! AXUIElement)
}

func accessibilityString(_ element: AXUIElement, _ attribute: CFString) -> String? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
  guard let string = value as? String else { return nil }
  let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty else { return nil }
  return String(trimmed.prefix(240))
}

func accessibilityValueString(_ element: AXUIElement) -> String? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &value) == .success,
        let value
  else { return nil }
  if let string = value as? String {
    let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    return String(trimmed.prefix(240))
  }
  if let number = value as? NSNumber { return number.stringValue }
  return nil
}

func nodePayload(_ element: AXUIElement) -> [String: Any] {
  AXUIElementSetMessagingTimeout(element, 0.2)
  var payload: [String: Any] = [:]
  if let role = accessibilityString(element, kAXRoleAttribute as CFString) { payload["role"] = role }
  if let subrole = accessibilityString(element, kAXSubroleAttribute as CFString) { payload["subrole"] = subrole }
  if let title = accessibilityString(element, kAXTitleAttribute as CFString) { payload["title"] = title }
  if let description = accessibilityString(element, kAXDescriptionAttribute as CFString) { payload["description"] = description }
  if let identifier = accessibilityString(element, kAXIdentifierAttribute as CFString) { payload["identifier"] = identifier }
  if let value = accessibilityValueString(element) { payload["value"] = value }
  return payload
}

func hasSemanticLabel(_ payload: [String: Any]) -> Bool {
  payload["title"] != nil || payload["description"] != nil || payload["value"] != nil
}

// Custom web controls (e.g. styled radio groups) usually place the labeled
// element next to the anonymous container the click physically lands on.
func labeledAncestors(of element: AXUIElement, limit: Int, maxDepth: Int) -> [[String: Any]] {
  var results: [[String: Any]] = []
  var current = element
  for _ in 0..<maxDepth {
    var parentRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(current, kAXParentAttribute as CFString, &parentRef) == .success,
          let parent = axElement(parentRef)
    else { break }
    let payload = nodePayload(parent)
    if hasSemanticLabel(payload) {
      results.append(payload)
      if results.count >= limit { break }
    }
    current = parent
  }
  return results
}

func labeledDescendants(of element: AXUIElement, limit: Int, maxNodes: Int) -> [[String: Any]] {
  var results: [[String: Any]] = []
  var queue: [AXUIElement] = [element]
  var visited = 0
  while !queue.isEmpty && visited < maxNodes && results.count < limit {
    let current = queue.removeFirst()
    visited += 1
    var childrenRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(current, kAXChildrenAttribute as CFString, &childrenRef) == .success,
          let children = childrenRef as? [AXUIElement]
    else { continue }
    for child in children.prefix(8) {
      let payload = nodePayload(child)
      if hasSemanticLabel(payload) {
        results.append(payload)
        if results.count >= limit { break }
      }
      queue.append(child)
    }
  }
  return results
}

func accessibilityHit(at point: CGPoint) -> (payload: [String: Any], pid: pid_t?)? {
  let system = AXUIElementCreateSystemWide()
  AXUIElementSetMessagingTimeout(system, 0.25)
  var elementRef: AXUIElement?
  guard AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &elementRef) == .success,
        let element = elementRef
  else { return nil }
  var payload = nodePayload(element)
  var pid: pid_t = 0
  let resolvedPid: pid_t? = AXUIElementGetPid(element, &pid) == .success ? pid : nil
  if !hasSemanticLabel(payload) {
    let descendants = labeledDescendants(of: element, limit: 2, maxNodes: 24)
    if !descendants.isEmpty { payload["descendants"] = descendants }
  }
  let ancestors = labeledAncestors(of: element, limit: 2, maxDepth: 8)
  if !ancestors.isEmpty { payload["ancestors"] = ancestors }
  return (payload, resolvedPid)
}

func hitHasSemantics(_ payload: [String: Any]) -> Bool {
  hasSemanticLabel(payload) || payload["descendants"] != nil
}

let interactiveFocusRoles: Set<String> = [
  "AXRadioButton", "AXCheckBox", "AXButton", "AXPopUpButton", "AXTextField",
  "AXTextArea", "AXComboBox", "AXLink", "AXMenuItem", "AXTabButton", "AXSlider",
  "AXIncrementor", "AXSearchField",
]

// The control that ends up focused after a click is immune to the stale-layout
// window in which position hit-tests resolve against pre-scroll geometry.
func focusedInteractiveNode(pid: pid_t) -> [String: Any]? {
  let app = AXUIElementCreateApplication(pid)
  AXUIElementSetMessagingTimeout(app, 0.2)
  var ref: CFTypeRef?
  guard AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute as CFString, &ref) == .success,
        let element = axElement(ref)
  else { return nil }
  let payload = nodePayload(element)
  guard let role = payload["role"] as? String,
        interactiveFocusRoles.contains(role),
        hasSemanticLabel(payload)
  else { return nil }
  return payload
}

// MARK: - Browser page context

let browserBundleIds: Set<String> = ["com.google.Chrome", "com.apple.Safari"]

func sanitizedPageUrl(_ raw: String) -> String? {
  guard var components = URLComponents(string: raw) else { return nil }
  guard components.scheme == "http" || components.scheme == "https" else { return nil }
  components.query = nil
  components.fragment = nil
  components.user = nil
  components.password = nil
  guard let sanitized = components.string, !sanitized.isEmpty else { return nil }
  return String(sanitized.prefix(500))
}

func webAreaUrl(_ element: AXUIElement) -> String? {
  var urlRef: CFTypeRef?
  if AXUIElementCopyAttributeValue(element, kAXURLAttribute as CFString, &urlRef) == .success {
    if let url = urlRef as? NSURL, let absolute = url.absoluteString {
      return sanitizedPageUrl(absolute)
    }
    if let string = urlRef as? String { return sanitizedPageUrl(string) }
  }
  if let document = accessibilityString(element, "AXDocument" as CFString) {
    return sanitizedPageUrl(document)
  }
  return nil
}

func browserPage(pid: pid_t) -> (url: String?, title: String?) {
  let app = AXUIElementCreateApplication(pid)
  AXUIElementSetMessagingTimeout(app, 0.3)
  var windowRef: CFTypeRef?
  if AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &windowRef) != .success {
    _ = AXUIElementCopyAttributeValue(app, kAXMainWindowAttribute as CFString, &windowRef)
  }
  guard let window = axElement(windowRef) else { return (nil, nil) }
  let title = accessibilityString(window, kAXTitleAttribute as CFString)
  if let document = accessibilityString(window, "AXDocument" as CFString),
     let sanitized = sanitizedPageUrl(document) {
    return (sanitized, title)
  }
  var queue: [AXUIElement] = [window]
  var visited = 0
  while !queue.isEmpty && visited < 120 {
    let current = queue.removeFirst()
    visited += 1
    if accessibilityString(current, kAXRoleAttribute as CFString) == "AXWebArea" {
      return (webAreaUrl(current), title)
    }
    var childrenRef: CFTypeRef?
    if AXUIElementCopyAttributeValue(current, kAXChildrenAttribute as CFString, &childrenRef) == .success,
       let children = childrenRef as? [AXUIElement] {
      queue.append(contentsOf: children.prefix(16))
    }
  }
  return (nil, title)
}

// MARK: - Secure input

// macOS raises secure input mode while a password field owns focus. Recording
// keystroke text in that window is exactly what we must never do, so every
// event carries the flag and text capture is suppressed while it is set.
func secureInputActive() -> Bool {
  IsSecureEventInputEnabled()
}

// MARK: - Event identity

let eventCounter = NSLock()
var eventSequence = 0

func nextEventId() -> String {
  eventCounter.lock()
  eventSequence += 1
  let value = eventSequence
  eventCounter.unlock()
  return "evt-\(value)"
}

// MARK: - Live accessibility state
//
// The previous recorder resolved a click by hit-testing the cursor position and
// then sleeping 300ms hoping the application had rebuilt its tree. That races
// the renderer. Instead we keep the focused element continuously up to date from
// AXObserver notifications, so a click can be attributed immediately and the
// positional hit test is only a fallback for controls that never take focus.

let axStateLock = NSLock()
var observedPid: pid_t?
var observedObserver: AXObserver?
var focusedElementCache: AXUIElement?
var focusedWindowTitle: String?
var focusedWindowUrl: String?

func cachedFocusedElement() -> AXUIElement? {
  axStateLock.lock(); defer { axStateLock.unlock() }
  return focusedElementCache
}

func cachedWindow() -> [String: Any] {
  axStateLock.lock(); defer { axStateLock.unlock() }
  var payload: [String: Any] = [:]
  if let focusedWindowTitle { payload["title"] = focusedWindowTitle }
  if let focusedWindowUrl { payload["url"] = focusedWindowUrl }
  return payload
}

func applicationEnvelope(_ application: [String: Any]? = nil) -> [String: Any] {
  let source = application ?? applicationPayload()
  var payload: [String: Any] = ["secureInput": secureInputActive()]
  if let name = source["name"] { payload["name"] = name }
  if let bundleId = source["bundleId"] { payload["bundleIdentifier"] = bundleId }
  return payload
}

func emitEvent(kind: String, application: [String: Any]? = nil, extra: [String: Any]) {
  var payload: [String: Any] = [
    "kind": kind,
    "id": nextEventId(),
    "timestamp": timestamp(),
    "app": applicationEnvelope(application),
  ]
  let window = cachedWindow()
  if !window.isEmpty { payload["window"] = window }
  for (key, value) in extra { payload[key] = value }
  emit(payload)
}

func refreshFocusedWindow(pid: pid_t) {
  let app = AXUIElementCreateApplication(pid)
  AXUIElementSetMessagingTimeout(app, 0.2)
  var windowRef: CFTypeRef?
  if AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &windowRef) != .success {
    _ = AXUIElementCopyAttributeValue(app, kAXMainWindowAttribute as CFString, &windowRef)
  }
  let title = axElement(windowRef).flatMap { accessibilityString($0, kAXTitleAttribute as CFString) }
  var url: String?
  if let bundleId = applicationPayload()["bundleId"] as? String, browserBundleIds.contains(bundleId) {
    url = browserPage(pid: pid).url
  }
  axStateLock.lock()
  focusedWindowTitle = title
  focusedWindowUrl = url
  axStateLock.unlock()
}

func refreshFocusedElement(pid: pid_t) {
  let app = AXUIElementCreateApplication(pid)
  AXUIElementSetMessagingTimeout(app, 0.2)
  var ref: CFTypeRef?
  guard AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute as CFString, &ref) == .success,
        let element = axElement(ref)
  else { return }
  axStateLock.lock()
  focusedElementCache = element
  axStateLock.unlock()
}

// Selected text is the single highest-volume semantic signal: it reports what
// the user is actually reading or editing without any coordinate involved.
func emitSelectionChanged(_ element: AXUIElement) {
  guard !secureInputActive() else { return }
  var target = nodePayload(element)
  var selection: [String: Any] = [:]
  if let text = accessibilityString(element, kAXSelectedTextAttribute as CFString) {
    selection["selectedText"] = text
  }
  var rangeRef: CFTypeRef?
  if AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, &rangeRef) == .success,
     let value = rangeRef, CFGetTypeID(value) == AXValueGetTypeID() {
    var range = CFRange(location: 0, length: 0)
    if AXValueGetValue(value as! AXValue, .cfRange, &range) {
      selection["selectedRange"] = ["location": range.location, "length": range.length]
    }
  }
  guard !selection.isEmpty else { return }
  if target.isEmpty { target = ["role": "AXUnknown"] }
  selection["target"] = target
  emitEvent(kind: "selection.changed", extra: ["selection": selection])
}

let axObserverCallback: AXObserverCallback = { _, element, notification, _ in
  let name = notification as String
  switch name {
  case kAXFocusedUIElementChangedNotification:
    axStateLock.lock()
    focusedElementCache = element
    axStateLock.unlock()
  case kAXSelectedTextChangedNotification:
    emitSelectionChanged(element)
  case kAXValueChangedNotification:
    axStateLock.lock()
    let isFocused = focusedElementCache == nil
    axStateLock.unlock()
    if isFocused {
      axStateLock.lock()
      focusedElementCache = element
      axStateLock.unlock()
    }
  case kAXFocusedWindowChangedNotification, kAXWindowMovedNotification:
    var pid: pid_t = 0
    if AXUIElementGetPid(element, &pid) == .success {
      refreshFocusedWindow(pid: pid)
      emitEvent(kind: "window.changed", extra: [:])
    }
  default:
    break
  }
}

func observeApplication(pid: pid_t) {
  axStateLock.lock()
  let alreadyObserved = observedPid == pid
  axStateLock.unlock()
  guard !alreadyObserved else { return }

  if let previous = observedObserver {
    CFRunLoopRemoveSource(
      CFRunLoopGetMain(),
      AXObserverGetRunLoopSource(previous),
      .defaultMode
    )
  }

  var observer: AXObserver?
  guard AXObserverCreate(pid, axObserverCallback, &observer) == .success,
        let observer
  else { return }
  let app = AXUIElementCreateApplication(pid)
  for notification in [
    kAXFocusedUIElementChangedNotification,
    kAXSelectedTextChangedNotification,
    kAXValueChangedNotification,
    kAXFocusedWindowChangedNotification,
    kAXWindowMovedNotification,
  ] {
    AXObserverAddNotification(observer, app, notification as CFString, nil)
  }
  CFRunLoopAddSource(
    CFRunLoopGetMain(),
    AXObserverGetRunLoopSource(observer),
    .defaultMode
  )

  axStateLock.lock()
  observedPid = pid
  observedObserver = observer
  focusedElementCache = nil
  axStateLock.unlock()

  refreshFocusedElement(pid: pid)
  refreshFocusedWindow(pid: pid)
}

// MARK: - Event tap
//
// The tap still tells us *that* an interaction happened; it no longer decides
// *what* was interacted with. Coordinates are used only to fall back to a hit
// test and are never emitted.

let enrichmentQueue = DispatchQueue(label: "human-recorder.enrichment")

let eventMask = (1 << CGEventType.leftMouseDown.rawValue)
  | (1 << CGEventType.leftMouseUp.rawValue)
  | (1 << CGEventType.rightMouseDown.rawValue)
  | (1 << CGEventType.keyDown.rawValue)

var eventTap: CFMachPort?
var dragOrigin: (point: CGPoint, target: [String: Any])?

// Resolve what was acted on. The AXObserver-maintained focused element is
// authoritative and always current; the positional hit test only covers
// controls that never take focus (static links, custom canvas widgets).
func resolveTarget(at point: CGPoint) -> [String: Any] {
  if let focused = cachedFocusedElement() {
    let payload = nodePayload(focused)
    if hasSemanticLabel(payload) { return payload }
  }
  if let hit = accessibilityHit(at: point), hitHasSemantics(hit.payload) {
    return hit.payload
  }
  return [:]
}

func modifierList(_ event: CGEvent) -> [String] {
  modifierNames(event.flags)
}

let callback: CGEventTapCallBack = { _, type, event, _ in
  switch type {
  case .leftMouseDown, .rightMouseDown:
    let point = event.location
    let clickCount = event.getIntegerValueField(.mouseEventClickState)
    let button = type == .rightMouseDown ? "right" : "left"
    let modifiers = modifierList(event)
    let application = applicationPayload()
    enrichmentQueue.async {
      var target = resolveTarget(at: point)
      if target.isEmpty { target = ["role": "AXUnknown"] }
      if type == .leftMouseDown { dragOrigin = (point, target) }
      var mouse: [String: Any] = ["button": button, "clickCount": clickCount, "target": target]
      if !modifiers.isEmpty { mouse["modifiers"] = modifiers }
      emitEvent(
        kind: type == .rightMouseDown ? "mouse.context_menu" : "mouse.click",
        application: application,
        extra: ["mouse": mouse]
      )
    }
  case .leftMouseUp:
    let point = event.location
    let application = applicationPayload()
    guard let origin = dragOrigin else { break }
    dragOrigin = nil
    let dx = point.x - origin.point.x
    let dy = point.y - origin.point.y
    // Anything under a few points is a click that wobbled, not a drag.
    guard (dx * dx + dy * dy) > 25 else { break }
    enrichmentQueue.async {
      var destination = resolveTarget(at: point)
      if destination.isEmpty { destination = ["role": "AXUnknown"] }
      emitEvent(
        kind: "mouse.drag",
        application: application,
        extra: ["mouse": ["origin": ["element": origin.target], "destination": ["element": destination]]]
      )
    }
  case .keyDown:
    let keyCode = CGKeyCode(event.getIntegerValueField(.keyboardEventKeycode))
    let text = characters(from: event)
    let modifiers = modifierList(event)
    let application = applicationPayload()
    let secure = secureInputActive()
    enrichmentQueue.async {
      var target = cachedFocusedElement().map { nodePayload($0) } ?? [:]
      if target.isEmpty { target = ["role": "AXUnknown"] }
      var keyboard: [String: Any] = ["target": target]
      if !modifiers.isEmpty { keyboard["modifiers"] = modifiers }

      // Return without modifiers ends an input; it is the cheapest reliable
      // marker of a task boundary, so it gets its own kind.
      if keyCode == 36 && modifiers.isEmpty {
        emitEvent(kind: "keyboard.submit", application: application, extra: ["keyboard": keyboard])
        return
      }
      let named = keyNames[keyCode]
      if !modifiers.isEmpty || named != nil {
        keyboard["keyEquivalent"] = named ?? (text.isEmpty ? "keycode-\(keyCode)" : text)
        keyboard["keyCode"] = Int(keyCode)
        emitEvent(kind: "keyboard.shortcut", application: application, extra: ["keyboard": keyboard])
        return
      }
      // Never carry keystroke text out of a secure input window.
      guard !secure, !text.isEmpty else { return }
      keyboard["text"] = text
      emitEvent(kind: "keyboard.text_input", application: application, extra: ["keyboard": keyboard])
    }
  case .tapDisabledByTimeout, .tapDisabledByUserInput:
    if let eventTap { CGEvent.tapEnable(tap: eventTap, enable: true) }
  default:
    break
  }
  return Unmanaged.passUnretained(event)
}

// MARK: - Entry point

let arguments = Set(CommandLine.arguments.dropFirst())
if arguments.contains("--permissions") || arguments.contains("--request-permissions") {
  emit(permissionsPayload(request: arguments.contains("--request-permissions")))
  exit(0)
}

guard let tap = CGEvent.tapCreate(
  tap: .cgSessionEventTap,
  place: .headInsertEventTap,
  options: .listenOnly,
  eventsOfInterest: CGEventMask(eventMask),
  callback: callback,
  userInfo: nil
) else {
  FileHandle.standardError.write(
    "Unable to create the event tap. Grant Input Monitoring permission and restart the recorder.\n"
      .data(using: .utf8)!
  )
  exit(2)
}
eventTap = tap

let workspaceObserver = NSWorkspace.shared.notificationCenter.addObserver(
  forName: NSWorkspace.didActivateApplicationNotification,
  object: nil,
  queue: .main
) { notification in
  let application = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
  let payload = applicationPayload(application)
  if let pid = payload["pid"] as? pid_t { observeApplication(pid: pid) }
  emitEvent(kind: "window.changed", application: payload, extra: [:])
}

let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)

if let pid = applicationPayload()["pid"] as? pid_t { observeApplication(pid: pid) }
emitEvent(kind: "session.started", extra: [:])

signal(SIGTERM) { _ in
  emitEvent(kind: "session.ended", extra: [:])
  exit(0)
}
signal(SIGINT) { _ in
  emitEvent(kind: "session.ended", extra: [:])
  exit(0)
}

CFRunLoopRun()
NSWorkspace.shared.notificationCenter.removeObserver(workspaceObserver)
