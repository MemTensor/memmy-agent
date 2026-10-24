import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryPermissions } from "../../../../src/tools/computer-history/mac/permissions.js";

// This stand-in never opens an event tap or reads the desktop. Tests own every
// stream, event record and exit, including stderr arriving after process exit.
class SyntheticRecorder extends EventEmitter {
  pid: number | undefined = 123456;
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  signals: string[] = [];
  kill(signal: string) { this.signals.push(signal); this.exit(0); return true; }
  exit(code = 1, close = true) {
    this.exitCode = code;
    this.emit("exit", code);
    if (close) this.emit("close", code);
  }
}
const state = vi.hoisted(() => ({ children: [] as SyntheticRecorder[] }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  spawn: () => { const child = new SyntheticRecorder(); state.children.push(child); return child; },
}));
import { ComputerHistoryDemoService } from "../../../../src/tools/computer-history/mac/computer-history-api.js";
import { recorderFailureMessage, WINDOWS_HISTORY_STREAM_DISCONNECT } from "../../../../src/tools/computer-history/mac/record-human-history.js";

const streamDisconnect = "Memmy Computer History stream disconnected unexpectedly.";
const initialConnectionClosed = "Memmy Computer Use.app closed the History connection.";
const windowsStreamDisconnect = recorderFailureMessage(new Error(WINDOWS_HISTORY_STREAM_DISCONNECT));
const granted: HistoryPermissions = { supported: true, accessibility: true, inputMonitoring: true };
let root: string;
let service: ComputerHistoryDemoService;
let permissionReader: ReturnType<typeof vi.fn<() => Promise<HistoryPermissions>>>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-09T10:01:00Z"));
  state.children.length = 0;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "history-recorder-reconnect-"));
  const recorderScript = path.join(root, "synthetic-recorder.js");
  fs.writeFileSync(recorderScript, "// spawn is replaced by an inert event emitter");
  permissionReader = vi.fn(async () => granted);
  service = new ComputerHistoryDemoService({
    recorderScript,
    historyDirectory: path.join(root, "histories"),
    recordingDirectory: path.join(root, "recordings"),
    workflowDirectory: path.join(root, "workflows"),
    observationSettingsFile: path.join(root, "settings.json"),
    weChatConsentFile: path.join(root, "wechat-consent.json"),
    permissionReader,
  });
});
afterEach(async () => {
  await service.shutdown();
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

function eventsFile(id = service.snapshot().observation.segmentId!) {
  return path.join(root, "recordings", "segments", id, "events.jsonl");
}
function appendActivity(label: string, id?: string) {
  if (!fs.existsSync(eventsFile(id))) {
    fs.appendFileSync(eventsFile(id), JSON.stringify({
      recordType: "human_history_metadata", schemaVersion: 1, recordingId: id ?? service.snapshot().observation.segmentId,
      title: "Synthetic reconnect fixture", platform: "macOS",
    }) + "\n");
  }
  fs.appendFileSync(eventsFile(id), JSON.stringify({
    recordType: "human_event", eventType: "accessibility_snapshot", timestamp: new Date().toISOString(),
    application: { name: label, bundleId: "com.example.synthetic" }, details: {},
    ax: { mode: "fullTree", text: `AXStaticText||${label}|||` },
  }) + "\n");
}
function appendStop(reason: string) {
  fs.appendFileSync(eventsFile(), JSON.stringify({
    recordType: "human_event", eventType: "recording_stopped", details: { reason },
  }) + "\n");
}
function disconnect(message = streamDisconnect) {
  const child = state.children.at(-1)!;
  child.stderr.write(message + "\n");
  appendStop("helper_exit:1");
  child.exit();
}
function intent() {
  return JSON.parse(fs.readFileSync(path.join(root, "histories", "recording-intent.json"), "utf8"));
}
function summary(id: string) {
  return fs.readFileSync(path.join(root, "histories", `${id}-10min-summary.md`), "utf8");
}

describe("Computer History native event stream reconnect", () => {
  it.each([streamDisconnect, initialConnectionClosed, windowsStreamDisconnect])("rechecks permissions and resumes the same stream after %s", async (message) => {
    const started = service.startObservation().observation;
    appendActivity("Before reconnect");
    const before = fs.readFileSync(eventsFile(), "utf8");
    disconnect(message);
    expect(service.snapshot().observation).toMatchObject({ state: "running", error: null, segmentId: started.segmentId });
    expect(intent()).toEqual({ state: "running" });
    await vi.advanceTimersByTimeAsync(499);
    expect(state.children).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(permissionReader).toHaveBeenCalledTimes(1);
    expect(state.children).toHaveLength(2);
    appendActivity("After reconnect");
    expect(service.snapshot().observation.startedAt).toBe(started.startedAt);
    expect(fs.readFileSync(eventsFile(), "utf8")).toContain(before);
    expect(fs.readFileSync(eventsFile(), "utf8")).toContain("After reconnect");
  });

  it("uses the final stderr received after exit before classifying the disconnect", async () => {
    service.startObservation();
    appendActivity("Late stderr fixture");
    const child = state.children[0]!;
    child.exit(1, false);
    child.stderr.write(streamDisconnect + "\n");
    child.emit("close", 1);
    await vi.advanceTimersByTimeAsync(500);
    expect(service.snapshot().observation).toMatchObject({ state: "running", error: null });
    expect(state.children).toHaveLength(2);
  });

  it.each(["stop", "pause", "shutdown"])("cancels the backoff when the user requests %s", async (action) => {
    service.startObservation();
    appendActivity("Cancel backoff fixture");
    disconnect();
    if (action === "stop") await service.stopObservation();
    else if (action === "pause") await service.pauseObservation();
    else await service.shutdown();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.children).toHaveLength(1);
    expect(permissionReader).not.toHaveBeenCalled();
    expect(service.snapshot().observation.state).toBe(action === "pause" ? "paused" : "stopped");
    expect(intent().state).toBe(action === "shutdown" ? "running" : action === "pause" ? "paused" : "stopped");
  });

  it.each(["stop", "pause", "shutdown"])("cancels a reconnect permission check when the user requests %s", async (action) => {
    let resolvePermissions!: (value: HistoryPermissions) => void;
    permissionReader.mockImplementationOnce(() => new Promise((resolve) => { resolvePermissions = resolve; }));
    service.startObservation();
    appendActivity("Cancel permission check fixture");
    disconnect();
    await vi.advanceTimersByTimeAsync(500);
    expect(permissionReader).toHaveBeenCalledTimes(1);
    if (action === "stop") await service.stopObservation();
    else if (action === "pause") await service.pauseObservation();
    else await service.shutdown();
    resolvePermissions(granted);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.children).toHaveLength(1);
    expect(service.snapshot().observation.state).toBe(action === "pause" ? "paused" : "stopped");
  });

  it.each(["stop", "pause", "shutdown"])("cancels classification while stderr is draining on %s", async (action) => {
    service.startObservation();
    appendActivity("Cancel drain fixture");
    const child = state.children[0]!;
    child.exit(1, false);
    if (action === "stop") await service.stopObservation();
    else if (action === "pause") await service.pauseObservation();
    else await service.shutdown();
    child.stderr.write(streamDisconnect + "\n");
    child.emit("close", 1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.children).toHaveLength(1);
    expect(permissionReader).not.toHaveBeenCalled();
    expect(service.snapshot().observation.state).toBe(action === "pause" ? "paused" : "stopped");
  });

  it.each(["accessibility", "inputMonitoring"] as const)("stops and closes existing evidence when %s was revoked", async (permission) => {
    permissionReader.mockResolvedValue({ ...granted, [permission]: false });
    const id = service.startObservation().observation.segmentId!;
    appendActivity("Permission revoked fixture");
    disconnect();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.children).toHaveLength(1);
    expect(service.snapshot().observation).toMatchObject({ state: "stopped", error: null, segmentId: null });
    expect(intent()).toEqual({ state: "stopped" });
    expect(summary(id)).toContain("Permission revoked fixture");
    expect(summary(id)).toContain("capture_complete: true");
  });

  it.each(["stop_hotkey", "user_stop", "user_interrupt"])("does not restart after an explicit %s", async (reason) => {
    service.startObservation();
    appendActivity("Explicit stop fixture");
    state.children[0]!.stderr.write(streamDisconnect + "\n");
    appendStop(reason);
    state.children[0]!.exit(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.children).toHaveLength(1);
    expect(service.snapshot().observation.state).toBe("stopped");
    expect(intent()).toEqual({ state: "stopped" });
  });

  it("does not reconnect an explicit stop with a nonzero exit", async () => {
    service.startObservation();
    appendActivity("Failed explicit stop fixture");
    state.children[0]!.stderr.write(streamDisconnect + "\n");
    appendStop("stop_hotkey");
    state.children[0]!.exit(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.children).toHaveLength(1);
    expect(service.snapshot().observation.state).toBe("failed");
    expect(intent()).toEqual({ state: "stopped" });
  });

  it("closes a general failure immediately and does not reuse an earlier disconnect log", async () => {
    const id = service.startObservation().observation.segmentId!;
    appendActivity("Generic failure fixture");
    disconnect();
    await vi.advanceTimersByTimeAsync(500);
    state.children[1]!.stderr.write("A synthetic observer failure\n");
    state.children[1]!.exit(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.children).toHaveLength(2);
    expect(service.snapshot().observation).toMatchObject({ state: "failed", segmentId: null, error: "A synthetic observer failure" });
    expect(summary(id)).toContain("Generic failure fixture");
    expect(summary(id)).toContain("capture_complete: true");
    expect(JSON.parse(fs.readFileSync(path.join(path.dirname(eventsFile(id)), "metadata.json"), "utf8")).state).toBe("closed");
  });

  it("does not retry a permission error even if the same output contains a disconnect", async () => {
    service.startObservation();
    appendActivity("Native permission error fixture");
    disconnect(streamDisconnect + "\nhuman history recording failed: missing macOS permission: Accessibility.");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.children).toHaveLength(1);
    expect(permissionReader).not.toHaveBeenCalled();
    expect(service.snapshot().observation.state).toBe("stopped");
  });

  it("closes the previous time bucket before reconnecting in the next", async () => {
    vi.setSystemTime(new Date("2026-10-09T10:09:59.800Z"));
    const started = service.startObservation().observation;
    appendActivity("Previous bucket fixture");
    disconnect();
    await vi.advanceTimersByTimeAsync(500);
    expect(state.children).toHaveLength(2);
    expect(service.snapshot().observation).toMatchObject({
      state: "running", segmentId: "2026-10-09T10-10-00Z", startedAt: started.startedAt,
    });
    expect(summary(started.segmentId!)).toContain("Previous bucket fixture");
    expect(summary(started.segmentId!)).toContain("capture_complete: true");
    appendActivity("Next bucket fixture");
    expect(fs.readFileSync(eventsFile(), "utf8")).not.toContain("Previous bucket fixture");
  });

  it("bounds repeated disconnections to three attempts and preserves a completed summary", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const id = service.startObservation().observation.segmentId!;
    appendActivity("Exhausted reconnect fixture");
    for (const delay of [500, 1_500, 5_000]) {
      disconnect();
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(state.children).toHaveLength(4);
    disconnect();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state.children).toHaveLength(4);
    expect(service.snapshot().observation).toMatchObject({
      state: "failed", segmentId: null,
      error: "Computer History recording disconnected after 3 reconnect attempts",
    });
    expect(summary(id)).toContain("Exhausted reconnect fixture");
    expect(summary(id)).toContain("capture_complete: true");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("exhausted"), expect.stringContaining(streamDisconnect));
    warn.mockRestore();
  });

  it("allows a new bounded reconnect burst after the observer has remained stable", async () => {
    service.startObservation();
    appendActivity("Stable recorder fixture");
    disconnect();
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(60_000);
    disconnect();
    await vi.advanceTimersByTimeAsync(500);
    expect(state.children).toHaveLength(3);
    expect(service.snapshot().observation.state).toBe("running");
  });

  it("retains the stable stream window through a normal rotation before a new disconnect", async () => {
    service.startObservation();
    appendActivity("Rotation budget fixture");
    for (const delay of [500, 1_500, 5_000]) {
      disconnect();
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(state.children).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(9 * 60_000 - 7_000);
    expect(state.children).toHaveLength(5);
    expect(service.snapshot().observation.segmentId).toBe("2026-10-09T10-10-00Z");
    appendActivity("New rotated bucket fixture");
    await vi.advanceTimersByTimeAsync(30_000);
    disconnect();
    await vi.advanceTimersByTimeAsync(500);
    expect(state.children).toHaveLength(6);
    expect(service.snapshot().observation.state).toBe("running");
  });

  it.each(["backoff", "permission"])("starts one fresh observer and restores authorized polling when history is cleared during %s", async (phase) => {
    let resolvePermissions: ((value: HistoryPermissions) => void) | undefined;
    if (phase === "permission") {
      permissionReader.mockImplementationOnce(() => new Promise((resolve) => { resolvePermissions = resolve; }));
    }
    const polling = vi.spyOn(service as unknown as { startWeChatPolling: () => void }, "startWeChatPolling");
    service.startObservation();
    appendActivity("Clear reconnect fixture");
    disconnect();
    if (phase === "permission") await vi.advanceTimersByTimeAsync(500);
    await service.clearHistories("all");
    resolvePermissions?.(granted);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(state.children).toHaveLength(2);
    expect(service.snapshot().observation.state).toBe("running");
    expect(polling).toHaveBeenCalledTimes(2);
    expect(permissionReader).toHaveBeenCalledTimes(phase === "permission" ? 1 : 0);
    expect(fs.existsSync(eventsFile())).toBe(false);
    polling.mockRestore();
  });
});
