import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WindowsHistoryRecorder } from "../../../../src/tools/computer-history/win/recorder.js";
import { parseNativePolicy, readNativePolicy } from "../../../../src/tools/computer-history/win/policy.js";
import { loadRecords, renderHumanSummary } from "../../../../src/tools/computer-history/core/summarize-history.js";
import { applyNarrative, compactEventEvidence, isNarrated, writeSegmentNarrative } from "../../../../src/tools/computer-history/core/summary-writer.js";
import { context, counters, envelope, full, policyInput, root, text } from "./fixtures.js";
import { checkpointRequest } from "../../../../src/tools/computer-history/core/recorder-checkpoint.js";
import { parseRecorderArgs, runWindowsRecorder } from "../../../../src/tools/computer-history/win/record-human-history.js";

vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawn: vi.fn() }));
const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.mocked(spawn).mockReset(); });
// Retain failed-run evidence; temp paths are reported by Vitest on failure.
function setup(mode = "normal") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-win-adapter-")); directories.push(directory);
  const policyFile = path.join(directory, "policy.json");
  const eventsFile = path.join(directory, "events.jsonl");
  fs.writeFileSync(policyFile, JSON.stringify(policyInput));
  const child = Object.assign(new EventEmitter(), { pid: 321, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => { close(null); return true; }) });
  let sequence = 0;
  let ended = false;
  const send = (event: Record<string, unknown>, timestamp?: string) => child.stdout.write(JSON.stringify({ ...event, ...envelope(++sequence), ...(timestamp ? { timestamp } : {}) }) + "\n");
  const close = (code: number | null) => { if (!ended) { ended = true; child.stdout.end(); child.stderr.end(); child.emit("close", code); } };
  const stop = () => { send({ kind: "session.stopped", reason: "stop_command", hooksDetached: true, counters }); close(0); };
  child.stdin.on("data", (bytes: Buffer) => {
    const command = bytes.toString().trim();
    queueMicrotask(() => {
      if (ended) return;
      if (command === "pause" && mode !== "no-ack") send({ kind: "session.paused", alreadyPaused: false });
      if (command === "resume") { send({ kind: "session.resumed", alreadyRunning: false }); send({ ...full(), context: { ...context, generation: 2 } }); }
      if (command === "stop" && mode !== "stubborn") stop();
    });
  });
  child.stdin.on("finish", () => queueMicrotask(() => { if (!ended && mode !== "stubborn") stop(); }));
  vi.mocked(spawn).mockImplementation(() => {
    queueMicrotask(() => {
      if (mode === "no-start") return;
      send({ kind: "session.started", collector: { version: "1", pid: child.pid, testHooks: mode === "test-hooks" },
        policyRevision: readNativePolicy(policyFile).revision,
        options: { seconds: 30, rotateSeconds: 600, sampleMs: 1000, inputHooks: false, parentPid: process.pid }, segment: null });
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  });
  return { directory, child, policyFile, eventsFile, send, close, options: { binary: process.execPath, policyFile, eventsFile,
    title: "Release review api_key=metadata-secret", commandTimeoutMs: 200 } };
}
describe("owned Windows collector lifecycle", () => {
  const request = (id = "12345678-1234-1234-1234-123456789abc", range = {}) => checkpointRequest.parse({ kind: "checkpoint", id, ...range });
  it("rotates files at the native marker while retaining the collector, coverage and later snapshots", async () => {
    const test = setup(), recorder = await WindowsHistoryRecorder.start(test.options);
    const nextFile = path.join(test.directory, "next", "events.jsonl");
    const at = (ms: number) => `2026-10-02T01:00:00.${String(ms).padStart(3, "0")}Z`;
    test.send(full([root, {...text, name: "BEFORE_ROTATION"}]), at(1));
    test.send({kind: "capture.gap", code: "query_unavailable", from: at(2), through: at(3)}, at(3));
    const id = "12345678-1234-1234-1234-123456789ab1";
    const rotation = recorder.rotate({kind: "rotate", id, eventsFile: nextFile, title: "Next segment"});
    expect(fs.existsSync(nextFile)).toBe(false);
    test.send({kind: "session.checkpoint", id, captureSequence: 10, complete: true}, at(4));
    const {nodes: _nodes, ...snapshot} = full().snapshot;
    const delta = {...full(), snapshot: {...snapshot, mode: "delta", added: [{...text, name: "AFTER_ROTATION"}],
      removed: [text.key], unchangedCount: 1}};
    test.send(delta, at(5));
    await rotation;
    const original = fs.readFileSync(test.eventsFile, "utf8");
    expect(original).toContain("BEFORE_ROTATION"); expect(original).not.toContain("AFTER_ROTATION");
    const next = fs.readFileSync(nextFile, "utf8");
    expect(next).toContain("AFTER_ROTATION"); expect(next).toContain('"collectorContinues":true');
    const nativeId = JSON.parse(original.split("\n")[1]!).details.nativeSessionId;
    expect(JSON.parse(next.split("\n")[1]!).details.nativeSessionId).toBe(nativeId);
    expect(recorder.pid).toBe(test.child.pid); expect(spawn).toHaveBeenCalledOnce();
    const command = request(undefined, {from: at(0), through: at(6)}), checkpoint = recorder.checkpoint(command);
    test.send({kind: "session.checkpoint", id: command.id, captureSequence: 20, complete: true}, at(7));
    expect(await checkpoint).toMatchObject({complete: false, issues: ["query_unavailable"]});
    expect(fs.readFileSync(test.eventsFile, "utf8")).toBe(original);
    await recorder.stop();
    expect(fs.readFileSync(test.eventsFile, "utf8")).toBe(original);
  });
  it("rejects unsafe rotation paths without interrupting the active collector", async () => {
    const test = setup(), recorder = await WindowsHistoryRecorder.start(test.options);
    for (const eventsFile of [test.eventsFile, test.policyFile, "relative.jsonl"])
      await expect(recorder.rotate({kind: "rotate", id: request().id, eventsFile, title: "Invalid"})).rejects.toThrow("path_invalid");
    expect(recorder.state).toBe("running"); await recorder.stop();
  });
  it("waits for the ordered native marker, fsyncs it and freezes the exact byte position", async () => {
    const test = setup(), recorder = await WindowsHistoryRecorder.start(test.options);
    const flush = vi.spyOn(fs, "fsyncSync"), write = vi.spyOn(test.child.stdin, "write");
    const command = request();
    let acknowledged = false;
    const checkpoint = recorder.checkpoint(command);
    expect(recorder.checkpoint(command)).toBe(checkpoint);
    void checkpoint.then(() => { acknowledged = true; });
    test.send(full([root, { ...text, name: "BEFORE_MARKER" }]));
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    expect(flush).not.toHaveBeenCalled();
    test.send({ kind: "session.checkpoint", id: command.id, captureSequence: 20, complete: true });
    test.send(full([root, { ...text, name: "AFTER_MARKER" }]));
    const result = await checkpoint;
    expect(result).toMatchObject({ complete: true, rangeEvaluated: true, watermark: { captureSequence: 20, nativeSequence: 3, recordingSequence: 3 } });
    expect(flush).toHaveBeenCalledOnce();
    const bytes = fs.readFileSync(test.eventsFile);
    expect(bytes.length).toBeGreaterThan(result.watermark.bytes);
    const prefix = bytes.subarray(0, result.watermark.bytes).toString("utf8");
    expect(prefix).toContain("BEFORE_MARKER"); expect(prefix).not.toContain("AFTER_MARKER");
    expect(JSON.parse(prefix.trim().split("\n").at(-1)!)).toMatchObject({ eventType: "recording_checkpoint", details: { checkpointId: command.id, nativeSequence: 3, captureSequence: 20 } });
    expect(write.mock.calls.filter(([line]) => String(line).startsWith("checkpoint "))).toHaveLength(1);
    await recorder.stop();
  });
  it("keeps damaged intervals partial while later healthy fragments and starting fences recover", async () => {
    const test = setup(), recorder = await WindowsHistoryRecorder.start(test.options);
    const at = (ms: number) => `2026-10-02T01:00:00.${String(ms).padStart(3, "0")}Z`;
    test.send({ kind: "capture.gap", code: "queue_overflow", from: at(1), through: at(2) }, at(2));
    const damaged = request(undefined, { from: at(0), through: at(3) });
    const first = recorder.checkpoint(damaged);
    test.send({ kind: "session.checkpoint", id: damaged.id, captureSequence: 10, complete: true }, at(4));
    expect(await first).toMatchObject({ complete: false, rangeEvaluated: true, issues: ["queue_overflow"] });
    expect(fs.readFileSync(test.eventsFile, "utf8")).toContain('"eventType":"recording_gap"');
    const gapRecord = fs.readFileSync(test.eventsFile, "utf8").trim().split("\n").map(line => JSON.parse(line)).find(record => record.eventType === "recording_gap");
    expect(gapRecord.details).toMatchObject({ nativeSequence: 2, code: "queue_overflow", from: at(1), through: at(2) });
    const healthy = request("12345678-1234-1234-1234-123456789abd", { from: at(5), through: at(7) });
    const next = recorder.checkpoint(healthy);
    test.send(full(), at(6));
    test.send({ kind: "session.checkpoint", id: healthy.id, captureSequence: 20, complete: true }, at(8));
    expect(await next).toMatchObject({ complete: true, issues: [] });
    const initial = request("12345678-1234-1234-1234-123456789abe");
    const fence = recorder.checkpoint(initial);
    test.send({ kind: "session.checkpoint", id: initial.id, captureSequence: 21, complete: true }, at(9));
    expect(await fence).toMatchObject({ complete: true, rangeEvaluated: true });
    const old = request("12345678-1234-1234-1234-123456789abf", { from: at(0), through: at(3) });
    const previous = recorder.checkpoint(old);
    test.send({ kind: "session.checkpoint", id: old.id, captureSequence: 22, complete: true }, at(10));
    expect((await previous).complete).toBe(false);
    await recorder.stop();
  });
  it("times out without a native marker, ignores its late reply and allows the next fence", async () => {
    const test = setup(), recorder = await WindowsHistoryRecorder.start(test.options);
    const command = request();
    await expect(recorder.checkpoint(command)).rejects.toThrow("windows_checkpoint_timeout");
    test.send({ kind: "session.checkpoint", id: command.id, captureSequence: 10, complete: true });
    expect(fs.readFileSync(test.eventsFile, "utf8")).not.toContain("recording_checkpoint");
    const next = request("12345678-1234-1234-1234-123456789abd");
    const point = recorder.checkpoint(next);
    test.send({ kind: "session.checkpoint", id: next.id, captureSequence: 11, complete: true });
    expect((await point).complete).toBe(true);
    await recorder.stop();
  });
  it("cancels pending fences on pause and shutdown", async () => {
    const test = setup(), recorder = await WindowsHistoryRecorder.start(test.options);
    const command = request(), point = recorder.checkpoint(command);
    const paused = recorder.pause();
    await expect(point).rejects.toThrow("pausing"); await paused;
    test.send({ kind: "session.checkpoint", id: command.id, captureSequence: 10, complete: true });
    await recorder.resume();
    const final = recorder.checkpoint(request("12345678-1234-1234-1234-123456789abd"));
    const stopped = recorder.stop();
    await expect(final).rejects.toThrow("stopping"); await stopped;
  });
  it("never acknowledges a marker when durable persistence fails", async () => {
    const test = setup(), recorder = await WindowsHistoryRecorder.start(test.options);
    const command = request(), point = recorder.checkpoint(command);
    const flush = vi.spyOn(fs, "fsyncSync").mockImplementation(() => { throw new Error("disk failure"); });
    test.send({ kind: "session.checkpoint", id: command.id, captureSequence: 10, complete: true });
    await expect(point).rejects.toThrow("flush_failed");
    await expect(recorder.finished).rejects.toThrow("flush_failed"); flush.mockRestore();
    expect(fs.readFileSync(test.eventsFile, "utf8")).not.toContain("recording_checkpoint");
  });
  it("rejects unsolicited native markers", async () => {
    const test = setup(), recorder = await WindowsHistoryRecorder.start(test.options);
    test.send({ kind: "session.checkpoint", id: request().id, captureSequence: 10, complete: true });
    await expect(recorder.finished).rejects.toThrow("checkpoint_unrequested");
  });
  it("publishes content-free health only after a native event is persisted", async () => {
    const test = setup();
    // Vitest's piped stdin is already at EOF; give the CLI a live control stream.
    vi.spyOn(process, "stdin", "get").mockReturnValue(new PassThrough() as unknown as typeof process.stdin);
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const running = runWindowsRecorder(["--binary", process.execPath, "--policy", test.policyFile,
      "--out", test.eventsFile, "--title", "Private document title"]);
    await vi.waitFor(() => expect(output).toHaveBeenCalledWith('{"kind":"recorder.state","state":"running"}'));
    expect(output.mock.calls.some(([line]) => String(line).startsWith("[recorder-health] "))).toBe(false);
    test.send(full([root, { ...text, name: "PRIVATE_CAPTURE_CONTENT" }]));
    expect(fs.readFileSync(test.eventsFile, "utf8")).toContain("PRIVATE_CAPTURE_CONTENT");
    const signals = output.mock.calls.map(([line]) => String(line)).filter(line => line.startsWith("[recorder-health] "));
    expect(signals.map(line => JSON.parse(line.slice("[recorder-health] ".length))))
      .toEqual([{ code: "event_recorded", timestamp: "2026-10-02T01:00:00.000Z" }]);
    expect(signals.join("\n")).not.toMatch(/PRIVATE_CAPTURE_CONTENT|Private document title|heartbeat/);
    test.child.stdin.write("stop\n");
    await running;
    expect(output).toHaveBeenCalledWith('{"kind":"recorder.state","state":"stopped"}');
  });
  it("applies shared source exclusions before persisting native Windows content", async () => {
    const test = setup();
    const observationSettingsFile = path.join(test.directory, "observation.json");
    const writeSettings = (rules: unknown[]) => fs.writeFileSync(observationSettingsFile, JSON.stringify({
      observation: { defaultApplicationBehavior: "observe", defaultURLBehavior: "observe", rules },
    }));
    writeSettings([{ scope: "app", bundleID: "win32.fixture", behavior: "do_not_observe" }]);
    const recorder = await WindowsHistoryRecorder.start({ ...test.options, observationSettingsFile });
    test.send(full([root, { ...text, name: "EXCLUDED_NATIVE_TEXT" }]));
    expect(fs.readFileSync(test.eventsFile, "utf8")).not.toContain("EXCLUDED_NATIVE_TEXT");
    writeSettings([]);
    test.send(full([root, { ...text, name: "AUTHORIZED_NATIVE_TEXT" }]));
    expect(fs.readFileSync(test.eventsFile, "utf8")).toContain("AUTHORIZED_NATIVE_TEXT");
    fs.writeFileSync(observationSettingsFile, "broken live policy");
    test.send(full([root, { ...text, name: "AFTER_CORRUPT_POLICY" }]));
    await expect(recorder.finished).rejects.toThrow();
    expect(fs.readFileSync(test.eventsFile, "utf8")).not.toContain("AFTER_CORRUPT_POLICY");
  });
  it("accepts the native stop hotkey only after terminal output and clean process close", async () => {
    const test = setup();
    const recorder = await WindowsHistoryRecorder.start(test.options);
    test.send({ kind: "session.stopped", reason: "stop_hotkey", hooksDetached: true, counters });
    expect(fs.readFileSync(test.eventsFile, "utf8")).not.toContain('"eventType":"recording_stopped"');
    test.close(0);
    await recorder.finished;
    expect(recorder.state).toBe("stopped");
    expect(fs.readFileSync(test.eventsFile, "utf8")).toContain('"reason":"stop_hotkey"');
  });
  it("records only sanitized content, pauses/resumes and completes the shared summary chain", async () => {
    const test = setup();
    const recorder = await WindowsHistoryRecorder.start(test.options);
    const raw = "release 218 api_key=supersecret credential Bearer abcdefghijklmnop";
    test.send(full([root, { ...text, name: raw }]));
    const beforePause = fs.readFileSync(test.eventsFile, "utf8");
    const pause = recorder.pause();
    test.send(full([root, { ...text, name: "discarded inflight capture" }]));
    await pause;
    expect(recorder.state).toBe("paused");
    await recorder.resume();
    await recorder.stop();
    const contents = fs.readFileSync(test.eventsFile, "utf8");
    expect(beforePause).toContain("release 218");
    for (const secret of ["supersecret", "abcdefghijklmnop", "metadata-secret", "discarded inflight capture"]) expect(contents).not.toContain(secret);
    expect(contents).toContain("[REDACTED]");
    expect(recorder.state).toBe("stopped");
    const evidence = compactEventEvidence(contents.split("\n"));
    expect(evidence).toContain("release 218"); expect(evidence).not.toContain("click(s)");
    const summary = renderHumanSummary({ file: test.eventsFile, ...loadRecords(test.eventsFile) });
    expect(summary).toContain("status: completed"); expect(summary).toContain("windows:");
    const chat = vi.fn(async () => ({ content: JSON.stringify({ title: "Release review", description: "You reviewed release 218.", body: "## Recording summary\n\nYou reviewed release 218." }) }));
    const resolver = () => ({ provider: { chatWithRetry: chat } as any, model: "test" });
    const narrative = await writeSegmentNarrative(resolver, { applications: [], evidence, window: "10min" });
    const narrated = applyNarrative(summary, narrative!);
    expect(isNarrated(narrated)).toBe(true);
    expect(narrated).toContain("release 218");
    expect(JSON.stringify(chat.mock.calls)).not.toContain("supersecret");
  });
  it("pauses before publishing a new instance-bound policy and resumes with a fresh baseline", async () => {
    const test = setup(); const recorder = await WindowsHistoryRecorder.start(test.options);
    test.send(full());
    const updated = parseNativePolicy({ ...policyInput, sensitiveAutomationIds: ["new-private"] });
    await recorder.updatePolicy(updated);
    expect(readNativePolicy(test.policyFile).policy.sensitiveAutomationIds).toEqual(["new-private"]);
    expect(recorder.state).toBe("running"); await recorder.endInput();
  });
  it("leaves collection paused when publishing policy fails", async () => {
    const test = setup(); const recorder = await WindowsHistoryRecorder.start(test.options);
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("denied"); });
    await expect(recorder.updatePolicy(parseNativePolicy(policyInput))).rejects.toThrow("policy_update_failed");
    expect(recorder.state).toBe("paused"); rename.mockRestore(); await recorder.stop();
  });
  it.each(["no-start", "test-hooks"])("cleans up a rejected startup (%s)", async (mode) => {
    const test = setup(mode); await expect(WindowsHistoryRecorder.start(test.options)).rejects.toThrow();
    expect(test.child.stdin.writableEnded).toBe(true);
  });
  it("stops on command timeout and rejects invalid concurrent commands", async () => {
    const test = setup("no-ack"); const recorder = await WindowsHistoryRecorder.start(test.options);
    const pause = recorder.pause(); await expect(recorder.resume()).rejects.toThrow("state_invalid");
    await expect(pause).rejects.toThrow("ack_timeout"); await expect(recorder.finished).rejects.toThrow("ack_timeout");
  });
  it.each(["invalid-protocol", "partial-frame", "exit", "privacy"])("preserves an incomplete recording on %s", async (mode) => {
    const test = setup(); const recorder = await WindowsHistoryRecorder.start(test.options);
    if (mode === "invalid-protocol") test.child.stdout.write('{"secret":"do not leak"}\n');
    else if (mode === "partial-frame") { test.child.stdout.write("{"); test.close(0); }
    else if (mode === "exit") test.close(1);
    else test.send(full([root, { ...text, password: true, name: "password secret" }]));
    await expect(recorder.finished).rejects.toThrow();
    const contents = fs.readFileSync(test.eventsFile, "utf8");
    expect(contents).not.toContain("do not leak"); expect(contents).not.toContain("password secret");
    expect(contents).not.toContain("recording_stopped");
    expect(renderHumanSummary({ file: test.eventsFile, ...loadRecords(test.eventsFile) })).toContain("status: incomplete");
  });
  it("fails on disk writes and refuses to overwrite recordings", async () => {
    const test = setup(); const recorder = await WindowsHistoryRecorder.start(test.options);
    const write = vi.spyOn(fs, "writeSync").mockImplementation(() => { throw new Error("full"); });
    test.send(full()); await expect(recorder.finished).rejects.toThrow("recording_write_failed"); write.mockRestore();
    expect(fs.readFileSync(test.eventsFile, "utf8")).not.toContain("recording_stopped");
    await expect(WindowsHistoryRecorder.start(test.options)).rejects.toThrow();
  });
  it("rejects a pause acknowledgement when its record cannot be written", async () => {
    const test = setup(); const recorder = await WindowsHistoryRecorder.start(test.options);
    const write = vi.spyOn(fs, "writeSync").mockImplementation(() => { throw new Error("full"); });
    await expect(recorder.pause()).rejects.toThrow("recording_write_failed");
    await expect(recorder.finished).rejects.toThrow("recording_write_failed"); write.mockRestore();
  });
  it("stops successfully even when a pending pause is superseded", async () => {
    const test = setup(); const recorder = await WindowsHistoryRecorder.start(test.options);
    const pause = recorder.pause(); const stop = recorder.stop();
    await expect(pause).rejects.toThrow("stopping"); await stop;
    expect(recorder.state).toBe("stopped");
  });
  it("rolls back the completion marker when the final flush fails", async () => {
    const test = setup(); const recorder = await WindowsHistoryRecorder.start(test.options);
    const flush = vi.spyOn(fs, "fsyncSync").mockImplementation(() => { throw new Error("disk error"); });
    await expect(recorder.stop()).rejects.toThrow("recording_write_failed"); flush.mockRestore();
    expect(fs.readFileSync(test.eventsFile, "utf8")).not.toContain("recording_stopped");
  });
  it("kills only its owned child when stop is not acknowledged", async () => {
    const test = setup("stubborn"); const recorder = await WindowsHistoryRecorder.start(test.options);
    await expect(recorder.stop()).rejects.toThrow("control_stop_timeout");
    expect(test.child.kill).toHaveBeenCalledOnce();
    expect(recorder.state).toBe("failed");
    expect(fs.readFileSync(test.eventsFile, "utf8")).not.toContain("recording_stopped");
  });
  it("redacts credential-shaped text supplied by a model before summary persistence", async () => {
    const chat = vi.fn(async () => ({ content: JSON.stringify({ title: "Release api_key=modelsecret", description: "Review password=generatedsecret", body: "## Recording summary\n\nBearer abcdefghijklmnop" }) }));
    const narrative = await writeSegmentNarrative(() => ({ provider: { chatWithRetry: chat } as any, model: "test" }),
      { applications: [], evidence: "Release 218", window: "10min" });
    const markdown = applyNarrative("---\nsummary_state: pending\n---\n\n## Citations\n", narrative!);
    for (const secret of ["modelsecret", "generatedsecret", "abcdefghijklmnop"]) expect(markdown).not.toContain(secret);
    expect(markdown).toContain("[REDACTED]");
  });
  it("validates the developer CLI without starting an application", () => {
    expect(parseRecorderArgs(["--help"])).toBeNull();
    const args = ["--policy", "C:\\Policy File.json", "--out", "C:\\Output File.jsonl"];
    expect(parseRecorderArgs(args)?.seconds).toBe(30);
    for (const extra of [["--seconds", "1e3"], ["--out", "another.jsonl"], ["--unknown", "x"], ["--seconds"]]) {
      expect(() => parseRecorderArgs([...args, ...extra])).toThrow("arguments_invalid");
    }
  });
});
