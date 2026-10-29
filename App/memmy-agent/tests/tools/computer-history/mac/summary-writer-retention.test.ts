import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compactEventEvidence, MAX_EVIDENCE_CHARS } from "../../../../src/tools/computer-history/mac/summary-writer.js";

function record(marker: string, extra = "") {
  return JSON.stringify({ recordType: "human_event", eventType: "accessibility_snapshot", timestamp: "2026-10-09T10:01:00Z",
    application: { name: marker, bundleId: "com.example.synthetic" }, ax: { mode: "fullTree", text: `AXStaticText||${marker} ${extra}|||` } });
}
describe("retention semantic evidence", () => {
  it("recovers repeated action order and precise times from the saved durable projection", () => {
    const records = ["Save", "Cancel", "Save"].map((title, index) => ({
      recordType: "human_event", eventType: "mouse_click", sequence: index + 1,
      timestamp: `2026-10-15T10:00:0${index}.123Z`, application: { name: "Editor", bundleId: "win32.editor" },
      details: { button: "left", accessibility: { role: "AXButton", title }, x: 30, unknownPayload: "PRIVATE_EXTRA" },
    }));
    records.push({ ...records[2], sequence: 4, timestamp: "2026-10-15T10:00:03.456Z",
      details: { button: "left", accessibility: { role: "AXUnknown", title: "" }, x: 90, unknownPayload: "PRIVATE_EXTRA" } });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "history-durable-actions-"));
    try {
      const destination = path.join(root, "retained-evidence.md");
      fs.writeFileSync(destination, compactEventEvidence(records.map(record => JSON.stringify(record)), { purpose: "retention" }), "utf8");
      const saved = fs.readFileSync(destination, "utf8");
      const actions = saved.split("\n").filter(line => line.startsWith("recorded_action ")).map(line => JSON.parse(line.slice("recorded_action ".length)));
      expect(actions.map(action => action.details.accessibility.title)).toEqual(["Save", "Cancel", "Save", ""]);
      expect(actions.map(action => action.timestamp)).toEqual(records.map(record => record.timestamp));
      expect(actions.map(action => action.sequence)).toEqual([1, 2, 3, 4]);
      expect(actions[3].details.accessibility.role).toBe("AXUnknown");
      expect(actions.every(action => action.details.actor === undefined)).toBe(true);
      expect(saved).not.toContain("PRIVATE_EXTRA");
      expect(actions.every(action => action.details.x === undefined)).toBe(true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("keeps browser attribution and observed states in order without expanding the safe action projection", () => {
    const base = { recordType: "human_event", eventType: "browser_action", application: { name: "Browser" } };
    const lines = [
      { ...base, timestamp: "2026-10-15T10:00:00.123Z", sequence: 1, details: {
        action: "click", actor: "agent", phase: "attempt", interactionId: "fixture-action",
        target: { role: "button", name: "Continue", opaque: "UNSAFE_TARGET_EXTRA" },
        before: { title: "Step one", text: ["Awaiting confirmation", "Review before continuing"], target: { role: "button", name: "Continue" }, opaque: "UNSAFE_STATE_EXTRA" },
      } },
      { ...base, timestamp: "2026-10-15T10:00:00.456Z", sequence: 2, details: {
        action: "click", actor: "agent", phase: "observed", interactionId: "fixture-action",
        after: { title: "Step two", text: ["Pending review"], target: { role: "AXSecureTextField", value: "SECRET_FIELD_VALUE" } },
      } },
      { recordType: "human_event", eventType: "text_input", timestamp: "2026-10-15T10:00:01.000Z", sequence: 3,
        details: { redacted: true, text: "HIDDEN_INPUT", accessibility: { role: "AXSecureTextField", value: "SECRET_FIELD_VALUE" } } },
    ].map(record => JSON.stringify(record));
    const retained = compactEventEvidence(lines, { purpose: "retention" });
    const actions = retained.split("\n").filter(line => line.startsWith("recorded_action "))
      .map(line => JSON.parse(line.slice("recorded_action ".length)));
    expect(actions.map(action => [action.sequence, action.details.actor, action.details.phase]))
      .toEqual([[1, "agent", "attempt"], [2, "agent", "observed"], [3, undefined, undefined]]);
    expect(actions[0].details.before).toEqual({ title: "Step one", text: ["Awaiting confirmation", "Review before continuing"], target: { role: "button", name: "Continue" } });
    expect(actions[1].details.after).toEqual({ title: "Step two", text: ["Pending review"] });
    expect(actions[2].details).toEqual({ redacted: true });
    for (const secret of ["UNSAFE_TARGET_EXTRA", "UNSAFE_STATE_EXTRA", "SECRET_FIELD_VALUE", "HIDDEN_INPUT"]) expect(retained).not.toContain(secret);
  });
  it("does not restore sensitive browser values in either model or durable evidence", () => {
    const event = JSON.stringify({ recordType: "human_event", eventType: "browser_action", timestamp: "2026-10-15T10:00:00.000Z",
      details: { action: "input", target: { role: "textbox", name: "Authentication", sensitive: true, value: "PRIVATE_VALUE" },
        after: { text: ["Authentication requested"], target: { role: "textbox", inputType: "password", value: "PRIVATE_PASSWORD" } } } });
    for (const purpose of ["model", "retention"] as const) {
      const evidence = compactEventEvidence([event], { purpose });
      expect(evidence).toContain("Authentication requested");
      expect(evidence).not.toContain("PRIVATE_VALUE");
      expect(evidence).not.toContain("PRIVATE_PASSWORD");
    }
  });
  it("keeps every arc and full visible field while model compaction remains bounded", () => {
    const middle = `HEAD ${"complete visible evidence ".repeat(90)} MIDDLE_ONLY_MARKER ${"readable evidence ".repeat(80)} TAIL`;
    const lines = Array.from({ length: 71 }, (_, index) => record(`ARC_${index}_END`, middle));
    const retained = compactEventEvidence(lines, { purpose: "retention" });
    for (let index = 0; index < 71; index++) expect(retained).toContain(`ARC_${index}_END`);
    expect(retained.includes(middle.replace(/\s+/gu, " "))).toBe(true);
    expect(retained.length).toBeGreaterThan(MAX_EVIDENCE_CHARS);
    expect(compactEventEvidence(lines).length).toBeLessThanOrEqual(MAX_EVIDENCE_CHARS);
  });
  it("keeps complete long labels, queries, keys, selections and messages with redaction", () => {
    const long = `HEAD ${"readable long field ".repeat(60)} MIDDLE_DETAIL_MARKER ${"other field ".repeat(60)} TAIL`;
    const base = { recordType: "human_event", timestamp: "2026-10-09T10:01:00Z", application: { name: "Fixture" } };
    const lines = [
      { ...base, eventType: "mouse_click", details: { accessibility: { title: long } } },
      { ...base, eventType: "text_input", details: { text: long, redacted: false, textPurpose: "search_query" } },
      { ...base, eventType: "key_press", details: { keys: Array.from({ length: 12 }, (_, i) => `KEY_${i}`) } },
      { ...base, eventType: "selection_changed", details: { text: long, redacted: false } },
      { ...base, eventType: "wechat_message", details: { messageId: "synthetic", senderName: "Fixture sender", text: long } },
      { ...base, eventType: "page_context", details: { url: "https://example.com/?api_key=secret_fixture_token" } },
    ].map((event) => JSON.stringify(event));
    const retained = compactEventEvidence(lines, { purpose: "retention" });
    expect(retained.includes(`interacted with: ${long.replace(/\s+/gu, " ")}`)).toBe(true);
    expect(retained.includes(`selected text: ${JSON.stringify(long.replace(/\s+/gu, " ").trim())}`)).toBe(true);
    for (let i = 0; i < 12; i++) expect(retained).toContain(`KEY_${i}`);
    expect(retained).not.toContain("secret_fixture_token");
  });
  it.each(["{broken", "{}", JSON.stringify({ recordType: "human_event", eventType: "future_event", timestamp: "2026-10-09T10:01:00Z" }),
    JSON.stringify({ recordType: "human_event", eventType: "accessibility_snapshot" })])("refuses incomplete or unsupported durable input: %s", (line) => {
    expect(() => compactEventEvidence([record("VALID"), line], { purpose: "retention" })).toThrow(/incomplete or invalid record/u);
  });
});
