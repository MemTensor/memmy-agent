import { describe, expect, it } from "vitest";
import { compactEventEvidence, MAX_EVIDENCE_CHARS } from "../../../../src/tools/computer-history/mac/summary-writer.js";

const app = { name: "Editor", bundleId: "win32.editor" };
const at = "2026-10-15T10:00:00.000Z";
const event = (extra: Record<string, unknown>) => JSON.stringify({
  recordType: "human_event", timestamp: at, application: app, eventType: "accessibility_snapshot", ...extra,
});
const health = (code: string, timestamp = at, extra: Record<string, unknown> = {}) => JSON.stringify({
  recordType: "capture_health", code, timestamp, ...extra,
});
const snapshot = (text: string, extra: Record<string, unknown> = {}) => event({
  ax: { mode: "fullTree", windowKey: "editor:1", text, ...extra },
});

describe("capture evidence for narration and durable retention", () => {
  it("preserves timestamped health signals without inserting an unknown application or leaking diagnostic extras", () => {
    const lines = [
      snapshot("AXStaticText||FIRST_VIEW|||"),
      health("ax_snapshot_failed", "2026-10-15T10:00:10.000Z", { count: 2, providerText: "UNTRUSTED_DIAGNOSTIC_TEXT" }),
      health("heartbeat", "2026-10-15T10:00:15.000Z"),
      health("ax_snapshot_ready", "2026-10-15T10:00:30.000Z"),
      snapshot("AXStaticText||FINAL_VIEW|||"),
    ];
    for (const purpose of ["model", "retention"] as const) {
      const evidence = compactEventEvidence(lines, { purpose });
      expect(evidence).toContain("FIRST_VIEW");
      expect(evidence).toContain("FINAL_VIEW");
      expect(evidence.match(/\[10:00-10:00\] Editor/gu)).toHaveLength(1);
      expect(evidence).not.toContain("] unknown");
      expect(evidence).not.toContain("UNTRUSTED_DIAGNOSTIC_TEXT");
      expect(evidence).toContain("last failure 2026-10-15T10:00:10.000Z; last persisted-ready 2026-10-15T10:00:30.000Z");
    }
    const retained = compactEventEvidence(lines, { purpose: "retention" });
    expect(retained).toContain('capture_health {"code":"ax_snapshot_failed","timestamp":"2026-10-15T10:00:10.000Z","count":2}');
    expect(retained).toContain('capture_health {"code":"heartbeat","timestamp":"2026-10-15T10:00:15.000Z"}');
  });

  it("distinguishes empty, partial and legacy snapshots and keeps per-snapshot quality for retention", () => {
    const lines = [
      snapshot("", { truncated: false, readFailures: 0 }),
      snapshot("AXStaticText||PARTIAL_TEXT|||", { truncated: true, readFailures: 3 }),
      snapshot("AXStaticText||LEGACY_TEXT|||"),
    ];
    for (const purpose of ["model", "retention"] as const) {
      const evidence = compactEventEvidence(lines, { purpose });
      expect(evidence).toContain("AX records: 3; text-bearing: 2; empty/unreadable: 1; partial: 1; quality unreported: 1.");
      expect(evidence).toContain("PARTIAL_TEXT");
      expect(evidence).toContain("LEGACY_TEXT");
    }
    expect(compactEventEvidence(lines, { purpose: "retention" }))
      .toContain('AX quality at 2026-10-15T10:00:00.000Z: {"truncated":true,"readFailures":3}');
  });

  it("reports missing diff baselines across recording restarts and never presents removed text as newly visible", () => {
    const diff = (text: string) => snapshot(text, { mode: "diffFromPrevious" });
    const lines = [
      diff("+ AXStaticText||UNBASED_ADDITION|||"),
      snapshot("AXStaticText||BASELINE_TEXT|||"),
      diff("- AXStaticText||BASELINE_TEXT|||\n+ AXStaticText||NEW_TEXT|||"),
      event({ eventType: "recording_stopped" }),
      event({ eventType: "recording_started" }),
      diff("- AXStaticText||UNSEEN_REMOVAL|||\n+ AXStaticText||AFTER_RESTART|||"),
    ];
    const evidence = compactEventEvidence(lines);
    expect(evidence).toContain("Full trees: 1; diffs: 3; diffs without a supplied continuous baseline: 2.");
    expect(evidence).toContain("UNBASED_ADDITION");
    expect(evidence).toContain("AFTER_RESTART");
    expect(evidence).not.toContain("UNSEEN_REMOVAL");
  });

  it("bounds diagnostic floods without displacing content and keeps all signals in durable evidence", () => {
    const signals = Array.from({ length: 2500 }, (_, index) => health("heartbeat", new Date(Date.parse(at) + index * 100).toISOString()));
    const lines = [snapshot("AXStaticText||FIRST_CONTENT|||"), ...signals,
      health("ax_snapshot_failed", "2026-10-15T10:05:00.000Z"),
      snapshot("AXStaticText||FINAL_CONTENT|||", { truncated: true, readFailures: 1 })];
    const model = compactEventEvidence(lines);
    expect(model.length).toBeLessThanOrEqual(MAX_EVIDENCE_CHARS);
    expect(model).toContain("heartbeat: count=2500");
    expect(model).toContain("last failure 2026-10-15T10:05:00.000Z");
    expect(model).toContain("FIRST_CONTENT");
    expect(model).toContain("FINAL_CONTENT");
    expect(model.match(/capture_health heartbeat:/gu)).toHaveLength(1);
    expect(compactEventEvidence(lines, { purpose: "retention" }).match(/capture_health \{/gu)).toHaveLength(2501);
  });

  it("does not manufacture readable coverage or a failure from action-only records and heartbeats", () => {
    const evidence = compactEventEvidence([
      event({ eventType: "mouse_click", details: { accessibility: { role: "AXUnknown" } } }),
      health("observer_ready"), health("heartbeat"), health("event_recorded"),
    ]);
    expect(evidence).toContain("AX records: 0");
    expect(evidence).toContain("No window accessibility text records were supplied");
    expect(evidence).toContain("last failure not recorded; last persisted-ready not recorded");
    expect(evidence).toContain("1 click(s)");
  });

  it("retains input gaps without attributing their scope or converting them into ordinary actions", () => {
    const gap = JSON.stringify({ recordType: "capture_gap", timestamp: at, actionKind: "mouse.click", button: "left", count: 2,
      reason: "foreground_changed", application: { name: "UNVERIFIED_APP" }, url: "https://private.example", x: 42, typedText: "PRIVATE_TEXT" });
    for (const purpose of ["model", "retention"] as const) {
      const evidence = compactEventEvidence([gap], { purpose });
      expect(evidence).toContain("Input context gaps: 1 record(s)");
      expect(evidence).toContain("input observed, target/actor/outcome unconfirmed");
      expect(evidence).toContain("2026-10-15T10:00:00.000Z");
      expect(evidence).not.toContain("UNVERIFIED_APP");
      expect(evidence).not.toContain("private.example");
      expect(evidence).not.toContain("PRIVATE_TEXT");
      expect(evidence).not.toContain("click(s)");
      expect(evidence).not.toContain("] unknown");
    }
    const retained = compactEventEvidence([gap], { purpose: "retention" });
    const record = JSON.parse(retained.split("\n").find(line => line.startsWith("capture_gap "))!.slice("capture_gap ".length));
    expect(record).toEqual({ recordType: "capture_gap", timestamp: at, actionKind: "mouse.click", reason: "foreground_changed", count: 2, button: "left" });
    expect(() => compactEventEvidence([gap.replace("foreground_changed", "arbitrary_reason")], { purpose: "retention" })).toThrow();
  });

  it("keeps earlier control candidates distinct from verified interaction labels and strips unrelated content", () => {
    const click = event({ eventType: "mouse_click", timestamp: "2026-10-15T10:00:02.000Z", details: {
      accessibility: { role: "AXUnknown" },
      previousControlsAtPoint: { observedAt: at, interpretation: "previously_observed_not_confirmed_target",
        controls: [{ role: "AXButton", name: "Prior control", identifier: "prior-control", value: "UNWANTED_VALUE", x: 10 }],
        extra: "UNWANTED_METADATA" },
    } });
    for (const purpose of ["model", "retention"] as const) {
      const evidence = compactEventEvidence([click], { purpose });
      expect(evidence).toContain("Prior control");
      expect(evidence).toContain(`"observedAt":"${at}"`);
      expect(evidence).toContain("previously_observed_not_confirmed_target");
      expect(evidence).toContain("target/actor/outcome unconfirmed");
      expect(evidence).not.toContain("interacted with: Prior control");
      expect(evidence).not.toContain("UNWANTED_VALUE");
      expect(evidence).not.toContain("UNWANTED_METADATA");
    }
    expect(compactEventEvidence([click.replace(at, "2026-10-15T10:00:03.000Z")])).not.toContain("Prior control");
  });

  it("does not lose the quality prefix or activity when many different gap groups fill the diagnostic budget", () => {
    const gaps = ["mouse.click", "mouse.context_menu", "mouse.scroll", "keyboard.keydown"].flatMap(actionKind =>
      ["worker_failed", "action_origin_unknown", "action_origin_expired", "action_origin_changed", "foreground_changed", "navigation_changed", "focus_changed"]
        .map(reason => JSON.stringify({ recordType: "capture_gap", timestamp: at, actionKind, reason, count: 1 })));
    const evidence = compactEventEvidence([health("ax_snapshot_failed"), ...gaps, snapshot("AXStaticText||CONTENT_SURVIVES|||", { truncated: true, readFailures: 1 })]);
    expect(evidence.length).toBeLessThanOrEqual(MAX_EVIDENCE_CHARS);
    expect(evidence).toContain("AX records: 1; text-bearing: 1; empty/unreadable: 0; partial: 1");
    expect(evidence).toContain(`last failure ${at}`);
    expect(evidence).toContain("Input context gaps: 28 record(s)");
    expect(evidence).toContain("CONTENT_SURVIVES");
  });

  it.each([
    health("untrusted_future_code"), health("heartbeat", "not a time"),
    health("heartbeat", at, { count: 0 }), health("heartbeat", at, { count: 1.5 }),
  ])("fails closed on invalid durable health records while model input discards them", (invalid) => {
    expect(() => compactEventEvidence([snapshot("AXStaticText||VALID|||"), invalid], { purpose: "retention" }))
      .toThrow(/incomplete or invalid record/u);
    expect(compactEventEvidence([invalid])).toBe("");
  });
});
