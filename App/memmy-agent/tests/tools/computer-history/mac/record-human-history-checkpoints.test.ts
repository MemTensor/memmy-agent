import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { persistedCheckpoint } from "../../../../src/tools/computer-history/core/recorder-checkpoint.js";

const fixture = vi.hoisted(() => ({ input: undefined as PassThrough | undefined, faults: false, commands: [] as unknown[],
  rotation: undefined as { eventsFile: string; title: string } | undefined, spawns: 0, stopAtRotation: false }));
const id = "c892ee91-1d7c-4b43-b149-97284fe3caff";
vi.mock("../../../../src/tools/computer-history/mac/native-helper.js", () => ({
  historyNativeCommand: async () => ({ binary: "/controlled/mac-helper", args: [], managed: true }),
}));
vi.mock("node:readline", async () => {
  const actual = await vi.importActual<typeof import("node:readline")>("node:readline");
  const createInterface = (options: any) => actual.createInterface({ ...options,
    input: options.input === process.stdin ? fixture.input! : options.input });
  return { ...actual, createInterface, default: { ...actual, createInterface } };
});
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const { promisify } = await import("node:util");
  const execFile = vi.fn();
  Object.defineProperty(execFile, promisify.custom, { value: async () => ({ stdout: JSON.stringify({
    inputMonitoring: true, screenRecording: false, accessibility: true, mainDisplayWidth: 100, mainDisplayHeight: 100,
  }), stderr: "" }) });
  return { ...actual, execFile, spawn: () => {
    fixture.spawns++;
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(),
      stderr: new PassThrough(), killed: false, kill() { this.killed = true; return true; } });
    const app = { name: "Controlled Notes", bundleIdentifier: "com.example.notes", secureInput: false };
    const ax = { mode: "fullTree", windowKey: "controlled", text: "AXStaticText||Persistent document|||" };
    const window = { url: "https://controlled.example/page" };
    child.stdin.on("data", data => {
      const command = JSON.parse(data.toString()); fixture.commands.push(command);
      const marker = { kind: "session.checkpoint", id: command.id, complete: true,
        nativeSessionId: "a".repeat(32), nativeSequence: fixture.commands.length * 3, issues: fixture.faults ? ["ax_snapshot_budget_exceeded"] : [] };
      // One native stdout chunk deliberately delivers the marker and later
      // observation together, while an earlier text burst is still buffered.
      child.stdout.write(JSON.stringify(marker) + "\n" + JSON.stringify({ kind: "mouse.click", app, ax, window,
        timestamp: new Date().toISOString(), mouse: { target: { role: "AXButton", title: fixture.commands.length === 1 ? "after-boundary" : "after-second-boundary" } } }) + "\n");
      if (fixture.stopAtRotation) child.stdout.write(JSON.stringify({ kind: "keyboard.shortcut", keyboard: {
        keyCode: 15, modifiers: ["cmd", "control", "option"] } }) + "\n");
      if (!fixture.rotation || fixture.commands.length === 2 || fixture.stopAtRotation) {
        setImmediate(() => { child.stdout.end(); child.emit("exit", 0, null); child.emit("close", 0, null); });
      }
    });
    setImmediate(() => {
      if (fixture.faults) for (let i = 0; i < 2; i++) child.stdout.write(JSON.stringify({
        type: "recorder.diagnostic", timestamp: new Date().toISOString(), code: "ax_snapshot_budget_exceeded", count: 1 }) + "\n");
      child.stdout.write(JSON.stringify({ kind: "keyboard.text_input", app, ax, window, timestamp: new Date().toISOString(),
        keyboard: { text: "before-boundary", target: { role: "AXTextField" } } }) + "\n");
      fixture.input!.write(JSON.stringify(fixture.rotation ? { kind: "rotate", id, ...fixture.rotation } : { kind: "checkpoint", id,
        from: "2026-10-21T00:00:00.000Z", through: "2026-10-21T01:00:00.000Z" }) + "\n");
    });
    return child;
  } };
});
import { run } from "../../../../src/tools/computer-history/mac/record-human-history.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let root: string, listeners: Map<string, Function[]>;
beforeEach(() => {
  fixture.input = new PassThrough(); fixture.commands = []; fixture.rotation = undefined; fixture.spawns = 0; fixture.stopAtRotation = false;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mac-checkpoint-ingest-"));
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  listeners = new Map(["SIGINT", "SIGTERM"].map(signal => [signal, process.listeners(signal)]));
});

it.each([false, true])("continues one native collector through output rotation and keeps both boundaries durable (faults=%s)", async faults => {
  fixture.faults = faults;
  const first = path.join(root, "first", "events.jsonl"), next = path.join(root, "下一段", "events.jsonl");
  fixture.rotation = { eventsFile: next, title: "下一段" };
  let frozen: Buffer | undefined;
  const secondId = "b3fd24a5-fb7d-4c2c-8d1a-706ff73607d1";
  const logs = vi.spyOn(console, "log").mockImplementation(line => {
    if (String(line).startsWith("[recorder-rotation] ")) {
      expect(JSON.parse(String(line).slice("[recorder-rotation] ".length))).toEqual({ id, complete: true });
      frozen = fs.readFileSync(first);
      fixture.input!.write(JSON.stringify({ kind: "checkpoint", id: secondId }) + "\n");
    }
  });
  await run(["node", "controlled", "--out", first, "--no-screenshots", "--capture-text"]);
  expect(fixture.spawns).toBe(1);
  expect(fixture.commands).toEqual([{ kind: "checkpoint", id }, { kind: "checkpoint", id: secondId }]);
  expect(frozen).toBeDefined(); expect(fs.readFileSync(first)).toEqual(frozen);
  expect(frozen!.toString()).toContain("before-boundary"); expect(frozen!.toString()).not.toContain("after-boundary");
  const oldRecords = frozen!.toString().trim().split("\n").map(line => JSON.parse(line));
  const newRecords = fs.readFileSync(next, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const stopped = oldRecords.find(row => row.eventType === "recording_stopped");
  const started = newRecords.find(row => row.eventType === "recording_started");
  expect(stopped.details).toMatchObject({ reason: "segment_rotation", nativeSessionId: "a".repeat(32), collectorContinues: true });
  expect(started.details).toEqual({ nativeSessionId: "a".repeat(32), collectorContinues: true });
  expect(stopped.timestamp).toBe(started.timestamp);
  expect(newRecords.find(row => row.ax)?.ax.mode).toBe("fullTree");
  expect(newRecords.find(row => row.eventType === "page_context")?.details.url).toBe("https://controlled.example/page");
  const ack = logs.mock.calls.map(([line]) => String(line)).find(line => line.startsWith("[recorder-checkpoint] "))!;
  const point = persistedCheckpoint.parse(JSON.parse(ack.slice(22)));
  expect(point.complete).toBe(!faults); expect(point.watermark.nativeSessionId).toBe("a".repeat(32));
  const raw = fs.readFileSync(next), through = raw.subarray(0, point.watermark.bytes).toString();
  expect(through).toContain("after-boundary"); expect(through).not.toContain("after-second-boundary");
  expect(raw.toString()).toContain("after-second-boundary");
  if (faults) expect(point.issues).toContain("ax_snapshot_budget_exceeded");
});

it("finishes a stop hotkey delivered with a rotation marker in the new file", async () => {
  fixture.faults = false; fixture.stopAtRotation = true;
  const first = path.join(root, "first", "events.jsonl"), next = path.join(root, "next", "events.jsonl");
  fixture.rotation = { eventsFile: next, title: "next" };
  const logs = vi.spyOn(console, "log").mockImplementation(() => {});
  await run(["node", "controlled", "--out", first, "--no-screenshots", "--capture-text"]);
  expect(logs.mock.calls.map(([line]) => String(line))).toContain('[recorder-rotation] ' + JSON.stringify({ id, complete: true }));
  expect(fs.readFileSync(first, "utf8")).toContain('"reason":"segment_rotation"');
  expect(fs.readFileSync(next, "utf8")).toContain('"reason":"stop_hotkey"');
  expect(fixture.spawns).toBe(1);
});
afterEach(() => {
  fixture.input?.destroy();
  for (const [signal, original] of listeners) for (const listener of process.listeners(signal)) if (!original.includes(listener)) process.removeListener(signal, listener);
  Object.defineProperty(process, "platform", platform); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true });
});

it.each([false, true])("flushes the pre-marker text, excludes later events and publishes faults before the durable ack (faults=%s)", async faults => {
  fixture.faults = faults;
  const logs = vi.spyOn(console, "log").mockImplementation(() => {});
  const file = path.join(root, "events.jsonl");
  await run(["node", "controlled", "--out", file, "--no-screenshots", "--capture-text"]);
  expect(fixture.commands).toEqual([{ kind: "checkpoint", id, from: "2026-10-21T00:00:00.000Z", through: "2026-10-21T01:00:00.000Z" }]);
  const lines = logs.mock.calls.map(([line]) => String(line));
  const at = lines.findIndex(line => line.startsWith("[recorder-checkpoint] "));
  const point = persistedCheckpoint.parse(JSON.parse(lines[at]!.slice(22)));
  expect(point.complete).toBe(!faults);
  const raw = fs.readFileSync(file), before = raw.subarray(0, point.watermark.bytes).toString();
  expect(before).toContain("before-boundary"); expect(before).not.toContain("after-boundary");
  expect(raw.toString()).toContain("after-boundary");
  if (faults) {
    expect(point.issues).toContain("ax_snapshot_budget_exceeded");
    const health = lines.slice(0, at).filter(line => line.startsWith("[recorder-health] "))
      .map(line => JSON.parse(line.slice("[recorder-health] ".length))).filter(value => value.code === "ax_snapshot_budget_exceeded");
    expect(health.reduce((n, value) => n + value.count, 0)).toBe(2);
  }
});
