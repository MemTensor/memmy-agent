import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ execute: vi.fn(), spawn: vi.fn() }));
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execFile = vi.fn(); Object.defineProperty(execFile, promisify.custom, { value: native.execute });
  return { execFile, spawn: native.spawn };
});
import { MacTaskRecordingDriver, macRecordingApplicationSupported, nativeMacTaskMessage, readMacTaskMedia } from "../../../src/tools/computer-recordings/macos-driver.js";
import { ObservationSettingsStore } from "../../../src/tools/computer-history/mac/settings-store.js";
import { RecordingSessionService, type RecordingResult } from "../../../src/tools/computer-recordings/session-service.js";
import { CollectorGate } from "../../../src/tools/computer-history/core/collector-gate.js";
import { handleRecordingHttp } from "../../../src/tools/computer-recordings/http-api.js";
const app = { bundleId: "test.memmy.Editor", name: "Editor", pid: 123, processStart: "1770000000123456", executable: "/Applications/Editor.app/Contents/MacOS/Editor" };
const window = { platform: "macos" as const, bundleId: app.bundleId, pid: app.pid, processStart: app.processStart, executable: app.executable,
  windowId: 321, scale: 2, bounds: { left: -1200, top: 100, right: -600, bottom: 500 } };
const clock = { kind: "mach_host" as const, origin: "100000000000", frequency: "1000000000" };
const consent = { title: "Mac teach", applications: [app.bundleId], consent: true as const };
const permissions = { accessibility: true, inputMonitoring: true, screenRecording: true };
let directory: string, store: ObservationSettingsStore;
function writePackage() {
  fs.mkdirSync(path.join(directory, "parts"));
  const video = Buffer.from("verified fragment fixture");
  fs.writeFileSync(path.join(directory, "parts", "000001.mp4"), video);
  fs.writeFileSync(path.join(directory, "recording.mp4"), video);
  fs.writeFileSync(path.join(directory, "policy.json"), JSON.stringify({ version: 1, parentPid: process.pid, maxDurationMs: 1_200_000, applications: [{ ...app, name: undefined }] }));
  const media = { version: 1, platform: "macos", clock, width: 1920, height: 1080, durationMs: 200,
    complete: true, error: null, gaps: [], parts: [{ index: 1, startMs: 0, durationMs: 200, bytes: video.length, sha256: crypto.createHash("sha256").update(video).digest("hex") }] };
  fs.writeFileSync(path.join(directory, "native-media.json"), JSON.stringify(media));
  const frames = [0, 100].map((timeMs, index) => ({ index, timeMs, monotonicTicks: String(BigInt(clock.origin) + BigInt(timeMs) * 1_000_000n),
    sourceTicks: String(BigInt(clock.origin) + BigInt(timeMs) * 1_000_000n), repeated: false, partId: "part-000001", partFrame: index, window, blank: false,
    transform: { sourceWidth: 600, sourceHeight: 400, offsetX: 360, offsetY: 140, scale: 2, sourceLeft: -1200, sourceTop: 100 } }));
  fs.writeFileSync(path.join(directory, "frames.jsonl"), frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n");
  return { media, frames };
}
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-mac-task-")); store = new ObservationSettingsStore(path.join(directory, "settings.json"));
  native.execute.mockReset().mockResolvedValue({ stdout: JSON.stringify({ supported: true, permissions, applications: [app] }), stderr: "" });
  native.spawn.mockReset();
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });
describe("macOS task recording", () => {
  it("lists native applications and honors explicit exclusions without requesting permissions", async () => {
    store.write({ observation: { defaultApplicationBehavior: "observe", defaultURLBehavior: "observe", rules: [{ scope: "app", bundleID: app.bundleId, behavior: "do_not_observe" }] } });
    expect(await new MacTaskRecordingDriver("/fixture/task-recorder", store).configuration()).toMatchObject({ platform: "macos", minimumSystemVersion: "12.3", permissions,
      applications: [{ id: app.bundleId, allowed: false, supported: true, running: true }] });
    expect(native.execute).toHaveBeenCalledWith("/fixture/task-recorder", ["--configuration"], expect.any(Object));
    await expect(new MacTaskRecordingDriver("/fixture/task-recorder", store).start({ directory, applications: [app.bundleId], onEvent: vi.fn() })).rejects.toMatchObject({ status: 422 });
    expect(native.spawn).not.toHaveBeenCalled();
  });
  it.each(["com.google.Chrome", "com.apple.Safari", "com.apple.loginwindow", "com.microsoft.WindowsApp", "com.anydesk.AnyDesk", "test.Citrix.Remote"])("excludes unsupported surface %s", (bundleId) => {
    expect(macRecordingApplicationSupported(bundleId)).toBe(false);
  });
  it.each(["screenRecording", "accessibility", "inputMonitoring"] as const)("requests only an explicitly selected %s permission and blocks capture until granted", async (permission) => {
    native.execute.mockResolvedValue({ stdout: JSON.stringify({ supported: true, permissions: { ...permissions, [permission]: false }, applications: [app] }) });
    const driver = new MacTaskRecordingDriver("/fixture/task-recorder", store);
    await expect(driver.start({ directory, applications: [app.bundleId], onEvent: vi.fn() })).rejects.toThrow("permissions_required");
    expect(native.spawn).not.toHaveBeenCalled();
    await driver.openPermission(permission, "request");
    expect(native.execute).toHaveBeenCalledWith("/fixture/task-recorder", ["--configuration", `--request-${permission}`], expect.any(Object));
  });
  it("fails closed for a corrupt observation policy", async () => {
    fs.writeFileSync(store.filePath, "{broken");
    const driver = new MacTaskRecordingDriver("/fixture/task-recorder", store);
    await expect(driver.configuration()).rejects.toThrow("observation_policy_invalid");
    await expect(driver.start({ directory, applications: [app.bundleId], onEvent: vi.fn() })).rejects.toThrow("observation_policy_invalid");
    expect(native.spawn).not.toHaveBeenCalled();
  });
  it("rejects old macOS versions before starting a helper or asking for permissions", async () => {
    native.execute.mockResolvedValue({ stdout: JSON.stringify({ supported: false, permissions, applications: [app] }) });
    await expect(new MacTaskRecordingDriver("/fixture/task-recorder", store).start({ directory, applications: [app.bundleId], onEvent: vi.fn() })).rejects.toThrow("requires_macos_12_3");
    expect(native.spawn).not.toHaveBeenCalled();
  });
  it("checks monotonic clock precision and refuses foreign/legacy protocol envelopes", () => {
    const message = { protocol: "memmy.macos.task-recording", version: 1, sessionId: crypto.randomUUID(), pid: 555, parentPid: process.pid,
      policySha256: "a".repeat(64), sequence: 1, kind: "input", clock, ticks: "100150000000", timeMs: 150, timestamp: "2026-10-13T00:00:00Z", inputIncomplete: false,
      event: { type: "mouse_click", ticks: "100100000000", window, action: { x: -1100, y: 200, button: "left" } } };
    expect(nativeMacTaskMessage(message).event?.window.windowId).toBe(321);
    expect(() => nativeMacTaskMessage({ ...message, timeMs: 160 })).toThrow();
    expect(() => nativeMacTaskMessage({ ...message, clock: { ...clock, frequency: "0" } })).toThrow();
    expect(() => nativeMacTaskMessage({ ...message, protocol: "memmy.windows.task-recording" })).toThrow();
    expect(() => nativeMacTaskMessage({ ...message, event: { ...message.event, ticks: "100200000000" } })).toThrow();
    expect(() => nativeMacTaskMessage({ ...message, event: { ...message.event, action: { text: "must never persist" } } })).toThrow();
  });
  it("validates fragment hashes, Retina transforms, source timestamps and bound window identities", async () => {
    const { frames } = writePackage();
    expect(await readMacTaskMedia(directory)).toMatchObject({ clock, qpc: null, videoIntegrity: "complete", timelineCompleteness: "complete", durationMs: 200 });
    fs.writeFileSync(path.join(directory, "frames.jsonl"), frames.map((frame) => JSON.stringify({ ...frame, window: { ...frame.window, processStart: "123" } })).join("\n"));
    await expect(readMacTaskMedia(directory)).rejects.toThrow("frame_window_invalid");
    fs.writeFileSync(path.join(directory, "frames.jsonl"), frames.map((frame) => JSON.stringify({ ...frame, sourceTicks: "999999999999" })).join("\n"));
    await expect(readMacTaskMedia(directory)).rejects.toThrow("source_clock_invalid");
    fs.writeFileSync(path.join(directory, "parts", "000001.mp4"), "x".repeat(Buffer.byteLength("verified fragment fixture")));
    await expect(readMacTaskMedia(directory)).rejects.toThrow("part_hash_invalid");
  });
  it("preserves macOS provenance through lifecycle, OCU boundaries and authenticated permission routes", async () => {
    let finish!: (result: RecordingResult) => void;
    const result: RecordingResult = { qpc: null, clock, durationMs: 200, video: null, parts: [], gaps: [], videoIntegrity: "missing", timelineCompleteness: "partial", error: null };
    const configuration = vi.fn().mockResolvedValue({ platform: "macos", supported: true, applications: [], permissions });
    const openPermission = vi.fn().mockResolvedValue(await configuration()); configuration.mockClear();
    const service = new RecordingSessionService({ directory: path.join(directory, "sessions"), platform: "macos", gate: new CollectorGate(), driver: {
      configuration, openPermission, start: vi.fn(async ({ onEvent }) => {
        onEvent({ origin: "native", type: "mouse_click", timeMs: 100, monotonicTicks: "100100000000", timestamp: "2026-10-13T00:00:00Z", window, action: { x: -1100, y: 200, button: "left" } });
        return { finished: new Promise<RecordingResult>((resolve) => { finish = resolve; }), stop: async () => { finish(result); return result; }, pause: async () => {}, resume: async () => {}, timeMs: () => 200 };
      }), recover: vi.fn().mockResolvedValue(result), exportFlow: vi.fn().mockResolvedValue([]),
    } });
    try {
      expect((await handleRecordingHttp(service, { path: "/api/computer-recordings/configuration" }, false)).status).toBe(401);
      expect(configuration).not.toHaveBeenCalled();
      expect((await handleRecordingHttp(service, { path: "/api/computer-recordings/configuration" }, true)).status).toBe(200);
      expect((await handleRecordingHttp(service, { path: "/api/computer-recordings/permissions/open", method: "POST", body: '{"permission":"screenRecording","mode":"request"}' }, true)).status).toBe(200);
      expect(openPermission).toHaveBeenCalledExactlyOnceWith("screenRecording", "request");
      const session = await service.start(consent, { runId: "actual-mac-turn", chatId: "chat-mac", messageId: "message-mac" });
      expect(session.platform).toBe("macos");
      service.markOcu("chat-mac", "mcp_open_computer_use_click", "started", "actual-mac-turn");
      expect((await service.events(session.id)).events.map((event) => event.origin)).toEqual(["native", "ocu"]);
      expect(await service.control(session.id, "stop")).toMatchObject({ platform: "macos", clock, qpc: null });
    } finally { await service.shutdown(); }
  });
  it("uses one native process, binds the policy to its PID and waits for stop before finalizing", async () => {
    const child = Object.assign(new EventEmitter(), { pid: 555, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    native.spawn.mockReturnValue(child);
    const onEvent = vi.fn();
    const starting = new MacTaskRecordingDriver("/fixture/task-recorder", store).start({ directory, applications: [app.bundleId], onEvent });
    await vi.waitFor(() => expect(native.spawn).toHaveBeenCalledOnce());
    const policySha256 = crypto.createHash("sha256").update(fs.readFileSync(path.join(directory, "policy.json"))).digest("hex");
    const sessionId = crypto.randomUUID(); let sequence = 0;
    const send = (kind: string, timeMs: number, extra: object = {}) => child.stdout.write(JSON.stringify({ protocol: "memmy.macos.task-recording", version: 1,
      sessionId, pid: child.pid, parentPid: process.pid, policySha256, sequence: ++sequence, kind, clock, timeMs,
      ticks: String(BigInt(clock.origin) + BigInt(timeMs) * 1_000_000n), timestamp: "2026-10-13T00:00:00Z", inputIncomplete: false, ...extra }) + "\n");
    send("started", 0); const handle = await starting;
    send("input", 100, { event: { type: "key_press", ticks: "100080000000", window, action: { key: "Command+a", pressCount: 1 } } });
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ timeMs: 80, monotonicTicks: "100080000000", action: { key: "Command+a", pressCount: 1 } }));
    send("heartbeat", 105, { inputIncomplete: true });
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ origin: "control", type: "input_timeline_incomplete", timeMs: 105 }));
    const paused = handle.pause(); send("paused", 110); await paused;
    const resumed = handle.resume(); send("resumed", 120); await resumed;
    native.execute.mockResolvedValue({ stdout: "" });
    fs.rmSync(path.join(directory, "policy.json")); writePackage();
    let settled = false; const stopped = handle.stop().then((result) => { settled = true; return result; });
    expect(settled).toBe(false); send("stopped", 200, { reason: "user_stopped" }); child.emit("close", 0);
    expect(await stopped).toMatchObject({ videoIntegrity: "complete", timelineCompleteness: "partial", clock, endReason: "user_stopped" });
    expect(native.execute).toHaveBeenLastCalledWith("/fixture/task-recorder", ["--finalize-task", "--output-dir", directory], expect.any(Object));
    expect(native.spawn).toHaveBeenCalledOnce(); expect(child.kill).not.toHaveBeenCalled();
  });
});
