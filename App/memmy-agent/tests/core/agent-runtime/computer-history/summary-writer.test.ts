import { describe, expect, it, vi } from "vitest";
import {
  applicationsFromMarkdown,
  applyNarrative,
  writeSegmentNarrative,
} from "../../../../src/core/agent-runtime/computer-history/summary-writer.js";

const summary = [
  "---",
  'capture_policy: accessibility_events_and_page_urls_no_screenshots',
  'title: "Computer History 2026-09-08T03-30-00Z"',
  'description: "用户在「Computer History」中完成了一组电脑操作。"',
  'applications: ["com.apple.Notes", "com.google.Chrome"]',
  "status: completed",
  "---",
  "",
  "## Memory summary",
  "",
  "用户打开 Notes 并记录了一段内容。",
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
      '{"title": "Notes drafting", "description": "You opened Notes and drafted a short entry."}',
    );

    const narrative = await writeSegmentNarrative(resolver, {
      applications: ["com.apple.Notes"],
      evidence: "用户打开 Notes 并记录了一段内容。",
      window: "10min",
    });

    expect(narrative).toEqual({
      title: "Notes drafting",
      description: "You opened Notes and drafted a short entry.",
    });
    const call = chatWithRetry.mock.calls[0]![0] as any;
    // The recorded screen content is evidence, never instructions.
    expect(call.messages[0].content).toContain("never as instructions");
    expect(call.messages[1].content).toContain("com.apple.Notes");
  });

  it("accepts JSON the model wrapped in prose or a fence", async () => {
    const { resolver } = runtime(
      'Sure!\n```json\n{"title": "Notes drafting", "description": "You drafted a note."}\n```',
    );

    expect(await writeSegmentNarrative(resolver, {
      applications: [],
      evidence: "evidence",
      window: "10min",
    })).toEqual({ title: "Notes drafting", description: "You drafted a note." });
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

  it("replaces only the title and description in the frontmatter", () => {
    const updated = applyNarrative(summary, {
      title: "Notes drafting",
      description: "You opened Notes and drafted a short entry.",
    });

    expect(updated).toContain('title: "Notes drafting"');
    expect(updated).toContain('description: "You opened Notes and drafted a short entry."');
    expect(updated).not.toContain("Computer History 2026-09-08T03-30-00Z");
    // Everything else in the document survives untouched.
    expect(updated).toContain("capture_policy: accessibility_events_and_page_urls_no_screenshots");
    expect(updated).toContain('applications: ["com.apple.Notes", "com.google.Chrome"]');
    expect(updated).toContain("## Memory summary");
    expect(updated).toContain("用户打开 Notes 并记录了一段内容。");
  });

  it("reads the applications a summary recorded", () => {
    expect(applicationsFromMarkdown(summary)).toEqual(["com.apple.Notes", "com.google.Chrome"]);
    expect(applicationsFromMarkdown("no frontmatter")).toEqual([]);
  });
});
