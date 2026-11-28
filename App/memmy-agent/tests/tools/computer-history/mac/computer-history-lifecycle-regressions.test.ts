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

// Exercise the private timer/finalization entrypoints without opening an event tap.
function internal(service: ComputerHistoryDemoService) {
  return service as unknown as {
    segment: ReturnType<typeof seed> | null;
    finalizeSegment(segment: ReturnType<typeof seed>): Promise<void>;
    writeLiveSummary(segment: ReturnType<typeof seed>): void;
    writeRollupFor(start: Date): string | null;
  };
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

describe("deletion and complete collection clearing", () => {
  it("cancels a pending finalization so deleted history and rollups cannot return", async () => {
    const { root, service } = serviceAt();
    const segment = seed(root);
    const pending = internal(service).finalizeSegment(segment);
    service.deleteHistory(historyId);
    await pending;
    expect(service.snapshot().histories).toHaveLength(0);
    expect(fs.existsSync(segment.directory)).toBe(false);
    // Memory sync may retain deletion receipts in the history directory.
    expect(fs.readdirSync(path.join(root, "histories")).filter(name => /\.md(?:\.staging)?$/u.test(name))).toEqual([]);
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

  it("clear all includes invisible, staged, raw-only records and the active segment", async () => {
    const { root, service } = serviceAt();
    const staged = seed(root);
    fs.copyFileSync(staged.historyFile, `${staged.historyFile}.staging`);
    const invisible = seed(root, "2026-09-13T02-20-00Z", false);
    const rawOnly = seed(root, "2026-09-13T02-30-00Z", false);
    fs.rmSync(rawOnly.historyFile);
    const active = seed(root, "2026-09-13T02-40-00Z", false);
    internal(service).segment = active;
    const result = await service.clearHistories("all");
    expect(result.histories).toHaveLength(0);
    expect(fs.existsSync(active.eventsFile)).toBe(false);
    expect(fs.existsSync(active.historyFile)).toBe(false);
    for (const segment of [staged, invisible, rawOnly]) {
      expect(fs.existsSync(segment.directory)).toBe(false);
      expect(fs.existsSync(segment.historyFile)).toBe(false);
    }
    expect(fs.readdirSync(path.join(root, "histories")).filter(name => /\.md(?:\.staging)?$/u.test(name))).toEqual([]);
  });

  it("clear today retains previous days while deleting pending records for today", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 13, 15));
    const { root, service } = serviceAt();
    const today = seed(root, instantId(new Date(2026, 8, 13, 10)), false);
    const yesterday = seed(root, instantId(new Date(2026, 8, 12, 10)), false);
    await service.clearHistories("today");
    expect(fs.existsSync(today.eventsFile)).toBe(false);
    expect(fs.existsSync(yesterday.eventsFile)).toBe(true);
    expect(fs.existsSync(yesterday.historyFile)).toBe(true);
  });
});
