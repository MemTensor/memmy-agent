import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { evaluateObservation, type ObservationSettings } from "../../../../src/tools/computer-history/mac/observation-settings.js";

test.runIf(process.platform === "darwin")("native policy gates metadata for blocked apps and matches the Node app/site rules", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("../../../../src/tools/computer-history/mac/human-recorder.swift", import.meta.url)), "utf8");
  const policy = source.slice(source.indexOf("struct NativeObservationPolicy"), source.indexOf("let observationSettingsPath:"));
  const begin = source.slice(source.indexOf("func beginCapture("), source.indexOf("func captureStillAllowed("));
  const content = source.slice(source.indexOf("func captureStillAllowed("), source.indexOf("func hasSemanticLabel("));
  const fixtures: Array<{ settings: ObservationSettings; bundleId: string; url: string | null; metadata: number }> = [];
  for (const appDefault of ["observe", "do_not_observe"] as const) {
    for (const urlDefault of ["observe", "do_not_observe"] as const) {
      for (const bundleId of ["com.apple.Notes", "com.google.Chrome", "com.apple.loginwindow"]) {
        for (const url of [null, "https://bank.com/path", "https://sub.bank.com/", "https://notbank.com/", "https://例子.测试/", "https://xn--fsqu00a.xn--0zwm56d/"]) {
          for (const ruleBehavior of ["observe", "do_not_observe"] as const) {
            const settings: ObservationSettings = { observation: { defaultApplicationBehavior: appDefault, defaultURLBehavior: urlDefault,
              rules: [{ scope: "app", bundleID: "com.google.Chrome", behavior: ruleBehavior }, { scope: "url", urlDomain: "bank.com", behavior: ruleBehavior }, { scope: "url", urlDomain: "xn--fsqu00a.xn--0zwm56d", behavior: ruleBehavior }] } };
            // Native applications intentionally have no URL axis.
            fixtures.push({ settings, bundleId, url: bundleId === "com.google.Chrome" ? url : null,
              metadata: bundleId === "com.apple.loginwindow" || (bundleId === "com.google.Chrome" ? ruleBehavior : appDefault) === "do_not_observe" ? 0 : 1 });
          }
        }
      }
    }
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "native-policy-"));
  const script = path.join(directory, "policy.swift");
  const input = path.join(directory, "fixtures.json");
  fs.writeFileSync(input, JSON.stringify(fixtures));
  fs.writeFileSync(script, `import Foundation
${policy}
typealias AXUIElement = Int
typealias CFString = String
typealias CFTypeRef = Any
let kAXWindowAttribute = "window", kAXRoleAttribute = "role", kAXParentAttribute = "parent"
let kAXSubroleAttribute = "subrole", kAXTitleAttribute = "title", kAXDescriptionAttribute = "description"
let kAXIdentifierAttribute = "identifier", kAXValueAttribute = "value"
enum AXResult { case success, failure }
var contentReads = 0
var fields: [Int: [String: Any]] = [
  1: ["role": "AXWindow", "title": "allowed window"],
  2: ["role": "AXWebArea", "window": 1, "parent": 1],
  3: ["role": "AXWebArea", "window": 1, "parent": 1],
  4: ["role": "AXTextField", "window": 1, "parent": 2, "value": "PUBLIC"],
  5: ["role": "AXTextField", "window": 1, "parent": 3, "value": "SECRET"]
]
func AXUIElementCopyAttributeValue(_ element: Int, _ attribute: String, _ result: inout Any?) -> AXResult {
  if ["title", "description", "identifier", "value", "selected"].contains(attribute) { contentReads += 1 }
  result = fields[element]?[attribute]
  return result == nil ? .failure : .success
}
func AXUIElementGetPid(_ element: Int, _ pid: inout pid_t) -> AXResult { pid = 1; return .success }
func AXUIElementSetMessagingTimeout(_ element: Int, _ timeout: Double) {}
func axElement(_ value: Any?) -> Int? { value as? Int }
func webAreaUrl(_ element: Int) -> String? { element == 2 ? "https://example.com/" : "https://bank.com/" }
func secureInputActive() -> Bool { false }
func CFEqual(_ a: Int, _ b: Int) -> Bool { a == b }
class RunningApp { let processIdentifier: pid_t = 1 }
class NSWorkspace { static let shared = NSWorkspace(); let frontmostApplication: RunningApp? = RunningApp() }
struct CapturePermit { let data: Data; let pid: pid_t; let bundleId: String; let window: Int; let url: String?; let restrictsWebsites: Bool }
var capturePermit: CapturePermit?
var dragOrigin: Int?
var currentData: Data?
var currentURL: String?
var metadataReads = 0
let browserBundleIds: Set<String> = ["com.google.Chrome"]
func observationPolicyBytes() -> Data? { currentData }
func invalidateCapture() { capturePermit = nil; dragOrigin = nil }
func currentWindow(pid: pid_t, bundleId: String) -> (payload: [String: Any], element: Int?) {
  metadataReads += 1
  return (currentURL.map { ["url": $0] } ?? [:], 1)
}
${begin}
${content}
let rows = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [[String: Any]]
var results: [[String: Any]] = []
for row in rows {
  currentData = try JSONSerialization.data(withJSONObject: row["settings"]!)
  currentURL = row["url"] as? String
  metadataReads = 0
  let allowed = beginCapture(application: ["bundleId": row["bundleId"]!, "pid": pid_t(1)], policy: currentData)
  results.append(["allowed": allowed, "metadataReads": metadataReads])
}
currentData = Data("{broken".utf8)
metadataReads = 0
let corrupt = beginCapture(application: ["bundleId": "com.google.Chrome", "pid": pid_t(1)], policy: currentData)
let stale = beginCapture(application: ["bundleId": "com.google.Chrome", "pid": pid_t(1)], policy: Data("old policy".utf8))
let invalidReads = metadataReads
contentReads = 0
_ = nodePayload(1)
let corruptContentReads = contentReads
currentData = Data(#"{"observation":{"defaultApplicationBehavior":"observe","defaultURLBehavior":"observe","rules":[{"scope":"url","urlDomain":"bank.com","behavior":"do_not_observe"}]}}"#.utf8)
currentURL = "https://example.com/"
_ = beginCapture(application: ["bundleId": "com.google.Chrome", "pid": pid_t(1)], policy: currentData)
let publicNode = nodePayload(4)
contentReads = 0
let blockedPane = nodePayload(5)
let blockedPaneReads = contentReads
currentURL = "https://bank.com/"
_ = nodePayload(4)
_ = accessibilityString(4, "selected")
let navigationReads = contentReads
currentURL = "https://example.com/"
_ = beginCapture(application: ["bundleId": "com.google.Chrome", "pid": pid_t(1)], policy: currentData)
currentData = Data("changed".utf8)
_ = nodePayload(4)
let changedPolicyReads = contentReads
print(String(data: try JSONSerialization.data(withJSONObject: ["results": results, "corrupt": corrupt, "stale": stale,
  "invalidReads": invalidReads, "corruptContentReads": corruptContentReads, "publicNode": publicNode,
  "blockedPane": blockedPane, "blockedPaneReads": blockedPaneReads, "navigationReads": navigationReads, "changedPolicyReads": changedPolicyReads]), encoding: .utf8)!)
`);
  try {
    const output = JSON.parse(execFileSync("swift", ["-module-cache-path", path.join(os.tmpdir(), "memmy-recorder-test-swift-cache"), script, input], { encoding: "utf8", timeout: 60_000 }));
    expect(output.results).toEqual(fixtures.map((fixture) => ({
      allowed: evaluateObservation(fixture.settings, { bundleId: fixture.bundleId, url: fixture.url }).observe,
      metadataReads: fixture.metadata,
    })));
    expect([output.corrupt, output.stale, output.invalidReads]).toEqual([false, false, 0]);
    expect(output.publicNode.value).toBe("PUBLIC");
    expect(output.blockedPane).toEqual({});
    expect([output.corruptContentReads, output.blockedPaneReads, output.navigationReads, output.changedPolicyReads]).toEqual([0, 0, 0, 0]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}, 65_000);
