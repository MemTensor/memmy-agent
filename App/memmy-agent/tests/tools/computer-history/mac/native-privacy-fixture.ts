import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Runs production Swift functions against synthetic AX/CG values, never an event tap. */
export function nativePrivacyFixture(directory: string): Record<string, any> {
  const source = fs.readFileSync(fileURLToPath(new URL(
    "../../../../src/tools/computer-history/mac/human-recorder.swift", import.meta.url,
  )), "utf8");
  const classifier = source.slice(source.indexOf("let keyNames:"), source.indexOf("func characters("));
  const focus = source.slice(source.indexOf("struct FocusSnapshot"), source.indexOf("func applicationEnvelope("));
  const resolver = source.slice(source.indexOf("func resolveTarget("), source.indexOf("func modifierList("));
  const callback = source.slice(source.indexOf("let callback:"), source.indexOf("// MARK: - Entry point"));
  const snapshot = source.slice(source.indexOf("func axSnapshot("), source.indexOf("let axObserverCallback:"));
  const observer = source.slice(source.indexOf("let axObserverCallback:"), source.indexOf("func observeApplication("));
  const script = path.join(directory, "native-privacy.swift");
  fs.writeFileSync(script, `import Foundation
import Dispatch
struct CGPoint { var x: Double; var y: Double }
enum EventType { case leftMouseDown, rightMouseDown, leftMouseUp, keyDown, tapDisabledByTimeout, tapDisabledByUserInput, other }
enum EventField { case mouseEventClickState, keyboardEventKeycode }
final class CGEvent {
  let location = CGPoint(x: 0, y: 0)
  let text: String
  init(_ text: String) { self.text = text }
  func getIntegerValueField(_ field: EventField) -> Int64 { 0 }
  static func tapEnable(tap: Int, enable: Bool) {}
}
typealias CGEventTapCallBack = (Int, EventType, CGEvent, Any?) -> Unmanaged<CGEvent>?
final class AXUIElement {
  let label: String
  let role: String
  init(_ label: String, _ role: String = "AXTextField") { self.label = label; self.role = role }
}
typealias AXObserverCallback = (Int, AXUIElement, String, Any?) -> Void
let kAXFocusedUIElementChangedNotification = "focus", kAXSelectedTextChangedNotification = "selection"
let kAXValueChangedNotification = "value", kAXFocusedWindowChangedNotification = "window"
let kAXWindowMovedNotification = "move"
enum AXResult { case success }
func AXUIElementGetPid(_ element: AXUIElement, _ pid: inout pid_t) -> AXResult { pid = 1; return .success }
func emitSelectionChanged(_ element: AXUIElement) {}
func refreshFocusedElement(pid: pid_t) {}
let axStateLock = NSLock()
var observedPid: pid_t? = 1
var focusedElementCache: AXUIElement? = AXUIElement("Customer ID")
var focusedElementGeneration: UInt64 = 0
var frontPid: pid_t = 1
var mutateDuringRead = false
var nodeReads = 0
func changeFocus(_ element: AXUIElement?, pid: pid_t? = 1) {
  axStateLock.lock()
  focusedElementCache = element; observedPid = pid; focusedElementGeneration &+= 1
  axStateLock.unlock()
}
func nodePayload(_ element: AXUIElement) -> [String: Any] {
  nodeReads += 1
  if mutateDuringRead {
    mutateDuringRead = false
    changeFocus(AXUIElement("Customer ID"))
  }
  return ["role": element.role, "title": element.label]
}
func accessibilityHit(at point: CGPoint) -> (payload: [String: Any], pid: pid_t?)? { nil }
func hitHasSemantics(_ payload: [String: Any]) -> Bool { false }
func modifierList(_ event: CGEvent) -> [String] { [] }
func applicationPayload() -> [String: Any] { ["pid": frontPid] }
func secureInputActive() -> Bool { false }
func characters(from event: CGEvent) -> String { event.text }
let enrichmentQueue = DispatchQueue(label: "native-privacy-fixture.enrichment")
var eventTap: Int? = nil
var dragOrigin: (point: CGPoint, target: [String: Any])?
var emitted: [[String: Any]] = []
func emitEvent(kind: String, application: [String: Any]? = nil, extra: [String: Any]) {
  var value = extra; value["kind"] = kind; emitted.append(value)
}
let AX_TREE_MIN_INTERVAL: TimeInterval = 0.4
var lastTreeKey: String?
var lastTreeAt: Date?
var fixtureLines: [String] = []
func axTreeLines(window: AXUIElement) -> [String] { fixtureLines }
${classifier}
${focus}
${resolver}
${callback}
${snapshot}
${observer}

// The window identity, URL and title stay unchanged; only document content
// and the consumer's observation rule change between these captures.
let window = AXUIElement("Same document", "AXWindow")
let stable = (1...10).map { "AXStaticText||Stable " + String($0) + "|||" }
func sample(_ content: String, windowKey: String = "1:windowA:https://example.com/") -> [String: Any] {
  lastTreeAt = nil
  fixtureLines = stable + ["AXStaticText||" + content + "|||"]
  return axSnapshot(window: window, windowKey: windowKey)!
}
let blocked = sample("SYNTHETIC_EXCLUDED_CUSTOMER_ID")
let restored = sample("Public document")
let unchanged = sample("Public document")
let changed = sample("Public document updated")
let otherWindow = sample("Another window", windowKey: "1:windowB:https://example.com/")
let throttled = axSnapshot(window: window, windowKey: "1:windowB:https://example.com/") == nil

// Simulate a slow AX read ahead of a tap event, then focus moving to Search.
let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
enrichmentQueue.async { entered.signal(); release.wait() }
entered.wait()
let readsBeforeTap = nodeReads
_ = callback(0, .keyDown, CGEvent("SYNTHETIC_ORDINARY_FIELD_TEXT"), nil)
let tapDidNoAXRead = nodeReads == readsBeforeTap
axObserverCallback(0, AXUIElement("Search", "AXSearchField"), kAXFocusedUIElementChangedNotification, nil)
release.signal()
enrichmentQueue.sync {}

// Stable search focus must still retain a legitimate query.
_ = callback(0, .keyDown, CGEvent("allowed query"), nil)
enrichmentQueue.sync {}

// Unknown focus and another application's cache never grant search access.
changeFocus(nil)
// A search box elsewhere updates while focus is unknown. The notification
// must not invent search focus for the following ordinary input.
axObserverCallback(0, AXUIElement("Search", "AXSearchField"), kAXValueChangedNotification, nil)
_ = callback(0, .keyDown, CGEvent("UNKNOWN_FOCUS_TEXT"), nil)
enrichmentQueue.sync {}
changeFocus(AXUIElement("Search", "AXSearchField"))
frontPid = 2
_ = callback(0, .keyDown, CGEvent("OTHER_APP_TEXT"), nil)
enrichmentQueue.sync {}
frontPid = 1

// A generation change during AX enrichment also discards the old payload.
mutateDuringRead = true
_ = callback(0, .keyDown, CGEvent("CHANGED_DURING_AX_READ"), nil)
enrichmentQueue.sync {}
let result: [String: Any] = ["blocked": blocked, "restored": restored,
  "unchanged": unchanged, "changed": changed, "otherWindow": otherWindow,
  "throttled": throttled, "tapDidNoAXRead": tapDidNoAXRead, "keyboard": emitted]
print(String(data: try JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
`);
  return JSON.parse(execFileSync("swift", ["-module-cache-path",
    path.join(os.tmpdir(), "memmy-recorder-test-swift-cache"), script], { encoding: "utf8", timeout: 60_000 }));
}
