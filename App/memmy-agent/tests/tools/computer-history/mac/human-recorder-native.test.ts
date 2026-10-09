import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

test.runIf(process.platform === "darwin")("native capture classifies text safely and rereads same-window browser URLs", () => {
  const source = fs.readFileSync(fileURLToPath(new URL(
    "../../../../src/tools/computer-history/mac/human-recorder.swift", import.meta.url,
  )), "utf8");
  // Compile only the production classifier. Never execute the recorder's
  // entrypoint, request permissions, or install a desktop event tap in tests.
  const classifier = source.slice(source.indexOf("let keyNames:"), source.indexOf("func characters("));
  const browserPage = source.slice(source.indexOf("func browserPage("), source.indexOf("// MARK: - Secure input"));
  const sanitizeUrl = source.slice(source.indexOf("func sanitizedPageUrl("), source.indexOf("func webAreaUrl("));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "recorder-native-"));
  const script = path.join(directory, "classification.swift");
  fs.writeFileSync(script, `import Foundation\n${classifier}\n
// AX calls are stubbed to exercise the production URL reader without touching
// a real application. Mutating the same AXWebArea simulates same-tab navigation.
typealias CFString = String
typealias CFTypeRef = Any
class AXUIElement { var fields: [String: Any]; init(_ fields: [String: Any]) { self.fields = fields } }
enum AXResult { case success, failure }
let kAXTitleAttribute = "title", kAXRoleAttribute = "role", kAXChildrenAttribute = "children"
func AXUIElementSetMessagingTimeout(_ element: AXUIElement, _ timeout: Double) {}
func accessibilityString(_ element: AXUIElement, _ attribute: String) -> String? { element.fields[attribute] as? String }
func webAreaUrl(_ element: AXUIElement) -> String? { element.fields["url"] as? String }
func AXUIElementCopyAttributeValue(_ element: AXUIElement, _ attribute: String, _ result: inout Any?) -> AXResult {
  result = element.fields[attribute]
  return result == nil ? .failure : .success
}
${sanitizeUrl}
${browserPage}
let page = AXUIElement(["role": "AXWebArea", "url": "https://example.com/"])
let window = AXUIElement(["role": "AXWindow", "title": "Browser", "children": [page]])
var urls: [Any] = [browserPage(window: window).url as Any? ?? NSNull()]
page.fields["url"] = "https://bank.com/"
urls.append(browserPage(window: window).url as Any? ?? NSNull())
page.fields.removeValue(forKey: "url")
urls.append(browserPage(window: window).url as Any? ?? NSNull())
let inputs: [(Int, String, [String], Bool)] = [
  (0, "A", ["shift"], false), (18, "!", ["shift"], false),
  (14, "é", ["option"], false), (49, " ", [], false),
  (0, "A", ["shift"], true), (18, "!", ["shift"], true),
  (14, "é", ["option"], true), (0, "a", [], true),
  (8, "c", ["cmd"], false), (48, "\\t", [], false)
]
let results: [Any] = inputs.map { classifiedKeyboard(keyCode: $0.0, text: $0.1, modifiers: $0.2, secure: $0.3) as Any? ?? NSNull() }
let data = try JSONSerialization.data(withJSONObject: ["keys": results, "urls": urls])
print(String(data: data, encoding: .utf8)!)
`);
  try {
    const output = execFileSync("swift", ["-module-cache-path",
      path.join(os.tmpdir(), "memmy-recorder-test-swift-cache"), script], { encoding: "utf8", timeout: 60_000 });
    const parsed = JSON.parse(output);
    const results = parsed.keys;
    assert.deepEqual(parsed.urls, ["https://example.com/", "https://bank.com/", null]);
    assert.deepEqual(results.slice(0, 4).map((result: any) => [result.kind, result.keyboard.text]), [
      ["keyboard.text_input", "A"], ["keyboard.text_input", "!"],
      ["keyboard.text_input", "é"], ["keyboard.text_input", " "],
    ]);
    assert.deepEqual(results.slice(4, 8), [null, null, null, null]);
    assert.equal(results[8].kind, "keyboard.shortcut");
    assert.equal(results[8].keyboard.keyEquivalent, "c");
    assert.equal(results[9].kind, "keyboard.shortcut");
    assert.equal(results[9].keyboard.keyEquivalent, "tab");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 65_000);

test.runIf(process.platform === "darwin")("native mouse targets use hit tests and queued drags retain their ordered endpoints", () => {
  const source = fs.readFileSync(fileURLToPath(new URL(
    "../../../../src/tools/computer-history/mac/human-recorder.swift", import.meta.url,
  )), "utf8");
  const classifier = source.slice(source.indexOf("let keyNames:"), source.indexOf("func characters("));
  const resolveTarget = source.slice(source.indexOf("func resolveTarget("), source.indexOf("func modifierList("));
  const callback = source.slice(source.indexOf("let callback:"), source.indexOf("// MARK: - Entry point"));
  const focus = source.slice(source.indexOf("struct FocusSnapshot"), source.indexOf("func applicationEnvelope("));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "recorder-native-events-"));
  const script = path.join(directory, "mouse-events.swift");
  // Execute the actual target resolver and event callback against synthetic AX
  // and CGEvent values. No event tap, permissions, or desktop access is used.
  fs.writeFileSync(script, `import Foundation
import Dispatch
struct CGPoint { var x: Double; var y: Double }
enum EventType { case leftMouseDown, rightMouseDown, leftMouseUp, keyDown, tapDisabledByTimeout, tapDisabledByUserInput, other }
enum EventField { case mouseEventClickState, keyboardEventKeycode }
final class CGEvent {
  let location: CGPoint
  let keyCode: Int64
  let text: String
  init(_ x: Double, _ y: Double, keyCode: Int64 = 0, text: String = "a") {
    location = CGPoint(x: x, y: y); self.keyCode = keyCode; self.text = text
  }
  func getIntegerValueField(_ field: EventField) -> Int64 { field == .keyboardEventKeycode ? keyCode : 1 }
  static func tapEnable(tap: Int, enable: Bool) {}
}
typealias CGEventTapCallBack = (Int, EventType, CGEvent, Any?) -> Unmanaged<CGEvent>?
let enrichmentQueue = DispatchQueue(label: "native-event-test.enrichment")
var eventTap: Int? = nil
var dragOrigin: (point: CGPoint, target: [String: Any])?
typealias AXUIElement = String
let axStateLock = NSLock()
var observedPid: pid_t? = 1
var focusedElementCache: String? = "Previously focused editor"
var focusedElementGeneration: UInt64 = 0
var hitAvailable = true
var hitTests = 0
var emitted: [[String: Any]] = []
func nodePayload(_ element: String) -> [String: Any] { ["role": "AXTextField", "title": element] }
func hasSemanticLabel(_ payload: [String: Any]) -> Bool { payload["title"] != nil }
func accessibilityHit(at point: CGPoint) -> (payload: [String: Any], pid: Int?)? {
  hitTests += 1
  return hitAvailable ? (["role": "AXButton", "title": "Hit \\(Int(point.x)),\\(Int(point.y))"], 1) : nil
}
func hitHasSemantics(_ payload: [String: Any]) -> Bool { hasSemanticLabel(payload) }
func modifierList(_ event: CGEvent) -> [String] { [] }
func applicationPayload() -> [String: Any] { ["pid": pid_t(1)] }
func secureInputActive() -> Bool { false }
func characters(from event: CGEvent) -> String { event.text }
func emitEvent(kind: String, application: [String: Any]? = nil, extra: [String: Any]) {
  var payload = extra; payload["kind"] = kind; emitted.append(payload)
}
${classifier}
${focus}
${resolveTarget}
${callback}

// A mouse click and a context click must not inherit the old editor's focus.
_ = callback(0, .leftMouseDown, CGEvent(1, 2), nil)
_ = callback(0, .leftMouseUp, CGEvent(1, 2), nil)
_ = callback(0, .rightMouseDown, CGEvent(3, 4), nil)
enrichmentQueue.sync {}
let hitTestsBeforeKeyboard = hitTests
_ = callback(0, .keyDown, CGEvent(999, 999), nil)
enrichmentQueue.sync {}
let keyboardHitTests = hitTests - hitTestsBeforeKeyboard
// A failed mouse lookup must stay unknown rather than inventing a focus hit.
hitAvailable = false
_ = callback(0, .leftMouseDown, CGEvent(5, 6), nil)
_ = callback(0, .leftMouseUp, CGEvent(5, 6), nil)
enrichmentQueue.sync {}
let targeting = emitted
emitted.removeAll()
hitAvailable = true

// Hold enrichment while tap events arrive. Releasing the queue later must
// preserve both drags and clear a wobbling click's origin. The tap callback
// must return while enrichment is blocked, without waiting for an AX read.
let entered = DispatchSemaphore(value: 0)
let release = DispatchSemaphore(value: 0)
let tapReturned = DispatchSemaphore(value: 0)
enrichmentQueue.async { entered.signal(); release.wait() }
entered.wait()
DispatchQueue(label: "native-event-test.tap").async {
  _ = callback(0, .leftMouseDown, CGEvent(0, 0), nil)
  _ = callback(0, .leftMouseUp, CGEvent(50, 50), nil)
  _ = callback(0, .leftMouseDown, CGEvent(60, 60), nil)
  _ = callback(0, .leftMouseUp, CGEvent(100, 100), nil)
  _ = callback(0, .leftMouseDown, CGEvent(10, 10), nil)
  _ = callback(0, .leftMouseUp, CGEvent(13, 13), nil)
  _ = callback(0, .leftMouseUp, CGEvent(150, 150), nil)
  tapReturned.signal()
}
let returnedWhileBlocked = tapReturned.wait(timeout: .now() + 1) == .success
release.signal()
if !returnedWhileBlocked { tapReturned.wait() }
enrichmentQueue.sync {}
let result: [String: Any] = [
  "targeting": targeting, "keyboardHitTests": keyboardHitTests,
  "dragEvents": emitted, "dragOriginCleared": dragOrigin == nil,
  "callbackReturnedWhileBlocked": returnedWhileBlocked,
]
print(String(data: try JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
`);
  try {
    const output = execFileSync("swift", ["-module-cache-path",
      path.join(os.tmpdir(), "memmy-recorder-test-swift-cache"), script], { encoding: "utf8", timeout: 60_000 });
    const parsed = JSON.parse(output);
    assert.deepEqual(parsed.targeting.map((event: any) => event.kind), [
      "mouse.click", "mouse.context_menu", "keyboard.text_input", "mouse.click",
    ]);
    assert.equal(parsed.targeting[0].mouse.target.title, "Hit 1,2");
    assert.equal(parsed.targeting[1].mouse.target.title, "Hit 3,4");
    assert.equal(parsed.targeting[2].keyboard.target.title, "Previously focused editor");
    assert.equal(parsed.keyboardHitTests, 0);
    assert.deepEqual(parsed.targeting[3].mouse.target, { role: "AXUnknown" });
    assert.equal(parsed.callbackReturnedWhileBlocked, true);
    assert.deepEqual(parsed.dragEvents.map((event: any) => event.kind), [
      "mouse.click", "mouse.drag", "mouse.click", "mouse.drag", "mouse.click",
    ]);
    const drags = parsed.dragEvents.filter((event: any) => event.kind === "mouse.drag");
    assert.deepEqual(drags.map((event: any) => [event.mouse.origin.element.title, event.mouse.destination.element.title]), [
      ["Hit 0,0", "Hit 50,50"], ["Hit 60,60", "Hit 100,100"],
    ]);
    assert.equal(parsed.dragOriginCleared, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 65_000);
