import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// No native helper, personal profile, network call or real desktop event is used.
class SyntheticRecorder extends EventEmitter {
  pid = 123456;
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  closeOnExit = true;
  onKill?: () => void;
  kill() { this.onKill?.(); this.exit(0); return true; }
  exit(code = 1) { this.exitCode = code; this.emit("exit", code); if (this.closeOnExit) this.emit("close", code); }
}
const transport = vi.hoisted(() => ({ children: [] as SyntheticRecorder[] }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  spawn: () => { const child = new SyntheticRecorder(); transport.children.push(child); return child; },
}));
vi.mock("../../../../src/tools/computer-history/memory-adapter.js", () => ({
  HistoryMemoryAdapter: class {
    status() { return { lastSyncedAt: null, error: null }; }
    memoryIdFor() { return undefined; }
    schedule() {}
    remove() {}
    async close() {}
  },
}));
import { ComputerHistoryDemoService } from "../../../../src/tools/computer-history/mac/computer-history-api.js";

interface FixtureSegment {
  id: string; directory: string; eventsFile: string; historyFile: string; metadataFile: string;
  startedAt: string; child: null; output: string; stoppedByUser: boolean;
}
interface Internals {
  segment: FixtureSegment | null;
  observationState: "running" | "stopped";
  writeLiveSummary(segment: FixtureSegment): void;
  writeSegmentSummary(segment: FixtureSegment, destination?: string, closed?: boolean): string | null;
  canExpireRaw(directory: string): boolean;
  retentionCheckpointPath(id: string): string | null;
  summaryJobs: Map<string, { promise: Promise<boolean> }>;
}
let root: string;
let service: ComputerHistoryDemoService;
const internal = () => service as unknown as Internals;
const runtime = (chat: (...args: unknown[]) => Promise<{ content: string }>) =>
  (() => ({ model: "synthetic", provider: { chatWithRetry: chat } })) as unknown as Parameters<ComputerHistoryDemoService["setLlmRuntime"]>[0];
const narrative = (marker: string) => ({ content: JSON.stringify({ title: marker, description: marker, body: `## Memory summary\n\n${marker}` }) });
const checkpointPath = (segment: FixtureSegment) => `${segment.historyFile}.evidence.json`;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-09T10:01:00Z"));
  transport.children.length = 0;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "history-coverage-health-"));
  const recorderScript = path.join(root, "synthetic-recorder.js");
  fs.writeFileSync(recorderScript, "// inert: spawn is mocked");
  service = new ComputerHistoryDemoService({ recorderScript,
    historyDirectory: path.join(root, "histories"), recordingDirectory: path.join(root, "recordings"),
    workflowDirectory: path.join(root, "workflows"), observationSettingsFile: path.join(root, "settings.json"),
    weChatConsentFile: path.join(root, "wechat-consent.json"),
    permissionReader: async () => ({ supported: true, accessibility: true, inputMonitoring: true }),
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await service.shutdown();
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});
function fixture(id = "2026-10-09T10-00-00Z"): FixtureSegment {
  const directory = path.join(root, "recordings", "segments", id);
  fs.mkdirSync(directory, { recursive: true });
  const segment: FixtureSegment = { id, directory, eventsFile: path.join(directory, "events.jsonl"),
    historyFile: path.join(root, "histories", `${id}-10min-summary.md`), metadataFile: path.join(directory, "metadata.json"),
    startedAt: "2026-10-09T10:01:00Z", child: null, output: "", stoppedByUser: false };
  fs.writeFileSync(segment.metadataFile, JSON.stringify({ id, startedAt: segment.startedAt, state: "open" }));
  fs.writeFileSync(segment.eventsFile, JSON.stringify({ recordType: "human_history_metadata", schemaVersion: 1, recordingId: id, title: "Synthetic", platform: "macOS" }) + "\n");
  return segment;
}
function active(): FixtureSegment {
  service.startObservation();
  const segment = internal().segment!;
  fs.writeFileSync(segment.eventsFile, JSON.stringify({ recordType: "human_history_metadata", schemaVersion: 1, recordingId: segment.id, title: "Synthetic", platform: "macOS" }) + "\n");
  return segment;
}
function append(segment: FixtureSegment, marker: string, padding = "") {
  fs.appendFileSync(segment.eventsFile, JSON.stringify({ recordType: "human_event", eventType: "accessibility_snapshot", timestamp: new Date().toISOString(),
    application: { name: `Synthetic ${marker}`, bundleId: "com.example.synthetic" }, details: {},
    ax: { mode: "fullTree", text: `AXStaticText||${marker} ${padding}|||` } }) + "\n");
}
async function settle() { await Promise.all([...internal().summaryJobs.values()].map((job) => job.promise)); }
function health(code: string, count?: number, timestamp = new Date().toISOString()) {
  transport.children.at(-1)!.stdout.write(`[recorder-health] ${JSON.stringify({ timestamp, code, ...(count === undefined ? {} : { count }) })}\n`);
}
function status() { return service.snapshot().observation.captureHealth!; }
function expired() { vi.setSystemTime(new Date("2026-10-12T10:01:00Z")); }
async function onWindows(body: () => Promise<void>) {
  const platform = process.platform;
  Object.defineProperty(process, "platform", { value: "win32" });
  try { await body(); }
  finally { Object.defineProperty(process, "platform", { value: platform }); }
}

describe("live raw visibility and summary refresh", () => {
  it("shows real current raw before the first timer tick and before a model is available", () => {
    const segment = active(); append(segment, "RECENT_SMALL_ACTION");
    expect(fs.statSync(segment.eventsFile).size).toBeLessThan(4_000);
    expect(service.snapshot().histories).toMatchObject([{ id: `${segment.id}-10min-summary`, summaryStatus: "pending", eventStreamPath: segment.eventsFile }]);
    const matches = service.searchHistories("RECENT_SMALL_ACTION");
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ matchedTerms: ["recent_small_action"], history: { summaryStatus: "pending", eventStreamPath: segment.eventsFile } });
    expect(matches[0].history.markdown).toContain("summary_state: pending");
    expect(fs.existsSync(matches[0].history.filePath)).toBe(true);
  });

  it("does not invent a timeline window from metadata or recording_started alone", () => {
    const segment = active();
    fs.appendFileSync(segment.eventsFile, JSON.stringify({ recordType: "human_event", eventType: "recording_started" }) + "\n");
    expect(service.snapshot().histories).toEqual([]);
    expect(service.searchHistories("Synthetic")).toEqual([]);
  });

  it("keeps the standing body while searching newer same-id raw and swaps on success", async () => {
    const segment = active(); append(segment, "FIRST", "readable fixture ".repeat(400));
    let finish!: (value: { content: string }) => void;
    const chat = vi.fn(async () => narrative("FIRST_ACCOUNT"));
    chat.mockImplementationOnce(async () => narrative("FIRST_ACCOUNT"));
    chat.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    service.setLlmRuntime(runtime(chat)); await settle();
    const standing = fs.readFileSync(segment.historyFile, "utf8");
    append(segment, "LAST_ACTION");
    expect(service.snapshot().histories[0]).toMatchObject({ title: "FIRST_ACCOUNT", summaryStatus: "pending" });
    const matches = service.searchHistories("LAST_ACTION");
    expect(matches).toHaveLength(1);
    expect(matches[0].history.markdown).toContain("LAST_ACTION");
    expect(matches[0].history.summaryStatus).toBe("pending");
    expect(fs.readFileSync(segment.historyFile, "utf8")).toBe(standing);
    finish(narrative("LAST_ACTION_ACCOUNT")); await settle();
    expect(service.snapshot().histories[0]).toMatchObject({ title: "LAST_ACTION_ACCOUNT", summaryStatus: "ready" });
    expect(fs.existsSync(`${segment.historyFile}.staging`)).toBe(false);
    internal().writeLiveSummary(segment); await settle();
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("retrieves newly appended raw while an older model request is still in flight", async () => {
    const segment = active(); append(segment, "EARLY", "evidence ".repeat(600));
    let finish!: (value: { content: string }) => void;
    service.setLlmRuntime(runtime(() => new Promise((resolve) => { finish = resolve; })));
    append(segment, "WHILE_MODEL_BUSY");
    expect(service.searchHistories("WHILE_MODEL_BUSY")[0].history.markdown).toContain("WHILE_MODEL_BUSY");
    finish(narrative("EARLY_ACCOUNT")); await settle();
    expect(service.snapshot().histories[0].summaryStatus).toBe("pending");
  });

  it("reports a failed live write, preserves ready prose, and still locates raw", async () => {
    const segment = active(); append(segment, "EARLY", "evidence ".repeat(600));
    service.setLlmRuntime(runtime(async () => narrative("READY_BODY"))); await settle();
    const standing = fs.readFileSync(segment.historyFile, "utf8");
    append(segment, "RAW_WRITE_FAILURE_MARKER");
    const original = fs.writeFileSync;
    const writes = vi.spyOn(fs, "writeFileSync").mockImplementation(((file, ...args) => {
      if (String(file).startsWith(`${segment.historyFile}.staging.`)) throw Object.assign(new Error("synthetic disk full"), { code: "ENOSPC" });
      return original(file, ...args);
    }) as typeof fs.writeFileSync);
    const matches = service.searchHistories("RAW_WRITE_FAILURE_MARKER");
    expect(matches[0].history.eventStreamPath).toBe(segment.eventsFile);
    expect(service.snapshot().observation.narrationError).toBe("synthetic disk full");
    expect(fs.readFileSync(segment.historyFile, "utf8")).toBe(standing);
    writes.mockRestore();
  });

  it("retries failed live narration without losing the previous readable body", async () => {
    const segment = active(); append(segment, "EARLY", "evidence ".repeat(600));
    const chat = vi.fn(async () => narrative("NEW_ACCOUNT"));
    chat.mockImplementationOnce(async () => narrative("OLD_ACCOUNT"));
    chat.mockImplementationOnce(async () => ({ content: "" }));
    service.setLlmRuntime(runtime(chat)); await settle();
    append(segment, "NEW_ACTION"); internal().writeLiveSummary(segment); await settle();
    expect(service.snapshot().histories[0]).toMatchObject({ title: "OLD_ACCOUNT", summaryStatus: "pending" });
    expect(service.snapshot().observation.narrationError).toMatch(/no content/u);
    await vi.advanceTimersByTimeAsync(60_000); await settle();
    expect(service.snapshot().histories[0]).toMatchObject({ title: "NEW_ACCOUNT", summaryStatus: "ready" });
    expect(service.snapshot().observation.narrationError).toBeNull();
  });

  it("makes the missing model explicit for a prepared live summary", () => {
    const segment = active(); append(segment, "OFFLINE", "evidence ".repeat(600));
    service.searchHistories("OFFLINE");
    expect(service.snapshot().observation.narrationError).toMatch(/no model runtime/u);
    expect(service.snapshot().histories[0].summaryStatus).toBe("pending");
  });

  it("preserves pending source visibility and newer same-id retrieval after stop", async () => {
    const segment = active(); append(segment, "EARLY", "evidence ".repeat(600));
    const chat = vi.fn(async () => ({ content: "" }));
    chat.mockImplementationOnce(async () => narrative("EARLIER_ACCOUNT"));
    service.setLlmRuntime(runtime(chat)); await settle();
    append(segment, "CLOSED_LATE_ACTION");
    await service.stopObservation(); await settle();
    expect(service.snapshot().histories[0]).toMatchObject({ title: "EARLIER_ACCOUNT", summaryStatus: "pending" });
    const matches = service.searchHistories("CLOSED_LATE_ACTION");
    expect(matches).toHaveLength(1);
    expect(matches[0].history).toMatchObject({ id: `${segment.id}-10min-summary`, summaryStatus: "pending" });
    expect(matches[0].history.markdown).toContain("CLOSED_LATE_ACTION");
  });

  it("can pin first-tick captured raw and refuses active deletion with the normal conflict", () => {
    const segment = active(); append(segment, "FIRST_TICK");
    expect(() => service.deleteHistory(`${segment.id}-10min-summary`)).toThrow(/stop recording/u);
    expect(service.pinSegment(`${segment.id}-10min-summary`, true).histories[0]).toMatchObject({ pinned: true, summaryStatus: "pending" });
    expect(fs.existsSync(segment.historyFile)).toBe(true);
  });
});

describe("durable semantic evidence before raw retention", () => {
  it("retains all activity arcs and long fields without a model before expiring raw", () => {
    const segment = fixture();
    for (let i = 0; i < 61; i++) append(segment, `ARC_${i}_MARKER`, `complete field ${i} `.repeat(70));
    service.snapshot();
    const retained = JSON.parse(fs.readFileSync(checkpointPath(segment), "utf8"));
    expect(retained.evidence.length).toBeGreaterThan(12_000);
    for (let i = 0; i < 61; i++) expect(retained.evidence).toContain(`ARC_${i}_MARKER`);
    expired(); service.snapshot();
    expect(fs.existsSync(segment.eventsFile)).toBe(false);
    expect(JSON.parse(fs.readFileSync(checkpointPath(segment), "utf8")).evidence).toBe(retained.evidence);
  });

  it("creates a checkpoint for an already-ready closed summary from the actual raw source", () => {
    const segment = fixture(); append(segment, "FULL_RAW_VERSION");
    fs.mkdirSync(path.dirname(segment.historyFile), { recursive: true });
    fs.writeFileSync(segment.historyFile, `---\ntitle: Earlier account\nsource_type: captured\nstatus: completed\nsummary_state: ready\ncapture_complete: true\nsummary_input_bytes: ${fs.statSync(segment.eventsFile).size}\n---\n\nEarlier account.\n`);
    service.snapshot();
    expect(JSON.parse(fs.readFileSync(checkpointPath(segment), "utf8")).evidence).toContain("FULL_RAW_VERSION");
    expect(fs.readFileSync(segment.historyFile, "utf8")).toContain("Earlier account.");
  });

  it.each(["{\"recordType\":", "{}\n", JSON.stringify({ recordType: "human_event", eventType: "future_unknown", timestamp: "2026-10-09T10:02:00Z", details: { text: "UNSUPPORTED_CONTENT" } }) + "\n",
    JSON.stringify({ recordType: "human_event", eventType: "accessibility_snapshot", ax: { mode: "fullTree", text: "AXStaticText||MISSING_TIME|||" } }) + "\n"])("keeps malformed, partial or unsupported evidence instead of expiring it: %s", (invalid) => {
    const segment = fixture(); append(segment, "SAFE_CHECKPOINT"); service.snapshot();
    const standing = fs.readFileSync(checkpointPath(segment), "utf8");
    fs.appendFileSync(segment.eventsFile, invalid);
    expired(); service.snapshot();
    expect(fs.existsSync(segment.eventsFile)).toBe(true);
    expect(fs.readFileSync(checkpointPath(segment), "utf8")).toBe(standing);
    expect(service.snapshot().observation.narrationError).toMatch(/retention is deferred/u);
  });

  it("rejects a same-byte-length replacement using the raw SHA256", () => {
    const segment = fixture(); append(segment, "EQUAL_LEN_ONE"); service.snapshot();
    const before = fs.readFileSync(segment.eventsFile, "utf8");
    const changed = before.replaceAll("EQUAL_LEN_ONE", "EQUAL_LEN_TWO");
    expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(before));
    fs.writeFileSync(segment.eventsFile, changed);
    expect(internal().canExpireRaw(segment.directory)).toBe(false);
    expect(fs.existsSync(segment.eventsFile)).toBe(true);
  });

  it("verifies checkpoint contents on disk again immediately before deletion", () => {
    const segment = fixture(); append(segment, "SAFE_ARCHIVE"); service.snapshot();
    const file = checkpointPath(segment);
    const retained = JSON.parse(fs.readFileSync(file, "utf8"));
    retained.evidence = retained.evidence.replaceAll("SAFE_ARCHIVE", "BROKEN_VALUE");
    fs.writeFileSync(file, JSON.stringify(retained));
    expect(internal().canExpireRaw(segment.directory)).toBe(false);
  });

  it("rejects a self-consistent but truncated checkpoint that omits extracted evidence", () => {
    const segment = fixture(); append(segment, "FIRST_SAFE_ARC"); append(segment, "SECOND_MUST_REMAIN"); service.snapshot();
    const file = checkpointPath(segment);
    const retained = JSON.parse(fs.readFileSync(file, "utf8"));
    retained.evidence = retained.evidence.split("SECOND_MUST_REMAIN")[0];
    retained.evidenceSha256 = crypto.createHash("sha256").update(retained.evidence).digest("hex");
    fs.writeFileSync(file, JSON.stringify(retained));
    expect(internal().canExpireRaw(segment.directory)).toBe(false);
    expect(fs.existsSync(segment.eventsFile)).toBe(true);
  });

  it("keeps closed pending records queryable from complete retained evidence after raw expiry", () => {
    const segment = fixture();
    append(segment, "ARCHIVED", `HEAD ${"earlier evidence ".repeat(150)} UNIQUE_MIDDLE_ARCHIVE_FACT ${"later evidence ".repeat(150)} TAIL`);
    expired(); service.snapshot();
    expect(fs.existsSync(segment.eventsFile)).toBe(false);
    expect(service.snapshot().histories[0]).toMatchObject({ summaryStatus: "pending", eventStreamPath: null });
    const matches = service.searchHistories("UNIQUE_MIDDLE_ARCHIVE_FACT");
    expect(matches[0]).toMatchObject({ matchedTerms: ["unique_middle_archive_fact"], history: { id: `${segment.id}-10min-summary`, summaryStatus: "pending" } });
  });

  it("keeps the previous checkpoint and raw when the next checkpoint write fails", () => {
    const segment = fixture(); append(segment, "ORIGINAL"); service.snapshot();
    const saved = fs.readFileSync(checkpointPath(segment), "utf8");
    append(segment, "NEW_RAW_EVIDENCE");
    const original = fs.writeFileSync;
    const writes = vi.spyOn(fs, "writeFileSync").mockImplementation(((file, ...args) => {
      if (String(file).startsWith(`${checkpointPath(segment)}.`)) throw Object.assign(new Error("synthetic checkpoint failure"), { code: "EIO" });
      return original(file, ...args);
    }) as typeof fs.writeFileSync);
    expired(); service.snapshot();
    expect(fs.existsSync(segment.eventsFile)).toBe(true);
    expect(fs.readFileSync(checkpointPath(segment), "utf8")).toBe(saved);
    writes.mockRestore(); service.snapshot();
    expect(fs.existsSync(segment.eventsFile)).toBe(false);
    expect(fs.readFileSync(checkpointPath(segment), "utf8")).toContain("NEW_RAW_EVIDENCE");
  });

  it("does not recompact unchanged closed sources on each snapshot", () => {
    const segment = fixture(); append(segment, "STABLE_SOURCE"); service.snapshot();
    const reads = vi.spyOn(fs, "readFileSync");
    service.snapshot(); service.snapshot();
    expect(reads.mock.calls.filter(([file]) => String(file) === segment.eventsFile)).toHaveLength(0);
    reads.mockRestore();
  });

  it.each(["delete", "clear"])("removes retained evidence with an explicit %s", async (action) => {
    const segment = fixture(); append(segment, "DISPOSABLE"); service.snapshot();
    expect(fs.existsSync(checkpointPath(segment))).toBe(true);
    if (action === "delete") service.deleteHistory(`${segment.id}-10min-summary`);
    else await service.clearHistories("all");
    expect(fs.existsSync(checkpointPath(segment))).toBe(false);
    expect(internal().retentionCheckpointPath("../../outside")).toBeNull();
  });
});

describe("capture health protocol", () => {
  it("tracks a split heartbeat and recorded event without treating idle as failure", async () => {
    active(); expect(status().status).toBe("starting");
    const child = transport.children.at(-1)!;
    const line = `[recorder-health] ${JSON.stringify({ timestamp: new Date().toISOString(), code: "heartbeat" })}\n`;
    child.stdout.write(line.slice(0, 17)); child.stdout.write(line.slice(17));
    expect(status()).toMatchObject({ status: "healthy", lastEventAt: null, lastHeartbeatAt: new Date().toISOString() });
    for (let i = 0; i < 8; i++) { await vi.advanceTimersByTimeAsync(10_000); health("heartbeat"); }
    expect(status()).toMatchObject({ status: "healthy", lastEventAt: null, issues: [] });
  });

  it("reports missing macOS heartbeat and recovers without requiring user events", async () => {
    active(); await vi.advanceTimersByTimeAsync(60_001);
    expect(status()).toMatchObject({ status: "degraded", issues: [{ code: "heartbeat_missing", count: 1 }] });
    health("heartbeat"); expect(status().status).toBe("healthy");
  });

  it("keeps input failures active despite AX events until the matching ready signal", async () => {
    active(); health("observer_ready"); health("input_monitoring_unavailable", 2);
    await vi.advanceTimersByTimeAsync(31_000); health("event_recorded"); health("heartbeat");
    expect(status()).toMatchObject({ status: "degraded", issues: [{ code: "input_monitoring_unavailable", count: 2 }] });
    health("input_monitoring_ready"); expect(status()).toMatchObject({ status: "healthy", issues: [] });
  });

  it.each(["observer", "input_monitoring"])("does not reactivate a delayed old %s issue after ready, but keeps its count", async (kind) => {
    active(); const old = new Date().toISOString();
    await vi.advanceTimersByTimeAsync(2_000); health(`${kind}_ready`); health("heartbeat");
    health(`${kind}_unavailable`, 2, old);
    expect(status()).toMatchObject({ status: "healthy", issues: [] });
    await vi.advanceTimersByTimeAsync(1_000); health(`${kind}_unavailable`, 3);
    expect(status()).toMatchObject({ status: "degraded", issues: [{ code: `${kind}_unavailable`, count: 5 }] });
  });

  it("recovers transient capture gaps after healthy events and ignores codes the recorder never sends", async () => {
    active(); health("observer_ready"); health("ax_snapshot_budget_exceeded", 4); health("privacy_unknown", 50);
    expect(status()).toMatchObject({ status: "degraded", issues: [{ code: "ax_snapshot_budget_exceeded", count: 4 }] });
    await vi.advanceTimersByTimeAsync(1_000); health("event_recorded"); health("heartbeat");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(status()).toMatchObject({ status: "healthy", issues: [] });
  });

  it("reports reconnecting intent, then inactive after stop, and ignores old child health", async () => {
    active(); const old = transport.children.at(-1)!; health("observer_ready");
    old.stderr.write("Memmy Computer History stream disconnected unexpectedly.\n"); old.exit();
    expect(status().status).toBe("reconnecting");
    await service.stopObservation();
    old.stdout.write(`[recorder-health] ${JSON.stringify({ timestamp: new Date().toISOString(), code: "observer_unavailable" })}\n`);
    expect(status()).toMatchObject({ status: "inactive", issues: [] });
  });

  it("accepts only the final successfully-written event timestamp while stopping, then rejects stale children", async () => {
    active(); const child = transport.children.at(-1)!;
    health("observer_ready"); health("event_recorded"); health("ax_snapshot_budget_exceeded");
    await vi.advanceTimersByTimeAsync(5_000);
    const finalAt = new Date().toISOString();
    child.closeOnExit = false;
    await service.stopObservation();
    // Node may deliver a final stdout chunk after exit, before stdio close.
    child.stdout.write(`[recorder-health] ${JSON.stringify({ timestamp: finalAt, code: "event_recorded" })}\n`);
    child.stdout.write(`[recorder-health] ${JSON.stringify({ timestamp: finalAt, code: "observer_unavailable" })}\n`);
    expect(status()).toMatchObject({ status: "inactive", lastEventAt: finalAt, issues: [] });
    child.emit("close", 0);
    service.startObservation();
    child.stdout.write(`[recorder-health] ${JSON.stringify({ timestamp: finalAt, code: "event_recorded" })}\n`);
    expect(status().lastEventAt).toBeNull();
  });

  it("reports paused capture as inactive without its former active warnings", async () => {
    active(); health("observer_ready"); health("ax_snapshot_budget_exceeded", 3);
    await service.pauseObservation();
    expect(status()).toMatchObject({ status: "inactive", issues: [] });
  });

  it("never copies malformed, oversized, unknown-code or extra-field payloads into errors", () => {
    active(); const child = transport.children.at(-1)!;
    child.stdout.write('[recorder-health] {"code":"SECRET_PAYLOAD"\n');
    child.stdout.write(`[recorder-health] ${"SECRET_PAYLOAD".repeat(400)}\n`);
    child.stdout.write(`[recorder-health] ${JSON.stringify({ timestamp: new Date().toISOString(), code: "unknown_SECRET_PAYLOAD", text: "SECRET_PAYLOAD" })}\n`);
    child.stdout.write(`[recorder-health] ${JSON.stringify({ timestamp: new Date().toISOString(), code: "heartbeat", app: "SECRET_PAYLOAD", url: "SECRET_PAYLOAD" })}\n`);
    expect(status().status).toBe("healthy");
    child.exit();
    expect(JSON.stringify(service.snapshot().observation)).not.toContain("SECRET_PAYLOAD");
  });

  it("keeps legacy Windows event-only health compatible without calling idle a failure", async () => {
    await onWindows(async () => {
      active(); health("event_recorded"); await vi.advanceTimersByTimeAsync(70_000);
      expect(status()).toMatchObject({ status: "healthy", issues: [], limitations: ["foreground_events_and_accessibility_only", "screenshots_and_audio_not_recorded"] });
    });
  });

  it("discloses Windows capture limits even with a healthy heartbeat and no longer claims browsers are excluded", async () => {
    await onWindows(async () => {
      active(); health("heartbeat");
      expect(status()).toMatchObject({ status: "healthy", issues: [],
        limitations: expect.arrayContaining(["foreground_events_and_accessibility_only"]) });
      expect(status().limitations).not.toContain("private_and_unverifiable_browsers_excluded");
    });
    expect(status().limitations).not.toContain("foreground_events_and_accessibility_only");
  });

  it("uses Windows heartbeats to confirm idle capture and reports a missing heartbeat despite new events", async () => {
    await onWindows(async () => {
      active(); expect(status().status).toBe("starting");
      health("heartbeat");
      for (let i = 0; i < 8; i++) { await vi.advanceTimersByTimeAsync(10_000); health("heartbeat"); }
      expect(status()).toMatchObject({ status: "healthy", lastEventAt: null, issues: [] });
      await vi.advanceTimersByTimeAsync(60_001); health("event_recorded");
      expect(status()).toMatchObject({ status: "degraded", issues: [{ code: "heartbeat_missing", count: 1 }] });
      health("heartbeat"); expect(status()).toMatchObject({ status: "healthy", issues: [] });
    });
  });

  it("keeps Windows observer failures active until UIA recovery even when the supervisor and output are alive", async () => {
    await onWindows(async () => {
      active(); health("heartbeat"); health("observer_unavailable", 2);
      await vi.advanceTimersByTimeAsync(31_000); health("heartbeat"); health("event_recorded");
      expect(status()).toMatchObject({ status: "degraded", issues: [{ code: "observer_unavailable", count: 2 }] });
      health("observer_ready"); expect(status()).toMatchObject({ status: "healthy", issues: [] });
    });
  });

  it("does not recover missing Windows content from successful input, observer startup or heartbeats", async () => {
    await onWindows(async () => {
      active(); health("heartbeat"); health("ax_snapshot_failed", 1);
      await vi.advanceTimersByTimeAsync(31_000);
      health("heartbeat"); health("event_recorded"); health("observer_ready");
      expect(status()).toMatchObject({ status: "degraded", issues: [{ code: "ax_snapshot_failed", count: 1 }] });
      const failedAt = new Date().toISOString();
      await vi.advanceTimersByTimeAsync(1_000); health("ax_snapshot_ready");
      expect(status()).toMatchObject({ status: "healthy", issues: [] });
      // Delayed batched failures cannot erase newer persisted-read evidence.
      health("ax_snapshot_failed", 2, failedAt);
      expect(status()).toMatchObject({ status: "healthy", issues: [] });
      await vi.advanceTimersByTimeAsync(1_000); health("ax_snapshot_failed", 1);
      expect(status()).toMatchObject({ status: "degraded", issues: [{ code: "ax_snapshot_failed", count: 4 }] });
    });
  });

  it("requires post-issue heartbeat evidence before recovering a Windows transient gap", async () => {
    await onWindows(async () => {
      active(); health("heartbeat");
      await vi.advanceTimersByTimeAsync(1_000); health("ax_snapshot_budget_exceeded", 3);
      await vi.advanceTimersByTimeAsync(31_000); health("event_recorded");
      expect(status()).toMatchObject({ status: "degraded", issues: [{ code: "ax_snapshot_budget_exceeded", count: 3 }] });
      health("heartbeat"); expect(status()).toMatchObject({ status: "healthy", issues: [] });
    });
  });

  it("preserves Windows heartbeat support across rotation and resets it for a separate legacy run", async () => {
    await onWindows(async () => {
      active(); health("heartbeat");
      await vi.advanceTimersByTimeAsync(9 * 60_000);
      expect(transport.children).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(60_001); health("event_recorded");
      expect(status()).toMatchObject({ status: "degraded", issues: [{ code: "heartbeat_missing", count: 1 }] });
      await service.stopObservation(); service.startObservation(); health("event_recorded");
      await vi.advanceTimersByTimeAsync(70_000);
      expect(status()).toMatchObject({ status: "healthy", issues: [] });
    });
  });
});
