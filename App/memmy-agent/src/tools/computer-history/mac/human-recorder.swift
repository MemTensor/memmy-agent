import AppKit
import ApplicationServices
import Carbon.HIToolbox
import CoreGraphics
import Foundation

let emitLock = NSLock()
// The product runs this recorder inside Memmy Computer Use.app. The CLI keeps
// stdout output for source builds and standalone diagnostics.
var historyEventSink: ((String) -> Void)?
var historySessionId: UInt64 = 0

let separatelyAuthorizedSourceBundleIds: Set<String> = ["com.tencent.xinwechat", "com.tencent.wechat"]

func isSeparatelyAuthorizedSource(_ application: [String: Any]) -> Bool {
  excludesUnconsentedWeChat(application)
}

func emit(_ payload: [String: Any], expectedSession: UInt64? = nil) {
  guard JSONSerialization.isValidJSONObject(payload),
        let data = try? JSONSerialization.data(withJSONObject: payload),
        let line = String(data: data, encoding: .utf8)
  else { return }
  emitLock.lock()
  defer { emitLock.unlock() }
  if let expectedSession, expectedSession != historySessionId { return }
  if let historyEventSink {
    historyEventSink(line)
  } else {
    #if !MEMMY_COMPUTER_USE_APP
    print(line)
    fflush(stdout)
    #endif
  }
}

func applicationPayload(_ application: NSRunningApplication? = NSWorkspace.shared.frontmostApplication) -> [String: Any] {
  guard let application else { return [:] }
  return [
    "name": application.localizedName ?? "unknown",
    "bundleId": application.bundleIdentifier ?? "unknown",
    "pid": application.processIdentifier,
  ]
}

// Both the window observer and the database reader use this one consent file.
// When it is absent or invalid, stop before querying AX or keyboard focus.
func excludesUnconsentedWeChat(_ application: [String: Any]) -> Bool {
  guard let bundleId = application["bundleId"] as? String,
        separatelyAuthorizedSourceBundleIds.contains(bundleId.lowercased())
  else { return false }
  let file = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent(".memmy/computer-history/wechat/consent.json")
  guard (try? file.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) != true,
        let attributes = try? FileManager.default.attributesOfItem(atPath: file.path),
        let permissions = attributes[.posixPermissions] as? NSNumber,
        permissions.intValue & 0o77 == 0,
        let data = try? Data(contentsOf: file),
        let state = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        state["version"] as? Int == 1,
        state["enabled"] as? Bool == true,
        state["consentId"] as? String != nil,
        state["consentedAt"] as? String != nil
  else { return true }
  return false
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

let keyNames: [Int: String] = [
  36: "return", 48: "tab", 49: "space", 51: "backspace", 53: "escape",
  115: "home", 116: "pageup", 117: "forwarddelete", 119: "end",
  121: "pagedown", 123: "left", 124: "right", 125: "down", 126: "up",
]

// Shift/Option change printable text; only Command/Control turn a printable
// character into a shortcut. Check secure input before carrying any text.
func classifiedKeyboard(keyCode: Int, text: String, modifiers: [String], secure: Bool) -> [String: Any]? {
  var keyboard: [String: Any] = [:]
  if !modifiers.isEmpty { keyboard["modifiers"] = modifiers }
  if keyCode == 36 && modifiers.isEmpty {
    return ["kind": "keyboard.submit", "keyboard": keyboard]
  }
  let command = modifiers.contains("cmd") || modifiers.contains("control")
  let named = keyNames[keyCode]
  if command || (named != nil && keyCode != 49) {
    keyboard["keyEquivalent"] = named ?? (text.isEmpty ? "keycode-\(keyCode)" : text)
    keyboard["keyCode"] = keyCode
    return ["kind": "keyboard.shortcut", "keyboard": keyboard]
  }
  guard !secure, !text.isEmpty else { return nil }
  keyboard["text"] = text
  return ["kind": "keyboard.text_input", "keyboard": keyboard]
}

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

public func permissionsPayload(request: Bool, requestInputMonitoring: Bool = false, requestScreenRecording: Bool = false, requestAccessibility: Bool = false) -> [String: Any] {
  let inputMonitoring = (request || requestInputMonitoring) ? CGRequestListenEventAccess() : CGPreflightListenEventAccess()
  let screenRecording = (request || requestScreenRecording) ? CGRequestScreenCaptureAccess() : CGPreflightScreenCaptureAccess()
  let accessibilityOptions = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: (request || requestAccessibility)] as CFDictionary
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

let browserBundleIds: Set<String> = [
  "com.google.Chrome", "com.google.Chrome.canary", "com.apple.Safari",
  "com.apple.SafariTechnologyPreview", "company.thebrowser.Browser",
  "com.microsoft.edgemac", "com.brave.Browser", "org.mozilla.firefox",
  "org.chromium.Chromium", "com.operasoftware.Opera", "com.vivaldi.Vivaldi",
  "com.quark.desktop",
]

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

func browserPage(window: AXUIElement) -> (url: String?, title: String?) {
  AXUIElementSetMessagingTimeout(window, 0.1)
  let title = accessibilityString(window, kAXTitleAttribute as CFString)
  if let document = accessibilityString(window, "AXDocument" as CFString),
     let sanitized = sanitizedPageUrl(document) {
    return (sanitized, title)
  }
  var queue: [AXUIElement] = [window]
  var visited = 0
  let deadline = Date().addingTimeInterval(0.15)
  while !queue.isEmpty && visited < 120 && Date() < deadline {
    let current = queue.removeFirst()
    visited += 1
    AXUIElementSetMessagingTimeout(current, 0.05)
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

// One attribute, then the window's immediate children. Enough to notice a page
// in a browser that is not on the known list, without walking every Notes window.
func quickPageUrl(_ window: AXUIElement) -> String? {
  AXUIElementSetMessagingTimeout(window, 0.05)
  if let document = accessibilityString(window, "AXDocument" as CFString),
     let sanitized = sanitizedPageUrl(document) {
    return sanitized
  }
  var childrenRef: CFTypeRef?
  guard AXUIElementCopyAttributeValue(window, kAXChildrenAttribute as CFString, &childrenRef) == .success,
        let children = childrenRef as? [AXUIElement] else { return nil }
  for child in children.prefix(12) {
    AXUIElementSetMessagingTimeout(child, 0.05)
    if accessibilityString(child, kAXRoleAttribute as CFString) == "AXWebArea" {
      return webAreaUrl(child)
    }
  }
  return nil
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
// AXObserver maintains a versioned focus cache. The event tap can take its
// identity without performing a blocking AX read; enrichment verifies that
// the identity still belongs to the event before granting text permissions.

let axStateLock = NSLock()
var observedPid: pid_t?
var observedObserver: AXObserver?
var focusedElementCache: AXUIElement?
var focusedElementGeneration: UInt64 = 0
let enrichmentQueue = DispatchQueue(label: "human-recorder.enrichment")
let enrichmentQueueKey = DispatchSpecificKey<Bool>()
// These caches and the AX sampling clock are owned by enrichmentQueue.
var privacyWindow: AXUIElement?
var privacyWindowPid: pid_t?
var privacyWindowValue: Bool?

// Private browser windows are identified from the accessibility window title,
// as in the Codex recorder. Do not query the browser through Apple Events:
// that path triggers a macOS "Memmy wants to control Google Chrome" prompt
// every time a user opens Chrome. A title without a private-mode marker is a
// normal window; the recorder never needs an Automation entitlement.
let privateWindowTitleMarkers = [
  "(incognito)", "(private)", "(inprivate)", "(无痕)", "（无痕）", "无痕模式",
  "无痕浏览", "隐私浏览", "私密浏览", "(シークレット", "シークレット モード",
  "(プライベート", "private browsing", "private browsing", "navegação privada",
  "navigation privée", "navigazione privata", "navegación privada", "inkognito",
  "incognito", "inprivate", "anonym", "privat", "privé", "privado", "prywat",
  "privatno", "gizli", "súkrom", "частн", "инкогнито", "приват", "приватний",
  "개인정보 보호", "시크릿", "プライベート",
]

func frontWindowIsPrivate(window: AXUIElement, bundleId: String, pageDetected: Bool = false) -> Bool? {
  guard pageDetected || browserBundleIds.contains(bundleId),
        let title = accessibilityString(window, kAXTitleAttribute as CFString)
  else { return false }
  let normalized = title.lowercased()
  return privateWindowTitleMarkers.contains { normalized.contains($0.lowercased()) }
}

struct FocusSnapshot {
  let element: AXUIElement?
  let pid: pid_t?
  let generation: UInt64
}

func captureFocusSnapshot() -> FocusSnapshot {
  axStateLock.lock(); defer { axStateLock.unlock() }
  return FocusSnapshot(element: focusedElementCache, pid: observedPid, generation: focusedElementGeneration)
}

func focusSnapshotIsCurrent(_ snapshot: FocusSnapshot, pid: pid_t?) -> Bool {
  axStateLock.lock(); defer { axStateLock.unlock() }
  return pid != nil && snapshot.pid == pid && observedPid == pid
    && snapshot.generation == focusedElementGeneration && snapshot.element != nil
}

func keyboardTarget(snapshot: FocusSnapshot, pid: pid_t?) -> [String: Any] {
  guard focusSnapshotIsCurrent(snapshot, pid: pid), let element = snapshot.element else {
    return ["role": "AXUnknown"]
  }
  let target = nodePayload(element)
  // AX calls may yield while focus changes. Never attach the old field's
  // labels/value after that happens, even if they look like a search field.
  guard focusSnapshotIsCurrent(snapshot, pid: pid), !target.isEmpty else {
    return ["role": "AXUnknown"]
  }
  return target
}

func applicationEnvelope(_ application: [String: Any]? = nil) -> [String: Any] {
  let source = application ?? applicationPayload()
  var payload: [String: Any] = ["secureInput": secureInputActive()]
  if let name = source["name"] { payload["name"] = name }
  if let bundleId = source["bundleId"] { payload["bundleIdentifier"] = bundleId }
  return payload
}

func emitEvent(kind: String, application: [String: Any]? = nil, extra: [String: Any]) {
  emitLock.lock()
  let session = historySessionId
  emitLock.unlock()
  let source = application ?? applicationPayload()
  guard !excludesUnconsentedWeChat(source) else { return }
  let at = timestamp()
  let capture = {
    guard !excludesUnconsentedWeChat(source) else { return }
    guard let pid = source["pid"] as? pid_t,
          NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
    else { return }
    let bundleId = source["bundleId"] as? String ?? ""
    let context = currentWindow(pid: pid, bundleId: bundleId)
    let window = context.payload
    var payload: [String: Any] = [
      "kind": kind, "id": nextEventId(), "timestamp": at,
      "app": applicationEnvelope(source), "window": window,
    ]
    // Read the URL from this event's actual window, including same-tab
    // navigation. Never reuse an earlier URL when the lookup fails.
    if let element = context.element,
       window["privateBrowsing"] as? Bool != true,
       window["privateBrowsingUnknown"] as? Bool != true {
      let windowKey = "\(pid):\(CFHash(element)):\(window["url"] as? String ?? "")"
      if let ax = axSnapshot(window: element, windowKey: windowKey) {
        // Navigation during tree traversal must not attach the new page's
        // contents to a previously allowed URL.
        if browserBundleIds.contains(bundleId),
           browserPage(window: element).url != window["url"] as? String {
          lastTreeKey = nil
          lastTreeAt = nil
          return
        }
        payload["ax"] = ax
      }
    }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { return }
    for (key, value) in extra { payload[key] = value }
    emit(payload, expectedSession: session)
  }
  if DispatchQueue.getSpecific(key: enrichmentQueueKey) == true { capture() }
  else { enrichmentQueue.async(execute: capture) }
}

func currentWindow(pid: pid_t, bundleId: String) -> (payload: [String: Any], element: AXUIElement?) {
  let app = AXUIElementCreateApplication(pid)
  AXUIElementSetMessagingTimeout(app, 0.2)
  var windowRef: CFTypeRef?
  if AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &windowRef) != .success {
    _ = AXUIElementCopyAttributeValue(app, kAXMainWindowAttribute as CFString, &windowRef)
  }
  let knownBrowser = browserBundleIds.contains(bundleId)
  var payload: [String: Any] = [:]
  if knownBrowser { payload["browser"] = true }
  guard let window = axElement(windowRef) else { return (payload, nil) }
  if let title = accessibilityString(window, kAXTitleAttribute as CFString) { payload["title"] = title }
  let pageUrl = knownBrowser ? browserPage(window: window).url : quickPageUrl(window)
  if let pageUrl {
    payload["browser"] = true
    payload["url"] = pageUrl
  }
  let treatsAsBrowser = knownBrowser || pageUrl != nil
  if privacyWindowPid != pid || privacyWindow == nil || !CFEqual(privacyWindow, window) {
    privacyWindowPid = pid
    privacyWindow = window
    privacyWindowValue = frontWindowIsPrivate(window: window, bundleId: bundleId, pageDetected: pageUrl != nil)
  }
  if treatsAsBrowser {
    if let isPrivate = privacyWindowValue {
      if isPrivate { payload["privateBrowsing"] = true }
    } else {
      payload["privateBrowsingUnknown"] = true
    }
  }
  return (payload, window)
}

func refreshFocusedElement(pid: pid_t) {
  let app = AXUIElementCreateApplication(pid)
  AXUIElementSetMessagingTimeout(app, 0.2)
  var ref: CFTypeRef?
  guard AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute as CFString, &ref) == .success,
        let element = axElement(ref)
  else { return }
  axStateLock.lock()
  guard observedPid == pid else { axStateLock.unlock(); return }
  focusedElementCache = element
  focusedElementGeneration &+= 1
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

// MARK: - Accessibility tree snapshots
//
// Always send a complete sampled tree to the policy-owning consumer. Computing
// diffs here would retain an excluded tree as a baseline and later leak its
// removed lines when that same window is allowed again. The consumer computes
// compact diffs only from snapshots it has authorized and written to disk.

let AX_TREE_MAX_NODES = 400
let AX_TREE_MIN_INTERVAL: TimeInterval = 0.4

var lastTreeKey: String?
var lastTreeAt: Date?

func treeLine(_ payload: [String: Any]) -> String? {
  let role = payload["role"] as? String ?? ""
  let fields = ["subrole", "title", "description", "identifier", "value"]
    .map { payload[$0] as? String ?? "" }
  guard !role.isEmpty, fields.contains(where: { !$0.isEmpty }) else { return nil }
  return ([role] + fields).joined(separator: "|")
}

func axTreeLines(window: AXUIElement) -> [String] {
  var lines: [String] = []
  var queue: [AXUIElement] = [window]
  var visited = 0
  while !queue.isEmpty && visited < AX_TREE_MAX_NODES {
    let current = queue.removeFirst()
    visited += 1
    if let line = treeLine(nodePayload(current)) { lines.append(line) }
    var childrenRef: CFTypeRef?
    if AXUIElementCopyAttributeValue(current, kAXChildrenAttribute as CFString, &childrenRef) == .success,
       let children = childrenRef as? [AXUIElement] {
      queue.append(contentsOf: children.prefix(24))
    }
  }
  return lines
}

// Returns nil when the snapshot was taken recently enough that recomputing it
// would cost more than the freshness is worth.
func axSnapshot(window: AXUIElement, windowKey: String) -> [String: Any]? {
  let now = Date()
  if windowKey == lastTreeKey, let lastTreeAt,
     now.timeIntervalSince(lastTreeAt) < AX_TREE_MIN_INTERVAL { return nil }

  let lines = axTreeLines(window: window)
  guard !lines.isEmpty else { return nil }
  lastTreeKey = windowKey
  lastTreeAt = now
  return ["mode": "fullTree", "windowKey": windowKey, "text": lines.joined(separator: "\n")]
}

let axObserverCallback: AXObserverCallback = { _, element, notification, _ in
  guard !excludesUnconsentedWeChat(applicationPayload()) else { return }
  let name = notification as String
  switch name {
  case kAXFocusedUIElementChangedNotification:
    axStateLock.lock()
    focusedElementCache = element
    focusedElementGeneration &+= 1
    axStateLock.unlock()
  case kAXSelectedTextChangedNotification:
    emitSelectionChanged(element)
  case kAXValueChangedNotification:
    // Only the foreground focused control may trigger a fresh window snapshot.
    // Background controls and password fields cannot cause their contents to
    // be captured merely by changing value.
    var pid: pid_t = 0
    guard AXUIElementGetPid(element, &pid) == .success,
          NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
          !secureInputActive() else { break }
    let focus = captureFocusSnapshot()
    guard focus.pid == pid, let focused = focus.element, CFEqual(focused, element),
          accessibilityString(element, kAXSubroleAttribute as CFString) != "AXSecureTextField"
    else { break }
    emitEvent(kind: "accessibility.changed", extra: [:])
  case kAXFocusedWindowChangedNotification, kAXWindowMovedNotification:
    axStateLock.lock()
    if name == kAXFocusedWindowChangedNotification { focusedElementCache = nil }
    focusedElementGeneration &+= 1
    axStateLock.unlock()
    var pid: pid_t = 0
    if AXUIElementGetPid(element, &pid) == .success {
      if name == kAXFocusedWindowChangedNotification {
        enrichmentQueue.async { refreshFocusedElement(pid: pid) }
      }
      emitEvent(kind: "window.changed", extra: [:])
    }
  default:
    break
  }
}

func observeApplication(pid: pid_t) {
  let application = applicationPayload()
  guard !excludesUnconsentedWeChat(application) else { return }
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
  // Electron and other Chromium shells build the accessibility tree of their
  // web content only once an assistive technology asks for it; until then a
  // window is a frame and three buttons. Claude's was recorded as five nodes
  // and no text, so every summary of it said nothing. Asking is what screen
  // readers do: the tree follows within a second or two, and an application
  // that is not Electron ignores the attribute.
  AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
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
  focusedElementGeneration &+= 1
  axStateLock.unlock()

  refreshFocusedElement(pid: pid)
}

// MARK: - Event tap
//
// The tap captures the interaction without waiting for AX enrichment. Mouse
// positions identify the clicked controls through hit tests and are never
// emitted; keyboard events use the focused element.

let eventMask = (1 << CGEventType.leftMouseDown.rawValue)
  | (1 << CGEventType.leftMouseUp.rawValue)
  | (1 << CGEventType.rightMouseDown.rawValue)
  | (1 << CGEventType.keyDown.rawValue)

var eventTap: CFMachPort?
// Read and written only on enrichmentQueue, in the order tap events arrive.
var dragOrigin: (point: CGPoint, target: [String: Any])?

// Mouse targets come from the event position. A previously focused editor can
// remain focused while a button or another non-focusable control is clicked.
func resolveTarget(at point: CGPoint) -> [String: Any] {
  if let hit = accessibilityHit(at: point), hitHasSemantics(hit.payload) {
    return hit.payload
  }
  return [:]
}

func modifierList(_ event: CGEvent) -> [String] {
  modifierNames(event.flags)
}

let callback: CGEventTapCallBack = { _, type, event, _ in
  // WeChat has a separate message-source consent flow. Do not enrich its
  // keyboard or pointer events through the general screen recorder.
  if isSeparatelyAuthorizedSource(applicationPayload()) { return Unmanaged.passUnretained(event) }
  switch type {
  case .leftMouseDown, .rightMouseDown:
    guard !excludesUnconsentedWeChat(applicationPayload()) else { break }
    let point = event.location
    let clickCount = event.getIntegerValueField(.mouseEventClickState)
    let button = type == .rightMouseDown ? "right" : "left"
    let modifiers = modifierList(event)
    let application = applicationPayload()
    enrichmentQueue.async {
      guard !excludesUnconsentedWeChat(application) else { return }
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
    guard !excludesUnconsentedWeChat(applicationPayload()) else { break }
    let point = event.location
    let application = applicationPayload()
    enrichmentQueue.async {
      guard !excludesUnconsentedWeChat(application) else { return }
      guard let origin = dragOrigin else { return }
      dragOrigin = nil
      let dx = point.x - origin.point.x
      let dy = point.y - origin.point.y
      // Anything under a few points is a click that wobbled, not a drag.
      guard (dx * dx + dy * dy) > 25 else { return }
      var destination = resolveTarget(at: point)
      if destination.isEmpty { destination = ["role": "AXUnknown"] }
      emitEvent(
        kind: "mouse.drag",
        application: application,
        extra: ["mouse": ["origin": ["element": origin.target], "destination": ["element": destination]]]
      )
    }
  case .keyDown:
    guard !excludesUnconsentedWeChat(applicationPayload()) else { break }
    let keyCode = Int(event.getIntegerValueField(.keyboardEventKeycode))
    let text = characters(from: event)
    let modifiers = modifierList(event)
    let application = applicationPayload()
    let secure = secureInputActive()
    let focus = captureFocusSnapshot()
    enrichmentQueue.async {
      guard !excludesUnconsentedWeChat(application) else { return }
      let target = keyboardTarget(snapshot: focus, pid: application["pid"] as? pid_t)
      guard let classified = classifiedKeyboard(keyCode: keyCode, text: text, modifiers: modifiers, secure: secure),
            let kind = classified["kind"] as? String,
            var keyboard = classified["keyboard"] as? [String: Any]
      else { return }
      keyboard["target"] = target
      emitEvent(kind: kind, application: application, extra: ["keyboard": keyboard])
    }
  case .tapDisabledByTimeout, .tapDisabledByUserInput:
    if let eventTap { CGEvent.tapEnable(tap: eventTap, enable: true) }
  default:
    break
  }
  return Unmanaged.passUnretained(event)
}

// MARK: - Entry point
// The standalone entry point is main.swift; the installed app uses the
// lifecycle functions below from its own process.

var historyRunLoopSource: CFRunLoopSource?
var historyWorkspaceObserver: NSObjectProtocol?

public func startHistoryRecorder(output: @escaping (String) -> Void) throws {
  guard eventTap == nil else { throw NSError(domain: "MemmyComputerHistory", code: 1,
    userInfo: [NSLocalizedDescriptionKey: "Computer History is already recording."]) }
  guard CGPreflightListenEventAccess() else {
    throw NSError(domain: "MemmyComputerHistory", code: 2,
      userInfo: [NSLocalizedDescriptionKey: "Input Monitoring permission is required for Memmy Computer Use."])
  }
  enrichmentQueue.setSpecific(key: enrichmentQueueKey, value: true)
  guard let tap = CGEvent.tapCreate(
    tap: .cgSessionEventTap,
    place: .headInsertEventTap,
    options: .listenOnly,
    eventsOfInterest: CGEventMask(eventMask),
    callback: callback,
    userInfo: nil
  ) else {
    throw NSError(domain: "MemmyComputerHistory", code: 2,
      userInfo: [NSLocalizedDescriptionKey: "Unable to create the event tap. Grant Input Monitoring to Memmy Computer Use and restart it."])
  }
  emitLock.lock()
  historySessionId &+= 1
  historyEventSink = output
  emitLock.unlock()
  eventTap = tap
  historyWorkspaceObserver = NSWorkspace.shared.notificationCenter.addObserver(
    forName: NSWorkspace.didActivateApplicationNotification,
    object: nil,
    queue: .main
  ) { notification in
    let application = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
    let payload = applicationPayload(application)
    if !isSeparatelyAuthorizedSource(payload), let pid = payload["pid"] as? pid_t { observeApplication(pid: pid) }
    emitEvent(kind: "window.changed", application: payload, extra: [:])
  }
  let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
  historyRunLoopSource = source
  CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
  CGEvent.tapEnable(tap: tap, enable: true)
  if !isSeparatelyAuthorizedSource(applicationPayload()), let pid = applicationPayload()["pid"] as? pid_t {
    observeApplication(pid: pid)
  }
  emitEvent(kind: "session.started", extra: [:])
}

public func stopHistoryRecorder() {
  guard let tap = eventTap else { return }
  CGEvent.tapEnable(tap: tap, enable: false)
  if let source = historyRunLoopSource {
    CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes)
    historyRunLoopSource = nil
  }
  if let observer = historyWorkspaceObserver {
    NSWorkspace.shared.notificationCenter.removeObserver(observer)
    historyWorkspaceObserver = nil
  }
  if let observer = observedObserver {
    CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode)
  }
  emitLock.lock()
  historyEventSink = nil
  historySessionId &+= 1
  emitLock.unlock()
  eventTap = nil
  dragOrigin = nil
  axStateLock.lock()
  focusedElementCache = nil
  observedPid = nil
  observedObserver = nil
  axStateLock.unlock()
}
