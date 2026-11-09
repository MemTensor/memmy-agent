import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecordingSessionSchema } from "@memmy/local-api-contracts";
import { CollectorGate } from "../../../src/tools/computer-history/core/collector-gate.js";
import { RecordingSessionService, writeJsonAtomic, type RecordingResult, type TaskRecordingDriver } from "../../../src/tools/computer-recordings/session-service.js";
import { handleRecordingHttp, recordingRange } from "../../../src/tools/computer-recordings/http-api.js";

const roots: string[] = [], services: RecordingSessionService[] = [];
const consent = { title: "Demonstration", applications: ["C:\\Apps\\Fixture.exe"], consent: true as const };
function fixture(input: { gate?: CollectorGate; historyBusy?: () => boolean; now?: () => number; directory?: string } = {}) {
  const directory = input.directory ?? fs.mkdtempSync(path.join(os.tmpdir(), "memmy-task-recording-"));
  if (!roots.includes(directory)) roots.push(directory);
  let finish!: (result: RecordingResult) => void;
  let result: RecordingResult;
  const handle = { finished: new Promise<RecordingResult>((resolve) => { finish = resolve; }),
    pause: vi.fn().mockResolvedValue(undefined), resume: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(async () => { finish(result); return result; }), timeMs: () => 1000 };
  const driver: TaskRecordingDriver = {
    start: vi.fn(async ({ directory: packageDirectory, onEvent }) => {
      const video = Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz");
      fs.writeFileSync(path.join(packageDirectory, "recording.mp4"), video);
      fs.mkdirSync(path.join(packageDirectory, "parts")); fs.writeFileSync(path.join(packageDirectory, "parts", "000001.mp4"), video);
      fs.writeFileSync(path.join(packageDirectory, "frames.jsonl"), "");
      result = { durationMs: 1000, video: { mediaId: "recording", width: 1920, height: 1080, fps: 15, audio: false },
        parts: [{ mediaId: "part-000001", startMs: 0, durationMs: 1000, bytes: video.length, sha256: crypto.createHash("sha256").update(video).digest("hex") }],
        gaps: [], qpc: { origin: "9007199254740993", frequency: "10000000" }, videoIntegrity: "complete", timelineCompleteness: "complete", error: null };
      onEvent({ timeMs: 50, timestamp: "2026-10-13T00:00:00.000Z", origin: "native", type: "mouse_click", window: null, action: { x: 10, y: 20, button: "left" } });
      return handle;
    }),
    recover: vi.fn(async (): Promise<RecordingResult> => ({ ...result, videoIntegrity: "partial", timelineCompleteness: "partial", error: "interrupted" })),
    exportFlow: vi.fn(async () => ["text_not_retained"]),
  };
  const gate = input.gate ?? new CollectorGate();
  const service = new RecordingSessionService({ driver, directory, gate, ...input }); services.push(service);
  return { directory, service, driver, handle, gate, finish: (value?: Partial<RecordingResult>) => finish({ ...result, ...value }) };
}
afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("task recording sessions", () => {
  it("persists only hashed consent claims and never automatically records a recovered message", async () => {
    const { service, directory } = fixture();
    expect(await service.claimAgentMessage("chat", "message")).toBe(true);
    expect(await service.claimAgentMessage("chat", "message")).toBe(false);
    const bytes = fs.readFileSync(path.join(directory, "agent-attempts.jsonl"), "utf8");
    expect(bytes).not.toContain("chat"); expect(bytes).not.toContain("message");
    await service.shutdown();
    const next = fixture({ directory }); expect(await next.service.claimAgentMessage("chat", "message")).toBe(false);
  });
  it("requires fresh video consent and explicit application scope before starting capture", async () => {
    const { service, driver } = fixture();
    await expect(service.start({ ...consent, consent: false } as never)).rejects.toMatchObject({ status: 422 });
    await expect(service.start({ ...consent, applications: [] })).rejects.toMatchObject({ status: 422 });
    expect(driver.start).not.toHaveBeenCalled(); expect(await service.list()).toEqual([]);
  });
  it("rejects history running or transitioning and shares the gate in both directions", async () => {
    const historyBusy = vi.fn(() => true);
    const { service, gate } = fixture({ historyBusy });
    await expect(service.start(consent)).rejects.toMatchObject({ status: 409 });
    historyBusy.mockReturnValue(false);
    const release = gate.acquire("history");
    await expect(service.start(consent)).rejects.toMatchObject({ status: 409 }); release();
    const session = await service.start(consent);
    expect(() => gate.acquire("history")).toThrow("collector_busy");
    await service.control(session.id, "stop"); expect(gate.busy).toBe(false);
  });
  it("persists independent strict manifests and serializes pause/resume/stop", async () => {
    const { service, handle, directory } = fixture();
    const session = await service.start(consent);
    expect(session.state).toBe("recording");
    await expect(service.control(session.id, "resume")).rejects.toMatchObject({ status: 409 });
    expect((await service.control(session.id, "pause")).state).toBe("paused");
    expect((await service.control(session.id, "resume")).state).toBe("recording");
    const ready = await service.control(session.id, "stop");
    expect(ready).toMatchObject({ state: "ready", videoIntegrity: "complete", taskEndReason: "user_stopped", privacy: { rawVisibleFrames: true, audio: false } });
    expect(RecordingSessionSchema.parse(JSON.parse(fs.readFileSync(path.join(directory, session.id, "manifest.json"), "utf8")))).toEqual(ready);
    expect(handle.pause).toHaveBeenCalledOnce(); expect(handle.resume).toHaveBeenCalledOnce(); expect(handle.stop).toHaveBeenCalledOnce();
    expect((await service.events(session.id)).events[0]).toMatchObject({ sequence: 1, timeMs: 50, origin: "native" });
  });
  it("reserves the collector before asynchronous startup and rejects a simultaneous start", async () => {
    const { service, driver, handle, gate } = fixture();
    const original = vi.mocked(driver.start).getMockImplementation()!;
    let ready!: () => void;
    const wait = new Promise<void>((resolve) => { ready = resolve; });
    vi.mocked(driver.start).mockReset().mockImplementation(async (input) => { await wait; return original(input); });
    const first = service.start(consent);
    await vi.waitFor(() => expect(gate.taskActive).toBe(true));
    await expect(service.start(consent)).rejects.toMatchObject({ status: 409 });
    ready(); const session = await first; await service.control(session.id, "stop"); expect(handle.stop).toHaveBeenCalledOnce();
  });
  it("keeps a valid video distinct from a partial input timeline", async () => {
    const { service, finish } = fixture();
    const session = await service.start(consent);
    finish({ timelineCompleteness: "partial" });
    await vi.waitFor(async () => expect((await service.get(session.id)).state).toBe("ready"));
    expect(await service.get(session.id)).toMatchObject({ videoIntegrity: "complete", timelineCompleteness: "partial" });
  });
  it("seals on Agent completion and keeps manual stopping independent of task execution", async () => {
    const { service, handle } = fixture();
    const session = await service.start(consent, { runId: crypto.randomUUID(), chatId: "chat-1", messageId: "message-1" });
    service.markOcu("other-chat", "mcp_open_computer_use_click", "started");
    service.markOcu("chat-1", "mcp_open_computer_use_click", "started");
    expect((await service.events(session.id)).events.map((event) => event.origin)).toEqual(["native", "ocu"]);
    await service.control(session.id, "stop"); await service.finishAgent("chat-1", "cancelled");
    expect(handle.stop).toHaveBeenCalledOnce();
    expect((await service.get(session.id)).taskEndReason).toBe("user_stopped");
  });
  it("retains an explicit failed session and releases the gate after startup failure", async () => {
    const { service, driver, gate } = fixture();
    vi.mocked(driver.start).mockRejectedValueOnce(new Error("synthetic start failure"));
    vi.mocked(driver.recover).mockRejectedValueOnce(new Error("no media"));
    await expect(service.start(consent)).rejects.toThrow("synthetic start failure");
    expect(gate.busy).toBe(false);
    expect((await service.list())[0]).toMatchObject({ state: "failed", videoIntegrity: "missing", taskEndReason: "capture_failed" });
  });
  it("still stops capture and releases the gate when metadata writes fail", async () => {
    const { service, handle, gate } = fixture(); const session = await service.start(consent);
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("synthetic disk full"); });
    try {
      const stopped = await service.control(session.id, "stop");
      expect(handle.stop).toHaveBeenCalledOnce(); expect(gate.busy).toBe(false);
      expect(stopped).toMatchObject({ state: "failed", error: "recording_metadata_write_failed" });
    } finally { rename.mockRestore(); }
  });
  it("cleans the complete package after 48h but keeps pinned recordings", async () => {
    let now = Date.parse("2026-10-13T00:00:00Z");
    const { service, directory } = fixture({ now: () => now });
    const session = await service.start(consent); await service.control(session.id, "stop"); await service.pin(session.id, true);
    await service.shutdown(); now += 49 * 3600_000;
    const second = fixture({ directory, now: () => now });
    expect((await second.service.list()).map((recording) => recording.id)).toContain(session.id);
    await second.service.pin(session.id, false); await second.service.shutdown();
    const third = fixture({ directory, now: () => now }); expect(await third.service.list()).toEqual([]);
    expect(fs.existsSync(path.join(directory, session.id))).toBe(false);
  });
  it("recovers sealed media without restarting capture and marks interruption", async () => {
    const { service, directory, driver } = fixture();
    const session = await service.start(consent); const stopped = await service.control(session.id, "stop"); await service.shutdown();
    writeJsonAtomic(path.join(directory, session.id, "manifest.json"), { ...stopped, state: "recording", stoppedAt: null });
    const recovered = fixture({ directory });
    vi.mocked(recovered.driver.recover).mockImplementation(async (folder) => driver.recover(folder));
    expect((await recovered.service.list())[0]).toMatchObject({ state: "failed", taskEndReason: "process_exit", videoIntegrity: "partial" });
    expect(recovered.driver.start).not.toHaveBeenCalled();
  });
  it("rejects deletion of an active recording and deletes all artifacts after stopping", async () => {
    const { service, directory } = fixture(); const session = await service.start(consent);
    await expect(service.delete(session.id)).rejects.toMatchObject({ status: 409 });
    await service.control(session.id, "stop"); await service.delete(session.id);
    expect(fs.existsSync(path.join(directory, session.id))).toBe(false);
  });
  it("refuses clearing active capture and clears kept video packages after explicit confirmation", async () => {
    const { service, directory } = fixture(); const session = await service.start(consent);
    await expect(service.clear("all")).rejects.toMatchObject({ status: 409 });
    await service.control(session.id, "stop"); await service.pin(session.id, true); await service.clear("all");
    expect(fs.existsSync(path.join(directory, session.id))).toBe(false);
  });
});

describe("authenticated recording media", () => {
  it("does not inspect files or start capture before authentication", async () => {
    const service = { list: vi.fn(), start: vi.fn() } as unknown as RecordingSessionService;
    expect((await handleRecordingHttp(service, { path: "/api/computer-recordings" }, false)).status).toBe(401);
    expect(service.list).not.toHaveBeenCalled();
  });
  it("streams a byte range, supports suffixes and HEAD, and rejects unsafe ranges", async () => {
    const { service } = fixture(); const session = await service.start(consent); await service.control(session.id, "stop");
    const request = { path: `/api/computer-recordings/${session.id}/video`, headers: { range: "bytes=5-9" } };
    const response = await handleRecordingHttp(service, request, true);
    expect(response.status).toBe(206); expect(response.headers["content-range"]).toBe("bytes 5-9/36");
    let content = ""; for await (const chunk of response.stream!) content += String(chunk); expect(content).toBe("56789");
    const head = await handleRecordingHttp(service, { ...request, method: "HEAD" }, true);
    expect(head.stream).toBeUndefined(); expect(head.headers["content-length"]).toBe("5");
    expect(recordingRange("bytes=-4", 36)).toEqual({ start: 32, end: 35, partial: true });
    for (const range of ["bytes=50-60", "bytes=4-2", "bytes=0-1,4-5", "bytes=-0", "bytes=-", "bytes=1e3-"]) {
      expect((await handleRecordingHttp(service, { ...request, headers: { range } }, true)).status).toBe(416);
    }
  });
  it("rejects arbitrary media paths, directory traversal and symlinked media", async () => {
    const { service, directory } = fixture(); const session = await service.start(consent); await service.control(session.id, "stop");
    await expect(service.openMedia(session.id, "../../secret")).rejects.toMatchObject({ status: 404 });
    await expect(service.get("../secret")).rejects.toMatchObject({ status: 400 });
    const file = path.join(directory, session.id, "recording.mp4"); fs.unlinkSync(file);
    const outside = path.join(directory, "secret"); fs.writeFileSync(outside, "private");
    try { fs.symlinkSync(outside, file); } catch { return; } // Windows non-admin environments may deny symlink creation.
    await expect(service.openMedia(session.id)).rejects.toMatchObject({ status: 404 });
  });
});
