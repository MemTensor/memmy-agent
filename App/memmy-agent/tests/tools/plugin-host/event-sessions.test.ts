import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compactEventEvidence } from "../../../src/tools/computer-history/mac/summary-writer.js";
import { redactSensitive } from "../../../src/tools/computer-history/mac/redaction.js";
import { PluginEventSessions } from "../../../src/tools/plugin-host/event-sessions.js";
import type { CaptureCheckpoint, EventCaptureSource } from "../../../src/tools/computer-history/core/event-capture-source.js";

const roots: string[] = [], services: PluginEventSessions[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });
function fixture(options: { permissions?: () => Promise<{ supported: boolean; accessibility: boolean; inputMonitoring: boolean }>;
  browserEnhancement?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "event-fragment-")); roots.push(root);
  const stream = path.join(root, "source.jsonl"); fs.writeFileSync(stream, "");
  const browserStream = path.join(root, "browser.jsonl"); fs.writeFileSync(browserStream, "");
  let time = Date.parse("2026-10-20T00:00:00Z"), running = true;
  const streams = [{ id: "first", file: stream }];
  const checkpoint = vi.fn(async (): Promise<CaptureCheckpoint> => ({ running, complete: true, limitations: ["Authorized UI events only"],
    streams: streams.map(source => ({ ...source, size: fs.statSync(source.file).size })) }));
  const release = vi.fn(async () => undefined), source: EventCaptureSource = { acquireEventCapture: vi.fn(async () => ({ checkpoint, release })) };
  const dataRoot = path.join(root, "data"), service = new PluginEventSessions({ dataRoot, source, now: () => time,
    ...(options.browserEnhancement ? { browserEnhancement: { acquire: async () => ({
      checkpoint: async () => ({ running: true, complete: true, limitations: [],
        streams: [{ id: "browser:fixture", file: browserStream, size: fs.statSync(browserStream).size }] }),
      release: async () => undefined,
    }) } } : {}),
    ...(options.permissions ? { permissions: options.permissions } : {}) }); services.push(service);
  function event(value: string, at = time, file = stream) { fs.appendFileSync(file, JSON.stringify({ recordType: "human_event", sequence: 1,
    eventType: "text_changed", timestamp: new Date(at).toISOString(), application: { name: "Any authorized app" }, details: { value } }) + "\n"); }
  return { root, stream, browserStream, streams, source, release, checkpoint, service, dataRoot, event,
    advance: (amount: number) => { time += amount; }, stopped: () => { running = false; } };
}
describe("conversation event fragments", () => {
  it("publishes byte-identical evidence with relative metadata, isolation and restricted file access", async () => {
    const f = fixture(), session = await f.service.start("test.capture", "original-chat", "Selection", true);
    f.advance(1); f.event("selected workflow content");
    const ended = await f.service.stop("test.capture", "original-chat", session.id);
    const workspace = path.join(f.root, "workspace"); fs.mkdirSync(workspace);
    const snapshot = f.service.publishEvidence("test.capture", "reading-chat", session.id, workspace);
    const source = path.join(f.dataRoot, "test.capture", "event-sessions", session.id, "events.jsonl");
    expect(fs.readFileSync(snapshot.eventsPath)).toEqual(fs.readFileSync(source));
    expect(snapshot.eventsSha256).toBe(ended.eventsSha256);
    const metadata = JSON.parse(fs.readFileSync(snapshot.metadataPath, "utf8"));
    expect(metadata).toMatchObject({ conversationId: "original-chat", state: "ready", availability: ended.availability,
      evidenceFiles: { events: "events.jsonl" } });
    expect(path.resolve(path.dirname(snapshot.metadataPath), metadata.evidenceFiles.events)).toBe(snapshot.eventsPath);
    const rows = fs.readFileSync(snapshot.eventsPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(rows).toEqual(f.service.readEvents("test.capture", "reading-chat", session.id).events);
    const { ReadFileTool } = await import("../../../src/core/agent-runtime/tools/filesystem.js");
    const reader = new ReadFileTool({ workspace, allowedDir: workspace });
    expect(await reader.execute({ path: snapshot.eventsPath })).toContain("selected workflow content");
    expect(await reader.execute({ path: source })).toContain("Error");
    const { ExecTool } = await import("../../../src/core/agent-runtime/tools/shell.js");
    const exec = new ExecTool({ workspace, restrictToWorkspace: true });
    // A real local program scans the complete JSONL without loading it as tool content.
    expect(await exec.execute({ command: `node -e 'const fs=require("fs");const rows=fs.readFileSync(process.argv[1],"utf8").trim().split("\\n").map(JSON.parse);console.log(rows.length, rows[0].index)' "${snapshot.eventsPath}"` })).toContain("1 0");
    const other = f.service.publishEvidence("test.capture", "another-chat", session.id, workspace);
    expect(path.dirname(path.dirname(other.eventsPath))).not.toBe(path.dirname(path.dirname(snapshot.eventsPath)));
    const retry = f.service.publishEvidence("test.capture", "reading-chat", session.id, workspace);
    expect(retry.eventsPath).not.toBe(snapshot.eventsPath);
    expect(fs.readdirSync(workspace)).toEqual([".teach-evidence"]);
    expect(JSON.stringify(snapshot)).not.toContain("selected workflow content");
    fs.appendFileSync(snapshot.eventsPath, "tampered copy");
    expect(f.service.readEvents("test.capture", "reading-chat", session.id).events).toEqual(rows);
    fs.appendFileSync(source, "tampered source");
    expect(() => f.service.publishEvidence("test.capture", "reading-chat", session.id, workspace)).toThrow("capture_evidence_hash_mismatch");
    expect(() => f.service.readEvents("test.capture", "reading-chat", session.id)).toThrow("capture_evidence_hash_mismatch");
  });
  it("preserves time-limit termination and rejects oversized or changed proof evidence", async () => {
    const f = fixture(), workspace = path.join(f.root, "workspace"); fs.mkdirSync(workspace);
    const session = await f.service.start("test.capture", "chat", "Timed recording", true);
    f.advance(1); f.event("action");
    const ended = await f.service.stop("test.capture", "chat", session.id, false, "max_duration");
    expect(f.service.publishEvidence("test.capture", "chat", session.id, workspace).endReason).toBe("max_duration");
    expect(await f.service.stop("test.capture", "chat", session.id)).toEqual(ended);
    const folder = path.join(f.dataRoot, "test.capture", "event-sessions", session.id);
    const manifest = JSON.parse(fs.readFileSync(path.join(folder, "session.json"), "utf8"));
    manifest.captureIntegrity = { protocolVersion: 2, coverageComplete: true, boundaryConfirmed: true, snapshotSaved: true, proofSha256: "a".repeat(64), gaps: [] };
    fs.writeFileSync(path.join(folder, "session.json"), JSON.stringify(manifest));
    fs.writeFileSync(path.join(folder, "capture-proof.jsonl"), "changed proof");
    expect(() => f.service.publishEvidence("test.capture", "chat", session.id, workspace)).toThrow("capture_proof_hash_mismatch");
    delete manifest.captureIntegrity; fs.writeFileSync(path.join(folder, "session.json"), JSON.stringify(manifest));
    fs.truncateSync(path.join(folder, "events.jsonl"), 64 * 1024 * 1024 + 1);
    expect(() => f.service.publishEvidence("test.capture", "chat", session.id, workspace)).toThrow("capture_evidence_invalid");
  });
  it("rejects non-ready evidence and symlink publication paths", async () => {
    const f = fixture(), workspace = path.join(f.root, "workspace"); fs.mkdirSync(workspace);
    const session = await f.service.start("test.capture", "chat", "Recording", true);
    expect(() => f.service.publishEvidence("test.capture", "chat", session.id, workspace)).toThrow("capture_ready_events_required");
    f.advance(1); f.event("action"); await f.service.stop("test.capture", "chat", session.id, true);
    expect(() => f.service.publishEvidence("test.capture", "chat", session.id, workspace)).toThrow("capture_ready_events_required");
    const empty = await f.service.start("test.capture", "chat", "Empty", true); await f.service.stop("test.capture", "chat", empty.id);
    expect(() => f.service.publishEvidence("test.capture", "chat", empty.id, workspace)).toThrow("capture_ready_events_required");
    f.advance(1); const ready = await f.service.start("test.capture", "chat", "Ready", true);
    f.advance(1); f.event("action"); await f.service.stop("test.capture", "chat", ready.id);
    fs.symlinkSync(f.dataRoot, path.join(workspace, ".teach-evidence"), "dir");
    expect(() => f.service.publishEvidence("test.capture", "chat", ready.id, workspace)).toThrow("capture_invalid_workspace_path");
    expect(() => f.service.publishEvidence("another.plugin", "chat", ready.id, workspace)).toThrow();
  });

  it("formats only the selected teaching session with shared code and persists only its derived summary", async () => {
    const f = fixture();
    // A prior session must not enter the selected session's summary.
    const old = await f.service.start("test.capture", "chat-a", "Earlier", true);
    f.advance(1); f.event("unrelated earlier value");
    await f.service.stop("test.capture", "chat-a", old.id);
    f.advance(10);
    const session = await f.service.start("test.capture", "chat-b", "Current", true);
    f.advance(1);
    fs.appendFileSync(f.stream, JSON.stringify({ recordType: "human_event", eventType: "text_input",
      timestamp: new Date(Date.parse(session.startedAt) + 1).toISOString(),
      application: { name: "Editor" }, details: { text: "Selected teaching note", redacted: false } }) + "\n");
    const ended = await f.service.stop("test.capture", "chat-b", session.id);
    const folder = path.join(f.dataRoot, "test.capture", "event-sessions", session.id);
    const rawBefore = fs.readFileSync(path.join(folder, "events.jsonl"), "utf8");
    const acquisitions = vi.mocked(f.source.acquireEventCapture).mock.calls.length;
    const summary = await f.service.invoke("test.capture", "chat-b", { action: "summary", session_id: session.id });
    const raw = f.service.readEvents("test.capture", "chat-b", session.id);
    expect(summary).toMatchObject({ schema: "memmy.teaching-summary/v1", sessionId: session.id,
      eventsSha256: ended.eventsSha256, eventCount: 1, limitations: ended.limitations,
      text: redactSensitive(compactEventEvidence(raw.events.map(row => JSON.stringify((row as any).event)))) });
    expect(summary.text).toContain("Selected teaching note");
    expect(summary.text).not.toContain("unrelated earlier value");
    expect(JSON.parse(fs.readFileSync(path.join(folder, "summary.json"), "utf8"))).toEqual(summary);
    expect(fs.readFileSync(path.join(folder, "events.jsonl"), "utf8")).toBe(rawBefore);
    expect(vi.mocked(f.source.acquireEventCapture).mock.calls.length).toBe(acquisitions);
    expect(fs.readdirSync(f.dataRoot)).toEqual(["test.capture"]);
    expect(fs.readdirSync(path.join(f.dataRoot, "test.capture"))).toEqual(["event-sessions"]);
    expect(fs.existsSync(path.join(f.dataRoot, "test.capture", "event-sessions", old.id, "summary.json"))).toBe(false);
    expect(() => f.service.summarize("another.plugin", "chat-b", session.id)).toThrow();
    fs.appendFileSync(path.join(folder, "events.jsonl"), "\n");
    expect(() => f.service.summarize("test.capture", "chat-b", session.id)).toThrow("capture_evidence_hash_mismatch");
  });
  it("does not produce a summary for active, empty or discarded recordings", async () => {
    const f = fixture(), session = await f.service.start("test.capture", "chat-a", "Not finished", true);
    expect(() => f.service.summarize("test.capture", "chat-a", session.id)).toThrow("capture_ready_events_required");
    const folder = path.join(f.dataRoot, "test.capture", "event-sessions", session.id);
    fs.writeFileSync(path.join(folder, "summary.json"), "stale derived data");
    await f.service.stop("test.capture", "chat-a", session.id, true);
    expect(fs.existsSync(path.join(folder, "summary.json"))).toBe(false);
    expect(() => f.service.summarize("test.capture", "chat-a", session.id)).toThrow("capture_ready_events_required");
    const empty = await f.service.start("test.capture", "chat-a", "Empty", true);
    await f.service.stop("test.capture", "chat-a", empty.id);
    expect(() => f.service.summarize("test.capture", "chat-a", empty.id)).toThrow("capture_ready_events_required");
  });
  it("discards captured evidence and keeps only an empty cancelled record", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(), session = await f.service.start("test.capture", "chat-a", "Discard this demo", true);
      const folder = path.join(f.dataRoot, "test.capture", "event-sessions", session.id);
      f.advance(1); f.event("private demonstration");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fs.statSync(path.join(folder, "events.jsonl")).size).toBeGreaterThan(0);
      fs.writeFileSync(path.join(folder, "capture-proof.jsonl"), "proof");
      const cancelled = await f.service.stop("test.capture", "chat-a", session.id, true);
      expect(cancelled).toMatchObject({ state: "cancelled", eventCount: 0, availability: "empty", eventsSha256: null,
        applications: [], eventTypes: {}, ranges: [], endReason: "recording_controls_cancelled" });
      expect(fs.statSync(path.join(folder, "events.jsonl")).size).toBe(0);
      expect(fs.existsSync(path.join(folder, "capture-proof.jsonl"))).toBe(false);
      expect(f.service.list("test.capture", "chat-a")[0]).toMatchObject({ state: "cancelled", eventCount: 0 });
    } finally { vi.useRealTimers(); }
  });
  it("finishes a recording automatically at the 30 minute limit", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(), session = await f.service.start("test.capture", "chat-a", "Timed demo", true);
      f.advance(30 * 60 * 1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(f.service.list("test.capture", "chat-a")[0]).toMatchObject({ state: "ready" });
      expect(f.release).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it("keeps optional browser and desktop events in timestamp order in one session", async () => {
    const f = fixture({ browserEnhancement: true });
    const session = await f.service.start("test.capture", "chat-a", "Use Chrome and desktop", true);
    f.advance(20);
    f.event("desktop later", Date.parse(session.startedAt) + 15);
    fs.appendFileSync(f.browserStream, JSON.stringify({ recordType: "human_event", sequence: 1,
      eventType: "browser_action", timestamp: new Date(Date.parse(session.startedAt) + 5).toISOString(),
      application: { name: "Google Chrome" }, details: { action: "click" } }) + "\n");
    const ended = await f.service.stop("test.capture", "chat-a", session.id);
    expect(ended).toMatchObject({ state: "ready", eventCount: 2, endReason: "recording_controls_stopped" });
    expect(f.service.readEvents("test.capture", "chat-a", session.id).events).toMatchObject([
      { index: 0, source: { stream: "browser:fixture" }, event: { eventType: "browser_action" } },
      { index: 1, source: { stream: "first" }, event: { details: { value: "desktop later" } } },
    ]);
  });
  it("reorders a late browser enhancement before earlier-collected desktop evidence at stop", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture({ browserEnhancement: true });
      const session = await f.service.start("test.capture", "chat-a", "Late browser event", true);
      f.advance(20);
      f.event("desktop arrived first", Date.parse(session.startedAt) + 15);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(f.service.list("test.capture", "chat-a")[0]?.eventCount).toBe(1);
      fs.appendFileSync(f.browserStream, JSON.stringify({ recordType: "human_event", sequence: 1,
        eventType: "browser_action", timestamp: new Date(Date.parse(session.startedAt) + 5).toISOString(),
        application: { name: "Google Chrome" }, details: { action: "click" } }) + "\n");
      const ended = await f.service.stop("test.capture", "chat-a", session.id);
      expect(ended.eventCount).toBe(2);
      expect(f.service.readEvents("test.capture", "chat-a", session.id).events).toMatchObject([
        { index: 0, source: { stream: "browser:fixture" } },
        { index: 1, source: { stream: "first" } },
      ]);
    } finally { vi.useRealTimers(); }
  });
  it("reads grants and keeps a permission alert scoped to one conversation", async () => {
    const f = fixture({ permissions: async () => ({ supported: true, accessibility: false, inputMonitoring: true }) });
    expect(await f.service.invoke("test.capture", "chat-a", { action: "permissions" }))
      .toEqual({ supported: true, accessibility: false, inputMonitoring: true });
    const pending = await f.service.invoke("test.capture", "chat-a", { action: "permission-alert", pending: true });
    expect(pending).toMatchObject({ pending: true, required: ["accessibility"] });
    expect((await f.service.invoke("test.capture", "chat-a", { action: "status" })).permissionAlert)
      .toMatchObject({ required: ["accessibility"] });
    expect((await f.service.invoke("test.capture", "chat-b", { action: "status" })).permissionAlert).toBeNull();
    await f.service.invoke("test.capture", "chat-a", { action: "permission-alert", pending: false });
    expect((await f.service.invoke("test.capture", "chat-a", { action: "status" })).permissionAlert).toBeNull();
  });
  it("keeps a forced alert when the grants read as present but the recorder still lacks them", async () => {
    const f = fixture({ permissions: async () => ({ supported: true, accessibility: true, inputMonitoring: true }) });
    expect(await f.service.invoke("test.capture", "chat-a", { action: "permission-alert", pending: true }))
      .toMatchObject({ pending: false });
    expect(await f.service.invoke("test.capture", "chat-a", { action: "permission-alert", pending: true, force: true }))
      .toMatchObject({ pending: true, required: [] });
    expect((await f.service.invoke("test.capture", "chat-a", { action: "status" })).permissionAlert).toMatchObject({ required: [] });
  });
  it("clears the alert when recording actually starts", async () => {
    const f = fixture({ permissions: async () => ({ supported: true, accessibility: false, inputMonitoring: true }) });
    await f.service.invoke("test.capture", "chat-a", { action: "permission-alert", pending: true });
    await f.service.start("test.capture", "chat-a", "Save a note", true);
    expect((await f.service.invoke("test.capture", "chat-a", { action: "status" })).permissionAlert).toBeNull();
  });
  it("defers events slightly ahead of the Host clock without advancing past them", async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      const session = await f.service.start("test.capture", "chat-a", "Native clock leads Host", true);
      f.event("中文事件稍后读取", Date.parse(session.startedAt) + 5);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(f.service.list("test.capture", "chat-a")[0]!.eventCount).toBe(0);
      expect(f.service.list("test.capture", "chat-a")[0]!.ranges[0]!.endByte).toBe(0);
      f.advance(10);
      await vi.advanceTimersByTimeAsync(1_000);
      const ended = await f.service.stop("test.capture", "chat-a", session.id);
      expect(ended).toMatchObject({ eventCount: 1, availability: "available" });
      expect(f.service.readEvents("test.capture", "chat-a", session.id).events).toMatchObject([{ event: { details: { value: "中文事件稍后读取" } } }]);
      expect(ended.ranges[0]!.endByte).toBe(fs.statSync(f.stream).size);
    } finally { vi.useRealTimers(); }
  });
  it("excludes checkpoint controls and later same-tick events beyond the acknowledged byte position", async () => {
    const f = fixture(), session = await f.service.start("test.capture", "chat-a", "Sequenced fence", true);
    f.advance(10); f.event("before marker");
    fs.appendFileSync(f.stream, JSON.stringify({ recordType: "human_event", sequence: 2, eventType: "recording_checkpoint",
      timestamp: session.startedAt, details: { nativeSequence: 20, captureSequence: 10 } }) + "\n");
    fs.appendFileSync(f.stream, JSON.stringify({ recordType: "human_event", sequence: 3, eventType: "recording_gap",
      timestamp: session.startedAt, details: { code: "queue_overflow" } }) + "\n");
    const original = f.checkpoint.getMockImplementation()!;
    f.checkpoint.mockImplementationOnce(async () => {
      const point = await original();
      f.event("after marker, same timestamp");
      return point;
    });
    const ended = await f.service.stop("test.capture", "chat-a", session.id);
    expect(ended).toMatchObject({ state: "ready", availability: "available", eventCount: 1 });
    expect(f.service.readEvents("test.capture", "chat-a", session.id).events).toMatchObject([
      { event: { eventType: "text_changed", details: { value: "before marker" } } },
    ]);
    expect(ended.ranges[0]!.endByte).toBeLessThan(fs.statSync(f.stream).size);
  });
  it("does not inherit a range-aware baseline gap before the fragment began", async () => {
    const f = fixture(), original = f.checkpoint.getMockImplementation()!;
    f.checkpoint.mockImplementationOnce(async () => ({ ...await original(), complete: false, rangeEvaluated: true,
      limitations: ["Capture coverage is incomplete (privacy_unknown)."] }));
    const session = await f.service.start("test.capture", "chat-a", "Healthy new interval", true);
    f.advance(1); f.event("inside"); f.advance(1);
    expect(await f.service.stop("test.capture", "chat-a", session.id)).toMatchObject({ availability: "available", eventCount: 1 });
  });
  it("freezes the first global stop cutoff during a slow periodic checkpoint and coalesces polls", async () => {
    vi.useFakeTimers();
    const f = fixture(), session = await f.service.start("test.capture", "chat-a", "Goal", true);
    const original = f.checkpoint.getMockImplementation()!;
    let unblock!: () => void;
    const barrier = new Promise<void>(resolve => { unblock = resolve; });
    f.checkpoint.mockImplementationOnce(async () => { await barrier; return original(); });
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      f.advance(10); f.event("before stop");
      expect((await f.service.invoke("test.capture", "other-chat", { action: "status" })).active).toMatchObject({ id: session.id, conversationId: "chat-a" });
      const first = f.service.stop("test.capture", "other-chat", session.id);
      const cutoff = f.service.list("test.capture", "chat-a")[0]!.endedAt;
      f.advance(1_000); f.event("after accepted stop");
      expect(f.service.stop("test.capture", "chat-a", session.id)).toBe(first);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(f.checkpoint).toHaveBeenCalledTimes(2); // baseline and one in-flight poll
      unblock();
      const ended = await first;
      expect(ended).toMatchObject({ endedAt: cutoff, state: "ready", eventCount: 1 });
      expect(f.service.readEvents("test.capture", "chat-a", session.id).events).toMatchObject([{ event: { details: { value: "before stop" } } }]);
      expect(f.checkpoint).toHaveBeenCalledTimes(3);
      expect(f.checkpoint).toHaveBeenLastCalledWith({ from: session.startedAt, through: cutoff });
    } finally { unblock(); vi.useRealTimers(); }
  });
  it("retains a transient incomplete boundary even when capture recovers before stop", async () => {
    const f = fixture(), original = f.checkpoint.getMockImplementation()!;
    f.checkpoint.mockImplementationOnce(async () => ({ ...await original(), complete: false, limitations: ["observer_unavailable"] }));
    const session = await f.service.start("test.capture", "chat-a", "Goal", true);
    f.advance(10); f.event("after recovery"); f.advance(10);
    expect(await f.service.stop("test.capture", "chat-a", session.id)).toMatchObject({ state: "ready", eventCount: 1, availability: "partial" });
    expect(f.release).toHaveBeenCalledOnce();
  });
  it("distinguishes a confirmed boundary with coverage gaps from a missing native acknowledgement", async () => {
    const f = fixture(), session = await f.service.start("test.capture", "chat-a", "Known gap", true);
    f.advance(10); f.event("readable partial evidence");
    const original = f.checkpoint.getMockImplementation()!;
    f.checkpoint.mockImplementationOnce(async () => ({ ...await original(), complete: false, rangeEvaluated: true,
      boundaryConfirmed: true, limitations: ["Capture coverage is incomplete (query_unavailable)."] }));
    const ended = await f.service.stop("test.capture", "chat-a", session.id);
    expect(ended.availability).toBe("partial");
    expect(ended.limitations).toContain("Capture coverage is incomplete for this fragment.");
    expect(ended.limitations.join(" ")).not.toContain("completion was not confirmed");
  });
  it("marks an unconfirmed native boundary partial and keeps post-stop observations outside the fragment", async () => {
    const f = fixture(), session = await f.service.start("test.capture", "chat-a", "Goal", true);
    f.advance(10); f.event("inside");
    const original = f.checkpoint.getMockImplementation()!;
    f.checkpoint.mockImplementation(async () => {
      f.advance(100); f.event("after stop request");
      return { ...await original(), complete: false };
    });
    const ended = await f.service.stop("test.capture", "chat-a", session.id);
    expect(ended).toMatchObject({ state: "ready", availability: "partial", eventCount: 1 });
    expect(f.service.readEvents("test.capture", "chat-a", session.id).events).toHaveLength(1);
  });

  it("uses source positions to retain an event in the same timestamp tick as end", async () => {
    const f = fixture(), session = await f.service.start("test.capture", "chat-a", "Goal", true);
    f.event("same tick");
    expect(await f.service.stop("test.capture", "chat-a", session.id)).toMatchObject({ state: "ready", eventCount: 1 });
    f.event("after confirmation");
    expect(f.service.readEvents("test.capture", "chat-a", session.id).events).toHaveLength(1);
  });
  it("seals exact positions/time bounds across rotation and preserves a durable snapshot independently of History cleanup", async () => {
    const f = fixture(); f.event("before");
    const session = await f.service.start("test.capture", "chat-a", "Record a workflow", true);
    f.advance(100); f.event("inside");
    const second = path.join(f.root, "second.jsonl"); fs.writeFileSync(second, ""); f.streams.push({ id: "second", file: second });
    f.advance(100); f.event("rotated", undefined, second); f.event("future", Date.parse(session.startedAt) + 10_000, second);
    f.advance(100); const ended = await f.service.stop("test.capture", "chat-a", session.id);
    f.event("after"); fs.rmSync(f.stream); fs.rmSync(second);
    expect(ended).toMatchObject({ state: "ready", availability: "available", eventCount: 2, eventTypes: { text_changed: 2 } });
    expect(ended.ranges).toHaveLength(2); expect(ended.ranges[0]!.startByte).toBeGreaterThan(0);
    const page = f.service.readEvents("test.capture", "chat-a", session.id);
    expect(page.events.map((item: any) => item.event.details.value)).toEqual(["inside", "rotated"]);
    expect(f.release).toHaveBeenCalledOnce(); expect(ended.eventsSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await f.service.stop("test.capture", "chat-a", session.id)).toEqual(ended);
  });
  it("requires explicit consent and serializes repeated start requests into one subscription", async () => {
    const f = fixture(); await expect(f.service.start("test.capture", "chat-a", "Goal", false)).rejects.toThrow("consent");
    const results = await Promise.all([f.service.start("test.capture", "chat-a", "Goal", true), f.service.start("test.capture", "chat-a", "Goal", true)]);
    expect(results[0]!.id).toBe(results[1]!.id); expect(f.source.acquireEventCapture).toHaveBeenCalledOnce();
    await f.service.release("test.capture"); expect(f.release).toHaveBeenCalledOnce();
    expect(f.service.list("test.capture", "chat-a")[0]).toMatchObject({ state: "failed", error: "capture_plugin_stopped" });
  });
  it("exposes one live recording globally and rejects a second start", async () => {
    const f = fixture(), first = await f.service.start("test.capture", "chat-a", "Goal", true);
    expect(await f.service.invoke("test.capture", "chat-b", { action: "status" })).toMatchObject({
      active: { id: first.id, conversationId: "chat-a", state: "recording" }
    });
    await expect(f.service.start("test.capture", "chat-b", "Another goal", true)).resolves.toMatchObject({
      id: first.id, conversationId: "chat-a", alreadyActive: true
    });
  });
  it("keeps source conversation provenance while exposing completed evidence globally", async () => {
    const f = fixture(), session = await f.service.start("test.capture", "chat-a", "Goal", true);
    f.advance(1); f.event("captured"); f.advance(1); await f.service.stop("test.capture", "chat-a", session.id);
    expect(f.service.list("test.capture", "chat-b")[0]).toMatchObject({ id: session.id, conversationId: "chat-a" });
    expect(f.service.readEvents("test.capture", "chat-b", session.id).session.conversationId).toBe("chat-a");
    const evidence = path.join(f.dataRoot, "test.capture", "event-sessions", session.id, "events.jsonl"); fs.appendFileSync(evidence, "tampered\n");
    expect(() => f.service.readEvents("test.capture", "chat-a", session.id)).toThrow("hash_mismatch");
    const cancelled = await f.service.start("test.capture", "chat-a", "Other goal", true); f.advance(1);
    expect(await f.service.stop("test.capture", "chat-a", cancelled.id, true)).toMatchObject({ state: "cancelled" });
    expect(() => f.service.readEvents("test.capture", "chat-a", cancelled.id)).toThrow("ready_events_required");
  });
  it("retains incomplete records as an explicit partial result without admitting their payload", async () => {
    const f = fixture(), session = await f.service.start("test.capture", "chat-a", "Goal", true);
    f.advance(1); f.event("complete"); fs.appendFileSync(f.stream, '{"recordType":"human_event",'); f.advance(1);
    const ended = await f.service.stop("test.capture", "chat-a", session.id);
    expect(ended).toMatchObject({ state: "ready", availability: "partial", eventCount: 1 });
    expect(ended.limitations.join(" ")).toContain("incomplete trailing");
  });

  it("excludes an in-progress source record that began before the start boundary", async () => {
    const f = fixture(); fs.appendFileSync(f.stream, '{"recordType":"human_event",');
    const session = await f.service.start("test.capture", "chat-a", "Goal", true);
    fs.appendFileSync(f.stream, '"eventType":"text_changed","timestamp":"2026-10-20T00:00:00.001Z"}\n');
    f.advance(2); f.event("inside"); f.advance(2);
    expect(await f.service.stop("test.capture", "chat-a", session.id)).toMatchObject({ state: "ready", eventCount: 1 });
    expect(f.service.readEvents("test.capture", "chat-a", session.id).events).toMatchObject([{ event: { details: { value: "inside" } } }]);
  });
  it("never reports a stopped source as ready or resumes a recovered recording", async () => {
    const f = fixture(), session = await f.service.start("test.capture", "chat-a", "Goal", true); f.stopped();
    expect(await f.service.stop("test.capture", "chat-a", session.id)).toMatchObject({ state: "failed", error: "capture_source_stopped" });
    expect(f.release).toHaveBeenCalledOnce();
    const manifest = path.join(f.dataRoot, "test.capture", "event-sessions", session.id, "session.json");
    const interrupted = JSON.parse(fs.readFileSync(manifest, "utf8")); interrupted.state = "recording"; fs.writeFileSync(manifest, JSON.stringify(interrupted));
    const recovered = new PluginEventSessions({ dataRoot: f.dataRoot, source: f.source }); services.push(recovered);
    expect(recovered.list("test.capture", "chat-a")[0]).toMatchObject({ state: "failed", error: "capture_interrupted" });
    expect(f.source.acquireEventCapture).toHaveBeenCalledOnce();
  });
});
