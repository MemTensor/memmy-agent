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

// Diagnostics never carry an app, title, URL, text, or a window identity.
// Count repeated failures rather than flooding a private/unsupported window.
let diagnosticLock = NSLock()
var diagnosticLastAt: [String: Date] = [:]
var diagnosticCounts: [String: Int] = [:]
let diagnosticQueue = DispatchQueue(label: "human-recorder.diagnostics")
var pendingDiagnostics: [String: (payload: [String: Any], session: UInt64)] = [:]
var pendingDiagnosticOrder: [String] = []
var diagnosticDraining = false
let historyWorkSessionKey = "MemmyHistoryWorkSession"
let historyAXDeadlineKey = "MemmyHistoryAXDeadline"
let historyAXExceededKey = "MemmyHistoryAXExceeded"

func recorderSession() -> UInt64 {
  emitLock.lock(); defer { emitLock.unlock() }
  return historySessionId
}

func queueRecorderDiagnostic(_ payload: [String: Any], session: UInt64) {
  guard let code = payload["code"] as? String else { return }
  diagnosticLock.lock()
  var newest = payload
  if let previous = pendingDiagnostics[code], previous.session == session {
    if let count = previous.payload["count"] as? Int {
      newest["count"] = count + (newest["count"] as? Int ?? 0)
    }
  }
  if pendingDiagnostics[code] == nil { pendingDiagnosticOrder.append(code) }
  pendingDiagnostics[code] = (newest, session)
  let start = !diagnosticDraining
  diagnosticDraining = true
  diagnosticLock.unlock()
  if start {
    diagnosticQueue.async {
      while true {
        diagnosticLock.lock()
        guard !pendingDiagnosticOrder.isEmpty else {
          diagnosticDraining = false; diagnosticLock.unlock(); return
        }
        let key = pendingDiagnosticOrder.removeFirst()
        let item = pendingDiagnostics.removeValue(forKey: key)
        diagnosticLock.unlock()
        if let item { emit(item.payload, expectedSession: item.session) }
      }
    }
  }
}

func emitRecorderDiagnostic(code: String, count: Int? = nil, minimumInterval: TimeInterval = 10) {
  let expected = (Thread.current.threadDictionary[historyWorkSessionKey] as? NSNumber)?.uint64Value
  if let expected, expected != recorderSession() { return }
  let now = Date()
  diagnosticLock.lock()
  if let count { diagnosticCounts[code, default: 0] += count }
  if let last = diagnosticLastAt[code], now.timeIntervalSince(last) < minimumInterval {
    diagnosticLock.unlock(); return
  }
  let accumulated = diagnosticCounts.removeValue(forKey: code)
  diagnosticLastAt[code] = now
  diagnosticLock.unlock()
  var payload: [String: Any] = ["type": "recorder.diagnostic", "timestamp": timestamp(), "code": code]
  if let accumulated { payload["count"] = accumulated }
  let session = expected ?? recorderSession()
  // A stalled output sink must not stall the input tap's overflow path. Only
  // one pending content-free payload per diagnostic code is retained.
  queueRecorderDiagnostic(payload, session: session)
}

// AX calls have an individual timeout, but a tree of individually slow calls
// also needs a total budget. This thread-local deadline nests without widening
// the event's budget and applies only to recorder enrichment, never the desktop.
func withAXReadBudget<T>(_ seconds: TimeInterval, _ work: () -> T) -> T {
  let state = Thread.current.threadDictionary
  let previous = state[historyAXDeadlineKey] as? Date
  let deadline = Date().addingTimeInterval(seconds)
  state[historyAXDeadlineKey] = previous.map { min($0, deadline) } ?? deadline
  let result = work()
  if let previous { state[historyAXDeadlineKey] = previous }
  else {
    state.removeObject(forKey: historyAXDeadlineKey)
    if state[historyAXExceededKey] as? Bool == true {
      emitRecorderDiagnostic(code: "ax_snapshot_budget_exceeded", count: 1)
    }
    state.removeObject(forKey: historyAXExceededKey)
  }
  return result
}

func prepareAXQuery(_ element: AXUIElement, timeout: TimeInterval = 0.05) -> Bool {
  guard let deadline = Thread.current.threadDictionary[historyAXDeadlineKey] as? Date else { return true }
  let remaining = deadline.timeIntervalSinceNow
  guard remaining > 0 else {
    Thread.current.threadDictionary[historyAXExceededKey] = true
    return false
  }
  AXUIElementSetMessagingTimeout(element, Float(min(timeout, remaining)))
  return true
}

func copyAXAttribute(_ element: AXUIElement, _ attribute: CFString, _ value: inout CFTypeRef?) -> AXError {
  guard prepareAXQuery(element) else { return .cannotComplete }
  return AXUIElementCopyAttributeValue(element, attribute, &value)
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

func accessibilityString(_ element: AXUIElement, _ attribute: CFString, maxCharacters: Int = 240) -> String? {
  var value: CFTypeRef?
  guard copyAXAttribute(element, attribute, &value) == .success else { return nil }
  guard let string = value as? String else { return nil }
  let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty else { return nil }
  return String(trimmed.prefix(maxCharacters))
}

func accessibilityValueString(_ element: AXUIElement) -> String? {
  var value: CFTypeRef?
  guard copyAXAttribute(element, kAXValueAttribute as CFString, &value) == .success,
        let value
  else { return nil }
  if let string = value as? String {
    let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    // Match the bounded Windows UIA field capture rather than discarding a
    // normal paragraph at 240 characters before it reaches raw History.
    return String(trimmed.prefix(1000))
  }
  if let number = value as? NSNumber { return number.stringValue }
  return nil
}

func nodePayload(_ element: AXUIElement) -> [String: Any] {
  AXUIElementSetMessagingTimeout(element, 0.2)
  var payload: [String: Any] = [:]
  if let role = accessibilityString(element, kAXRoleAttribute as CFString) { payload["role"] = role }
  if let subrole = accessibilityString(element, kAXSubroleAttribute as CFString) { payload["subrole"] = subrole }
  // Do not query any user-visible field of a password control. A provider may
  // place its contents in Title or Description rather than Value.
  if payload["role"] as? String != "AXSecureTextField",
     payload["subrole"] as? String != "AXSecureTextField" {
    if let title = accessibilityString(element, kAXTitleAttribute as CFString) { payload["title"] = title }
    if let description = accessibilityString(element, kAXDescriptionAttribute as CFString) { payload["description"] = description }
    if let identifier = accessibilityString(element, kAXIdentifierAttribute as CFString) { payload["identifier"] = identifier }
    if let value = accessibilityValueString(element) { payload["value"] = value }
  }
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
    guard copyAXAttribute(current, kAXParentAttribute as CFString, &parentRef) == .success,
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
    guard copyAXAttribute(current, kAXChildrenAttribute as CFString, &childrenRef) == .success,
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

func elementBelongsToWindow(_ element: AXUIElement, window: AXUIElement, pid: pid_t) -> Bool {
  var ownerPid: pid_t = 0
  guard AXUIElementGetPid(element, &ownerPid) == .success, ownerPid == pid else { return false }
  if CFEqual(element, window) { return true }
  var windowRef: CFTypeRef?
  if copyAXAttribute(element, kAXWindowAttribute as CFString, &windowRef) == .success,
     let ownerWindow = axElement(windowRef) { return CFEqual(ownerWindow, window) }
  // Some native controls omit AXWindow. Walk only ownership, without reading
  // labels from a different window or application's hierarchy.
  var current = element
  for _ in 0..<12 {
    var parentRef: CFTypeRef?
    guard copyAXAttribute(current, kAXParentAttribute as CFString, &parentRef) == .success,
          let parent = axElement(parentRef) else { return false }
    if CFEqual(parent, window) { return true }
    if accessibilityString(parent, kAXRoleAttribute as CFString) == "AXWindow" { return false }
    current = parent
  }
  return false
}

func accessibilityHit(at point: CGPoint, expectedPid: pid_t, expectedWindow: AXUIElement) -> (payload: [String: Any], pid: pid_t?)? {
  let system = AXUIElementCreateSystemWide()
  AXUIElementSetMessagingTimeout(system, 0.25)
  var elementRef: AXUIElement?
  guard prepareAXQuery(system, timeout: 0.25),
        AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &elementRef) == .success,
        let element = elementRef
  else { return nil }
  var pid: pid_t = 0
  // A click that activates another app (or a minimized private window in the
  // Dock) must not attach that target's labels to the old foreground app.
  guard AXUIElementGetPid(element, &pid) == .success, pid == expectedPid,
        accessibilityString(element, kAXRoleAttribute as CFString) != "AXDockItem",
        accessibilityString(element, kAXSubroleAttribute as CFString) != "AXMinimizedWindowDockItem",
        elementBelongsToWindow(element, window: expectedWindow, pid: expectedPid)
  else { return nil }
  var payload = nodePayload(element)
  if payload["role"] as? String == "AXSecureTextField" || payload["subrole"] as? String == "AXSecureTextField" {
    return (payload, pid)
  }
  if !hasSemanticLabel(payload) {
    let descendants = labeledDescendants(of: element, limit: 2, maxNodes: 24)
    if !descendants.isEmpty { payload["descendants"] = descendants }
  }
  let ancestors = labeledAncestors(of: element, limit: 2, maxDepth: 8)
  if !ancestors.isEmpty { payload["ancestors"] = ancestors }
  return (payload, pid)
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
  guard copyAXAttribute(app, kAXFocusedUIElementAttribute as CFString, &ref) == .success,
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
  if copyAXAttribute(element, kAXURLAttribute as CFString, &urlRef) == .success {
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
    if copyAXAttribute(current, kAXChildrenAttribute as CFString, &childrenRef) == .success,
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
  guard copyAXAttribute(window, kAXChildrenAttribute as CFString, &childrenRef) == .success,
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
var focusedNotificationsAvailable = false
let enrichmentQueue = DispatchQueue(label: "human-recorder.enrichment")
let enrichmentQueueKey = DispatchSpecificKey<Bool>()

// MARK: - Bounded enrichment scheduling

final class HistoryEnrichmentScheduler {
  private struct Work { let key: String?; let run: () -> Void }
  private let lock = NSLock()
  private let queue: DispatchQueue
  private let limit: Int
  private let overflow: () -> Void
  private var pending: [Work] = []
  private var draining = false

  init(queue: DispatchQueue, limit: Int = 64, overflow: @escaping () -> Void) {
    self.queue = queue; self.limit = limit; self.overflow = overflow
  }

  func enqueue(key: String? = nil, _ run: @escaping () -> Void) {
    lock.lock()
    // Replace a queued sampling job with its newest state. Input jobs have no
    // key and preserve their order, including mouse-down/up drag endpoints.
    if let key, let index = pending.firstIndex(where: { $0.key == key }) {
      pending[index] = Work(key: key, run: run)
      lock.unlock(); return
    }
    var dropped = false
    if pending.count >= limit {
      if key == nil, let sampled = pending.firstIndex(where: { $0.key != nil }) {
        pending.remove(at: sampled); dropped = true
      } else {
        lock.unlock(); overflow(); return
      }
    }
    pending.append(Work(key: key, run: run))
    let start = !draining
    draining = true
    lock.unlock()
    if dropped { overflow() }
    if start { queue.async { self.drain() } }
  }

  func cancelPending() {
    lock.lock(); pending.removeAll(); lock.unlock()
  }

  private func drain() {
    while true {
      lock.lock()
      guard !pending.isEmpty else { draining = false; lock.unlock(); return }
      let work = pending.removeFirst()
      lock.unlock()
      work.run()
    }
  }
}

let enrichmentScheduler = HistoryEnrichmentScheduler(queue: enrichmentQueue) {
  emitRecorderDiagnostic(code: "enrichment_backlog", count: 1)
}
var enrichmentStateSession: UInt64?

func enqueueEnrichment(key: String? = nil, _ capture: @escaping () -> Void) {
  let session = recorderSession()
  enrichmentScheduler.enqueue(key: key) {
    guard recorderSession() == session else { return }
    if enrichmentStateSession != session {
      dragOrigin = nil; resetAXSamplingCache()
      enrichmentStateSession = session
    }
    let state = Thread.current.threadDictionary
    state[historyWorkSessionKey] = NSNumber(value: session)
    defer { state.removeObject(forKey: historyWorkSessionKey) }
    withAXReadBudget(1) { capture() }
  }
}

// MARK: - Browser privacy evidence
// These caches and the AX sampling clock are owned by enrichmentQueue.
// A title marker can prove privacy, but an ordinary page title cannot prove
// normal mode. Use native browser chrome only; never inspect page content or
// bookmark names for privacy markers, or request Apple Events permission.
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
  guard pageDetected || browserBundleIds.contains(bundleId) else { return false }
  if let title = accessibilityString(window, kAXTitleAttribute as CFString),
     privateWindowTitleMarkers.contains(where: { title.lowercased().contains($0.lowercased()) }) { return true }

  let chromiumProfileBrowsers: Set<String> = [
    "com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.dev",
    "com.google.Chrome.canary", "org.chromium.Chromium",
  ]
  let privateControlNames = ["incognito", "inprivate", "无痕", "无痕模式", "无痕浏览", "隐私浏览", "私密浏览", "private browsing", "シークレット", "シークレット モード"]
  let addressNames: Set<String> = ["地址和搜索栏", "address and search bar", "網址和搜尋列", "地址與搜尋列"]
  let excludedRoles: Set<String> = ["AXWebArea", "AXList", "AXOutline", "AXTable", "AXMenu", "AXRadioButton"]
  var queue: [(AXUIElement, Int, AXUIElement?)] = [(window, 0, nil)]
  var visited = 0
  // Attribute observations are grouped by the actual AXToolbar identity. A
  // bookmark named You cannot authorize its window because its toolbar has
  // no browser address/search control. Never infer provenance from its name.
  var toolbars: [AXUIElement] = []
  var toolbarAddress: [Bool] = []
  var toolbarNormal: [Bool] = []
  var toolbarPrivate: [Bool] = []
  var toolbarComplete: [Bool] = []
  let deadline = Date().addingTimeInterval(0.15)
  while !queue.isEmpty && visited < 120 && Date() < deadline {
    let (current, queuedDepth, enclosingToolbar) = queue.removeFirst()
    var depth = queuedDepth
    visited += 1
    AXUIElementSetMessagingTimeout(current, 0.03)
    guard let role = accessibilityString(current, kAXRoleAttribute as CFString) else {
      if let toolbar = enclosingToolbar,
         let index = toolbars.firstIndex(where: { CFEqual($0, toolbar) }) { toolbarComplete[index] = false }
      continue
    }
    // Website controls, page/user lists and tab labels are never mode evidence.
    if excludedRoles.contains(role) { continue }
    var toolbar = enclosingToolbar
    if role == "AXToolbar" {
      toolbar = current
      toolbars.append(current)
      toolbarAddress.append(false); toolbarNormal.append(false); toolbarPrivate.append(false)
      toolbarComplete.append(true)
      // Completeness belongs to this native toolbar, independently of the
      // window's page, bookmarks, or other chrome branches.
      depth = 0
    }
    if let toolbar, let index = toolbars.firstIndex(where: { CFEqual($0, toolbar) }) {
      // Structural nodes need no labels. Avoid spending the small native AX
      // budget on unrelated groups before the address/profile controls.
      let labels = ["AXTextField", "AXComboBox", "AXButton"].contains(role)
        ? [kAXTitleAttribute, kAXDescriptionAttribute].compactMap {
            accessibilityString(current, $0 as CFString)?.lowercased()
          } : []
      if ["AXTextField", "AXComboBox"].contains(role),
         labels.contains(where: { addressNames.contains($0) }) { toolbarAddress[index] = true }
      if role == "AXButton" {
        if labels.contains(where: { label in privateControlNames.contains(where: { marker in
          label == marker || label.hasPrefix(marker + " (") || label.hasPrefix(marker + "（")
        }) }) { toolbarPrivate[index] = true }
        // Only verified Chrome native profile labels are positive normal-mode
        // evidence. Named/custom profiles remain unknown rather than guessing.
        if chromiumProfileBrowsers.contains(bundleId), labels.contains(where: { $0 == "您" || $0 == "you" }) {
          toolbarNormal[index] = true
        }
      }
    }
    var childrenRef: CFTypeRef?
    let result = copyAXAttribute(current, kAXChildrenAttribute as CFString, &childrenRef)
    if result == .attributeUnsupported || result == .noValue { continue }
    guard result == .success, let children = childrenRef as? [AXUIElement] else {
      if let toolbar, let index = toolbars.firstIndex(where: { CFEqual($0, toolbar) }) { toolbarComplete[index] = false }
      continue
    }
    if depth >= 6 {
      if !children.isEmpty, let toolbar,
         let index = toolbars.firstIndex(where: { CFEqual($0, toolbar) }) { toolbarComplete[index] = false }
      continue
    }
    if children.count > 24, let toolbar,
       let index = toolbars.firstIndex(where: { CFEqual($0, toolbar) }) { toolbarComplete[index] = false }
    let next = children.prefix(24).map { ($0, depth + 1, toolbar) }
    // Finish the actual toolbar before visiting another window branch. A
    // slow unrelated AX node cannot invalidate an already verified toolbar.
    if toolbar != nil { queue.insert(contentsOf: next, at: 0) }
    else { queue.append(contentsOf: next) }
  }
  // A deadline/node limit during this toolbar's scan still fails closed.
  for (_, _, toolbar) in queue {
    if let toolbar, let index = toolbars.firstIndex(where: { CFEqual($0, toolbar) }) { toolbarComplete[index] = false }
  }
  for index in toolbars.indices where toolbarAddress[index] && toolbarPrivate[index] { return true }
  // SafariWindow?IsSecure alone does not establish browsing mode. Safari and
  // unsupported/custom-profile windows stay unknown until a normal-mode
  // signal can be verified. An incomplete candidate-toolbar scan cannot
  // authorize normal capture.
  let normalProfile = toolbars.indices.contains {
    toolbarAddress[$0] && toolbarNormal[$0] && toolbarComplete[$0]
  }
  return normalProfile ? false : nil
}

struct FocusSnapshot {
  let element: AXUIElement?
  let pid: pid_t?
  let generation: UInt64
}

func captureFocusSnapshot() -> FocusSnapshot {
  axStateLock.lock(); defer { axStateLock.unlock() }
  return FocusSnapshot(element: focusedNotificationsAvailable ? focusedElementCache : nil,
    pid: observedPid, generation: focusedElementGeneration)
}

func focusSnapshotIsCurrent(_ snapshot: FocusSnapshot, pid: pid_t?) -> Bool {
  axStateLock.lock(); defer { axStateLock.unlock() }
  return focusedNotificationsAvailable && pid != nil && snapshot.pid == pid && observedPid == pid
    && snapshot.generation == focusedElementGeneration && snapshot.element != nil
}

func keyboardTarget(snapshot: FocusSnapshot, pid: pid_t?, window: AXUIElement? = nil) -> [String: Any] {
  guard focusSnapshotIsCurrent(snapshot, pid: pid), let element = snapshot.element else {
    return ["role": "AXUnknown"]
  }
  if let window, let pid, !elementBelongsToWindow(element, window: window, pid: pid) { return ["role": "AXUnknown"] }
  let target = nodePayload(element)
  // AX calls may yield while focus changes. Never attach the old field's
  // labels/value after that happens, even if they look like a search field.
  guard focusSnapshotIsCurrent(snapshot, pid: pid), !target.isEmpty else {
    return ["role": "AXUnknown"]
  }
  if let window, let pid, !elementBelongsToWindow(element, window: window, pid: pid) { return ["role": "AXUnknown"] }
  return target
}

func applicationEnvelope(_ application: [String: Any]? = nil) -> [String: Any] {
  let source = application ?? applicationPayload()
  var payload: [String: Any] = ["secureInput": secureInputActive()]
  if let name = source["name"] { payload["name"] = name }
  if let bundleId = source["bundleId"] { payload["bundleIdentifier"] = bundleId }
  return payload
}

func emitEvent(kind: String, application: [String: Any]? = nil, expectedWindow: AXUIElement? = nil, expectedUrl: String? = nil, extra: [String: Any]) {
  emitLock.lock()
  let session = (Thread.current.threadDictionary[historyWorkSessionKey] as? NSNumber)?.uint64Value ?? historySessionId
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
    guard window["privateBrowsing"] as? Bool != true,
          window["privateBrowsingUnknown"] as? Bool != true else {
      if window["privateBrowsingUnknown"] as? Bool == true { emitRecorderDiagnostic(code: "privacy_unknown", count: 1) }
      resetAXSamplingCache()
      return
    }
    if let expectedWindow {
      guard let actualWindow = context.element, CFEqual(expectedWindow, actualWindow),
            window["url"] as? String == expectedUrl else { return }
    }
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
      if let ax = axSnapshot(window: element, windowKey: windowKey, deduplicate: kind == "sampling.changed") {
        // Navigation during tree traversal must not attach the new page's
        // contents to a previously allowed URL.
        if browserBundleIds.contains(bundleId),
           browserPage(window: element).url != window["url"] as? String {
          resetAXSamplingCache()
          return
        }
        payload["ax"] = ax
      }
    }
    for (key, value) in extra { payload[key] = value }
    // AX reads can yield while another window of the same browser becomes
    // active, or its privacy evidence changes. PID/URL alone are insufficient.
    let latest = currentWindow(pid: pid, bundleId: bundleId)
    let sameWindow: Bool
    if let originalWindow = context.element, let latestWindow = latest.element {
      sameWindow = CFEqual(originalWindow, latestWindow)
    } else { sameWindow = context.element == nil && latest.element == nil }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
          sameWindow, latest.payload["url"] as? String == window["url"] as? String,
          latest.payload["privateBrowsing"] as? Bool != true,
          latest.payload["privateBrowsingUnknown"] as? Bool != true else {
      resetAXSamplingCache()
      return
    }
    emit(payload, expectedSession: session)
  }
  if DispatchQueue.getSpecific(key: enrichmentQueueKey) == true { capture() }
  else {
    let sampling = ["accessibility.changed", "window.changed", "sampling.changed"].contains(kind)
    enqueueEnrichment(key: sampling ? "window-snapshot" : nil, capture)
  }
}

func currentWindow(pid: pid_t, bundleId: String) -> (payload: [String: Any], element: AXUIElement?) {
  let app = AXUIElementCreateApplication(pid)
  AXUIElementSetMessagingTimeout(app, 0.2)
  var windowRef: CFTypeRef?
  let knownBrowser = browserBundleIds.contains(bundleId)
  if copyAXAttribute(app, kAXFocusedWindowAttribute as CFString, &windowRef) != .success {
    // A browser's main window may be a different, normal window while its
    // private window is foreground. Missing focus cannot authorize that fallback.
    if knownBrowser {
      resetAXSamplingCache(); emitRecorderDiagnostic(code: "privacy_unknown", count: 1)
      return (["browser": true, "privateBrowsingUnknown": true], nil)
    }
    _ = copyAXAttribute(app, kAXMainWindowAttribute as CFString, &windowRef)
  }
  var payload: [String: Any] = [:]
  if knownBrowser { payload["browser"] = true }
  guard let window = axElement(windowRef) else {
    if knownBrowser {
      payload["privateBrowsingUnknown"] = true
      resetAXSamplingCache(); emitRecorderDiagnostic(code: "privacy_unknown", count: 1)
    }
    return (payload, nil)
  }
  if let title = accessibilityString(window, kAXTitleAttribute as CFString) { payload["title"] = title }
  let pageUrl = knownBrowser ? browserPage(window: window).url : quickPageUrl(window)
  if let pageUrl {
    payload["browser"] = true
    payload["url"] = pageUrl
  }
  let treatsAsBrowser = knownBrowser || pageUrl != nil
  if treatsAsBrowser {
    // The same AX window may change mode or expose controls only after load.
    // Revalidate each event; never retain an earlier false classification.
    if let isPrivate = frontWindowIsPrivate(window: window, bundleId: bundleId, pageDetected: pageUrl != nil) {
      if isPrivate { payload["privateBrowsing"] = true; resetAXSamplingCache() }
    } else {
      payload["privateBrowsingUnknown"] = true
      resetAXSamplingCache(); emitRecorderDiagnostic(code: "privacy_unknown", count: 1)
    }
  }
  return (payload, window)
}

func refreshFocusedElement(pid: pid_t) {
  let app = AXUIElementCreateApplication(pid)
  AXUIElementSetMessagingTimeout(app, 0.2)
  var ref: CFTypeRef?
  let result = copyAXAttribute(app, kAXFocusedUIElementAttribute as CFString, &ref)
  let element = result == .success ? axElement(ref) : nil
  axStateLock.lock()
  guard observedPid == pid else { axStateLock.unlock(); return }
  let allowedElement = focusedNotificationsAvailable ? element : nil
  let same: Bool
  if let before = focusedElementCache, let after = allowedElement { same = CFEqual(before, after) }
  else { same = focusedElementCache == nil && allowedElement == nil }
  if !same {
    focusedElementCache = allowedElement
    focusedElementGeneration &+= 1
  }
  axStateLock.unlock()
}

// Selected text is the single highest-volume semantic signal: it reports what
// the user is actually reading or editing without any coordinate involved.
func emitSelectionChanged(_ element: AXUIElement) {
  let application = applicationPayload()
  enqueueEnrichment {
    guard !secureInputActive(), !excludesUnconsentedWeChat(application),
          let pid = application["pid"] as? pid_t,
          NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
    else { return }
    let context = currentWindow(pid: pid, bundleId: application["bundleId"] as? String ?? "")
    guard let window = context.element,
          context.payload["privateBrowsing"] as? Bool != true,
          context.payload["privateBrowsingUnknown"] as? Bool != true,
          elementBelongsToWindow(element, window: window, pid: pid),
          accessibilityString(element, kAXRoleAttribute as CFString) != "AXSecureTextField",
          accessibilityString(element, kAXSubroleAttribute as CFString) != "AXSecureTextField"
    else { return }
    var target = nodePayload(element)
    var selection: [String: Any] = [:]
    if let text = accessibilityString(element, kAXSelectedTextAttribute as CFString, maxCharacters: 2000) {
      selection["selectedText"] = text
    }
    var rangeRef: CFTypeRef?
    if copyAXAttribute(element, kAXSelectedTextRangeAttribute as CFString, &rangeRef) == .success,
       let value = rangeRef, CFGetTypeID(value) == AXValueGetTypeID() {
      var range = CFRange(location: 0, length: 0)
      if AXValueGetValue(value as! AXValue, .cfRange, &range) {
        selection["selectedRange"] = ["location": range.location, "length": range.length]
      }
    }
    // Ownership can change during AX reads. Do not emit a stale background
    // window's selection under the newly focused app/window's permission.
    let latest = currentWindow(pid: pid, bundleId: application["bundleId"] as? String ?? "")
    guard !selection.isEmpty, !secureInputActive(),
          NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
          let latestWindow = latest.element, CFEqual(window, latestWindow),
          latest.payload["privateBrowsing"] as? Bool != true,
          latest.payload["privateBrowsingUnknown"] as? Bool != true,
          elementBelongsToWindow(element, window: latestWindow, pid: pid)
    else { return }
    if target.isEmpty { target = ["role": "AXUnknown"] }
    selection["target"] = target
    guard latest.payload["url"] as? String == context.payload["url"] as? String else { return }
    emitEvent(kind: "selection.changed", application: application, expectedWindow: window,
      expectedUrl: context.payload["url"] as? String, extra: ["selection": selection])
  }
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
var lastTreeFingerprint: Int?
var lastTreeDeliveredAt: Date?

func resetAXSamplingCache() {
  lastTreeKey = nil; lastTreeAt = nil; lastTreeFingerprint = nil; lastTreeDeliveredAt = nil
}

func treeLine(_ payload: [String: Any]) -> String? {
  let role = payload["role"] as? String ?? ""
  guard role != "AXDockItem", payload["subrole"] as? String != "AXMinimizedWindowDockItem" else { return nil }
  let fields = ["subrole", "title", "description", "identifier", "value"]
    .map { payload[$0] as? String ?? "" }
  guard !role.isEmpty, fields.contains(where: { !$0.isEmpty }) else { return nil }
  return ([role] + fields).joined(separator: "|")
}

func axTreeLines(window: AXUIElement) -> [String] {
  withAXReadBudget(0.25) {
    var lines: [String] = []
    var queue: [AXUIElement] = [window]
    var visited = 0
    var truncated = false
    while !queue.isEmpty && visited < AX_TREE_MAX_NODES {
      let current = queue.removeFirst()
      guard prepareAXQuery(current) else { truncated = true; break }
      visited += 1
      let payload = nodePayload(current)
      if let line = treeLine(payload) { lines.append(line) }
      if payload["role"] as? String == "AXSecureTextField" || payload["subrole"] as? String == "AXSecureTextField" {
        continue
      }
      var childrenRef: CFTypeRef?
      if copyAXAttribute(current, kAXChildrenAttribute as CFString, &childrenRef) == .success,
         let children = childrenRef as? [AXUIElement] {
        if children.count > 24 { truncated = true }
        queue.append(contentsOf: children.prefix(24))
      }
    }
    if !queue.isEmpty { truncated = true }
    if truncated { emitRecorderDiagnostic(code: "ax_snapshot_budget_exceeded", count: 1) }
    return lines
  }
}

// Returns nil when the snapshot was taken recently enough that recomputing it
// would cost more than the freshness is worth.
func axSnapshot(window: AXUIElement, windowKey: String, deduplicate: Bool = false) -> [String: Any]? {
  let now = Date()
  if windowKey == lastTreeKey, let lastTreeAt,
     now.timeIntervalSince(lastTreeAt) < AX_TREE_MIN_INTERVAL { return nil }

  let lines = axTreeLines(window: window)
  guard !lines.isEmpty else { return nil }
  var fingerprint = Hasher()
  for line in lines { fingerprint.combine(line) }
  let currentFingerprint = fingerprint.finalize()
  // The native helper cannot see dynamic App/URL policy changes. Refresh a
  // full sample occasionally so the policy owner can rebuild an authorized
  // baseline after exclusion; it already suppresses unchanged disk records.
  if deduplicate, windowKey == lastTreeKey, currentFingerprint == lastTreeFingerprint,
     let delivered = lastTreeDeliveredAt, now.timeIntervalSince(delivered) < 30 {
    lastTreeAt = now
    return nil
  }
  lastTreeKey = windowKey
  lastTreeAt = now
  lastTreeFingerprint = currentFingerprint
  lastTreeDeliveredAt = now
  return ["mode": "fullTree", "windowKey": windowKey, "text": lines.joined(separator: "\n")]
}

let axObserverCallback: AXObserverCallback = { _, element, notification, _ in
  guard !excludesUnconsentedWeChat(applicationPayload()) else { return }
  let name = notification as String
  switch name {
  case kAXFocusedUIElementChangedNotification:
    var pid: pid_t = 0
    guard AXUIElementGetPid(element, &pid) == .success,
          NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { break }
    axStateLock.lock()
    guard observedPid == pid, focusedNotificationsAvailable else { axStateLock.unlock(); break }
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
    guard focus.pid == pid, let focused = focus.element, CFEqual(focused, element)
    else { break }
    enqueueEnrichment(key: "focused-value") {
      guard !secureInputActive(), NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
            focusSnapshotIsCurrent(focus, pid: pid),
            accessibilityString(element, kAXRoleAttribute as CFString) != "AXSecureTextField",
            accessibilityString(element, kAXSubroleAttribute as CFString) != "AXSecureTextField" else { return }
      emitEvent(kind: "accessibility.changed", extra: [:])
    }
  case kAXFocusedWindowChangedNotification, kAXWindowMovedNotification:
    var pid: pid_t = 0
    guard AXUIElementGetPid(element, &pid) == .success,
          NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { break }
    axStateLock.lock()
    if name == kAXFocusedWindowChangedNotification { focusedElementCache = nil }
    focusedElementGeneration &+= 1
    axStateLock.unlock()
    if name == kAXFocusedWindowChangedNotification {
      enqueueEnrichment(key: "focus-refresh") { refreshFocusedElement(pid: pid) }
    }
    emitEvent(kind: "window.changed", extra: [:])
  default:
    break
  }
}

let observedNotifications = [
  kAXFocusedUIElementChangedNotification, kAXSelectedTextChangedNotification,
  kAXValueChangedNotification, kAXFocusedWindowChangedNotification, kAXWindowMovedNotification,
]
var registeredObserverNotifications: Set<String> = []
var observerNotificationAttemptAt: [String: Date] = [:]
var observerNotificationFailures: [String: AXError] = [:]
var observerWasReady: Bool?

func registerObserverNotifications(_ observer: AXObserver, app: AXUIElement) {
  AXUIElementSetMessagingTimeout(app, 0.03)
  let now = Date()
  for notification in observedNotifications where !registeredObserverNotifications.contains(notification) {
    let retryInterval: TimeInterval = observerNotificationFailures[notification] == .notificationUnsupported ? 60 : 10
    if let last = observerNotificationAttemptAt[notification], now.timeIntervalSince(last) < retryInterval { continue }
    observerNotificationAttemptAt[notification] = now
    let result = AXObserverAddNotification(observer, app, notification as CFString, nil)
    if result == .success || result == .notificationAlreadyRegistered {
      registeredObserverNotifications.insert(notification)
      observerNotificationFailures.removeValue(forKey: notification)
    } else {
      observerNotificationFailures[notification] = result
    }
  }
  let ready = registeredObserverNotifications.count == observedNotifications.count
  axStateLock.lock()
  focusedNotificationsAvailable = registeredObserverNotifications.contains(kAXFocusedUIElementChangedNotification)
  if !focusedNotificationsAvailable, focusedElementCache != nil {
    focusedElementCache = nil; focusedElementGeneration &+= 1
  }
  axStateLock.unlock()
  if ready {
    if observerWasReady != true { emitRecorderDiagnostic(code: "observer_ready", minimumInterval: 0) }
  } else {
    emitRecorderDiagnostic(code: "observer_notifications_unavailable",
      count: observedNotifications.count - registeredObserverNotifications.count)
  }
  observerWasReady = ready
}

func observeApplication(pid: pid_t, refreshFocus: Bool = true) {
  let application = applicationPayload()
  guard !excludesUnconsentedWeChat(application),
        NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { return }
  axStateLock.lock()
  let alreadyObserved = observedPid == pid
  axStateLock.unlock()
  if alreadyObserved, let observer = observedObserver {
    registerObserverNotifications(observer, app: AXUIElementCreateApplication(pid))
    if refreshFocus {
      axStateLock.lock()
      focusedElementCache = nil; focusedElementGeneration &+= 1
      axStateLock.unlock()
    }
    enqueueEnrichment(key: "focus-refresh") { refreshFocusedElement(pid: pid) }
    return
  }

  var observer: AXObserver?
  guard AXObserverCreate(pid, axObserverCallback, &observer) == .success,
        let observer
  else {
    // Keep the old observer attached. Returning to its app must not skip an
    // observer whose source was removed by a failed switch to this app.
    axStateLock.lock()
    focusedElementCache = nil; focusedElementGeneration &+= 1
    axStateLock.unlock()
    observerWasReady = false
    emitRecorderDiagnostic(code: "observer_unavailable", count: 1)
    return
  }
  let app = AXUIElementCreateApplication(pid)
  AXUIElementSetMessagingTimeout(app, 0.03)
  // Electron and other Chromium shells build the accessibility tree of their
  // web content only once an assistive technology asks for it; until then a
  // window is a frame and three buttons. Claude's was recorded as five nodes
  // and no text, so every summary of it said nothing. Asking is what screen
  // readers do: the tree follows within a second or two, and an application
  // that is not Electron ignores the attribute.
  AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
  if let previous = observedObserver {
    CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(previous), .commonModes)
  }
  registeredObserverNotifications.removeAll()
  observerNotificationAttemptAt.removeAll(); observerNotificationFailures.removeAll()
  registerObserverNotifications(observer, app: app)
  CFRunLoopAddSource(
    CFRunLoopGetMain(),
    AXObserverGetRunLoopSource(observer),
    .commonModes
  )

  axStateLock.lock()
  observedPid = pid
  observedObserver = observer
  focusedElementCache = nil
  focusedElementGeneration &+= 1
  axStateLock.unlock()

  enqueueEnrichment(key: "focus-refresh") { refreshFocusedElement(pid: pid) }
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
  | (1 << CGEventType.scrollWheel.rawValue)

var eventTap: CFMachPort?
// Read and written only on enrichmentQueue, in the order tap events arrive.
var dragOrigin: (point: CGPoint, target: [String: Any], pid: pid_t, window: AXUIElement, url: String?)?

// Mouse targets come from the event position. A previously focused editor can
// remain focused while a button or another non-focusable control is clicked.
func resolveTarget(at point: CGPoint, pid: pid_t, window: AXUIElement) -> [String: Any] {
  if let hit = accessibilityHit(at: point, expectedPid: pid, expectedWindow: window),
     hit.pid == pid, hit.payload["role"] as? String != "AXDockItem",
     hit.payload["subrole"] as? String != "AXMinimizedWindowDockItem",
     hitHasSemantics(hit.payload) {
    return hit.payload
  }
  return [:]
}

func modifierList(_ event: CGEvent) -> [String] {
  modifierNames(event.flags)
}

let samplingLock = NSLock()
var lastScrollSampleAt: Date?

func requestScrollSample(application: [String: Any]) {
  let now = Date()
  samplingLock.lock()
  if let last = lastScrollSampleAt, now.timeIntervalSince(last) < 0.5 {
    samplingLock.unlock(); return
  }
  lastScrollSampleAt = now
  samplingLock.unlock()
  emitEvent(kind: "sampling.changed", application: application, extra: [:])
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
    enqueueEnrichment {
      guard !excludesUnconsentedWeChat(application),
            let pid = application["pid"] as? pid_t,
            NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { return }
      let context = currentWindow(pid: pid, bundleId: application["bundleId"] as? String ?? "")
      var target: [String: Any] = [:]
      if let window = context.element,
         context.payload["privateBrowsing"] as? Bool != true,
         context.payload["privateBrowsingUnknown"] as? Bool != true {
        target = resolveTarget(at: point, pid: pid, window: window)
        if type == .leftMouseDown { dragOrigin = (point, target, pid, window, context.payload["url"] as? String) }
      } else if type == .leftMouseDown { dragOrigin = nil }
      if target.isEmpty { target = ["role": "AXUnknown"] }
      var mouse: [String: Any] = ["button": button, "clickCount": clickCount, "target": target]
      if !modifiers.isEmpty { mouse["modifiers"] = modifiers }
      emitEvent(
        kind: type == .rightMouseDown ? "mouse.context_menu" : "mouse.click",
        application: application,
        expectedWindow: context.element,
        expectedUrl: context.payload["url"] as? String,
        extra: ["mouse": mouse]
      )
    }
  case .leftMouseUp:
    guard !excludesUnconsentedWeChat(applicationPayload()) else { break }
    let point = event.location
    let application = applicationPayload()
    enqueueEnrichment {
      guard !excludesUnconsentedWeChat(application) else { return }
      guard let origin = dragOrigin else { return }
      dragOrigin = nil
      guard let pid = application["pid"] as? pid_t, origin.pid == pid,
            NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { return }
      let context = currentWindow(pid: pid, bundleId: application["bundleId"] as? String ?? "")
      guard let window = context.element, CFEqual(window, origin.window),
            context.payload["url"] as? String == origin.url,
            context.payload["privateBrowsing"] as? Bool != true,
            context.payload["privateBrowsingUnknown"] as? Bool != true else { return }
      let dx = point.x - origin.point.x
      let dy = point.y - origin.point.y
      // Anything under a few points is a click that wobbled, not a drag.
      guard (dx * dx + dy * dy) > 25 else { return }
      var destination = resolveTarget(at: point, pid: pid, window: window)
      if destination.isEmpty { destination = ["role": "AXUnknown"] }
      emitEvent(
        kind: "mouse.drag",
        application: application,
        expectedWindow: context.element,
        expectedUrl: context.payload["url"] as? String,
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
    enqueueEnrichment {
      guard !excludesUnconsentedWeChat(application), let pid = application["pid"] as? pid_t,
            NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { return }
      let context = currentWindow(pid: pid, bundleId: application["bundleId"] as? String ?? "")
      guard context.payload["privateBrowsing"] as? Bool != true,
            context.payload["privateBrowsingUnknown"] as? Bool != true else { return }
      // Raw keys captured in a private window must not become public merely
      // because enrichment runs after another window of the same app activates.
      let browser = context.payload["browser"] as? Bool == true
      if browser {
        guard let window = context.element, let element = focus.element,
              focusSnapshotIsCurrent(focus, pid: pid),
              elementBelongsToWindow(element, window: window, pid: pid) else { return }
      }
      let target = keyboardTarget(snapshot: focus, pid: pid, window: context.element)
      if browser {
        guard let window = context.element, let element = focus.element,
              focusSnapshotIsCurrent(focus, pid: pid),
              elementBelongsToWindow(element, window: window, pid: pid) else { return }
      }
      guard let classified = classifiedKeyboard(keyCode: keyCode, text: text, modifiers: modifiers, secure: secure),
            let kind = classified["kind"] as? String,
            var keyboard = classified["keyboard"] as? [String: Any]
      else { return }
      keyboard["target"] = target
      emitEvent(kind: kind, application: application, expectedWindow: context.element,
        expectedUrl: context.payload["url"] as? String, extra: ["keyboard": keyboard])
    }
  case .tapDisabledByTimeout, .tapDisabledByUserInput:
    if let eventTap { CGEvent.tapEnable(tap: eventTap, enable: true) }
  case .scrollWheel:
    requestScrollSample(application: applicationPayload())
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
var historySamplingTimer: Timer?
var inputMonitoringWasReady: Bool?

func historySamplingTick(expectedSession: UInt64? = nil) {
  if let expectedSession {
    guard eventTap != nil, recorderSession() == expectedSession else { return }
  }
  emitRecorderDiagnostic(code: "heartbeat")
  let inputMonitoring = CGPreflightListenEventAccess()
  if inputMonitoring {
    if inputMonitoringWasReady != true { emitRecorderDiagnostic(code: "input_monitoring_ready", minimumInterval: 0) }
  } else {
    emitRecorderDiagnostic(code: "input_monitoring_unavailable", count: 1)
  }
  inputMonitoringWasReady = inputMonitoring
  guard AXIsProcessTrusted() else {
    observerWasReady = false
    emitRecorderDiagnostic(code: "observer_unavailable", count: 1)
    return
  }
  let application = applicationPayload()
  guard !isSeparatelyAuthorizedSource(application), let pid = application["pid"] as? pid_t else { return }
  observeApplication(pid: pid, refreshFocus: false)
  emitEvent(kind: "sampling.changed", application: application, extra: [:])
}

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
  enrichmentScheduler.cancelPending()
  inputMonitoringWasReady = nil
  diagnosticLock.lock()
  diagnosticLastAt.removeAll(); diagnosticCounts.removeAll()
  pendingDiagnostics.removeAll(); pendingDiagnosticOrder.removeAll()
  diagnosticLock.unlock()
  samplingLock.lock(); lastScrollSampleAt = nil; samplingLock.unlock()
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
  let samplingSession = recorderSession()
  let timer = Timer(timeInterval: 5, repeats: true) { _ in historySamplingTick(expectedSession: samplingSession) }
  historySamplingTimer = timer
  RunLoop.main.add(timer, forMode: .common)
  emitRecorderDiagnostic(code: "heartbeat")
  emitEvent(kind: "session.started", extra: [:])
}

public func stopHistoryRecorder() {
  guard let tap = eventTap else { return }
  historySamplingTimer?.invalidate(); historySamplingTimer = nil
  inputMonitoringWasReady = nil
  enrichmentScheduler.cancelPending()
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
    CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
  }
  emitLock.lock()
  historyEventSink = nil
  historySessionId &+= 1
  emitLock.unlock()
  eventTap = nil
  let stoppedSession = recorderSession()
  enrichmentQueue.async {
    guard recorderSession() == stoppedSession else { return }
    dragOrigin = nil; resetAXSamplingCache()
    enrichmentStateSession = nil
  }
  registeredObserverNotifications.removeAll()
  observerNotificationAttemptAt.removeAll(); observerNotificationFailures.removeAll()
  observerWasReady = nil
  axStateLock.lock()
    focusedElementCache = nil
    focusedNotificationsAvailable = false
  observedPid = nil
  observedObserver = nil
  axStateLock.unlock()
}
