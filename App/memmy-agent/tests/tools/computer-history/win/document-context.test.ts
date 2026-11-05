import { describe, expect, it, vi } from "vitest";
import { compactEventEvidence, MAX_EVIDENCE_CHARS, writeSegmentNarrative } from "../../../../src/tools/computer-history/core/summary-writer.js";
import type { CaptureNode, HistoryEvent } from "../../../../src/tools/computer-history/core/recording.js";

const prefix = "document context (visibility unconfirmed):";
const body: CaptureNode = { key: "body", parentKey: null, controlType: "Edit", providerOffscreen: false,
  documentStatus: "available", documentContext: "vscode.editor", name: "synthetic.txt",
  text: "Visible first line. SECOND-LINE-BODY-MARKER. Final paragraph.", visibleText: "Visible first line." };
const event = (node: CaptureNode = body): HistoryEvent => ({ eventType: "accessibility_snapshot", timestamp: "2026-10-08T03:00:00Z",
  application: { id: "windows:synthetic", platform: "windows", name: "Code.exe" }, accessibility: { mode: "full", truncated: false, nodes: [node] } });
const evidence = (...events: HistoryEvent[]) => compactEventEvidence(events.map((item) => JSON.stringify(item)));

describe("authorized VS Code document context", () => {
  it("retains qualified document context after raw-event retention", () => {
    const result = compactEventEvidence([JSON.stringify({ recordType: "human_event", sequence: 1, ...event() })], { purpose: "retention" });
    expect(result).toContain(`${prefix} ${body.text}`);
    expect(result).toContain("SECOND-LINE-BODY-MARKER");
    expect(result).toContain("on screen: Visible first line.");
    expect(result).not.toContain("on screen: Visible first line. SECOND-LINE-BODY-MARKER");
  });
  it("includes body outside the provider-visible line with a separate qualification", () => {
    const result = evidence(event());
    expect(result).toContain(`${prefix} ${body.text}`);
    expect(result.split("\n").find((line) => line.includes("on screen:"))).toBe("    on screen: Visible first line.");
    expect(result).not.toContain("typed");
    expect(result).not.toContain("synthetic.txt");
  });
  it("does not turn missing visible ranges or an offscreen provider flag into visibility evidence", () => {
    const result = evidence(event({ ...body, visibleText: undefined, providerOffscreen: true }));
    expect(result).toContain(prefix);
    expect(result).toContain("SECOND-LINE-BODY-MARKER");
    expect(result).not.toContain("on screen:");
  });
  it("requires adapter provenance and available content; preserves legacy visible-only behavior", () => {
    const unscoped = evidence(event({ ...body, documentContext: undefined }));
    expect(unscoped).not.toContain(prefix);
    expect(unscoped).not.toContain("SECOND-LINE-BODY-MARKER");
    for (const node of [{ ...body, redaction: "edit_control" }, { ...body, documentStatus: "label_only" as const },
      { ...body, documentStatus: "read_failed" as const }]) expect(evidence(event(node))).not.toContain("SECOND-LINE-BODY-MARKER");
    expect(evidence({ ...event(), application: { platform: "macOS", bundleId: "test", name: "Code" } })).not.toContain(prefix);
  });
  it("deduplicates context separately while preserving later visibility evidence and credential scrubbing", () => {
    const secret = "SYNTHETIC-SECRET-20261008";
    const node = { ...body, text: `${body.text} password=${secret}` };
    const result = evidence(event(node), event({ ...node, visibleText: "SECOND-LINE-BODY-MARKER" }));
    expect(result.split(prefix)).toHaveLength(2);
    expect(result).not.toContain(secret);
    expect(result).toContain("[REDACTED]");
    expect(result.split("\n").find((line) => line.includes("on screen:"))).toContain("SECOND-LINE-BODY-MARKER");
  });
  it("budgets document context with other evidence and retains the final state", () => {
    const events = Array.from({ length: 70 }, (_, index) => ({ ...event({ ...body,
      text: `BEGIN-${index} ${"synthetic ".repeat(1000)} END-${index}` }), application: { ...event().application, name: `Code-${index}.exe` } }));
    const result = evidence(...events);
    expect(result.length).toBeLessThanOrEqual(MAX_EVIDENCE_CHARS);
    expect(result).toContain(prefix);
    expect(result).toContain("END-69");
    expect(result).toContain("BEGIN-0");
  });
  it("sends qualified context and the activity-inference prohibition in the actual model request", async () => {
    const chatWithRetry = vi.fn(async (...args: unknown[]) => { void args; return { content: '{"title":"Synthetic document","description":"Document context only."}' }; });
    await writeSegmentNarrative(() => ({ model: "synthetic", provider: { chatWithRetry } as any }),
      { applications: ["windows:synthetic"], evidence: evidence(event()), window: "10min" });
    const request = chatWithRetry.mock.calls[0]![0] as { messages: { content: string }[] };
    expect(request.messages[0]!.content).toContain("does not prove the user saw, read, wrote or acted");
    expect(request.messages[0]!.content).toContain("never describe the whole document as on screen");
    expect(request.messages[0]!.content).toContain("Only explicit filename metadata can establish a filename");
    expect(request.messages[0]!.content).toContain("The document context contains/describes");
    expect(request.messages[1]!.content).toContain(prefix);
    expect(request.messages[1]!.content).toContain("SECOND-LINE-BODY-MARKER");
  });
});
