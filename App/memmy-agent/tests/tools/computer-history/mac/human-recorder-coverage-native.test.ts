import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const source = fs.readFileSync(fileURLToPath(new URL(
  "../../../../src/tools/computer-history/mac/human-recorder.swift", import.meta.url,
)), "utf8");
function production(start: string, end: string): string {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${start} → ${end}`);
  return source.slice(from, to);
}
function runNative(script: string): any {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "history-coverage-native-"));
  const file = path.join(directory, "fixture.swift");
  fs.writeFileSync(file, `import Foundation\nimport Dispatch\n${script}`);
  try {
    return JSON.parse(execFileSync("swift", ["-module-cache-path",
      path.join(os.tmpdir(), "memmy-recorder-test-swift-cache"), file], { encoding: "utf8", timeout: 60_000 }));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

// Every AX object, event, permission, and run-loop API in these fixtures is
// synthetic. Only production functions are executed; no desktop tap is made.
test.runIf(process.platform === "darwin")("observer switches retain the old source on failure and retry degraded subscriptions", () => {
  const result = runNative(`
typealias CFString = String
enum AXError { case success, cannotComplete, notificationUnsupported, notificationAlreadyRegistered }
final class AXUIElement { let pid: pid_t; init(_ pid: pid_t) { self.pid = pid } }
final class AXObserver { let pid: pid_t; init(_ pid: pid_t) { self.pid = pid } }
let kAXFocusedUIElementChangedNotification = "focus", kAXSelectedTextChangedNotification = "selection"
let kAXValueChangedNotification = "value", kAXFocusedWindowChangedNotification = "window", kAXWindowMovedNotification = "move"
let axObserverCallback = 0
let axStateLock = NSLock()
var observedPid: pid_t?, observedObserver: AXObserver?, focusedElementCache: AXUIElement?
var focusedElementGeneration: UInt64 = 0
var focusedNotificationsAvailable = false
var frontPid: pid_t = 1
final class Application { var processIdentifier: pid_t { frontPid } }
final class NSWorkspace { static let shared = NSWorkspace(); var frontmostApplication: Application? { Application() } }
func applicationPayload() -> [String: Any] { ["pid": frontPid] }
var excluded = false
func excludesUnconsentedWeChat(_ application: [String: Any]) -> Bool { excluded }
var diagnostics: [String] = [], refreshed: [pid_t] = [], attached: Set<pid_t> = []
var createCalls: [pid_t] = [], failedCreates: Set<pid_t> = [2]
var subscriptionFailures: [String: AXError] = [:], subscriptionCalls: [String: Int] = [:]
func emitRecorderDiagnostic(code: String, count: Int? = nil, minimumInterval: TimeInterval = 10) { diagnostics.append(code) }
func AXObserverCreate(_ pid: pid_t, _ callback: Int, _ observer: inout AXObserver?) -> AXError {
  createCalls.append(pid)
  if failedCreates.contains(pid) { return .cannotComplete }
  observer = AXObserver(pid); return .success
}
func AXUIElementCreateApplication(_ pid: pid_t) -> AXUIElement { AXUIElement(pid) }
func AXUIElementSetMessagingTimeout(_ element: AXUIElement, _ timeout: Double) {}
let kCFBooleanTrue = true
func AXUIElementSetAttributeValue(_ app: AXUIElement, _ attribute: String, _ value: Bool) {}
func AXObserverAddNotification(_ observer: AXObserver, _ app: AXUIElement, _ notification: String, _ ref: Any?) -> AXError {
  subscriptionCalls[notification, default: 0] += 1
  return subscriptionFailures[notification] ?? .success
}
enum RunMode { case commonModes }
func CFRunLoopGetMain() -> Int { 0 }
func AXObserverGetRunLoopSource(_ observer: AXObserver) -> pid_t { observer.pid }
func CFRunLoopAddSource(_ loop: Int, _ source: pid_t, _ mode: RunMode) { attached.insert(source) }
func CFRunLoopRemoveSource(_ loop: Int, _ source: pid_t, _ mode: RunMode) { attached.remove(source) }
func enqueueEnrichment(key: String? = nil, _ work: @escaping () -> Void) { work() }
func refreshFocusedElement(pid: pid_t) { refreshed.append(pid); focusedElementCache = AXUIElement(pid) }
${production("let observedNotifications =", "// MARK: - Event tap")}
observeApplication(pid: 1)
frontPid = 2; observeApplication(pid: 2)
let afterFailure: [String: Any] = ["attached": Array(attached), "observed": observedPid!, "focusCleared": focusedElementCache == nil]
frontPid = 1; observeApplication(pid: 1)
let returned: [String: Any] = ["attached": Array(attached), "refreshed": refreshed, "createCalls": createCalls]
frontPid = 2; failedCreates.remove(2)
subscriptionFailures = ["selection": .notificationUnsupported, "value": .cannotComplete]
observeApplication(pid: 2)
let beforeRetry = subscriptionCalls
observeApplication(pid: 2)
let retriesThrottled = beforeRetry == subscriptionCalls
subscriptionFailures.removeAll()
observerNotificationAttemptAt["selection"] = Date().addingTimeInterval(-11)
observerNotificationAttemptAt["value"] = Date().addingTimeInterval(-11)
observeApplication(pid: 2)
let transientRecovered = registeredObserverNotifications.contains("value") && !registeredObserverNotifications.contains("selection")
observerNotificationAttemptAt["selection"] = Date().addingTimeInterval(-61)
observeApplication(pid: 2)
let ready = observerWasReady == true && registeredObserverNotifications.count == 5
let beforeExcluded = createCalls
frontPid = 3; excluded = true; observeApplication(pid: 3)
excluded = false; observeApplication(pid: 4)
print(String(data: try JSONSerialization.data(withJSONObject: ["afterFailure": afterFailure, "returned": returned,
  "attached": Array(attached), "retriesThrottled": retriesThrottled, "transientRecovered": transientRecovered,
  "ready": ready, "excludedAndBackgroundUntouched": beforeExcluded == createCalls, "diagnostics": diagnostics]), encoding: .utf8)!)
`);
  assert.deepEqual(result.afterFailure, { attached: [1], observed: 1, focusCleared: true });
  assert.deepEqual(result.returned, { attached: [1], refreshed: [1, 1], createCalls: [1, 2] });
  assert.deepEqual(result.attached, [2]);
  assert.equal(result.retriesThrottled, true);
  assert.equal(result.transientRecovered, true);
  assert.equal(result.ready, true);
  assert.equal(result.excludedAndBackgroundUntouched, true);
  assert.ok(result.diagnostics.includes("observer_unavailable"));
  assert.ok(result.diagnostics.includes("observer_notifications_unavailable"));
  assert.equal(result.diagnostics.at(-1), "observer_ready");
}, 65_000);

test.runIf(process.platform === "darwin")("bounded enrichment coalesces samples, preserves input order, and rejects stale sessions", () => {
  const result = runNative(`
${production("final class HistoryEnrichmentScheduler", "let enrichmentScheduler =")}
let enrichmentQueue = DispatchQueue(label: "synthetic-bounded-enrichment")
let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
enrichmentQueue.async { entered.signal(); release.wait() }; entered.wait()
var values: [Int] = [], overflows = 0
let scheduler = HistoryEnrichmentScheduler(queue: enrichmentQueue, limit: 4) { overflows += 1 }
scheduler.enqueue(key: "sample") { values.append(10) }
for value in 1...3 { scheduler.enqueue { values.append(value) } }
scheduler.enqueue(key: "sample") { values.append(20) }
scheduler.enqueue { values.append(4) }
scheduler.enqueue { values.append(5) }
release.signal(); enrichmentQueue.sync {}
let ordered = values
values.removeAll()
enrichmentQueue.async { entered.signal(); release.wait() }; entered.wait()
for value in 0..<100 { scheduler.enqueue(key: "sample") { values.append(value) } }
scheduler.enqueue { values.append(7) }
release.signal(); enrichmentQueue.sync {}
let coalesced = values
values.removeAll()
enrichmentQueue.async { entered.signal(); release.wait() }; entered.wait()
scheduler.enqueue { values.append(999) }; scheduler.cancelPending()
release.signal(); enrichmentQueue.sync {}
let cancelled = values.isEmpty
let historyWorkSessionKey = "SyntheticHistorySession"
var currentSession: UInt64 = 1
func recorderSession() -> UInt64 { currentSession }
func emitRecorderDiagnostic(code: String, count: Int? = nil, minimumInterval: TimeInterval = 10) {}
func withAXReadBudget<T>(_ seconds: TimeInterval, _ work: () -> T) -> T { work() }
var dragOrigin: String? = "old drag", lastTreeKey: String? = "old window", lastTreeAt: Date? = Date()
func resetAXSamplingCache() { lastTreeKey = nil; lastTreeAt = nil }
${production("let enrichmentScheduler =", "struct FocusSnapshot {")}
enrichmentQueue.async { entered.signal(); release.wait() }; entered.wait()
enqueueEnrichment { values.append(1000) }
currentSession = 2
enqueueEnrichment { values.append(dragOrigin == nil && lastTreeKey == nil ? 2 : -1) }
release.signal(); enrichmentQueue.sync {}
let sessionKeyCleared = enrichmentQueue.sync { Thread.current.threadDictionary[historyWorkSessionKey] == nil }
print(String(data: try JSONSerialization.data(withJSONObject: ["ordered": ordered, "coalesced": coalesced,
  "overflows": overflows, "cancelled": cancelled, "sessionValues": values, "sessionKeyCleared": sessionKeyCleared]), encoding: .utf8)!)
`);
  assert.deepEqual(result.ordered, [1, 2, 3, 4]);
  assert.equal(result.overflows, 2);
  assert.deepEqual(result.coalesced, [99, 7]);
  assert.equal(result.cancelled, true);
  assert.deepEqual(result.sessionValues, [2]);
  assert.equal(result.sessionKeyCleared, true);
}, 65_000);

test.runIf(process.platform === "darwin")("periodic focus refresh preserves a stable identity and never trusts a failed focus read", () => {
  const result = runNative(`
typealias CFString = String
typealias CFTypeRef = Any
enum AXError { case success, cannotComplete }
final class AXUIElement {}
let kAXFocusedUIElementAttribute = "focus"
let axStateLock = NSLock()
var observedPid: pid_t? = 1
let first = AXUIElement(), second = AXUIElement()
var focusedElementCache: AXUIElement? = first
var focusedElementGeneration: UInt64 = 5
var focusedNotificationsAvailable = true, unavailable = false
var focused = first
func AXUIElementCreateApplication(_ pid: pid_t) -> AXUIElement { AXUIElement() }
func AXUIElementSetMessagingTimeout(_ element: AXUIElement, _ seconds: Double) {}
func copyAXAttribute(_ app: AXUIElement, _ attribute: String, _ value: inout Any?) -> AXError {
  value = focused; return unavailable ? .cannotComplete : .success
}
func axElement(_ value: Any?) -> AXUIElement? { value as? AXUIElement }
func CFEqual(_ lhs: AXUIElement, _ rhs: AXUIElement) -> Bool { lhs === rhs }
${production("func refreshFocusedElement(", "// Selected text is")}
refreshFocusedElement(pid: 1)
let stable = focusedElementGeneration == 5 && focusedElementCache === first
focused = second; refreshFocusedElement(pid: 1)
let changed = focusedElementGeneration == 6 && focusedElementCache === second
unavailable = true; refreshFocusedElement(pid: 1)
let cleared = focusedElementGeneration == 7 && focusedElementCache == nil
unavailable = false; focusedNotificationsAvailable = false; refreshFocusedElement(pid: 1)
let unsupported = focusedElementGeneration == 7 && focusedElementCache == nil
focusedNotificationsAvailable = true; refreshFocusedElement(pid: 1)
let restored = focusedElementGeneration == 8 && focusedElementCache === second
focused = first; refreshFocusedElement(pid: 2)
let otherPidUntouched = focusedElementGeneration == 8 && focusedElementCache === second
print(String(data: try JSONSerialization.data(withJSONObject: ["stable": stable, "changed": changed,
  "cleared": cleared, "unsupported": unsupported, "restored": restored, "otherPidUntouched": otherPidUntouched]), encoding: .utf8)!)
`);
  for (const [name, value] of Object.entries(result)) assert.equal(value, true, name);
}, 65_000);

test.runIf(process.platform === "darwin")("AX budgets cover each attribute and sampling fingerprints expire safely", () => {
  const result = runNative(`
typealias CFString = String
typealias CFTypeRef = Any
enum AXError { case success, cannotComplete, attributeUnsupported }
final class AXUIElement {
  var fields: [String: Any], delay: TimeInterval, timeout: Float = 0.2
  init(_ title: String, delay: TimeInterval = 0, children: [AXUIElement] = []) {
    fields = ["role": "AXGroup", "title": title, "children": children]; self.delay = delay
  }
}
let kAXRoleAttribute = "role", kAXSubroleAttribute = "subrole", kAXTitleAttribute = "title"
let kAXDescriptionAttribute = "description", kAXIdentifierAttribute = "identifier", kAXValueAttribute = "value", kAXChildrenAttribute = "children"
func AXUIElementSetMessagingTimeout(_ element: AXUIElement, _ timeout: Float) { element.timeout = timeout }
var queries = 0
func AXUIElementCopyAttributeValue(_ element: AXUIElement, _ attribute: String, _ value: inout Any?) -> AXError {
  queries += 1
  if element.delay > 0 { Thread.sleep(forTimeInterval: min(element.delay, Double(element.timeout))) }
  value = element.fields[attribute]; return value == nil ? .attributeUnsupported : .success
}
let emitLock = NSLock()
var historySessionId: UInt64 = 1
var diagnostics: [[String: Any]] = []
func emit(_ value: [String: Any], expectedSession: UInt64? = nil) {
  if expectedSession == nil || expectedSession == historySessionId { diagnostics.append(value) }
}
func timestamp() -> String { "2026-10-09T12:00:00Z" }
${production("// Diagnostics never carry", "func modifierNames(")}
${production("func accessibilityString(", "func hasSemanticLabel(")}
${production("let AX_TREE_MAX_NODES =", "let axObserverCallback:")}
let slow = AXUIElement("SYNTHETIC_SECRET", delay: 0.04, children: (0..<20).map { _ in AXUIElement("child", delay: 0.04) })
let started = Date(); _ = axTreeLines(window: slow)
let elapsed = Date().timeIntervalSince(started), slowQueries = queries
let budgetRestored = Thread.current.threadDictionary[historyAXDeadlineKey] == nil
let nestedStart = Date(); withAXReadBudget(0.01) { withAXReadBudget(1) { _ = nodePayload(slow) } }
let nestedElapsed = Date().timeIntervalSince(nestedStart)
let password = AXUIElement("Password")
password.fields["subrole"] = "AXSecureTextField"; password.fields["value"] = "SYNTHETIC_PASSWORD"
password.fields["title"] = "SYNTHETIC_PASSWORD_TITLE"
password.fields["description"] = "SYNTHETIC_PASSWORD_DESCRIPTION"
password.fields["identifier"] = "SYNTHETIC_PASSWORD_ID"
let passwordPayload = nodePayload(password)
let passwordContentWithheld = ["value", "title", "description", "identifier"]
  .allSatisfy { passwordPayload[$0] == nil }
let longField = AXUIElement("AXTextArea")
longField.fields["value"] = String(repeating: "a", count: 500)
let longValueLength = (nodePayload(longField)["value"] as? String)?.count ?? 0
let window = AXUIElement("public")
resetAXSamplingCache()
let first = axSnapshot(window: window, windowKey: "1:a", deduplicate: true) != nil
lastTreeAt = nil
let unchanged = axSnapshot(window: window, windowKey: "1:a", deduplicate: true) == nil
window.fields["title"] = "updated"; lastTreeAt = nil
let changed = axSnapshot(window: window, windowKey: "1:a", deduplicate: true) != nil
lastTreeAt = nil
let otherWindow = axSnapshot(window: window, windowKey: "2:a", deduplicate: true) != nil
lastTreeAt = nil; lastTreeDeliveredAt = Date().addingTimeInterval(-31)
let refreshed = axSnapshot(window: window, windowKey: "2:a", deduplicate: true) != nil
resetAXSamplingCache()
let cleared = lastTreeFingerprint == nil && lastTreeKey == nil && lastTreeDeliveredAt == nil
let restored = axSnapshot(window: window, windowKey: "2:a", deduplicate: true) != nil
let wide = AXUIElement("wide", children: (0..<25).map { _ in AXUIElement("child") })
_ = axTreeLines(window: wide)
let many = AXUIElement("many", children: (0..<20).map { _ in AXUIElement("group", children: (0..<20).map { _ in AXUIElement("child") }) })
let limitedLines = axTreeLines(window: many).count
emitRecorderDiagnostic(code: "enrichment_backlog", count: 1)
diagnosticQueue.sync {}
emitRecorderDiagnostic(code: "enrichment_backlog", count: 2)
diagnosticLastAt["enrichment_backlog"] = Date().addingTimeInterval(-11)
emitRecorderDiagnostic(code: "enrichment_backlog", count: 3)
Thread.current.threadDictionary[historyWorkSessionKey] = NSNumber(value: 0)
emitRecorderDiagnostic(code: "stale_session", minimumInterval: 0)
Thread.current.threadDictionary.removeObject(forKey: historyWorkSessionKey)
diagnosticQueue.sync {}
print(String(data: try JSONSerialization.data(withJSONObject: ["elapsed": elapsed, "queries": slowQueries,
  "nestedElapsed": nestedElapsed, "passwordContentWithheld": passwordContentWithheld,
  "longValueLength": longValueLength,
  "budgetRestored": budgetRestored, "first": first, "unchanged": unchanged,
  "changed": changed, "otherWindow": otherWindow, "refreshed": refreshed, "cleared": cleared,
  "restored": restored, "limitedLines": limitedLines, "diagnostics": diagnostics]), encoding: .utf8)!)
`);
  assert.ok(result.elapsed < 0.55, `budget elapsed ${result.elapsed}`);
  assert.ok(result.queries < 20);
  assert.ok(result.nestedElapsed < 0.15, `nested budget elapsed ${result.nestedElapsed}`);
  assert.equal(result.budgetRestored, true);
  assert.equal(result.passwordContentWithheld, true);
  assert.equal(result.longValueLength, 500);
  for (const name of ["first", "unchanged", "changed", "otherWindow", "refreshed", "cleared", "restored"]) {
    assert.equal(result[name], true, name);
  }
  assert.ok(result.limitedLines <= 400);
  assert.ok(result.diagnostics.some((item: any) => item.code === "ax_snapshot_budget_exceeded"));
  assert.deepEqual(result.diagnostics.filter((item: any) => item.code === "enrichment_backlog").map((item: any) => item.count), [1, 5]);
  for (const item of result.diagnostics) {
    assert.equal(item.type, "recorder.diagnostic");
    assert.ok(Object.keys(item).every((key) => ["type", "code", "timestamp", "count"].includes(key)));
    assert.notEqual(item.code, "stale_session");
  }
  assert.ok(!JSON.stringify(result.diagnostics).includes("SYNTHETIC_SECRET"));
}, 65_000);

test.runIf(process.platform === "darwin")("periodic and scroll sampling respect consent and expose permission loss and recovery", () => {
  const result = runNative(`
var monitoring = true, trusted = true, excluded = false
func CGPreflightListenEventAccess() -> Bool { monitoring }
func AXIsProcessTrusted() -> Bool { trusted }
var diagnostics: [String] = [], samples: [[String: Any]] = [], observed: [pid_t] = []
var observerWasReady: Bool?
var eventTap: Int? = 1
var currentSession: UInt64 = 1
func recorderSession() -> UInt64 { currentSession }
func emitRecorderDiagnostic(code: String, count: Int? = nil, minimumInterval: TimeInterval = 10) { diagnostics.append(code) }
func applicationPayload() -> [String: Any] { ["pid": pid_t(1)] }
func isSeparatelyAuthorizedSource(_ application: [String: Any]) -> Bool { excluded }
func observeApplication(pid: pid_t, refreshFocus: Bool = true) { observed.append(pid) }
func emitEvent(kind: String, application: [String: Any]? = nil, extra: [String: Any]) { samples.append(["kind": kind]) }
${production("let samplingLock =", "let callback:")}
${production("var historySamplingTimer:", "public func startHistoryRecorder(")}
currentSession = 2; historySamplingTick(expectedSession: 1)
eventTap = nil; historySamplingTick(expectedSession: 2)
let staleTimersBlocked = diagnostics.isEmpty && samples.isEmpty
eventTap = 1
for _ in 0..<20 { requestScrollSample(application: applicationPayload()) }
let scrollBurst = samples.count
lastScrollSampleAt = Date().addingTimeInterval(-1)
requestScrollSample(application: applicationPayload())
let nextScroll = samples.count
samples.removeAll()
historySamplingTick()
monitoring = false; historySamplingTick()
monitoring = true; historySamplingTick()
let allowed = samples.count
trusted = false; historySamplingTick()
trusted = true; excluded = true; historySamplingTick()
print(String(data: try JSONSerialization.data(withJSONObject: ["scrollBurst": scrollBurst, "nextScroll": nextScroll,
  "allowed": allowed, "samplesAfterBlocked": samples.count, "staleTimersBlocked": staleTimersBlocked,
  "observed": observed, "diagnostics": diagnostics,
  "samplingKinds": samples.map { $0["kind"]! }]), encoding: .utf8)!)
`);
  assert.equal(result.scrollBurst, 1);
  assert.equal(result.nextScroll, 2);
  assert.equal(result.allowed, 3);
  assert.equal(result.samplesAfterBlocked, 3);
  assert.equal(result.staleTimersBlocked, true);
  assert.deepEqual(result.observed, [1, 1, 1]);
  assert.deepEqual(result.samplingKinds, ["sampling.changed", "sampling.changed", "sampling.changed"]);
  assert.equal(result.diagnostics.filter((code: string) => code === "input_monitoring_ready").length, 2);
  assert.ok(result.diagnostics.includes("input_monitoring_unavailable"));
  assert.ok(result.diagnostics.includes("observer_unavailable"));
}, 65_000);
