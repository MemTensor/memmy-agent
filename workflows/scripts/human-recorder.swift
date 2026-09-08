import AppKit
import ApplicationServices
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

let enrichmentQueue = DispatchQueue(label: "human-recorder.enrichment")
var pageContextGeneration = 0

// Must be called on enrichmentQueue. Waits for the page to settle, then emits
// the front browser page (query and fragment stripped) as its own event.
func schedulePageContext(for application: [String: Any]) {
  guard let bundleId = application["bundleId"] as? String,
        browserBundleIds.contains(bundleId),
        let pid = application["pid"] as? pid_t
  else { return }
  pageContextGeneration += 1
  let generation = pageContextGeneration
  enrichmentQueue.asyncAfter(deadline: .now() + 0.9) {
    guard generation == pageContextGeneration else { return }
    let page = browserPage(pid: pid)
    guard let url = page.url else { return }
    var payload: [String: Any] = [
      "type": "page_context",
      "timestamp": timestamp(),
      "application": application,
      "url": url,
    ]
    if let title = page.title { payload["title"] = title }
    emit(payload)
  }
}

let arguments = Set(CommandLine.arguments.dropFirst())
if arguments.contains("--permissions") || arguments.contains("--request-permissions") {
  emit(permissionsPayload(request: arguments.contains("--request-permissions")))
  exit(0)
}

let eventMask = (1 << CGEventType.leftMouseDown.rawValue)
  | (1 << CGEventType.rightMouseDown.rawValue)
  | (1 << CGEventType.keyDown.rawValue)
  | (1 << CGEventType.scrollWheel.rawValue)

var eventTap: CFMachPort?

let callback: CGEventTapCallBack = { _, type, event, _ in
  switch type {
  case .leftMouseDown, .rightMouseDown:
    // The AX walk can take tens of milliseconds; run it off the tap thread so
    // a slow application cannot make the OS disable the listen-only tap.
    let point = event.location
    let button = type == .rightMouseDown ? "right" : "left"
    let clickCount = event.getIntegerValueField(.mouseEventClickState)
    let eventTimestamp = timestamp()
    let frontmost = applicationPayload()
    enrichmentQueue.async {
      var payload: [String: Any] = [
        "type": "mouse_click",
        "timestamp": eventTimestamp,
        "x": point.x,
        "y": point.y,
        "button": button,
        "clickCount": clickCount,
      ]
      var application = frontmost
      var hit = accessibilityHit(at: point)
      // Let the click settle, then re-probe: Chrome builds its AX tree lazily
      // and reports stale geometry right after scrolls, so an empty first hit
      // often resolves on the second attempt.
      usleep(300_000)
      if hit == nil || !hitHasSemantics(hit!.payload) {
        if let retried = accessibilityHit(at: point), hitHasSemantics(retried.payload) {
          hit = retried
        }
      }
      if let hit {
        var accessibility = hit.payload
        // Attribute the click to the process owning the clicked element, not
        // the frontmost application: the first click on a background window
        // arrives before macOS finishes activating it.
        if let pid = hit.pid {
          if let owner = NSRunningApplication(processIdentifier: pid) {
            application = applicationPayload(owner)
          }
          if let focused = focusedInteractiveNode(pid: pid) {
            accessibility["focused"] = focused
          }
        }
        if !accessibility.isEmpty { payload["accessibility"] = accessibility }
      }
      payload["application"] = application
      emit(payload)
      schedulePageContext(for: application)
    }
  case .keyDown:
    let keyCode = CGKeyCode(event.getIntegerValueField(.keyboardEventKeycode))
    let text = characters(from: event)
    let application = applicationPayload()
    emit([
      "type": "key_down",
      "timestamp": timestamp(),
      "application": application,
      "keyCode": keyCode,
      "key": keyNames[keyCode] ?? (text.isEmpty ? "keycode-\(keyCode)" : text),
      "characters": text,
      "modifiers": modifierNames(event.flags),
      "repeat": event.getIntegerValueField(.keyboardEventAutorepeat) == 1,
    ])
    if keyCode == 36 {
      enrichmentQueue.async { schedulePageContext(for: application) }
    }
  case .scrollWheel:
    emit([
      "type": "scroll",
      "timestamp": timestamp(),
      "application": applicationPayload(),
      "deltaX": event.getDoubleValueField(.scrollWheelEventPointDeltaAxis2),
      "deltaY": event.getDoubleValueField(.scrollWheelEventPointDeltaAxis1),
    ])
  case .tapDisabledByTimeout, .tapDisabledByUserInput:
    if let eventTap { CGEvent.tapEnable(tap: eventTap, enable: true) }
  default:
    break
  }
  return Unmanaged.passUnretained(event)
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

let observer = NSWorkspace.shared.notificationCenter.addObserver(
  forName: NSWorkspace.didActivateApplicationNotification,
  object: nil,
  queue: .main
) { notification in
  let application = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
  emit([
    "type": "application_changed",
    "timestamp": timestamp(),
    "application": applicationPayload(application),
  ])
}

let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)
emit([
  "type": "helper_ready",
  "timestamp": timestamp(),
  "application": applicationPayload(),
])
CFRunLoopRun()
NSWorkspace.shared.notificationCenter.removeObserver(observer)
