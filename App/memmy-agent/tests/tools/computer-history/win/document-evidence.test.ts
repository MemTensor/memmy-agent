import { describe, expect, it, vi } from "vitest";
import { compactEventEvidence, MAX_EVIDENCE_CHARS, writeSegmentNarrative } from "../../../../src/tools/computer-history/core/summary-writer.js";
import type { CaptureNode, HistoryEvent } from "../../../../src/tools/computer-history/core/recording.js";

const body: CaptureNode = { key: "body", parentKey: "editor", controlType: "Edit", providerOffscreen: false,
  documentStatus: "available", documentContext: "vscode.editor", name: "actual-label.txt",
  text: "misleading-filename.txt\nCONTEXT-ONLY-MARKER", visibleText: "misleading-filename.txt",
  documentEvidence: { adapter: "vscode.editor", labelKind: "editor_label", labelSource: "uia.name",
    textSource: "uia.document_range", visibleTextSource: "uia.visible_ranges", providerFocused: true } };
const event = (nodes: CaptureNode[] = [body], hwnd = "100"): HistoryEvent => ({ eventType: "accessibility_snapshot",
  timestamp: "2026-10-08T05:00:00Z", application: { platform: "windows", id: "windows:code", name: "Code.exe", executable: "C:\\Code.exe" },
  details: { hwnd, pid: 1, processStart: "99", nativeSessionId: "session", generation: 1, nativeSequence: 1 },
  accessibility: { mode: "full", truncated: false, nodes } });
const evidence = (...events: HistoryEvent[]) => compactEventEvidence(events.map((entry) => JSON.stringify(entry)));
const observations = (result: string): Record<string, any>[] => result.split("\n").filter((line) => line.startsWith("    document observation: "))
  .map((line) => JSON.parse(line.slice("    document observation: ".length)));

describe("document observation identity and provenance", () => {
  it("binds a provider label to its own visible text and context without inventing a filename", () => {
    const result = evidence(event());
    expect(result).toContain("Code.exe (window W1)");
    expect(observations(result)).toEqual([{ ref: "D1", adapter: "vscode.editor", provider_focused: true, pixel_visibility: "unverified",
      label: { kind: "editor_label", source: "uia.name", value: "actual-label.txt" },
      provider_range_text: "misleading-filename.txt", document_context: "misleading-filename.txt CONTEXT-ONLY-MARKER" }]);
    expect(result).not.toContain('"filename":');
    expect(result).not.toContain("on screen:");
  });
  it("keeps same-label split editors separate even when their contents are identical", () => {
    const result = observations(evidence(event([body, { ...body, key: "second", parentKey: "other-editor" }])));
    expect(result).toHaveLength(2);
    expect(result.map((entry) => entry.ref)).toEqual(["D1", "D2"]);
    expect(result.every((entry) => entry.label.value === body.name && entry.document_context.includes("CONTEXT-ONLY-MARKER"))).toBe(true);
  });
  it("keeps A/B/A tab observations associated even when the provider reuses a node", () => {
    const other = { ...body, name: "second-label.txt", text: "SECOND-BODY", visibleText: "SECOND-VISIBLE" };
    const result = observations(evidence(event(), event([other]), event()));
    expect(result.map((entry) => [entry.label.value, entry.document_context])).toEqual([
      ["actual-label.txt", "misleading-filename.txt CONTEXT-ONLY-MARKER"], ["second-label.txt", "SECOND-BODY"],
      ["actual-label.txt", "misleading-filename.txt CONTEXT-ONLY-MARKER"],
    ]);
    expect(observations(evidence(event(), event()))).toHaveLength(1);
  });
  it("separates same application windows, returns, process restarts and collector sessions", () => {
    const second = event([body], "200");
    const restarted = { ...event(), details: { ...event().details, processStart: "100" } };
    const session = { ...event(), details: { ...event().details, nativeSessionId: "new-session" } };
    const result = evidence(event(), second, event(), restarted, session);
    expect(result.match(/\(window W\d\)/gu)).toEqual(["(window W1)", "(window W2)", "(window W1)", "(window W3)", "(window W4)"]);
    expect(observations(result)).toHaveLength(5);
    const generation = { ...event(), details: { ...event().details, generation: 2 } };
    const sameWindow = evidence(event(), generation);
    expect(sameWindow.match(/\(window W\d\)/gu)).toEqual(["(window W1)", "(window W1)"]);
    expect(observations(sameWindow)).toHaveLength(2);
  });
  it("preserves focus and visible-range changes without promoting missing visibility to full text", () => {
    const result = observations(evidence(event(), event([{ ...body, visibleText: undefined, documentEvidence: { ...body.documentEvidence!, providerFocused: false } }])));
    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({ provider_focused: false, document_context: "misleading-filename.txt CONTEXT-ONLY-MARKER" });
    expect(result[1]).not.toHaveProperty("provider_range_text");
  });
  it("does not fabricate a name for an unnamed editor and scrubs secrets from labels and text", () => {
    const result = observations(evidence(event([{ ...body, name: undefined }]), event([{ ...body,
      name: "password=SYNTHETIC-SECRET", text: "password=SYNTHETIC-SECRET" }])));
    expect(result[0]).not.toHaveProperty("label");
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC-SECRET");
  });
  it("keeps Word label provenance without expanding its summary to non-visible document text", () => {
    const word: CaptureNode = { ...body, controlType: "Document", documentContext: undefined,
      documentEvidence: { ...body.documentEvidence!, adapter: "word.document", labelKind: "document_label" } };
    const result = observations(evidence(event([word])))[0];
    expect(result).toMatchObject({ adapter: "word.document", label: { kind: "document_label" }, pixel_visibility: "unverified", provider_range_text: "misleading-filename.txt" });
    expect(result).not.toHaveProperty("document_context");
  });
  it("does not accept unavailable, redacted or unverified observations", () => {
    for (const node of [{ ...body, redaction: "edit_control" }, { ...body, documentStatus: "read_failed" as const },
      { ...body, documentEvidence: undefined }]) expect(observations(evidence(event([node])))).toEqual([]);
  });
  it("samples busy multi-window evidence as intact JSON with labels and source semantics retained", () => {
    const events = Array.from({ length: 70 }, (_, index) => event([{ ...body, name: `document-${index}.txt`,
      text: `BEGIN-${index} ${'quoted " body \\ '.repeat(1200)} END-${index}`, visibleText: `VISIBLE-${index}` }], String(index + 1)));
    const result = evidence(...events);
    expect(result.length).toBeLessThanOrEqual(MAX_EVIDENCE_CHARS);
    const rows = observations(result);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0]!.document_context).toContain("BEGIN-0");
    expect(rows.at(-1)!.document_context).toContain("END-69");
    expect(rows.every((row) => row.content_sampled === true)).toBe(true);
  });
  it("keeps truncation explicit and omits labels that cannot fit without inventing a shortened name", () => {
    const input = event([{ ...body, name: "x".repeat(1000) }]); input.accessibility!.truncated = true;
    expect(observations(evidence(input))[0]).toMatchObject({ capture_truncated: true, label_omitted: true });
    expect(observations(evidence(input))[0]).not.toHaveProperty("label");
  });
  it("sends intact source-bound observations and all-section attribution rules in real summary requests", async () => {
    const chatWithRetry = vi.fn(async (...args: unknown[]) => { void args; return { content: '{"title":"Synthetic","description":"Synthetic document context."}' }; });
    await writeSegmentNarrative(() => ({ model: "synthetic", provider: { chatWithRetry } as any }),
      { applications: ["Code.exe"], evidence: evidence(event()), window: "10min" });
    const request = chatWithRetry.mock.calls[0]![0] as { messages: { content: string }[] };
    expect(observations(request.messages[1]!.content)[0]!.label.value).toBe("actual-label.txt");
    expect(request.messages[0]!.content).toContain("not a verified filename");
    expect(request.messages[0]!.content).toContain("title, description and every body section");
    expect(request.messages[0]!.content).toContain("Window-level actions have no verified document target");
    expect(request.messages[0]!.content).toContain("applies to BOTH fields");
    expect(request.messages[0]!.content).toContain("off-viewport text even after scrolling");
  });
});
