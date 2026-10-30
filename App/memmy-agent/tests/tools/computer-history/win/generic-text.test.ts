import { describe, expect, it } from "vitest";
import { parseNativePolicy, compileWindowsPolicy } from "../../../../src/tools/computer-history/win/policy.js";
import { parseNativeEvent, type NativeSnapshotEvent } from "../../../../src/tools/computer-history/win/protocol.js";
import { SnapshotNormalizer } from "../../../../src/tools/computer-history/win/normalize.js";
import { compactEventEvidence } from "../../../../src/tools/computer-history/core/summary-writer.js";
import { context, full, root } from "./fixtures.js";

// Keep the policy independent of the native snapshot envelope.
const genericPolicy = () => parseNativePolicy({ version: 1, applications: [{ pid: context.pid, executable: context.executable, captureText: true }] });
const body = { ...root, key: "0000000000000003", parentKey: root.key, depth: 1, runtimeId: "3", automationId: "",
  controlType: "Document", name: "Draft", text: "VISIBLE_SENTENCE HIDDEN_CONTEXT_SENTENCE", visibleText: "VISIBLE_SENTENCE", documentStatus: "available" };
const normalize = (nodes: unknown[], captureText = true) => new SnapshotNormalizer().normalize(
  parseNativeEvent(full(nodes)) as NativeSnapshotEvent,
  captureText ? genericPolicy() : parseNativePolicy({ version: 1, applications: [{ pid: context.pid, executable: context.executable, captureText: false }] }), "r1")!;

describe("generic non-password UIA content", () => {
  it("uses generic capture for browsers and region hints unless explicitly disabled", () => {
    const result = compileWindowsPolicy([], [context], { defaultApplicationBehavior: "observe" });
    expect(result.applications[0]?.captureText).toBe(true);
    expect(compileWindowsPolicy([{ executable: context.executable, documentRegions: [] }], [context]).applications[0]?.captureText).toBe(true);
    expect(compileWindowsPolicy([], [{ ...context, executable: "C:\\Apps\\chrome.exe" }], { defaultApplicationBehavior: "observe" }).applications[0]?.captureText).toBe(true);
    expect(() => parseNativePolicy({ version: 1, applications: [{ pid: 123, executable: "C:\\Apps\\chrome.exe", browser: "chrome", captureText: true }] })).not.toThrow();
  });

  it("reads a document without an app selector and keeps full text separate from visible evidence", () => {
    const event = normalize([root, body]);
    expect(event.accessibility?.nodes[1]).toMatchObject({ documentContext: "uia.document", documentEvidence: { adapter: "uia.text" } });
    const evidence = compactEventEvidence([JSON.stringify({ recordType: "human_event", ...event })]);
    expect(evidence).toContain('"document_context":"VISIBLE_SENTENCE HIDDEN_CONTEXT_SENTENCE"');
    expect(evidence).toContain('"provider_range_text":"VISIBLE_SENTENCE"');
    expect(evidence).toContain('"pixel_visibility":"unverified"');
    expect(evidence).not.toMatch(/on screen:.*HIDDEN_CONTEXT_SENTENCE/u);
  });

  it("records current non-focused field values with source and credential redaction", () => {
    const event = normalize([root, { ...body, controlType: "Edit", documentStatus: undefined, text: undefined, visibleText: undefined,
      value: "draft password=secret123", focused: false }]);
    expect(event.accessibility?.nodes[1]).toMatchObject({ value: "draft password=[REDACTED]", valueSource: "uia.value" });
    const evidence = compactEventEvidence([JSON.stringify({ recordType: "human_event", ...event })]);
    expect(evidence).toContain('"field_value":"draft password=[REDACTED]"');
    expect(evidence).not.toContain("entered text:");
    expect(evidence).not.toContain("secret123");
  });

  it.each([true])("rejects content from a password state of %s", password => {
    expect(() => normalize([root, { ...body, password }])).toThrow("windows_snapshot_invalid");
  });

  it.each(["Custom", "DataItem", "ComboBox", "Text"])("reads actual capabilities on %s and preserves legacy provenance", controlType => {
    const event = normalize([root, { ...body, controlType, password: null, name: undefined, text: undefined, visibleText: undefined,
      documentStatus: "read_failed", value: "LEGACY_CONTENT", valueSource: "uia.legacy_value" }]);
    expect(event.accessibility?.nodes[1]).toMatchObject({ value: "LEGACY_CONTENT", valueSource: "uia.legacy_value" });
    expect(compactEventEvidence([JSON.stringify({ recordType: "human_event", ...event })])).toContain('"adapter":"uia.legacy_value"');
  });

  it.each(["msaa.name", "msaa.value"])("preserves direct fallback source %s through summary input", valueSource => {
    const event = normalize([root, { ...body, controlType: "Text", name: undefined, text: undefined, visibleText: undefined,
      documentStatus: undefined, value: "DIRECT_LEGACY_BODY", valueSource }]);
    expect(compactEventEvidence([JSON.stringify({ recordType: "human_event", ...event })])).toContain(`"adapter":"${valueSource}"`);
  });

  it("keeps legacy explicit policies bounded and requires content provenance", () => {
    expect(() => normalize([root, body], false)).toThrow("windows_snapshot_invalid");
    expect(normalize([root, { ...body, name: undefined, documentStatus: undefined }]).accessibility?.nodes[1].text).toBe(body.text);
    expect(normalize([root, { ...body, controlType: "Custom", password: null, name: body.text }]).accessibility?.nodes[1].text).toBe(body.text);
    expect(() => normalize([root, { ...body, automationId: "private", password: true }])).toThrow();
  });
});
