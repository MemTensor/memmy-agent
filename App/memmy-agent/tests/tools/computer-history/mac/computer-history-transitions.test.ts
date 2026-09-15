import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class RecorderChild extends EventEmitter {
  pid: number | undefined = 123456;
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  signals: string[] = [];
  kill(signal: string) { this.signals.push(signal); return true; }
  exit(code = 0) { this.exitCode = code; this.emit("exit", code); }
}
const state = vi.hoisted(() => ({ children: [] as RecorderChild[] }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  spawn: () => { const child = new RecorderChild(); state.children.push(child); return child; },
}));
import { ComputerHistoryDemoService } from "../../../../src/tools/computer-history/mac/computer-history-api.js";

let root: string;
let service: ComputerHistoryDemoService;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-13T00:01:00Z"));
  state.children.length = 0;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "history-transitions-"));
  const recorderScript = path.join(root, "unused.js");
  fs.writeFileSync(recorderScript, "// spawn is replaced by an inert child");
  service = new ComputerHistoryDemoService({ recorderScript,
    historyDirectory: path.join(root, "histories"), recordingDirectory: path.join(root, "recordings"),
    workflowDirectory: path.join(root, "workflows"), observationSettingsFile: path.join(root, "settings.json"),
  });
});
afterEach(async () => {
  const shutdown = service.shutdown();
  for (const child of state.children) child.exit();
  await shutdown;
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("recorder transition ordering", () => {
  function writeStop(reason: string) {
    const id = service.snapshot().observation.segmentId!;
    const file = path.join(root, "recordings", "segments", id, "events.jsonl");
    fs.appendFileSync(file, JSON.stringify({ recordType: "human_event", eventType: "recording_stopped", details: { reason } }) + "\n");
  }

  it.each(["stop_hotkey", "user_stop", "user_interrupt"])("finishes a user stop (%s) without an error", async (reason) => {
    service.startObservation();
    writeStop(reason);
    state.children[0].exit();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.snapshot().observation).toMatchObject({ state: "stopped", segmentId: null, error: null });
    expect(state.children[0].signals).toEqual([]);
  });

  it("coalesces a stop hotkey with a simultaneous API Stop", async () => {
    service.startObservation();
    writeStop("stop_hotkey");
    state.children[0].exit();
    const stop = await service.stopObservation();
    expect(stop.observation).toMatchObject({ state: "stopped", segmentId: null, error: null });
    expect(state.children[0].signals).toEqual([]);
  });

  it.each(["stop_hotkey", "user_stop"])("honors %s when rotation has already detached the recorder", async (reason) => {
    vi.setSystemTime(new Date("2026-09-13T00:09:59Z"));
    service.startObservation();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.children[0].signals).toEqual(["SIGTERM"]);
    writeStop(reason);
    state.children[0].exit();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.snapshot().observation).toMatchObject({ state: "stopped", segmentId: null, error: null });
    expect(state.children).toHaveLength(1);
  });

  it("honors a hotkey when Pause has already detached the recorder", async () => {
    service.startObservation();
    const pause = service.pauseObservation();
    writeStop("stop_hotkey");
    state.children[0].exit();
    await pause;
    expect(service.snapshot().observation).toMatchObject({ state: "stopped", segmentId: null, error: null });
    expect(() => service.resumeObservation()).toThrow(/not paused/);
  });

  it("coalesces API Stop behind a hotkey that finishes during rotation", async () => {
    vi.setSystemTime(new Date("2026-09-13T00:09:59Z"));
    service.startObservation();
    await vi.advanceTimersByTimeAsync(1_000);
    const stop = service.stopObservation();
    writeStop("stop_hotkey");
    state.children[0].exit();
    await stop;
    expect(service.snapshot().observation.state).toBe("stopped");
    expect(state.children).toHaveLength(1);
  });

  it.each(["pause", "rotate"])("preserves normal %s when API SIGTERM produces user_interrupt", async (action) => {
    vi.setSystemTime(new Date("2026-09-13T00:09:59Z"));
    service.startObservation();
    const pause = action === "pause" ? service.pauseObservation() : null;
    if (action === "rotate") await vi.advanceTimersByTimeAsync(1_000);
    writeStop("user_interrupt");
    state.children[0].exit();
    await pause;
    await vi.advanceTimersByTimeAsync(0);
    expect(service.snapshot().observation.state).toBe(action === "pause" ? "paused" : "running");
    if (action === "pause") service.resumeObservation();
    expect(state.children).toHaveLength(2);
  });

  it("does not treat a previous run's stop marker as a successful fresh exit", async () => {
    service.startObservation();
    writeStop("stop_hotkey");
    state.children[0].exit();
    await vi.advanceTimersByTimeAsync(0);
    service.startObservation();
    state.children[1].exit();
    expect(service.snapshot().observation.state).toBe("failed");
  });

  it.each([0, 1])("keeps helper failure distinct from a user stop (exit %i)", (code) => {
    service.startObservation();
    writeStop("helper_exit:1");
    state.children[0].exit(code);
    expect(service.snapshot().observation.state).toBe("failed");
  });

  it("does not accept a stop marker with a nonzero process exit", () => {
    service.startObservation();
    writeStop("stop_hotkey");
    state.children[0].exit(1);
    expect(service.snapshot().observation.state).toBe("failed");
  });

  it("does not signal a failed spawn with no pid or wait for an exit it cannot emit", async () => {
    service.startObservation();
    const child = state.children[0];
    child.pid = undefined;
    await service.stopObservation();
    child.emit("error", new Error("synthetic spawn failure"));
    child.emit("close", -2);
    expect(child.signals).toEqual([]);
    expect(service.snapshot().observation.state).toBe("stopped");
  });
  it("rejects Start until Stop has actually reaped its child", async () => {
    service.startObservation();
    const stopped = service.stopObservation();
    expect(service.snapshot().observation.state).toBe("stopping");
    expect(() => service.startObservation()).toThrow(/transition/);
    expect(state.children).toHaveLength(1);
    state.children[0].exit();
    await stopped;
    expect(service.snapshot().observation.state).toBe("stopped");
    service.startObservation();
    expect(state.children).toHaveLength(2);
  });

  it("serializes Stop behind an in-flight Pause", async () => {
    service.startObservation();
    const paused = service.pauseObservation();
    const stopped = service.stopObservation();
    expect(() => service.startObservation()).toThrow(/transition/);
    state.children[0].exit();
    await Promise.all([paused, stopped]);
    expect(service.snapshot().observation).toMatchObject({ state: "stopped", segmentId: null });
    expect(state.children[0].signals).toEqual(["SIGTERM"]);
  });

  it("coalesces concurrent Stops without losing ownership of the child", async () => {
    service.startObservation();
    const one = service.stopObservation();
    const two = service.stopObservation();
    state.children[0].exit();
    await Promise.all([one, two]);
    expect(service.snapshot().observation.state).toBe("stopped");
    expect(state.children[0].signals).toEqual(["SIGTERM"]);
  });

  it("waits for exit after SIGKILL instead of reporting stopped on dispatch", async () => {
    service.startObservation();
    const stop = service.stopObservation();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(state.children[0].signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(service.snapshot().observation.state).toBe("stopping");
    state.children[0].exit();
    await stop;
    expect(service.snapshot().observation.state).toBe("stopped");
  });

  it("does not spawn a replacement when Stop overlaps rotation", async () => {
    vi.setSystemTime(new Date("2026-09-13T00:09:59Z"));
    service.startObservation();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.children[0].signals).toEqual(["SIGTERM"]);
    const stop = service.stopObservation();
    state.children[0].exit();
    await stop;
    expect(state.children).toHaveLength(1);
    expect(service.snapshot().observation.state).toBe("stopped");
  });
});

describe("aligned recording windows", () => {
  it("rotates at the next ten-minute boundary even when started just before it", async () => {
    vi.setSystemTime(new Date("2026-09-12T21:59:00Z"));
    service.startObservation();
    await vi.advanceTimersByTimeAsync(60_000);
    state.children[0].exit();
    await vi.advanceTimersByTimeAsync(0);
    expect(service.snapshot().observation.segmentId).toBe("2026-09-12T22-00-00Z");
    expect(state.children).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(state.children[1].signals).toEqual(["SIGTERM"]);
  });

  it("opens a new window when resuming the following day", async () => {
    const started = service.startObservation();
    const pause = service.pauseObservation();
    state.children[0].exit();
    await pause;
    vi.setSystemTime(new Date("2026-09-14T00:11:00Z"));
    const resumed = service.resumeObservation();
    expect(resumed.observation.segmentId).not.toBe(started.observation.segmentId);
    expect(resumed.observation.segmentId).toBe("2026-09-14T00-10-00Z");
    expect(resumed.observation.segmentStartedAt).toBe("2026-09-14T00:11:00.000Z");
  });
});
