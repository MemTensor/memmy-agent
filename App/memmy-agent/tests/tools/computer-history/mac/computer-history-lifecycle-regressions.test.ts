import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerHistoryDemoService } from "../../../../src/tools/computer-history/mac/computer-history-api.js";
import { applyNarrative } from "../../../../src/tools/computer-history/mac/summary-writer.js";
import { instantId, sixHourWindowStart } from "../../../../src/tools/computer-history/mac/rollup.js";

const roots: string[] = [];
const instances: ComputerHistoryDemoService[] = [];
const segmentId = "2026-09-13T02-10-00Z";
const historyId = `${segmentId}-10min-summary`;
const answer = (title: string) => ({
  title, description: `You completed ${title}.`, body: `## Memory summary\n\nYou completed ${title}.`,
});
const response = (title: string) => ({ content: JSON.stringify(answer(title)) });

function serviceAt(root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-history-regression-"))) {
  if (!roots.includes(root)) roots.push(root);
  const service = new ComputerHistoryDemoService({
    historyDirectory: path.join(root, "histories"),
    recordingDirectory: path.join(root, "recordings"),
    workflowDirectory: path.join(root, "workflows"),
    observationSettingsFile: path.join(root, "settings.json"),
  });
  instances.push(service);
  fs.mkdirSync(path.join(root, "histories"), { recursive: true });
  return { root, service };
}

function seed(root: string, id = segmentId, ready = true) {
  const directory = path.join(root, "recordings", "segments", id);
  fs.mkdirSync(directory, { recursive: true });
  const metadataFile = path.join(directory, "metadata.json");
  const eventsFile = path.join(directory, "events.jsonl");
  const historyFile = path.join(root, "histories", `${id}-10min-summary.md`);
  fs.writeFileSync(metadataFile, JSON.stringify({ startedAt: new Date().toISOString() }));
  fs.writeFileSync(eventsFile, [
    { recordType: "human_history_metadata", schemaVersion: 1, recordingId: id, title: "Review", createdAt: "2026-09-13T02:10:00Z", platform: "macOS", display: { width: 100, height: 100 }, captureText: false, captureSearchText: true, allowedApplications: [], captureScopeApplications: [] },
    { recordType: "human_event", sequence: 1, timestamp: "2026-09-13T02:10:01Z", eventType: "application_changed", application: { name: "Notes", bundleId: "com.apple.Notes" }, details: {} },
    { recordType: "human_event", sequence: 2, timestamp: "2026-09-13T02:19:59Z", eventType: "recording_stopped", application: {}, details: {} },
  ].map((value) => JSON.stringify(value)).join("\n") + "\n");
  const mechanical = "---\ntitle: Review\nsource_type: captured\nsummary_state: pending\nstatus: completed\nexperience_version: 1\n---\n\n## Memory summary\n\nRecorded work.\n";
  fs.writeFileSync(historyFile, ready ? applyNarrative(mechanical, answer("Standing summary")) : mechanical);
  return { id, directory, metadataFile, eventsFile, historyFile, startedAt: "2026-09-13T02:10:00Z", child: null, output: "" };
}

function runtime(chat: () => Promise<{ content: string }>) {
  return (() => ({ model: "stub", provider: { chatWithRetry: chat } })) as unknown as Parameters<ComputerHistoryDemoService["setLlmRuntime"]>[0];
}

// Exercise the private timer/finalization entrypoints without opening an event tap.
function internal(service: ComputerHistoryDemoService) {
  return service as unknown as {
    llmRuntime: ReturnType<typeof runtime>;
    segment: ReturnType<typeof seed> | null;
    finalizeSegment(segment: ReturnType<typeof seed>): Promise<void>;
    writeLiveSummary(segment: ReturnType<typeof seed>): void;
    writeRollupFor(start: Date): string | null;
    writeSixHourRollup(id: string): void;
    writeSummaryWith(file: string, window: "10min" | "6h", events: string | null): Promise<boolean>;
  };
}

function deferred() {
  let resolve!: (value: { content: string }) => void;
  const promise = new Promise<{ content: string }>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
afterEach(async () => {
  for (const instance of instances.splice(0)) {
    internal(instance).segment = null;
    await instance.shutdown();
  }
  vi.useRealTimers();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("summary retries and atomic replacement", () => {
  it("retries a failed pass with the recovered model in the same process", async () => {
    const { root, service } = serviceAt();
    seed(root, segmentId, false);
    service.setLlmRuntime(runtime(async () => { throw new Error("temporary outage"); }));
    expect(await service.backfillUnwrittenSummaries()).toBe(0);
    expect(service.snapshot().histories).toHaveLength(0);
    const recovered = vi.fn(async () => response("Recovered"));
    service.setLlmRuntime(runtime(recovered));
    await service.backfillUnwrittenSummaries();
    expect(recovered).toHaveBeenCalled();
    expect(service.snapshot().histories.find((entry) => entry.id === historyId)?.title).toBe("Recovered");
  });

  it("periodically retries failed summaries even after recording has stopped", async () => {
    vi.useFakeTimers();
    const { root, service } = serviceAt();
    seed(root, segmentId, false);
    let available = false;
    service.setLlmRuntime(runtime(async () => {
      if (!available) throw new Error("offline");
      return response("Back online");
    }));
    await service.backfillUnwrittenSummaries();
    expect(service.snapshot().observation.state).toBe("stopped");
    available = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(service.snapshot().histories.find((entry) => entry.id === historyId)?.title).toBe("Back online");
  });

  it("keeps a failed replacement and recovers it after a service restart", async () => {
    const { root, service } = serviceAt();
    const segment = seed(root);
    internal(service).llmRuntime = runtime(async () => { throw new Error("offline"); });
    await internal(service).finalizeSegment(segment);
    expect(service.snapshot().histories[0].title).toBe("Standing summary");
    expect(fs.existsSync(`${segment.historyFile}.staging`)).toBe(true);
    await service.shutdown();
    const restarted = serviceAt(root).service;
    restarted.setLlmRuntime(runtime(async () => response("Full final account")));
    await restarted.backfillUnwrittenSummaries();
    expect(restarted.snapshot().histories.find((entry) => entry.id === historyId)?.title).toBe("Full final account");
    expect(fs.existsSync(`${segment.historyFile}.staging`)).toBe(false);
  });

  it("does not let an earlier live response overwrite the finalized account", async () => {
    const { root, service } = serviceAt();
    const segment = seed(root, segmentId, false);
    const live = deferred();
    const final = deferred();
    let calls = 0;
    internal(service).llmRuntime = runtime(() => ++calls === 1 ? live.promise : calls === 2 ? final.promise : Promise.resolve(response("Rollup")));
    const liveJob = internal(service).writeSummaryWith(segment.historyFile, "10min", segment.eventsFile);
    const finalJob = internal(service).finalizeSegment(segment);
    final.resolve(response("Final version"));
    await finalJob;
    live.resolve(response("Old live version"));
    expect(await liveJob).toBe(false);
    expect(service.snapshot().histories.find((entry) => entry.id === historyId)?.title).toBe("Final version");
  });

  it("retries live narration with unchanged events after a failure", async () => {
    const { root, service } = serviceAt();
    const segment = seed(root, segmentId, false);
    internal(service).segment = segment;
    fs.appendFileSync(segment.eventsFile, " ".repeat(4_100));
    internal(service).llmRuntime = runtime(async () => { throw new Error("offline"); });
    internal(service).writeLiveSummary(segment);
    await vi.waitFor(() => expect(service.snapshot().observation.narrationError).toBe("offline"));
    internal(service).llmRuntime = runtime(async () => response("Live recovery"));
    internal(service).writeLiveSummary(segment);
    await vi.waitFor(() => expect(service.snapshot().histories.find((entry) => entry.id === historyId)?.title).toBe("Live recovery"));
  });

  it("preserves the standing rollup on failure and commits the retry atomically", async () => {
    const { root, service } = serviceAt();
    const segment = seed(root);
    const first = internal(service).writeRollupFor(sixHourWindowStart(new Date(segment.startedAt)))!;
    fs.writeFileSync(first, applyNarrative(fs.readFileSync(first, "utf8"), answer("Old rollup")));
    seed(root, "2026-09-13T02-20-00Z");
    internal(service).llmRuntime = runtime(async () => { throw new Error("offline"); });
    internal(service).writeSixHourRollup(segment.id);
    await vi.waitFor(() => expect(service.snapshot().observation.narrationError).toBe("offline"));
    expect(service.snapshot().histories.find((entry) => entry.summaryWindow === "6h")?.title).toBe("Old rollup");
    expect(fs.existsSync(`${first}.staging`)).toBe(true);
    service.setLlmRuntime(runtime(async () => response("Updated rollup")));
    await service.backfillUnwrittenSummaries();
    const updated = service.snapshot().histories.find((entry) => entry.summaryWindow === "6h");
    expect(updated?.title).toBe("Updated rollup");
    expect(updated?.coveredHistoryIds).toEqual([historyId, "2026-09-13T02-20-00Z-10min-summary"]);
    expect(fs.existsSync(`${first}.staging`)).toBe(false);
  });

  it("coalesces recovered segments into one model request per six-hour window", async () => {
    const { root, service } = serviceAt();
    for (const id of [segmentId, "2026-09-13T02-20-00Z", "2026-09-13T02-30-00Z"]) seed(root, id, false);
    const model = vi.fn(async () => response("Recovered account"));
    internal(service).llmRuntime = runtime(model);
    await service.backfillUnwrittenSummaries();
    expect(model).toHaveBeenCalledTimes(4); // Three segments, then one rollup.
    expect(service.snapshot().histories.find((entry) => entry.summaryWindow === "6h")?.coveredHistoryIds).toHaveLength(3);
  });

  it("invalidates an old-window staging request while realigning rollups", async () => {
    const { root, service } = serviceAt();
    const morning = new Date(2026, 8, 13, 9, 10);
    seed(root, instantId(morning));
    const oldId = `${instantId(new Date(2026, 8, 13, 2))}-6h-summary`;
    const file = path.join(root, "histories", `${oldId}.md`);
    const markdown = "---\ntitle: Old window\nsource_type: rollup\nsummary_state: pending\n---\n\n## Memory summary\n\nOld data.\n";
    // The old implementation could already have removed the canonical file
    // before a restart. An orphan staging file must be realigned as well.
    fs.writeFileSync(`${file}.staging`, markdown);
    const model = deferred();
    internal(service).llmRuntime = runtime(() => model.promise);
    const pending = internal(service).writeSummaryWith(`${file}.staging`, "6h", null);
    expect(service.realignRollups()).toBe(1);
    model.resolve(response("Obsolete window"));
    expect(await pending).toBe(false);
    await service.backfillUnwrittenSummaries();
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(`${file}.staging`)).toBe(false);
    expect(service.snapshot().histories.some((entry) => entry.id === oldId)).toBe(false);
  });
});

describe("deletion and complete collection clearing", () => {
  it("cancels a pending finalization so deleted history and rollups cannot return", async () => {
    const { root, service } = serviceAt();
    const segment = seed(root);
    const model = deferred();
    internal(service).llmRuntime = runtime(() => model.promise);
    const pending = internal(service).finalizeSegment(segment);
    service.deleteHistory(historyId);
    model.resolve(response("Deleted work"));
    await pending;
    expect(service.snapshot().histories).toHaveLength(0);
    expect(fs.existsSync(segment.directory)).toBe(false);
    expect(fs.readdirSync(path.join(root, "histories"))).toEqual([]);
  });

  it("deletes pending summaries and removes rollups containing deleted evidence", () => {
    const { root, service } = serviceAt();
    const segment = seed(root);
    const rollup = internal(service).writeRollupFor(sixHourWindowStart(new Date(segment.startedAt)))!;
    fs.writeFileSync(rollup, applyNarrative(fs.readFileSync(rollup, "utf8"), answer("Contains deleted evidence")));
    seed(root, segmentId, false);
    service.deleteHistory(historyId);
    expect(fs.existsSync(rollup)).toBe(false);
    expect(service.snapshot().histories).toHaveLength(0);
  });

  it("clear all includes invisible, staged, and raw-only records but preserves the active segment", async () => {
    const { root, service } = serviceAt();
    const staged = seed(root);
    const model = deferred();
    internal(service).llmRuntime = runtime(() => model.promise);
    const pending = internal(service).finalizeSegment(staged);
    const invisible = seed(root, "2026-09-13T02-20-00Z", false);
    const rawOnly = seed(root, "2026-09-13T02-30-00Z", false);
    fs.rmSync(rawOnly.historyFile);
    const active = seed(root, "2026-09-13T02-40-00Z", false);
    internal(service).segment = active;
    const result = service.clearHistories("all");
    expect(result.histories).toHaveLength(0);
    expect(fs.existsSync(active.eventsFile)).toBe(true);
    expect(fs.existsSync(active.historyFile)).toBe(true);
    for (const segment of [staged, invisible, rawOnly]) {
      expect(fs.existsSync(segment.directory)).toBe(false);
      expect(fs.existsSync(segment.historyFile)).toBe(false);
    }
    model.resolve(response("Must not return"));
    await pending;
    expect(fs.readdirSync(path.join(root, "histories"))).toEqual([path.basename(active.historyFile)]);
  });

  it("clear today retains previous days while deleting pending records for today", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 13, 15));
    const { root, service } = serviceAt();
    const today = seed(root, instantId(new Date(2026, 8, 13, 10)), false);
    const yesterday = seed(root, instantId(new Date(2026, 8, 12, 10)), false);
    service.clearHistories("today");
    expect(fs.existsSync(today.eventsFile)).toBe(false);
    expect(fs.existsSync(yesterday.eventsFile)).toBe(true);
    expect(fs.existsSync(yesterday.historyFile)).toBe(true);
  });
});
