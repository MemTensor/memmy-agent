import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, test } from "vitest";

const source = fs.readFileSync(fileURLToPath(new URL(
  "../../../../src/tools/computer-history/mac/human-recorder.swift", import.meta.url,
)), "utf8");
const swiftModuleCache = fs.mkdtempSync(path.join(os.tmpdir(), "recorder-privacy-swift-cache-"));
afterAll(() => fs.rmSync(swiftModuleCache, { recursive: true, force: true }));
function production(from: string, until: string): string {
  return source.slice(source.indexOf(from), source.indexOf(until, source.indexOf(from)));
}
function runSwift(body: string): Record<string, any> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "recorder-privacy-native-"));
  try {
    const script = path.join(directory, "privacy.swift");
    fs.writeFileSync(script, `import Foundation\nimport Dispatch\nimport CoreFoundation\n${body}`);
    return JSON.parse(execFileSync("swift", ["-module-cache-path",
      swiftModuleCache, script], { encoding: "utf8", timeout: 60_000 }));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// All AX objects and calls below are synthetic. These fixtures execute the
// production Swift functions without loading an app, installing a tap, or
// requesting permissions. No live browser/user content is used.
const axFixture = `
typealias CFString = String
typealias CFTypeRef = Any
let kAXTitleAttribute = "title", kAXDescriptionAttribute = "description", kAXRoleAttribute = "role"
let kAXSubroleAttribute = "subrole", kAXIdentifierAttribute = "identifier", kAXChildrenAttribute = "children"
let kAXWindowAttribute = "window", kAXParentAttribute = "parent", kAXValueAttribute = "value"
let kAXFocusedWindowAttribute = "focusedWindow", kAXMainWindowAttribute = "mainWindow"
let kAXSelectedTextAttribute = "selectedText", kAXSelectedTextRangeAttribute = "selectedRange"
enum AXResult { case success, attributeUnsupported, noValue, cannotComplete }
final class AXUIElement {
  var fields: [String: Any]
  var pid: pid_t
  var childrenError: AXResult?
  var childrenDelay: TimeInterval = 0
  init(_ role: String, title: String? = nil, children: [AXUIElement] = [], pid: pid_t = 1) {
    self.pid = pid; fields = ["role": role, "children": children]
    if let title { fields["title"] = title }
  }
}
func CFEqual(_ lhs: AXUIElement, _ rhs: AXUIElement) -> Bool { lhs === rhs }
func axElement(_ value: Any?) -> AXUIElement? { value as? AXUIElement }
func AXUIElementSetMessagingTimeout(_ element: AXUIElement, _ timeout: Double) {}
var labelReads = 0, selectedReads = 0
var trackedLabelReads = 0
var mutateLabel: (() -> Void)?
var mutateSelection: (() -> Void)?
func accessibilityString(_ element: AXUIElement, _ attribute: String, maxCharacters: Int = 240) -> String? {
  if attribute == kAXTitleAttribute || attribute == kAXDescriptionAttribute {
    labelReads += 1
    if element.fields["tracked"] as? Bool == true {
      trackedLabelReads += 1
      if let mutation = mutateLabel { mutateLabel = nil; mutation() }
    }
  }
  if attribute == kAXSelectedTextAttribute {
    selectedReads += 1
    if let mutateSelection { mutateSelection(); selfClearSelectionMutation() }
  }
  return (element.fields[attribute] as? String).map { String($0.prefix(maxCharacters)) }
}
func selfClearSelectionMutation() { mutateSelection = nil }
func accessibilityValueString(_ element: AXUIElement) -> String? { element.fields["value"] as? String }
func AXUIElementCopyAttributeValue(_ element: AXUIElement, _ attribute: String, _ value: inout Any?) -> AXResult {
  if attribute == kAXChildrenAttribute, element.childrenDelay > 0 { Thread.sleep(forTimeInterval: element.childrenDelay) }
  if attribute == kAXChildrenAttribute, let error = element.childrenError { return error }
  value = element.fields[attribute]
  return value == nil ? .attributeUnsupported : .success
}
func copyAXAttribute(_ element: AXUIElement, _ attribute: String, _ value: inout Any?) -> AXResult { AXUIElementCopyAttributeValue(element, attribute, &value) }
func prepareAXQuery(_ element: AXUIElement, timeout: TimeInterval = 0.05) -> Bool { true }
func emitRecorderDiagnostic(code: String, count: Int? = nil, minimumInterval: TimeInterval = 10) {}
let historyWorkSessionKey = "FixtureWorkSession"
var lastTreeKey: String?, lastTreeAt: Date?
func resetAXSamplingCache() { lastTreeKey = nil; lastTreeAt = nil }
func AXUIElementGetPid(_ element: AXUIElement, _ pid: inout pid_t) -> AXResult { pid = element.pid; return .success }
var current = AXUIElement("AXWindow", title: "Public page")
var frontPid: pid_t = 1
var frontBundle = "com.google.Chrome"
var focusedWindowAvailable = true
final class RunningApplication { var processIdentifier: pid_t { frontPid } }
final class NSWorkspace {
  static let shared = NSWorkspace()
  var frontmostApplication: RunningApplication? { RunningApplication() }
}
func applicationPayload() -> [String: Any] { ["pid": frontPid, "bundleId": frontBundle] }
func AXUIElementCreateApplication(_ pid: pid_t) -> AXUIElement {
  let app = AXUIElement("AXApplication", pid: pid)
  if focusedWindowAvailable { app.fields["focusedWindow"] = current }
  app.fields["mainWindow"] = current
  return app
}
let browserBundleIds: Set<String> = ["com.google.Chrome", "com.apple.Safari"]
var pageUrl: String? = "https://public.example/"
func browserPage(window: AXUIElement) -> (url: String?, title: String?) { (pageUrl, nil) }
func quickPageUrl(_ window: AXUIElement) -> String? { nil }
func address() -> AXUIElement { AXUIElement("AXTextField", title: "地址和搜索栏") }
func normalToolbar() -> AXUIElement { AXUIElement("AXToolbar", children: [address(), AXUIElement("AXButton", title: "您")]) }
`;

test.runIf(process.platform === "darwin")("native browser windows report their own page without a private-window classification", () => {
  const result = runSwift(`${axFixture}
${production("func currentWindow(", "func refreshFocusedElement(")}
var outcomes: [String: Any] = [:]
current = AXUIElement("AXWindow", title: "Page (Incognito)", children: [AXUIElement("AXToolbar", children: [address(), AXUIElement("AXButton", title: "无痕模式")])])
outcomes["privateLooking"] = currentWindow(pid: 1, bundleId: "com.google.Chrome").payload
focusedWindowAvailable = false
let fallback = currentWindow(pid: 1, bundleId: "com.google.Chrome")
outcomes["focusedUnavailable"] = fallback.payload
outcomes["focusedUnavailableHasWindow"] = fallback.element != nil
focusedWindowAvailable = true
outcomes["nativeApp"] = currentWindow(pid: 1, bundleId: "com.example.Editor").payload
print(String(data: try JSONSerialization.data(withJSONObject: outcomes), encoding: .utf8)!)
`);
  const page = { browser: true, title: "Page (Incognito)", url: "https://public.example/" };
  assert.deepEqual(result.privateLooking, page);
  // A browser without a focused window falls back to its main window like any other app.
  assert.deepEqual(result.focusedUnavailable, page);
  assert.equal(result.focusedUnavailableHasWindow, true);
  assert.deepEqual(result.nativeApp, { title: "Page (Incognito)" });
}, 65_000);

test.runIf(process.platform === "darwin")("queued browser keyboard input never borrows another same-app window's field", () => {
  const result = runSwift(`${axFixture}
${production("func currentWindow(", "func refreshFocusedElement(")}
${production("func nodePayload(", "let interactiveFocusRoles:")}
${production("let keyNames:", "func characters(")}
let axStateLock = NSLock()
var observedPid: pid_t? = 1
var focusedElementCache: AXUIElement?
var focusedElementGeneration: UInt64 = 0
var focusedNotificationsAvailable = true
${production("struct FocusSnapshot", "func applicationEnvelope(")}
struct CGPoint { var x: Double; var y: Double }
enum EventType { case leftMouseDown, rightMouseDown, leftMouseUp, keyDown, scrollWheel, tapDisabledByTimeout, tapDisabledByUserInput, other }
enum EventField { case mouseEventClickState, keyboardEventKeycode }
final class CGEvent {
  let location = CGPoint(x: 0, y: 0)
  let text: String
  init(_ text: String) { self.text = text }
  func getIntegerValueField(_ field: EventField) -> Int64 { 0 }
  static func tapEnable(tap: Int, enable: Bool) {}
}
typealias CGEventTapCallBack = (Int, EventType, CGEvent, Any?) -> Unmanaged<CGEvent>?
func AXUIElementCreateSystemWide() -> AXUIElement { AXUIElement("AXApplication") }
func AXUIElementCopyElementAtPosition(_ system: AXUIElement, _ x: Float, _ y: Float, _ element: inout AXUIElement?) -> AXResult { .noValue }
func modifierList(_ event: CGEvent) -> [String] { [] }
func requestScrollSample(application: [String: Any]) {}
func characters(from event: CGEvent) -> String { event.text }
func secureInputActive() -> Bool { false }
func excludesUnconsentedWeChat(_ app: [String: Any]) -> Bool { false }
func isSeparatelyAuthorizedSource(_ app: [String: Any]) -> Bool { false }
let emitLock = NSLock()
var historySessionId: UInt64 = 1
let enrichmentQueue = DispatchQueue(label: "native-keyboard-fixture")
func enqueueEnrichment(key: String? = nil, _ work: @escaping () -> Void) { enrichmentQueue.async(execute: work) }
let enrichmentQueueKey = DispatchSpecificKey<Bool>()
enrichmentQueue.setSpecific(key: enrichmentQueueKey, value: true)
var eventTap: Int?
var dragOrigin: (point: CGPoint, target: [String: Any], pid: pid_t, window: AXUIElement, url: String?)?
var emitted: [[String: Any]] = []
func timestamp() -> String { "2026-10-09T00:00:00Z" }
func nextEventId() -> String { "synthetic-event" }
func applicationEnvelope(_ app: [String: Any]) -> [String: Any] { app }
func emit(_ payload: [String: Any], expectedSession: UInt64? = nil) { emitted.append(payload) }
func axSnapshot(window: AXUIElement, windowKey: String, deduplicate: Bool = false) -> [String: Any]? { nil }
${production("func emitEvent(", "func currentWindow(")}
${production("func resolveTarget(", "func modifierList(")}
${production("let callback:", "// MARK: - Entry point")}
let firstWindow = AXUIElement("AXWindow", title: "First page", children: [normalToolbar()])
let otherWindow = AXUIElement("AXWindow", title: "Other page")
let firstField = AXUIElement("AXTextField", title: "Search")
firstField.fields["window"] = firstWindow; firstField.fields["tracked"] = true
let otherField = AXUIElement("AXTextField", title: "OTHER_WINDOW_FIELD")
otherField.fields["window"] = otherWindow; otherField.fields["tracked"] = true
current = otherWindow; focusedElementCache = otherField
let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
enrichmentQueue.async { entered.signal(); release.wait() }; entered.wait()
_ = callback(0, .keyDown, CGEvent("typed before the switch"), nil)
current = firstWindow
// The browser PID and focus generation are unchanged: its delayed focus
// notification has not arrived yet. The other window's field must not label it.
release.signal(); enrichmentQueue.sync {}
var outcomes: [String: Any] = ["staleFocusInput": emitted, "staleFieldReads": trackedLabelReads]
emitted.removeAll(); focusedElementCache = firstField
_ = callback(0, .keyDown, CGEvent("query"), nil); enrichmentQueue.sync {}
outcomes["normalKeyboard"] = emitted
emitted.removeAll(); focusedElementCache = nil
_ = callback(0, .keyDown, CGEvent("browser input"), nil); enrichmentQueue.sync {}
outcomes["unknownBrowserFocus"] = emitted
emitted.removeAll(); focusedElementCache = firstField
mutateLabel = { current = otherWindow }
_ = callback(0, .keyDown, CGEvent("SWITCHED_DURING_TARGET_READ"), nil); enrichmentQueue.sync {}
outcomes["switchDuringTargetRead"] = emitted
emitted.removeAll(); current = firstWindow; frontBundle = "com.example.Editor"; focusedElementCache = nil
_ = callback(0, .keyDown, CGEvent("ordinary editor input"), nil); enrichmentQueue.sync {}
outcomes["ordinaryEditorUnknownFocus"] = emitted
print(String(data: try JSONSerialization.data(withJSONObject: outcomes), encoding: .utf8)!)
`);
  assert.equal(result.staleFocusInput.length, 1);
  assert.deepEqual(result.staleFocusInput[0].keyboard.target, { role: "AXUnknown" });
  assert.equal(result.staleFieldReads, 0);
  assert.equal(result.normalKeyboard.length, 1);
  assert.equal(result.normalKeyboard[0].keyboard.text, "query");
  assert.equal(result.normalKeyboard[0].keyboard.target.title, "Search");
  // Without a known focused element, browser input is kept like any other app's.
  assert.equal(result.unknownBrowserFocus.length, 1);
  assert.deepEqual(result.unknownBrowserFocus[0].keyboard.target, { role: "AXUnknown" });
  assert.deepEqual(result.switchDuringTargetRead, []);
  assert.equal(result.ordinaryEditorUnknownFocus.length, 1);
  assert.deepEqual(result.ordinaryEditorUnknownFocus[0].keyboard.target, { role: "AXUnknown" });
}, 65_000);

test.runIf(process.platform === "darwin")("native hits and selections verify actual app/window ownership before reading labels or text", () => {
  const result = runSwift(`${axFixture}
${production("func currentWindow(", "func refreshFocusedElement(")}
${production("func nodePayload(", "let interactiveFocusRoles:")}
struct CGPoint { var x: Double; var y: Double }
var hit: AXUIElement?
func AXUIElementCreateSystemWide() -> AXUIElement { AXUIElement("AXApplication") }
func AXUIElementCopyElementAtPosition(_ system: AXUIElement, _ x: Float, _ y: Float, _ element: inout AXUIElement?) -> AXResult {
  element = hit; return hit == nil ? .noValue : .success
}
typealias AXValue = AXUIElement
enum AXValueType { case cfRange }
func CFGetTypeID(_ value: Any) -> Int { 0 }
func AXValueGetTypeID() -> Int { 1 }
func AXValueGetValue(_ value: AXValue, _ kind: AXValueType, _ range: inout CFRange) -> Bool { false }
let enrichmentQueue = DispatchQueue(label: "native-selection-fixture")
func enqueueEnrichment(key: String? = nil, _ work: @escaping () -> Void) { enrichmentQueue.async(execute: work) }
var secure = false
func secureInputActive() -> Bool { secure }
func excludesUnconsentedWeChat(_ app: [String: Any]) -> Bool { false }
var emitted: [[String: Any]] = []
func emitEvent(kind: String, application: [String: Any]? = nil, expectedWindow: AXUIElement? = nil, expectedUrl: String? = nil, extra: [String: Any]) {
  var event = extra; event["kind"] = kind; emitted.append(event)
}
${production("func emitSelectionChanged(", "// MARK: - Accessibility tree snapshots")}
frontBundle = "com.example.Editor"
let window = AXUIElement("AXWindow", title: "Public document")
current = window
let field = AXUIElement("AXTextField", title: "Public field")
field.fields["window"] = window; field.fields["selectedText"] = "Permitted selection"
let otherWindow = AXUIElement("AXWindow", title: "PRIVATE_OTHER_WINDOW_TITLE")
let otherField = AXUIElement("AXTextField", title: "PRIVATE_OTHER_WINDOW_FIELD")
otherField.fields["window"] = otherWindow; otherField.fields["selectedText"] = "PRIVATE_OTHER_WINDOW_SELECTION"
let foreign = AXUIElement("AXTextField", title: "PRIVATE_OTHER_APP_FIELD", pid: 2)
foreign.fields["window"] = window; foreign.fields["selectedText"] = "PRIVATE_OTHER_APP_SELECTION"
let dock = AXUIElement("AXDockItem", title: "PRIVATE_MINIMIZED_WINDOW_TITLE")
dock.fields["subrole"] = "AXMinimizedWindowDockItem"; dock.fields["window"] = window
var outcomes: [String: Any] = [:]
for (name, candidate) in [("foreign", foreign), ("backgroundWindow", otherField), ("dock", dock)] {
  hit = candidate; labelReads = 0
  let result = accessibilityHit(at: CGPoint(x: 1, y: 1), expectedPid: 1, expectedWindow: window)
  outcomes[name] = ["accepted": result != nil, "labelReads": labelReads]
}
hit = field
outcomes["normalHit"] = accessibilityHit(at: CGPoint(x: 1, y: 1), expectedPid: 1, expectedWindow: window)?.payload as Any? ?? NSNull()
selectedReads = 0
emitSelectionChanged(foreign); emitSelectionChanged(otherField); enrichmentQueue.sync {}
outcomes["rejectedSelectionsRead"] = selectedReads
emitSelectionChanged(field); enrichmentQueue.sync {}
outcomes["permittedSelection"] = emitted
emitted.removeAll()
field.fields["selectedText"] = String(repeating: "a", count: 500)
emitSelectionChanged(field); enrichmentQueue.sync {}
outcomes["longSelectionLength"] = (emitted.last?["selection"] as? [String: Any])?["selectedText"] as? String ?? ""
emitted.removeAll()
let passwordField = AXUIElement("AXSecureTextField", title: "PASSWORD_FIELD_TITLE")
passwordField.fields["window"] = window; passwordField.fields["selectedText"] = "PASSWORD_SELECTION"
selectedReads = 0
emitSelectionChanged(passwordField); enrichmentQueue.sync {}
outcomes["passwordSelectionRead"] = selectedReads
mutateSelection = { current = otherWindow }
emitSelectionChanged(field); enrichmentQueue.sync {}
outcomes["changedDuringRead"] = emitted
current = window; secure = true
selectedReads = 0
emitSelectionChanged(field); enrichmentQueue.sync {}
outcomes["secureSelectionRead"] = selectedReads
secure = false; frontBundle = "com.google.Chrome"; field.fields["selectedText"] = "Browser selection"
selectedReads = 0; emitted.removeAll()
emitSelectionChanged(field); enrichmentQueue.sync {}
outcomes["browserSelectionRead"] = selectedReads
outcomes["browserSelection"] = emitted
print(String(data: try JSONSerialization.data(withJSONObject: outcomes), encoding: .utf8)!)
`);
  for (const name of ["foreign", "backgroundWindow", "dock"]) {
    assert.deepEqual(result[name], { accepted: false, labelReads: 0 }, name);
  }
  assert.equal(result.normalHit.title, "Public field");
  assert.equal(result.rejectedSelectionsRead, 0);
  assert.equal(result.permittedSelection.length, 1);
  assert.equal(result.permittedSelection[0].selection.selectedText, "Permitted selection");
  assert.equal(result.longSelectionLength.length, 500);
  assert.equal(result.passwordSelectionRead, 0);
  assert.deepEqual(result.changedDuringRead, []);
  assert.equal(result.secureSelectionRead, 0);
  assert.equal(result.browserSelectionRead, 1);
  assert.equal(result.browserSelection.length, 1);
  assert.equal(result.browserSelection[0].selection.selectedText, "Browser selection");
}, 65_000);

test.runIf(process.platform === "darwin")("native event emission discards snapshots after same-app window or URL changes", () => {
  const result = runSwift(`${axFixture}
let emitLock = NSLock()
var historySessionId: UInt64 = 1
let enrichmentQueue = DispatchQueue(label: "native-emission-fixture")
func enqueueEnrichment(key: String? = nil, _ work: @escaping () -> Void) { enrichmentQueue.async(execute: work) }
let enrichmentQueueKey = DispatchSpecificKey<Bool>()
enrichmentQueue.setSpecific(key: enrichmentQueueKey, value: true)
var emitted: [[String: Any]] = []
var snapshotReads = 0
var switchAppDuringSnapshot = false
func timestamp() -> String { "2026-10-09T00:00:00Z" }
func nextEventId() -> String { "synthetic-event" }
func excludesUnconsentedWeChat(_ app: [String: Any]) -> Bool { false }
func applicationEnvelope(_ app: [String: Any]) -> [String: Any] { app }
func emit(_ payload: [String: Any], expectedSession: UInt64? = nil) { emitted.append(payload) }
func axSnapshot(window: AXUIElement, windowKey: String, deduplicate: Bool = false) -> [String: Any]? {
  snapshotReads += 1; lastTreeKey = windowKey; lastTreeAt = Date()
  if switchAppDuringSnapshot { frontPid = 2 }
  return ["mode": "fullTree", "text": "SYNTHETIC_TREE"]
}
typealias Context = (payload: [String: Any], element: AXUIElement?)
var contexts: [Context] = []
func currentWindow(pid: pid_t, bundleId: String) -> Context { contexts.count > 1 ? contexts.removeFirst() : contexts[0] }
${production("func emitEvent(", "func currentWindow(")}
let a = AXUIElement("AXWindow"), b = AXUIElement("AXWindow")
let normal: [String: Any] = ["browser": true, "url": "https://public.example/"]
var outcomes: [String: Any] = [:]
func scenario(_ name: String, first: Context, latest: Context, switchApp: Bool = false) {
  contexts = [first, latest]; emitted.removeAll(); frontPid = 1
  snapshotReads = 0; switchAppDuringSnapshot = switchApp
  lastTreeKey = "previous"; lastTreeAt = Date()
  enrichmentQueue.sync { emitEvent(kind: "mouse.click", extra: [:]) }
  outcomes[name] = ["emitted": emitted.count, "snapshotReads": snapshotReads, "baselineCleared": lastTreeKey == nil && lastTreeAt == nil]
}
scenario("normal", first: (normal, a), latest: (normal, a))
scenario("samePidOtherWindow", first: (normal, a), latest: (normal, b))
scenario("navigation", first: (normal, a), latest: (["browser": true, "url": "https://other.example/"], a))
scenario("appSwitchDuringRead", first: (normal, a), latest: (normal, a), switchApp: true)
print(String(data: try JSONSerialization.data(withJSONObject: outcomes), encoding: .utf8)!)
`);
  assert.equal(result.normal.emitted, 1);
  assert.equal(result.normal.snapshotReads, 1);
  for (const name of ["samePidOtherWindow", "navigation", "appSwitchDuringRead"]) {
    assert.equal(result[name].emitted, 0, name);
    assert.equal(result[name].baselineCleared, true, name);
  }
}, 65_000);
