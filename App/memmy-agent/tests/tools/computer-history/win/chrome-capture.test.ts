import { describe, expect, it } from "vitest";
import { compileWindowsPolicy, parseNativePolicy } from "../../../../src/tools/computer-history/win/policy.js";
import { SnapshotNormalizer } from "../../../../src/tools/computer-history/win/normalize.js";
import { parseNativeEvent, type NativeSnapshotEvent } from "../../../../src/tools/computer-history/win/protocol.js";
import { compactEventEvidence } from "../../../../src/tools/computer-history/core/summary-writer.js";
import { context, full, root, text, stats } from "./fixtures.js";

export const chromeExe = "C:\\Apps\\chrome.exe";
export const chromePolicy = compileWindowsPolicy([{ executable: chromeExe }], [{ ...context, executable: chromeExe }]);
export function chromeSnapshot(url = "https://www.gutenberg.org/ebooks/11", name = "Alice’s Adventures in Wonderland — Lewis Carroll") {
  const document = { ...root, controlType: "Document", name: "Book", bounds: [0, 80, 800, 520] };
  return { ...full([document, { ...text, name, bounds: [10, 100, 700, 25] }]),
    context: { ...context, executable: chromeExe, browser: { kind: "chrome", mode: "normal", url,
      documentId: "1.2.3", viewport: [0, 80, 800, 520] } } };
}
const parse = (raw: unknown) => parseNativeEvent(raw) as NativeSnapshotEvent;
const normalized = (raw: unknown) => new SnapshotNormalizer().normalize(parse(raw), chromePolicy, "r");

describe("Chrome capture evidence", () => {
  it("uses the generic path with optional URL and mode metadata", () => {
    expect(chromePolicy.applications[0]).toMatchObject({ browser: "chrome", captureText: true });
    const raw = chromeSnapshot();
    const { browser: _browser, ...withoutBrowser } = raw.context; void _browser;
    expect(normalized({ ...raw, context: withoutBrowser })?.accessibility?.nodes[1].name).toContain("Lewis Carroll");
    for (const mode of ["normal", "unknown", "private"]) expect(normalized({ ...raw,
      context: { ...raw.context, browser: { ...raw.context.browser, mode } } })?.details?.browserMode).toBe(mode);
    expect(parseNativePolicy({ version: 1, applications: [{ pid: 1, executable: chromeExe, browser: "chrome", captureText: true }] }).applications[0]?.captureText).toBe(true);
  });
  it.each(["https://example.com/?token=secret", "https://example.com/#secret", "https://user:secret@example.com/", "file:///private", "javascript:alert(1)"])(
    "drops unusable URL metadata while retaining page content: %s", url => {
      const event = normalized(chromeSnapshot(url));
      expect(event?.details?.url).toBeUndefined();
      expect(JSON.stringify(event)).toContain("Lewis Carroll");
      expect(JSON.stringify(event)).not.toContain("secret");
    });
  it("retains book content and sanitized URL with document provenance", () => {
    const event = normalized(chromeSnapshot());
    expect(event?.details).toMatchObject({ browser: true, url: "https://www.gutenberg.org/ebooks/11", urlSource: "chrome.uia.document" });
  });
  it("accepts additional content capabilities but still rejects passwords", () => {
    const raw = chromeSnapshot();
    raw.snapshot.nodes[1] = { ...(raw.snapshot.nodes[1] as Record<string, unknown>), password: true };
    expect(() => normalized(raw)).toThrow();
  });
  it("requires a fresh baseline after a same-tab URL change or tab identity change", () => {
    for (const changed of [{ url: "https://www.gutenberg.org/ebooks/55" }, { documentId: "4.5.6" }]) {
      const n = new SnapshotNormalizer();
      const before = chromeSnapshot();
      n.normalize(parse(before), chromePolicy, "r");
      const delta = { ...before, context: { ...before.context, browser: { ...before.context.browser, ...changed } },
        snapshot: { status: "ok", reason: null, mode: "delta", added: [], removed: [], unchangedCount: 2,
          focusKey: null, truncated: false, truncation: [], stats: stats(), elapsedMs: 3 } };
      expect(() => n.normalize(parse(delta), chromePolicy, "r")).toThrow();
      expect(n.normalize(parse({ ...before, context: delta.context }), chromePolicy, "r")).not.toBeNull();
    }
  });
  it("keeps different pages separate in model and retention evidence, including return visits", () => {
    const a = normalized(chromeSnapshot())!;
    const b = normalized(chromeSnapshot("https://www.gutenberg.org/ebooks/55", "The Wonderful Wizard of Oz — L. Frank Baum"))!;
    const lines = [a, b, a].map((event, i) => JSON.stringify({ ...event, sequence: i + 1, recordType: "human_event" }));
    for (const purpose of ["model", "retention"] as const) {
      const evidence = compactEventEvidence(lines, { purpose });
      expect(evidence).toContain("/ebooks/11"); expect(evidence).toContain("/ebooks/55");
      expect(evidence).toContain("Lewis Carroll"); expect(evidence).toContain("L. Frank Baum");
      expect(evidence.match(/page: https:\/\/www.gutenberg.org\/ebooks\/11/g)).toHaveLength(2);
    }
  });
});
