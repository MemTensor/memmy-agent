import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { captureGapRecord, nativeRecorderDiagnostic, recorderHealthReporter } from "../../../../src/tools/computer-history/mac/recorder-health.js";

const fixture = vi.hoisted(() => ({ lines: [] as string[], afterLine: undefined as ((index: number) => void) | undefined }));
vi.mock("../../../../src/tools/computer-history/mac/native-helper.js", () => ({
  historyNativeCommand: async () => ({ binary: "/synthetic/history-helper", args: [], managed: false }),
}));
vi.mock("../../../../src/tools/computer-history/win/win11.js", () => ({
  isWindows11: () => true,
  windowsObserverCommand: () => ({ binary: "/synthetic/windows-helper", args: [] }),
}));
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const { promisify } = await import("node:util");
  const execFile = vi.fn();
  Object.defineProperty(execFile, promisify.custom, { value: async () => ({
    stdout: JSON.stringify({ inputMonitoring: true, screenRecording: false, accessibility: true,
      mainDisplayWidth: 100, mainDisplayHeight: 100 }), stderr: "",
  }) });
  return { ...actual, execFile, spawn: () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), killed: false,
      kill() { this.killed = true; return true; },
    });
    setImmediate(async () => {
      for (const [index, line] of fixture.lines.entries()) {
        child.stdout.write(line + "\n");
        await new Promise<void>((resolve) => setImmediate(resolve));
        fixture.afterLine?.(index);
      }
      child.stdout.end();
      child.emit("exit", 0, null); child.emit("close", 0, null);
    });
    return child;
  } };
});
import { recordingStep, run } from "../../../../src/tools/computer-history/mac/record-human-history.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let directory: string;
let signalListeners: Map<string, ((...args: unknown[]) => unknown)[]>;
beforeEach(() => {
  fixture.afterLine = undefined;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "recorder-health-fixture-"));
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  signalListeners = new Map(["SIGINT", "SIGTERM"].map((signal) => [signal, process.listeners(signal)]));
});
afterEach(() => {
  for (const [signal, original] of signalListeners) for (const listener of process.listeners(signal)) {
    if (!original.includes(listener)) process.removeListener(signal, listener);
  }
  Object.defineProperty(process, "platform", platform);
  fs.rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers(); vi.restoreAllMocks();
});

describe("content-free recorder health", () => {
  test("projects only allowed codes, UTC times and positive counters", () => {
    assert.deepEqual(nativeRecorderDiagnostic({ type: "recorder.diagnostic", code: "observer_unavailable",
      timestamp: "2026-10-09T12:00:00Z", count: 2, app: "Private app", url: "https://private.invalid", text: "Private data" }), {
      code: "observer_unavailable", timestamp: "2026-10-09T12:00:00.000Z", count: 2,
    });
    for (const value of [null, [], { type: "recorder.diagnostic", code: "event_recorded", timestamp: "2026-10-09T12:00:00Z" },
      { type: "recorder.diagnostic", code: "Private data", timestamp: "2026-10-09T12:00:00Z" },
      { type: "recorder.diagnostic", code: "heartbeat", timestamp: "invalid" },
      { type: "recorder.diagnostic", code: "ax_snapshot_ready", timestamp: "2026-10-09T12:00:00Z" },
      { type: "recorder.diagnostic", code: "privacy_unknown", timestamp: "2026-10-09T12:00:00Z", count: 1 },
      { type: "recorder.diagnostic", code: "enrichment_backlog", timestamp: "2026-10-09T12:00:00Z", count: 0 }]) {
      assert.equal(nativeRecorderDiagnostic(value), null);
    }
  });

  test("throttles per code, sums batches, and retains the last successful write time through Stop", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-09T12:00:00Z"));
    const output: string[] = [];
    const health = recorderHealthReporter((line) => output.push(line));
    health.report("event_recorded"); health.report("observer_unavailable");
    vi.advanceTimersByTime(2_000);
    health.report("event_recorded"); health.report("observer_unavailable", { count: 2 });
    vi.advanceTimersByTime(2_000); health.report("observer_unavailable", { count: 3 });
    assert.equal(output.length, 2);
    vi.advanceTimersByTime(6_000);
    const signals = output.map((line) => JSON.parse(line.slice("[recorder-health] ".length)));
    assert.equal(signals[2].timestamp, "2026-10-09T12:00:02.000Z");
    assert.equal(signals[3].count, 5);
    assert.equal(signals[3].timestamp, "2026-10-09T12:00:04.000Z");
    vi.advanceTimersByTime(1_000); health.report("event_recorded");
    health.close(); health.report("observer_unavailable");
    assert.equal(output.length, 5);
    assert.equal(JSON.parse(output[4].slice("[recorder-health] ".length)).timestamp, "2026-10-09T12:00:11.000Z");
    assert.equal(vi.getTimerCount(), 0);
  });

  test("retains content-free historical capture issues separately from human actions", async () => {
    const app = { name: "Synthetic Notes", bundleIdentifier: "com.example.Notes" };
    fixture.lines = [
      JSON.stringify({ type: "recorder.diagnostic", code: "heartbeat", timestamp: "2026-10-09T12:00:00Z", text: "Private diagnostic" }),
      JSON.stringify({ type: "recorder.diagnostic", code: "observer_unavailable", timestamp: "2026-10-09T12:00:00Z", count: 2, url: "https://private.invalid" }),
      "Malformed Private helper data",
      JSON.stringify({ kind: "mouse.click", app, mouse: { target: { role: "AXButton", title: "Allowed control" } } }),
    ];
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const output = path.join(directory, "events.jsonl");
    await run(["node", "synthetic", "--out", output, "--no-screenshots"]);
    const signals = logs.mock.calls.filter(([line]) => String(line).startsWith("[recorder-health] "))
      .map(([line]) => JSON.parse(String(line).slice("[recorder-health] ".length)));
    assert.deepEqual(signals.find((signal) => signal.code === "observer_unavailable"), {
      code: "observer_unavailable", timestamp: "2026-10-09T12:00:00.000Z", count: 2,
    });
    assert.ok(signals.some((signal) => signal.code === "helper_parse_error"));
    assert.ok(signals.some((signal) => signal.code === "event_recorded"));
    assert.doesNotMatch(JSON.stringify(signals), /Private|private\.invalid|Synthetic Notes|Allowed control/u);
    const raw = fs.readFileSync(output, "utf8");
    const persistedEvents = raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.doesNotMatch(JSON.stringify(persistedEvents), /recorder\.diagnostic|private\.invalid|Private data|Private target|Malformed Private/u);
    assert.deepEqual(persistedEvents.find((event) => event.code === "observer_unavailable"), {
      recordType: "capture_health", code: "observer_unavailable", timestamp: "2026-10-09T12:00:00.000Z", count: 2,
    });
    assert.ok(!persistedEvents.some((event) => event.code === "heartbeat" || event.code === "event_recorded"));
    assert.match(raw, /Allowed control/u);
  });

  test("only persisted complete Windows trees recover snapshot failure; actions and partial trees do not", async () => {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    const app = { name: "Synthetic Notes", bundleIdentifier: "win32.notes" };
    const tree = { mode: "fullTree", windowKey: "fixture", text: "ControlType.Button||Existing button|||", truncated: false, readFailures: 0 };
    fixture.lines = [
      JSON.stringify({ type: "recorder.diagnostic", code: "ax_snapshot_failed", timestamp: "2026-10-09T12:00:00Z" }),
      JSON.stringify({ kind: "mouse.click", app, ax: { focused: { role: "AXWindow" } }, mouse: { target: { role: "AXUnknown" } } }),
      JSON.stringify({ type: "recorder.diagnostic", code: "observer_ready", timestamp: "2026-10-09T12:00:01Z" }),
      JSON.stringify({ kind: "window.changed", app, ax: { ...tree, mode: "unknown" } }),
      JSON.stringify({ kind: "window.changed", app, ax: { ...tree, truncated: true, readFailures: 1 } }),
      JSON.stringify({ kind: "window.changed", app, ax: tree }),
      JSON.stringify({ kind: "window.changed", app, ax: tree }),
    ];
    vi.spyOn(console, "log").mockImplementation(() => {});
    const output = path.join(directory, "events.jsonl");
    await assert.rejects(run(["node", "synthetic", "--out", output, "--no-screenshots"]), /stream disconnected/u);
    const records = fs.readFileSync(output, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const snapshots = records.filter((record) => record.eventType === "accessibility_snapshot");
    assert.deepEqual(snapshots.map((record) => [record.ax.truncated, record.ax.readFailures]), [[true, 1], [false, 0]]);
    const ready = records.findIndex((record) => record.code === "ax_snapshot_ready");
    assert.ok(ready > records.indexOf(snapshots[1]));
    assert.equal(records.filter((record) => record.code === "ax_snapshot_ready").length, 1);
    assert.ok(records.findIndex((record) => record.code === "ax_snapshot_failed") < ready);
  });

  test("preserves input time for lost enrichment without borrowing a page or claiming a clicked control", async () => {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    const gap = { type: "recorder.capture_gap", actionTimestamp: "2026-10-15T12:00:02Z", actionKind: "mouse.click",
      reason: "navigation_changed", button: "left", count: 1, url: "https://private.invalid", text: "PRIVATE_VALUE" };
    const previous = { observedAt: "2026-10-15T12:00:00.500Z", interpretation: "previously_observed_not_confirmed_target",
      controls: [{ role: "AXButton", title: "Finish", value: "PRIVATE_VALUE" }] };
    const app = { name: "Synthetic Notes", bundleIdentifier: "win32.notes" };
    fixture.lines = [JSON.stringify(gap), JSON.stringify({ kind: "sampling.changed", timestamp: "2026-10-15T12:00:00Z", app,
      ax: { mode: "fullTree", windowKey: "fixture", observedAt: "2026-10-15T12:00:00Z",
        text: "AXButton||Finish|||", truncated: false, readFailures: 0 } }),
      JSON.stringify({ kind: "sampling.changed", timestamp: previous.observedAt, app,
      ax: { mode: "fullTree", windowKey: "fixture", observedAt: previous.observedAt,
        text: "AXButton||Finish|||", truncated: false, readFailures: 0 } }),
      JSON.stringify({ kind: "mouse.click", timestamp: "2026-10-15T12:00:01Z", ax: { windowKey: "fixture" },
      app: { name: "Synthetic Notes", bundleIdentifier: "win32.notes" },
      mouse: { target: { role: "AXUnknown" }, previousControlsAtPoint: previous } })];
    vi.spyOn(console, "log").mockImplementation(() => {});
    const output = path.join(directory, "events.jsonl");
    await assert.rejects(run(["node", "synthetic", "--out", output, "--no-screenshots"]), /stream disconnected/u);
    const raw = fs.readFileSync(output, "utf8");
    const records = raw.trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(records.find((record) => record.recordType === "capture_gap"), {
      recordType: "capture_gap", timestamp: "2026-10-15T12:00:02.000Z", actionKind: "mouse.click", reason: "navigation_changed", count: 1, button: "left",
    });
    const click = records.find((record) => record.eventType === "mouse_click");
    assert.equal(records.filter((record) => record.eventType === "accessibility_snapshot").length, 1);
    assert.deepEqual(click.details.accessibility, { role: "AXUnknown" });
    assert.equal(click.details.previousControlsAtPoint.controls[0].title, "Finish");
    assert.doesNotMatch(raw, /private\.invalid|PRIVATE_VALUE/u);
    assert.equal(captureGapRecord({ ...gap, actionKind: "keyboard.text", text: "secret" }), null);
    assert.equal(captureGapRecord({ ...gap, reason: "secret" }), null);
    assert.equal(captureGapRecord({ ...gap, count: -1 }), null);
  });

  test("reauthorizes earlier controls after exclusions instead of admitting the native excluded cache", async () => {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    const app = { name: "Synthetic Notes", bundleIdentifier: "win32.notes" };
    const settings = path.join(directory, "settings.json");
    const policy = (blocked: boolean) => ({ observation: { defaultApplicationBehavior: "observe", defaultURLBehavior: "observe",
      rules: blocked ? [{ scope: "app", bundleID: app.bundleIdentifier, behavior: "do_not_observe" }] : [] } });
    fs.writeFileSync(settings, JSON.stringify(policy(false)));
    const at = (second: number) => `2026-10-15T12:00:0${second}Z`;
    const tree = (second: number, title: string) => ({ kind: "sampling.changed", timestamp: at(second), app,
      ax: { mode: "fullTree", windowKey: "fixture", observedAt: at(second), text: `AXButton||${title}|||`, truncated: false, readFailures: 0 } });
    const click = (second: number, observed: number, title: string) => ({ kind: "mouse.click", timestamp: at(second), app,
      ax: { windowKey: "fixture" }, mouse: { target: { role: "AXUnknown" }, previousControlsAtPoint: {
        observedAt: at(observed), interpretation: "previously_observed_not_confirmed_target", controls: [{ role: "AXButton", title }] } } });
    fixture.lines = [tree(0, "Allowed"), tree(1, "EXCLUDED_CACHE"), click(2, 1, "EXCLUDED_CACHE"),
      tree(3, "Reauthorized"), click(4, 3, "Reauthorized")].map((event) => JSON.stringify(event));
    fixture.afterLine = (index) => {
      if (index === 0) fs.writeFileSync(settings, JSON.stringify(policy(true)));
      if (index === 1) fs.writeFileSync(settings, JSON.stringify(policy(false)));
    };
    vi.spyOn(console, "log").mockImplementation(() => {});
    const output = path.join(directory, "events.jsonl");
    await assert.rejects(run(["node", "synthetic", "--out", output, "--no-screenshots", "--observation-settings", settings]), /stream disconnected/u);
    const raw = fs.readFileSync(output, "utf8");
    assert.doesNotMatch(raw, /EXCLUDED_CACHE/u);
    const clicks = raw.trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.eventType === "mouse_click");
    assert.equal(clicks[0].details.previousControlsAtPoint, undefined);
    assert.equal(clicks[1].details.previousControlsAtPoint.controls[0].title, "Reauthorized");
  });

  test("legacy Windows trees without quality metadata do not assert snapshot recovery", async () => {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    fixture.lines = [JSON.stringify({ kind: "sampling.changed", app: { bundleIdentifier: "win32.notes" },
      ax: { mode: "fullTree", windowKey: "fixture", text: "AXButton||Legacy observation|||" } })];
    vi.spyOn(console, "log").mockImplementation(() => {});
    const output = path.join(directory, "events.jsonl");
    await assert.rejects(run(["node", "synthetic", "--out", output, "--no-screenshots"]), /stream disconnected/u);
    const records = fs.readFileSync(output, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(records.some((event) => event.ax?.text.includes("Legacy observation")));
    assert.ok(records.some((event) => event.code === "ax_snapshot_failed"));
    assert.ok(!records.some((event) => event.code === "ax_snapshot_ready"));
  });

  test("drops previously authorized candidates when policy changes before the click is persisted", async () => {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    const app = { bundleIdentifier: "win32.notes" };
    const settings = path.join(directory, "settings.json");
    fs.writeFileSync(settings, JSON.stringify({ observation: { defaultApplicationBehavior: "observe", defaultURLBehavior: "observe", rules: [] } }));
    let armed = false, reads = 0;
    const readFile = fs.readFileSync.bind(fs);
    vi.spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, ...args: any[]) => {
      if (file === settings && armed && ++reads === 2) {
        fs.writeFileSync(settings, JSON.stringify({ observation: { defaultApplicationBehavior: "observe", defaultURLBehavior: "observe",
          rules: [{ scope: "app", bundleID: "win32.other", behavior: "do_not_observe" }] } }));
      }
      return (readFile as any)(file, ...args);
    }) as typeof fs.readFileSync);
    const observedAt = "2026-10-15T12:00:00Z";
    fixture.lines = [JSON.stringify({ kind: "sampling.changed", timestamp: observedAt, app,
      ax: { mode: "fullTree", windowKey: "fixture", observedAt, text: "AXButton||Prior control|||", truncated: false, readFailures: 0 } }),
      JSON.stringify({ kind: "mouse.click", timestamp: "2026-10-15T12:00:01Z", app, ax: { windowKey: "fixture" },
        mouse: { target: { role: "AXUnknown" }, previousControlsAtPoint: { observedAt,
          interpretation: "previously_observed_not_confirmed_target", controls: [{ role: "AXButton", title: "Prior control" }] } } })];
    fixture.afterLine = (index) => { if (index === 0) armed = true; };
    vi.spyOn(console, "log").mockImplementation(() => {});
    const output = path.join(directory, "events.jsonl");
    await assert.rejects(run(["node", "synthetic", "--out", output, "--no-screenshots", "--observation-settings", settings]), /stream disconnected/u);
    const records = readFile(output, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const click = records.find((event) => event.eventType === "mouse_click");
    assert.ok(reads >= 2 && click, JSON.stringify({ reads, types: records.map((event) => event.eventType ?? event.code) }));
    assert.equal(click.details.previousControlsAtPoint, undefined);
    assert.deepEqual(click.details.accessibility, { role: "AXUnknown" });
  });
  test("checkpoint flush publishes throttled faults without shutting down health reporting", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-21T00:00:00Z"));
    const output: string[] = [], health = recorderHealthReporter(line => output.push(line));
    health.report("enrichment_backlog"); vi.advanceTimersByTime(100);
    health.report("enrichment_backlog", { count: 2 });
    assert.equal(output.length, 1);
    health.flush();
    assert.equal(JSON.parse(output[1].slice("[recorder-health] ".length)).count, 2);
    assert.equal(vi.getTimerCount(), 0);
    health.report("observer_ready"); assert.equal(output.length, 3);
    health.close();
  });

  test("policy exclusions alone do not claim a capture fault or successful event write", async () => {
    fixture.lines = [JSON.stringify({ kind: "mouse.click", app: { bundleIdentifier: "com.example.Excluded" },
      mouse: { target: { title: "Excluded" } } }), JSON.stringify({ kind: "mouse.click", app: { bundleIdentifier: "com.example.Excluded" },
      window: { browser: true }, mouse: { target: { title: "Excluded browser window" } } })];
    const settings = path.join(directory, "settings.json");
    fs.writeFileSync(settings, JSON.stringify({ observation: { defaultApplicationBehavior: "observe", defaultURLBehavior: "observe",
      rules: [{ scope: "app", bundleID: "com.example.Excluded", behavior: "do_not_observe" }] } }));
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    await run(["node", "synthetic", "--out", path.join(directory, "events.jsonl"), "--no-screenshots", "--observation-settings", settings]);
    assert.equal(logs.mock.calls.filter(([line]) => String(line).startsWith("[recorder-health] ")).length, 0);
  });

  test("an isolated processing failure emits a signal and subsequent events still run", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onFailure = vi.fn(), fatal = vi.fn();
    const step = recordingStep(fatal, onFailure);
    await step(async () => { throw new Error("Private failure text"); })();
    const next = vi.fn(); await step(async () => { next(); })();
    assert.equal(onFailure.mock.calls.length, 1); assert.equal(next.mock.calls.length, 1); assert.equal(fatal.mock.calls.length, 0);
  });
  test("a write failure stops directly without recursively reporting to the failing health sink", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onFailure = vi.fn(() => { throw new Error("health sink must not be used"); }), fatal = vi.fn();
    await recordingStep(fatal, onFailure)(async () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); })();
    assert.equal(fatal.mock.calls.length, 1);
    assert.equal(onFailure.mock.calls.length, 0);
  });
});
