import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const source = fs.readFileSync(fileURLToPath(new URL("../../../../src/tools/computer-history/mac/human-recorder.swift", import.meta.url)), "utf8");
function production(start: string, end?: string) {
  const from = source.indexOf(start), to = end ? source.indexOf(end, from + start.length) : source.length;
  assert.ok(from >= 0 && to > from); return source.slice(from, to);
}
function runNative(script: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mac-checkpoint-native-"));
  try {
    const file = path.join(root, "fixture.swift");
    fs.writeFileSync(file, "import Foundation\nimport Dispatch\nimport Darwin\n" + script);
    return JSON.parse(execFileSync("swift", ["-module-cache-path", path.join(os.tmpdir(), "memmy-recorder-test-swift-cache"), file], { encoding: "utf8", timeout: 60_000 }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// Native production queue/control code, with no desktop access or TCC prompts.
test.runIf(process.platform === "darwin")("Mac checkpoints cannot be dropped or crossed by coalesced samples", () => {
  const result = runNative(`
${production("final class HistoryEnrichmentScheduler", "let enrichmentScheduler =")}
let queue = DispatchQueue(label: "test.checkpoints")
let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
queue.async { entered.signal(); release.wait() }; entered.wait()
var values: [String] = []
let scheduler = HistoryEnrichmentScheduler(queue: queue, limit: 64) {}
scheduler.enqueue(key: "sample") { values.append("before") }
scheduler.enqueue { values.append("input") }
let accepted = scheduler.checkpoint { values.append("marker") }
scheduler.enqueue(key: "sample") { values.append("after") }
release.signal(); queue.sync {}
let ordered = values
queue.async { entered.signal(); release.wait() }; entered.wait()
let bounded = (0..<17).map { _ in scheduler.checkpoint {} }
release.signal(); queue.sync {}
print(String(data: try JSONSerialization.data(withJSONObject: ["accepted": accepted, "ordered": ordered, "bounded": bounded]), encoding: .utf8)!)
`);
  assert.equal(result.accepted, true);
  assert.deepEqual(result.ordered, ["before", "input", "marker", "after"]);
  assert.deepEqual(result.bounded, [...Array(16).fill(true), false]);
}, 65_000);

test.runIf(process.platform === "darwin")("Mac controls handle fragmented input, discard oversized commands and release on EOF", () => {
  const result = runNative(`
${production("public final class HistoryControlInput")}
final class Results: @unchecked Sendable {
  let lock = NSLock(); var ids: [String] = []
  func append(_ id: String) { lock.lock(); ids.append(id); lock.unlock() }
}
let results = Results(), ended = DispatchSemaphore(value: 0), closed = DispatchSemaphore(value: 0)
let pipe = Pipe()
let controls = HistoryControlInput(fileDescriptor: pipe.fileHandleForReading.fileDescriptor,
  onCheckpoint: { results.append($0) }, onEnd: { ended.signal() }, onClose: { closed.signal() })
let id = "c892ee91-1d7c-4b43-b149-97284fe3caff"
try pipe.fileHandleForWriting.write(contentsOf: Data("{\\"kind\\":\\"check".utf8))
try pipe.fileHandleForWriting.write(contentsOf: Data(("point\\",\\"id\\":\\"" + id + "\\"}\\n").utf8))
try pipe.fileHandleForWriting.write(contentsOf: Data((String(repeating: "x", count: 20_000) + "\\n").utf8))
try pipe.fileHandleForWriting.write(contentsOf: Data(("{\\"kind\\":\\"checkpoint\\",\\"id\\":\\"" + id + "\\"}\\n").utf8))
try pipe.fileHandleForWriting.close()
let eof = ended.wait(timeout: .now() + 5) == .success
let cleanup = closed.wait(timeout: .now() + 5) == .success
controls.cancel(); try pipe.fileHandleForReading.close()
print(String(data: try JSONSerialization.data(withJSONObject: ["ids": results.ids, "eof": eof, "cleanup": cleanup]), encoding: .utf8)!)
`);
  assert.deepEqual(result.ids, Array(2).fill("c892ee91-1d7c-4b43-b149-97284fe3caff"));
  assert.equal(result.eof, true); assert.equal(result.cleanup, true);
}, 65_000);

test.runIf(process.platform === "darwin")("Mac checkpoint diagnostics preserve original fault times and clear throttled counts", () => {
  const result = runNative(`
let diagnosticLock = NSLock()
var diagnosticCounts = ["enrichment_backlog": 3]
var diagnosticPendingAt = ["enrichment_backlog": Date(timeIntervalSince1970: 12)]
var pendingDiagnostics: [String: (payload: [String: Any], session: UInt64)] = [
  "heartbeat": ([:], 7), "observer_unavailable": ([:], 7)]
var payloads: [[String: Any]] = []
func timestampAt(_ date: Date) -> String { String(date.timeIntervalSince1970) }
func queueRecorderDiagnostic(_ value: [String: Any], session: UInt64) { payloads.append(value) }
${production("func flushCheckpointDiagnostics", "// AX calls")}
let issues = flushCheckpointDiagnostics(session: 7)
pendingDiagnostics.removeAll()
let next = flushCheckpointDiagnostics(session: 7)
print(String(data: try JSONSerialization.data(withJSONObject: ["issues": issues, "next": next,
  "payloads": payloads, "countsEmpty": diagnosticCounts.isEmpty, "timesEmpty": diagnosticPendingAt.isEmpty]), encoding: .utf8)!)
`);
  assert.deepEqual(result.issues, ["enrichment_backlog", "observer_unavailable"]);
  assert.deepEqual(result.next, []);
  assert.deepEqual(result.payloads, [{ type: "recorder.diagnostic", code: "enrichment_backlog", timestamp: "12.0", count: 3 }]);
  assert.equal(result.countsEmpty, true); assert.equal(result.timesEmpty, true);
}, 65_000);
