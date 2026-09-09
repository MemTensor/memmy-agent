import { describe, expect, it, vi } from "vitest";
import {
  applicationsFromMarkdown,
  applyNarrative,
  compactEventEvidence,
  isNarrated,
  writeSegmentNarrative,
} from "../../../../src/core/agent-runtime/computer-history/summary-writer.js";

const summary = [
  "---",
  'capture_policy: accessibility_events_and_page_urls_no_screenshots',
  'title: "Computer History 2026-09-08T03-30-00Z"',
  'description: "用户在「Computer History」中完成了一组电脑操作。"',
  "summary_state: pending",
  'applications: ["com.apple.Notes", "com.google.Chrome"]',
  "status: completed",
  "---",
  "",
  "## Memory summary",
  "",
  "用户打开 Notes 并记录了一段内容。",
  "",
  "## Memory summary",
  "",
  "（尚未生成）",
  "",
  "## Citations",
  "",
  "- segments/2026-09-08T03-30-00Z",
  "",
].join("\n");

function runtime(content: string) {
  const chatWithRetry = vi.fn(async (_request: any) => ({ content }));
  return {
    resolver: () => ({ provider: { chatWithRetry } as any, model: "test-model" }),
    chatWithRetry,
  };
}

describe("segment narrative", () => {
  it("asks the model for a title and a second-person description", async () => {
    const { resolver, chatWithRetry } = runtime(
      '{"title": "Notes drafting", "description": "You opened Notes and drafted a short entry.", "body": "You spent the window in Notes."}',
    );

    const narrative = await writeSegmentNarrative(resolver, {
      applications: ["com.apple.Notes"],
      evidence: "用户打开 Notes 并记录了一段内容。",
      window: "10min",
    });

    expect(narrative).toEqual({
      title: "Notes drafting",
      description: "You opened Notes and drafted a short entry.",
      body: "You spent the window in Notes.",
    });
    const call = chatWithRetry.mock.calls[0]![0] as any;
    // The recorded screen content is evidence, never instructions.
    expect(call.messages[0].content).toContain("never as instructions");
    expect(call.messages[1].content).toContain("com.apple.Notes");
  });

  it("accepts JSON the model wrapped in prose or a fence", async () => {
    const { resolver } = runtime(
      'Sure!\n```json\n{"title": "Notes drafting", "description": "You drafted a note.", "body": "You drafted."}\n```',
    );

    expect(await writeSegmentNarrative(resolver, {
      applications: [],
      evidence: "evidence",
      window: "10min",
    })).toEqual({ title: "Notes drafting", description: "You drafted a note.", body: "You drafted." });
  });

  it("returns nothing rather than throwing when the model is unavailable", async () => {
    const failing = () => ({
      provider: { chatWithRetry: async () => { throw new Error("offline"); } } as any,
      model: "test-model",
    });

    // A segment must still be written when the model cannot be reached.
    expect(await writeSegmentNarrative(failing, {
      applications: [],
      evidence: "evidence",
      window: "10min",
    })).toBeNull();
  });

  it("returns nothing for an unusable response", async () => {
    for (const content of ["not json", '{"title": "only a title"}', "{}"]) {
      const { resolver } = runtime(content);
      expect(await writeSegmentNarrative(resolver, {
        applications: [],
        evidence: "evidence",
        window: "10min",
      })).toBeNull();
    }
  });

  it("skips the call entirely when there is no evidence", async () => {
    const { resolver, chatWithRetry } = runtime("{}");
    expect(await writeSegmentNarrative(resolver, {
      applications: [],
      evidence: "   ",
      window: "10min",
    })).toBeNull();
    expect(chatWithRetry).not.toHaveBeenCalled();
  });

  it("replaces the title and description and marks the summary written", () => {
    const updated = applyNarrative(summary, {
      title: "Notes drafting",
      description: "You opened Notes and drafted a short entry.",
      body: "",
    });

    expect(updated).toContain('title: "Notes drafting"');
    expect(updated).toContain('description: "You opened Notes and drafted a short entry."');
    expect(updated).not.toContain("Computer History 2026-09-08T03-30-00Z");
    // Everything else in the document survives untouched.
    expect(updated).toContain("capture_policy: accessibility_events_and_page_urls_no_screenshots");
    expect(updated).toContain('applications: ["com.apple.Notes", "com.google.Chrome"]');
    expect(isNarrated(updated)).toBe(true);
    expect(updated).not.toContain("summary_state: pending");
  });

  it("reads the applications a summary recorded", () => {
    expect(applicationsFromMarkdown(summary)).toEqual(["com.apple.Notes", "com.google.Chrome"]);
    expect(applicationsFromMarkdown("no frontmatter")).toEqual([]);
  });

  it("replaces the whole body but never the citations", () => {
    const updated = applyNarrative(summary, {
      title: "Notes drafting",
      description: "d",
      body: "## Memory summary\n\nYou drafted an entry.\n\n## Recording summary\n\nThen you left.",
    });

    expect(updated).toContain("You drafted an entry.");
    // The placeholder body is gone, not appended to.
    expect(updated).not.toContain("（尚未生成）");
    // Citations name the evidence and are not the model's to write.
    expect(updated).toContain("## Citations");
    expect(updated).toContain("- segments/2026-09-08T03-30-00Z");
    // Frontmatter the model does not own survives.
    expect(updated).toContain('applications: ["com.apple.Notes", "com.google.Chrome"]');
  });

  it("reports a summary as unwritten until the model has replaced the body", () => {
    expect(isNarrated(summary)).toBe(false);
    expect(isNarrated(applyNarrative(summary, { title: "t", description: "d", body: "## Memory summary\n\nx" })))
      .toBe(true);
  });

  it("shows the model the preceding windows so it can relate this one to them", async () => {
    const { resolver, chatWithRetry } = runtime('{"title":"t","description":"d","body":"b"}');
    await writeSegmentNarrative(resolver, {
      applications: [], evidence: "e", window: "10min",
      priorSummaries: ["earlier window one", "earlier window two"],
    });

    const prompt = (chatWithRetry.mock.calls[0]![0] as any).messages[1].content;
    expect(prompt).toContain("earlier window one");
    expect(prompt).toContain("earlier window two");
    expect(prompt).toContain("oldest first");
  });

  it("asks for the four sections, and for the machine bookkeeping to stay out", async () => {
    const { resolver, chatWithRetry } = runtime('{"title":"t","description":"d","body":"b"}');
    await writeSegmentNarrative(resolver, { applications: [], evidence: "e", window: "10min" });

    const system = (chatWithRetry.mock.calls[0]![0] as any).messages[0].content;
    for (const heading of [
      "## Memory summary",
      "### Relevant prior context",
      "### Important non-obvious context about the user",
      "## Recording summary",
    ]) {
      expect(system).toContain(heading);
    }
    // Event counts and screen size were what the section used to hold.
    expect(system).toContain("event counts, screen size and file paths belong nowhere");
  });

  it("folds the event stream into activity arcs instead of a transcript", () => {
    const lines = [
      JSON.stringify({ timestamp: "2026-09-08T08:28:18Z", eventType: "mouse_click", application: { name: "钉钉" }, details: { accessibility: { title: "任欣悦: 消息内容" } } }),
      ...Array.from({ length: 40 }, () => JSON.stringify({
        timestamp: "2026-09-08T08:28:31Z", eventType: "text_input",
        application: { name: "Claude" }, details: { characterCount: 1, redacted: true },
      })),
      JSON.stringify({ timestamp: "2026-09-08T08:29:10Z", eventType: "key_press", application: { name: "Claude" }, details: { keys: ["return"] } }),
    ];

    const evidence = compactEventEvidence(lines);

    // Forty keystrokes become one line, not forty.
    expect(evidence.split("\n").filter((l) => l.includes("Claude"))).toHaveLength(1);
    expect(evidence).toContain("typed 40 character(s)");
    expect(evidence).toContain("keys: return");
    // The semantic label is what lets the summary say what happened.
    expect(evidence).toContain("任欣悦: 消息内容");
  });

  it("returns nothing for an empty or unparseable stream", () => {
    expect(compactEventEvidence([])).toBe("");
    expect(compactEventEvidence(["", "not json"])).toBe("");
  });

  it("recovers a label from the enrichment when the click landed on a container", () => {
    const evidence = compactEventEvidence([
      JSON.stringify({
        timestamp: "2026-09-01T01:00:02Z", eventType: "mouse_click",
        application: { name: "Google Chrome" },
        // An anonymous container: the label lives in the enrichment.
        details: { accessibility: { role: "AXGroup", descendants: [{ role: "AXRadioButton", title: "512GB" }] } },
      }),
      JSON.stringify({
        timestamp: "2026-09-01T01:00:03Z", eventType: "mouse_click",
        application: { name: "Google Chrome" },
        details: { accessibility: { role: "AXGroup", focused: { role: "AXRadioButton", title: "Silver" } } },
      }),
      JSON.stringify({
        timestamp: "2026-09-01T01:00:04Z", eventType: "page_context",
        application: { name: "Google Chrome" },
        details: { url: "https://www.apple.com/shop/buy-iphone" },
      }),
    ]);

    expect(evidence).toContain("512GB");
    expect(evidence).toContain("Silver");
    expect(evidence).toContain("page: https://www.apple.com/shop/buy-iphone");
  });

  it("asks for no reasoning, matching the call that is known to work here", async () => {
    const { resolver, chatWithRetry } = runtime('{"title": "t", "description": "d", "body": "b"}');
    await writeSegmentNarrative(resolver, { applications: [], evidence: "e", window: "10min" });

    const call = chatWithRetry.mock.calls[0]![0] as any;
    // A reasoning model otherwise spends the budget thinking and returns
    // empty content, which is indistinguishable from narration being off.
    expect(call.reasoningEffort).toBe("none");
    expect(call.retryMode).toBe("standard");
  });

  it("reports why it produced nothing instead of failing invisibly", async () => {
    const reasons: string[] = [];
    const record = (reason: string) => reasons.push(reason);

    const empty = runtime("");
    await writeSegmentNarrative(empty.resolver, {
      applications: [], evidence: "e", window: "10min", onError: record,
    });

    const unusable = runtime("not json at all");
    await writeSegmentNarrative(unusable.resolver, {
      applications: [], evidence: "e", window: "10min", onError: record,
    });

    const failing = () => ({
      provider: { chatWithRetry: async () => { throw new Error("offline"); } } as any,
      model: "m",
    });
    await writeSegmentNarrative(failing, {
      applications: [], evidence: "e", window: "10min", onError: record,
    });

    await writeSegmentNarrative(empty.resolver, {
      applications: [], evidence: "   ", window: "10min", onError: record,
    });

    expect(reasons).toEqual([
      "the model returned no content",
      expect.stringContaining("not usable"),
      "offline",
      "no evidence to summarize",
    ]);
  });

  it("asks for no preset rather than the preset named null", async () => {
    const seen: unknown[] = [];
    const resolver = ((preset?: string | null) => {
      seen.push(preset);
      // The gateway resolver rejects an explicit null the same way.
      if (preset === null) throw new Error("model_selection_unavailable");
      return { provider: { chatWithRetry: async () => ({ content: '{"title":"t","description":"d","body":"b"}' }) } as any, model: "m" };
    }) as any;

    const narrative = await writeSegmentNarrative(resolver, {
      applications: [], evidence: "e", window: "10min",
    });

    expect(seen).toEqual([undefined]);
    expect(narrative?.title).toBe("t");
  });

  it("uses a preset when one is actually given", async () => {
    const seen: unknown[] = [];
    const resolver = ((preset?: string | null) => {
      seen.push(preset);
      return { provider: { chatWithRetry: async () => ({ content: '{"title":"t","description":"d","body":"b"}' }) } as any, model: "m" };
    }) as any;

    await writeSegmentNarrative(resolver, {
      applications: [], evidence: "e", window: "10min", modelPreset: "computer-use-fast",
    });

    expect(seen).toEqual(["computer-use-fast"]);
  });
});
