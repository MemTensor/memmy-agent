import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerHistoryDemoService } from "../../../../src/tools/computer-history/mac/computer-history-api.js";
import { isCaptureInterruptionRecord, renderSummary } from "../../../../src/tools/computer-history/mac/summarize-history.js";

const id = "2026-10-15T10-00-00Z";
const historyId = `${id}-10min-summary`;
const timestamp = "2026-10-15T10:00:03.000Z";
const failure = { recordType: "capture_health", timestamp, code: "ax_snapshot_failed", count: 2 };
const gap = { recordType: "capture_gap", timestamp, actionKind: "mouse.click", button: "left",
  count: 1, reason: "action_origin_expired" };
let root: string;
const services: ComputerHistoryDemoService[] = [];

function makeService() {
  const service = new ComputerHistoryDemoService({
    recorderScript: path.join(root, "never-run.js"), historyDirectory: path.join(root, "histories"),
    recordingDirectory: path.join(root, "recordings"), workflowDirectory: path.join(root, "workflows"),
    observationSettingsFile: path.join(root, "settings.json"),
  });
  services.push(service);
  return service;
}

function segmentWith(records: Record<string, unknown>[]) {
  const directory = path.join(root, "recordings", "segments", id);
  fs.mkdirSync(directory, { recursive: true });
  const eventsFile = path.join(directory, "events.jsonl");
  const metadataFile = path.join(directory, "metadata.json");
  fs.writeFileSync(metadataFile, JSON.stringify({ id, startedAt: "2026-10-15T10:00:00Z", state: "open" }));
  fs.writeFileSync(eventsFile, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  return { id, directory, eventsFile, metadataFile,
    historyFile: path.join(root, "histories", `${historyId}.md`),
    startedAt: "2026-10-15T10:00:00Z", child: null, output: "", stoppedByUser: false };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-15T10:06:00Z"));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "history-capture-gaps-"));
});

afterEach(async () => {
  for (const service of services.splice(0)) {
    (service as unknown as { segment: unknown }).segment = null;
    await service.shutdown();
  }
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("capture failures remain retrievable without fabricated activity", () => {
  it.each([failure, gap])("renders a failure-only stream as incomplete capture: $recordType", (record) => {
    const markdown = renderSummary({ file: "/synthetic/events.jsonl", records: [record] });
    expect(markdown).toContain('title: "采集记录存在缺口"');
    expect(markdown).toContain("无法据此还原具体活动");
    expect(markdown).toContain("applications: []");
    expect(markdown).toContain("status: incomplete");
    expect(markdown).not.toContain("完成了一组电脑操作");
  });

  it.each([failure, gap])("exposes the active raw segment before narration: $recordType", (record) => {
    const segment = segmentWith([record]);
    const service = makeService();
    (service as unknown as { segment: typeof segment }).segment = segment;
    const query = record.recordType === "capture_health" ? "ax_snapshot_failed" : "action_origin_expired";
    const matches = service.searchHistories(query, 5, { historyId });
    expect(matches).toHaveLength(1);
    expect(matches[0].matchedTerms).toContain(query);
    expect(matches[0].history.summaryStatus).toBe("pending");
    expect(matches[0].history.markdown).toContain(query);
    expect(fs.readFileSync(segment.historyFile, "utf8")).toContain("无法据此还原具体活动");
  });

  it.each([failure, gap])("checkpoints failure evidence before expiring raw records: $recordType", (record) => {
    const segment = segmentWith([record]);
    vi.setSystemTime(new Date("2026-10-18T10:00:00Z"));
    const service = makeService();
    const snapshot = service.snapshot();
    const history = snapshot.histories.find((entry) => entry.id === historyId);
    expect(history?.markdown).toContain("无法据此还原具体活动");
    expect(history?.markdown).not.toContain("完成了一组电脑操作");
    const checkpoint = JSON.parse(fs.readFileSync(`${segment.historyFile}.evidence.json`, "utf8"));
    const query = record.recordType === "capture_health" ? "ax_snapshot_failed" : "action_origin_expired";
    expect(checkpoint.evidence).toContain(query);
    expect(checkpoint.evidence).toContain(timestamp);
    expect(fs.existsSync(segment.eventsFile)).toBe(false);
    expect(service.searchHistories(query, 5, { historyId })[0]?.matchedTerms).toContain(query);
  });

  it("preserves malformed failure evidence instead of treating it as an empty expired segment", () => {
    const segment = segmentWith([failure]);
    fs.appendFileSync(segment.eventsFile, '{"recordType":"capture_gap","timestamp":');
    vi.setSystemTime(new Date("2026-10-18T10:00:00Z"));
    makeService().snapshot();
    expect(fs.existsSync(segment.eventsFile)).toBe(true);
    expect(fs.existsSync(`${segment.historyFile}.evidence.json`)).toBe(false);
  });

  it.each(["heartbeat", "observer_ready", "input_monitoring_ready", "ax_snapshot_ready", "event_recorded"])(
    "does not create timeline activity from %s or lifecycle metadata", (code) => {
      segmentWith([
        { recordType: "human_history_metadata", recordingId: id },
        { recordType: "human_event", eventType: "recording_started", timestamp },
        { recordType: "capture_health", code, timestamp },
        { recordType: "human_event", eventType: "recording_stopped", timestamp },
      ]);
      expect(makeService().snapshot().histories).toHaveLength(0);
    });

  it.each([
    { ...failure, code: "unrecognized_provider_message" },
    { ...failure, timestamp: "invalid" },
    { ...failure, count: 0 },
    { ...gap, actionKind: "private_app_name" },
    { ...gap, reason: "private_provider_text" },
    { recordType: "human_history_metadata", code: "ax_snapshot_failed", timestamp },
  ])("does not turn malformed or unrelated metadata into capture evidence", (record) => {
    expect(isCaptureInterruptionRecord(record)).toBe(false);
  });
});
