import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerHistoryDemoService } from "../../../../src/tools/computer-history/mac/computer-history-api.js";
import { applyNarrative } from "../../../../src/tools/computer-history/mac/summary-writer.js";

const id = "2026-09-13T00-00-00Z";
let root: string;
const services: ComputerHistoryDemoService[] = [];
const answer = { title: "Recovered decision", description: "LATE_DECISION_RELEASE_218", body: "## Memory summary\n\nLATE_DECISION_RELEASE_218" };
const makeRuntime = (chat: (...args: unknown[]) => Promise<{ content: string }>) =>
  (() => ({ model: "stub", provider: { chatWithRetry: chat } })) as unknown as Parameters<ComputerHistoryDemoService["setLlmRuntime"]>[0];
function makeService() {
  const service = new ComputerHistoryDemoService({
    recorderScript: path.join(root, "never-run.js"),
    historyDirectory: path.join(root, "histories"), recordingDirectory: path.join(root, "recordings"),
    workflowDirectory: path.join(root, "workflows"), observationSettingsFile: path.join(root, "settings.json"),
  });
  services.push(service);
  return service;
}
function rawSegment() {
  const directory = path.join(root, "recordings", "segments", id);
  fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(path.join(root, "histories"), { recursive: true });
  const eventsFile = path.join(directory, "events.jsonl");
  const historyFile = path.join(root, "histories", `${id}-10min-summary.md`);
  const metadataFile = path.join(directory, "metadata.json");
  fs.writeFileSync(metadataFile, JSON.stringify({ id, startedAt: "2026-09-13T00:00:00Z", state: "open" }));
  fs.writeFileSync(eventsFile, [
    { recordType: "human_history_metadata", schemaVersion: 1, recordingId: id, title: "Review", platform: "macOS" },
    { recordType: "human_event", eventType: "application_changed", timestamp: "2026-09-13T00:00:01Z", application: { name: "Notes", bundleId: "com.apple.Notes" }, details: {} },
    { recordType: "human_event", eventType: "accessibility_snapshot", timestamp: "2026-09-13T00:05:00Z", application: { name: "Notes", bundleId: "com.apple.Notes" }, ax: { mode: "fullTree", text: "AXStaticText||LATE_DECISION_RELEASE_218|||" }, details: {} },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n");
  return { id, directory, eventsFile, historyFile, metadataFile, child: null, output: "", startedAt: "2026-09-13T00:00:00Z" };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-13T00:06:00Z"));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "history-recovery-"));
});
afterEach(async () => {
  for (const service of services.splice(0)) {
    (service as unknown as { segment: unknown }).segment = null;
    await service.shutdown();
  }
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("interrupted segment recovery", () => {
  it("recovers raw-only evidence before the first live summary and does not repeat it", async () => {
    const segment = rawSegment();
    const service = makeService();
    const chat = vi.fn<Parameters<typeof makeRuntime>[0]>(async () => ({ content: JSON.stringify(answer) }));
    service.setLlmRuntime(makeRuntime(chat));
    expect(await service.backfillUnwrittenSummaries()).toBeGreaterThan(0);
    expect(service.snapshot().histories.find((entry) => entry.id === `${id}-10min-summary`)?.markdown).toContain("LATE_DECISION_RELEASE_218");
    expect(JSON.stringify(chat.mock.calls)).toContain("LATE_DECISION_RELEASE_218");
    expect(fs.readFileSync(segment.historyFile, "utf8")).toContain("capture_end_reason: interrupted");
    const count = chat.mock.calls.length;
    await service.backfillUnwrittenSummaries();
    expect(chat).toHaveBeenCalledTimes(count);
  });

  it.each(["in_progress", "incomplete"])("replaces a legacy %s live account with the full recovered evidence", async (status) => {
    const segment = rawSegment();
    fs.writeFileSync(segment.historyFile, applyNarrative(`---\ntitle: Early\nsource_type: captured\nstatus: ${status}\nsummary_state: pending\n---\n\n## Memory summary\n\nEarly.\n`, {
      title: "First minute", description: "Opened Notes", body: "## Memory summary\n\nOpened Notes.",
    }));
    const service = makeService();
    const chat = vi.fn<Parameters<typeof makeRuntime>[0]>(async () => ({ content: JSON.stringify(answer) }));
    service.setLlmRuntime(makeRuntime(chat));
    await service.backfillUnwrittenSummaries();
    const history = service.snapshot().histories.find((entry) => entry.id === `${id}-10min-summary`)!;
    expect(history.title).toBe(answer.title);
    expect(history.markdown).toContain("capture_complete: true");
    expect(history.markdown).toContain(`summary_input_bytes: ${fs.statSync(segment.eventsFile).size}`);
    expect(JSON.stringify(chat.mock.calls)).toContain("LATE_DECISION_RELEASE_218");
  });

  it("recovers input appended after the last completed account", async () => {
    const segment = rawSegment();
    const service = makeService();
    const chat = vi.fn<Parameters<typeof makeRuntime>[0]>(async () => ({ content: JSON.stringify(answer) }));
    service.setLlmRuntime(makeRuntime(chat));
    await service.backfillUnwrittenSummaries();
    const count = chat.mock.calls.length;
    fs.appendFileSync(segment.eventsFile, JSON.stringify({ recordType: "human_event", eventType: "application_changed", timestamp: "2026-09-13T00:06:00Z", application: { name: "Safari", bundleId: "com.apple.Safari" }, details: {} }) + "\n");
    await service.backfillUnwrittenSummaries();
    expect(chat.mock.calls.length).toBeGreaterThan(count);
    expect(fs.readFileSync(segment.historyFile, "utf8")).toContain(`summary_input_bytes: ${fs.statSync(segment.eventsFile).size}`);
  });

  it("recovers reopened legacy recordings even when their old summary says completed", async () => {
    const segment = rawSegment();
    fs.writeFileSync(segment.metadataFile, JSON.stringify({ id, startedAt: segment.startedAt, eventsPath: segment.eventsFile }));
    const raw = fs.readFileSync(segment.eventsFile, "utf8");
    const lines = raw.trimEnd().split("\n");
    lines.splice(2, 0, ...["recording_stopped", "recording_started"].map((eventType) => JSON.stringify({ recordType: "human_event", eventType })));
    fs.writeFileSync(segment.eventsFile, lines.join("\n") + "\n");
    fs.writeFileSync(segment.historyFile, applyNarrative("---\ntitle: Early\nsource_type: captured\nstatus: completed\nsummary_state: pending\n---\n\n## Memory summary\n\nEarly.\n", {
      title: "First session only", description: "Opened Notes", body: "## Memory summary\n\nOpened Notes.",
    }));
    const service = makeService();
    const chat = vi.fn<Parameters<typeof makeRuntime>[0]>(async () => ({ content: JSON.stringify(answer) }));
    service.setLlmRuntime(makeRuntime(chat));
    await service.backfillUnwrittenSummaries();
    expect(JSON.stringify(chat.mock.calls)).toContain("LATE_DECISION_RELEASE_218");
    expect(fs.readFileSync(segment.historyFile, "utf8")).toContain("capture_end_reason: interrupted");
    expect(service.snapshot().histories.find((entry) => entry.id === `${id}-10min-summary`)?.title).toBe(answer.title);
  });

  it("keeps compacted recovery evidence when raw retention expires before a model is available", async () => {
    const segment = rawSegment();
    vi.setSystemTime(new Date("2026-09-16T00:00:00Z"));
    const service = makeService();
    service.snapshot();
    expect(fs.existsSync(segment.eventsFile)).toBe(false);
    expect(fs.readFileSync(segment.historyFile, "utf8")).toContain("LATE_DECISION_RELEASE_218");
    const chat = vi.fn<Parameters<typeof makeRuntime>[0]>(async () => ({ content: JSON.stringify(answer) }));
    service.setLlmRuntime(makeRuntime(chat));
    await service.backfillUnwrittenSummaries();
    expect(JSON.stringify(chat.mock.calls)).toContain("LATE_DECISION_RELEASE_218");
    expect(service.snapshot().histories.find((entry) => entry.id === `${id}-10min-summary`)?.title).toBe(answer.title);
  });

  it("does not reset legacy retention age when recovery creates missing metadata", () => {
    const segment = rawSegment();
    fs.rmSync(segment.metadataFile);
    const originalAge = new Date("2026-09-13T00:00:00Z");
    fs.utimesSync(segment.directory, originalAge, originalAge);
    vi.setSystemTime(new Date("2026-09-16T00:00:00Z"));
    const service = makeService();
    service.snapshot();
    expect(fs.existsSync(segment.directory)).toBe(false);
    expect(fs.readFileSync(segment.historyFile, "utf8")).toContain("LATE_DECISION_RELEASE_218");
  });

  it("does not recover the active segment or resurrect a cleared raw-only record", async () => {
    const segment = rawSegment();
    const service = makeService();
    (service as unknown as { segment: typeof segment | null }).segment = segment;
    const chat = vi.fn(async () => ({ content: JSON.stringify(answer) }));
    service.setLlmRuntime(makeRuntime(chat));
    await service.backfillUnwrittenSummaries();
    expect(chat).not.toHaveBeenCalled();
    expect(fs.existsSync(segment.historyFile)).toBe(false);
    (service as unknown as { segment: null }).segment = null;
    await service.clearHistories("all");
    await service.backfillUnwrittenSummaries();
    expect(service.snapshot().histories).toHaveLength(0);
    expect(fs.existsSync(segment.directory)).toBe(false);
  });
});
