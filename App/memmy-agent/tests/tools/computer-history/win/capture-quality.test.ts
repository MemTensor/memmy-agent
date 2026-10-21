import { describe, expect, it } from "vitest";
import type { HistoryEvent } from "../../../../src/tools/computer-history/core/recording.js";
import { contentQuality } from "../../../../src/tools/computer-history/win/capture-quality.js";

const sample: HistoryEvent = { eventType: "accessibility_snapshot", timestamp: "2026-10-15T12:00:00.000Z",
  accessibility: { mode: "full", truncated: false, nodes: [{ key: "1", parentKey: null, controlType: "Window", providerOffscreen: false, name: "Window" }] } };
describe("last persisted content quality", () => {
  it("distinguishes labels, readable text, a failed read and an exhausted budget", () => {
    expect(contentQuality(sample)).toMatchObject({ status: "partial", reason: "labels_only" });
    const readable = structuredClone(sample);
    readable.accessibility!.nodes.push({ key: "2", parentKey: "1", controlType: "Edit", providerOffscreen: false, value: "PRIVATE_USER_VALUE" });
    const quality = contentQuality(readable);
    expect(quality).toEqual({ timestamp: sample.timestamp, status: "available", reason: "text_read" });
    expect(JSON.stringify(quality)).not.toContain("PRIVATE_USER_VALUE");
    readable.accessibility!.truncated = true;
    expect(contentQuality(readable)).toMatchObject({ status: "partial", reason: "budget_exceeded" });
    const failed = structuredClone(sample);
    failed.accessibility!.nodes.push({ key: "2", parentKey: "1", controlType: "Document", providerOffscreen: false,
      documentStatus: "read_failed", redaction: "edit_control" });
    expect(contentQuality(failed)).toMatchObject({ status: "unavailable", reason: "read_failed" });
  });
  it("does not interpret idle events, blank windows or redacted controls as a capture failure", () => {
    expect(contentQuality({ eventType: "recording_started", timestamp: sample.timestamp })).toBeUndefined();
    const blank = structuredClone(sample); blank.accessibility!.nodes[0]!.name = "";
    expect(contentQuality(blank)).toBeUndefined();
    blank.accessibility!.nodes[0]!.redaction = "password";
    expect(contentQuality(blank)).toBeUndefined();
  });
  it("keeps fallback menu labels distinct from readable body content", () => {
    const labels = structuredClone(sample);
    labels.accessibility!.nodes = [{ key: "1", parentKey: null, controlType: "Custom", providerOffscreen: false,
      value: "File", valueSource: "msaa.name" }];
    expect(contentQuality(labels)).toMatchObject({ status: "partial", reason: "labels_only" });
    labels.accessibility!.nodes[0]!.controlType = "Text";
    expect(contentQuality(labels)).toMatchObject({ status: "available", reason: "text_read" });
  });
});
