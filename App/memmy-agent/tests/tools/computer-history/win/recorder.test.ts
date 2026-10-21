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
  const send = (event: Record<string, unknown>) => child.stdout.write(JSON.stringify({ ...event, ...envelope(++sequence) }) + "\n");
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
      if (mode === "already-running") { close(4); return; }
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
  it("reports a competing collector as an occupied session instead of an incomplete recording", async () => {
    const test = setup("already-running");
    await expect(WindowsHistoryRecorder.start(test.options)).rejects.toThrow("windows_collector_already_running");
    expect(fs.readFileSync(test.eventsFile, "utf8")).not.toContain('"eventType":"recording_stopped"');
  });
  it.each(["chrome", "edge"] as const)("filters %s websites before persistence and permits the next allowed page", async (browser) => {
    const test = setup();
    const chromeExe = browser === "edge" ? "C:\\Apps\\msedge.exe" : "C:\\Apps\\chrome.exe";
    fs.writeFileSync(test.policyFile, JSON.stringify({ version: 1, applications: [{ pid: context.pid, executable: chromeExe, browser }] }));
    const observationSettingsFile = path.join(test.directory, "observation.json");
    fs.writeFileSync(observationSettingsFile, JSON.stringify({ memory: { syncEnabled: false }, observation: {
      defaultApplicationBehavior: "do_not_observe", defaultURLBehavior: "do_not_observe",
      rules: [{ scope: "app", bundleID: browser === "edge" ? "win32.msedge" : "win32.chrome", behavior: "observe" },
        { scope: "url", urlDomain: "gutenberg.org", behavior: "observe" }],
    } }));
    const recorder = await WindowsHistoryRecorder.start({ ...test.options, observationSettingsFile });
    const page = (url: string, name: string) => ({ ...full([
      { ...root, name: "Book", controlType: "Document", bounds: [0, 80, 800, 520] },
      { ...text, name, bounds: [10, 100, 700, 25] },
    ]), context: { ...context, executable: chromeExe, browser: { kind: browser, mode: "normal", url, documentId: "1.2", viewport: [0, 80, 800, 520] } } });
    test.send(page("https://www.gutenberg.org/ebooks/11", "ALLOWED_BOOK_A"));
    test.send(page("https://blocked.test/private", "BLOCKED_PAGE_CONTENT"));
    const blocked = page("https://blocked.test/private", "BLOCKED_PAGE_CONTENT");
    test.send({ ...blocked, snapshot: { ...blocked.snapshot, mode: "delta", nodes: undefined,
      added: [], removed: [], unchangedCount: 2 } });
    expect(recorder.state).toBe("running");
    test.send(page("https://www.gutenberg.org/ebooks/55", "ALLOWED_BOOK_B"));
    await recorder.stop();
    const saved = fs.readFileSync(test.eventsFile, "utf8");
    expect(saved).toContain("ALLOWED_BOOK_A"); expect(saved).toContain("ALLOWED_BOOK_B");
    expect(saved).not.toContain("blocked.test"); expect(saved).not.toContain("BLOCKED_PAGE_CONTENT");
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
