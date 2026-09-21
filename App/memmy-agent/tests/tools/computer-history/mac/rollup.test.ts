import { describe, expect, it } from "vitest";
import {
  SIX_HOUR_MS,
  alignedId,
  buildSixHourSummary,
  instantFromId,
  isLocalSixHourWindow,
  isSixHourWindowClosed,
  rollupCoveredHistoryIds,
  sixHourWindowStart,
  summariesInWindow,
} from "../../../../src/tools/computer-history/mac/rollup.js";
import { MAX_EVIDENCE_CHARS, writeSegmentNarrative } from "../../../../src/tools/computer-history/mac/summary-writer.js";

function tenMinute(id: string, options: {
  title?: string;
  applications?: string[];
  prior?: string;
  nonObvious?: string;
  description?: string;
  memory?: string;
  recording?: string;
  sourceType?: string;
  summaryState?: string;
  status?: string;
} = {}) {
  return {
    name: `${id}-10min-summary.md`,
    markdown: [
      "---",
      `title: "${options.title ?? id}"`,
      `description: ${JSON.stringify(options.description ?? "You reviewed your notes.")}`,
      `applications: [${(options.applications ?? ["com.apple.Notes"]).map((a) => `"${a}"`).join(", ")}]`,
      `source_type: ${options.sourceType ?? "captured"}`,
      `summary_state: ${options.summaryState ?? "ready"}`,
      `status: ${options.status ?? "completed"}`,
      "---",
      "",
      "## Memory summary",
      "",
      options.memory ?? "You gathered evidence for a decision.",
      "",
      "### Relevant prior context",
      "",
      options.prior ?? "- 继续昨天的调研",
      "",
      "### Important non-obvious context about the user",
      "",
      options.nonObvious ?? "- 用户偏好键盘操作",
      "",
      "## Recording summary",
      "",
      options.recording ?? "You checked the latest notes and saved the result.",
      "",
      "## Citations",
      "",
      `- segments/${id}`,
      "",
    ].join("\n"),
  };
}

describe("layered summaries", () => {
  it("reads exact legacy citations without claiming nearby, invalid, or uncited source windows", () => {
    const id = "2026-09-08T00-00-00Z-6h-summary";
    const markdown = [
      "---", "source_type: rollup", "summary_state: ready", "---", "",
      "## Memory summary", "- 2026-09-08T00-20-00Z-10min-summary.md", "",
      "## Citations", "",
      "- 2026-09-08T00-10-00Z-10min-summary.md",
      "- 2026-09-08T00-10-00Z-10min-summary.md",
      "- 2026-09-08T05-50-00Z-10min-summary.md",
      "- 2026-09-08T06-00-00Z-10min-summary.md",
      "- 2026-09-07T23-50-00Z-10min-summary.md",
      "- 2026-09-08T00-11-00Z-10min-summary.md",
      "- 2026-08-39T00-30-00Z-10min-summary.md",
      "- ../2026-09-08T00-30-00Z-10min-summary.md",
      "- 2026-09-08T00-40-00Z-10min-summary.md untrusted suffix",
      "", "## Other text", "- 2026-09-08T00-50-00Z-10min-summary.md", "",
    ].join("\r\n");
    expect(rollupCoveredHistoryIds(markdown, id)).toEqual([
      "2026-09-08T00-10-00Z-10min-summary", "2026-09-08T05-50-00Z-10min-summary",
    ]);
    expect(rollupCoveredHistoryIds(markdown, `${id}.md`)).toEqual(rollupCoveredHistoryIds(markdown, id));
    expect(rollupCoveredHistoryIds(markdown, "arbitrary-6h-summary")).toEqual([]);
  });

  it("respects explicit coverage, including an empty or invalid value, instead of falling back to citations", () => {
    const id = "2026-09-08T00-00-00Z-6h-summary";
    const cited = "2026-09-08T00-10-00Z-10min-summary";
    for (const value of ["[]", "null", "not json", "", '["../unsafe"]']) {
      const markdown = `---\ncovered_history_ids: ${value}\n---\n\n## Citations\n\n- ${cited}.md\n`;
      expect(rollupCoveredHistoryIds(markdown, id)).toEqual([]);
    }
    const explicit = "2026-09-08T00-20-00Z-10min-summary";
    expect(rollupCoveredHistoryIds(`---\ncovered_history_ids: ${JSON.stringify([explicit])}\n---\n\n## Citations\n\n- ${cited}.md\n`, id)).toEqual([explicit]);
  });

  it("parses aligned ids back into instants", () => {
    expect(instantFromId("2026-09-08T03-30-00Z")?.toISOString()).toBe("2026-09-08T03:30:00.000Z");
    expect(instantFromId("2026-09-08T03-30-00Z-10min-summary.md")?.toISOString())
      .toBe("2026-09-08T03:30:00.000Z");
    expect(instantFromId("not-an-id")).toBeNull();
  });

  it("aligns ids down to the window grid", () => {
    const at = new Date("2026-09-08T03:37:41.000Z");
    expect(alignedId(at, 10 * 60 * 1000)).toBe("2026-09-08T03-30-00Z");
    expect(alignedId(at, SIX_HOUR_MS)).toBe("2026-09-08T00-00-00Z");
  });

  it("cuts six-hour windows on the local clock, one per part of the day", () => {
    // Written against local getters so it holds in any time zone. Epoch
    // alignment put the boundaries at 02/08/14/20 in UTC+8, which gave a day
    // two windows that began before noon.
    const day = new Date(2026, 8, 11);
    const starts = new Set<number>();
    for (let hour = 0; hour < 24; hour += 1) {
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, 37);
      const start = sixHourWindowStart(at);
      expect(start.getHours() % 6).toBe(0);
      expect(start.getMinutes()).toBe(0);
      expect(start.getDate()).toBe(at.getDate());
      expect(at.getTime() - start.getTime()).toBeLessThan(SIX_HOUR_MS);
      expect(isLocalSixHourWindow(start)).toBe(true);
      starts.add(start.getTime());
    }
    expect([...starts].map((time) => new Date(time).getHours())).toEqual([0, 6, 12, 18]);
    expect(isLocalSixHourWindow(new Date(day.getFullYear(), day.getMonth(), day.getDate(), 2))).toBe(false);
  });

  it("closes a six-hour window only when its full duration has elapsed", () => {
    const start = new Date(2026, 8, 11, 6);
    expect(isSixHourWindowClosed(start, new Date(start.getTime() + SIX_HOUR_MS - 1))).toBe(false);
    expect(isSixHourWindowClosed(start, new Date(start.getTime() + SIX_HOUR_MS))).toBe(true);
  });

  it("selects only the ten-minute summaries inside the window", () => {
    const windowStart = new Date("2026-09-08T00:00:00.000Z");
    const covered = summariesInWindow([
      tenMinute("2026-09-07T23-50-00Z"),
      tenMinute("2026-09-08T00-10-00Z"),
      tenMinute("2026-09-08T05-50-00Z"),
      tenMinute("2026-09-08T06-00-00Z"),
      // A six-hour file must never be folded into another six-hour file.
      { name: "2026-09-08T00-00-00Z-6h-summary.md", markdown: "---\ntitle: \"x\"\n---" },
    ], windowStart);

    expect(covered.map((summary) => summary.name)).toEqual([
      "2026-09-08T00-10-00Z-10min-summary.md",
      "2026-09-08T05-50-00Z-10min-summary.md",
    ]);
  });

  it("cites the summaries it reused rather than the raw segments", () => {
    const rollup = buildSixHourSummary([
      tenMinute("2026-09-08T00-10-00Z"),
      tenMinute("2026-09-08T01-20-00Z"),
    ], new Date("2026-09-08T00:00:00.000Z"))!;

    expect(rollup.fileName).toBe("2026-09-08T00-00-00Z-6h-summary.md");
    expect(rollup.citedSummaries).toEqual([
      "2026-09-08T00-10-00Z-10min-summary.md",
      "2026-09-08T01-20-00Z-10min-summary.md",
    ]);
    // The whole point of the layer: one level down, not all the way down.
    expect(rollup.markdown).not.toContain("segments/");
  });

  it("merges applications and context without repeating them", () => {
    const rollup = buildSixHourSummary([
      tenMinute("2026-09-08T00-10-00Z", { applications: ["com.apple.Notes"], prior: "- 同一条线索" }),
      tenMinute("2026-09-08T00-20-00Z", {
        applications: ["com.apple.Notes", "com.google.Chrome"],
        prior: "- 同一条线索",
      }),
    ], new Date("2026-09-08T00:00:00.000Z"))!;

    expect(rollup.markdown).toContain('applications: ["com.apple.Notes", "com.google.Chrome"]');
    expect(rollup.markdown.match(/同一条线索/g)).toHaveLength(1);
  });

  it("returns nothing when the window holds no summaries", () => {
    expect(buildSixHourSummary([], new Date("2026-09-08T00:00:00.000Z"))).toBeNull();
    expect(buildSixHourSummary(
      [tenMinute("2026-09-09T00-10-00Z")],
      new Date("2026-09-08T00:00:00.000Z"),
    )).toBeNull();
  });

  it("covers only completed narrated captures and records their exact history ids", () => {
    const rollup = buildSixHourSummary([
      tenMinute("2026-09-08T00-10-00Z"),
      tenMinute("2026-09-08T00-20-00Z", { sourceType: "human_computer_history" }),
      tenMinute("2026-09-08T00-30-00Z", { summaryState: "pending" }),
      tenMinute("2026-09-08T00-40-00Z", { status: "incomplete" }),
      tenMinute("2026-09-08T00-50-00Z", { sourceType: "imported" }),
      tenMinute("2026-09-08T01-00-00Z", { sourceType: "demo_fixture" }),
    ], new Date("2026-09-08T00:00:00Z"))!;

    expect(rollup.coveredHistoryIds).toEqual([
      "2026-09-08T00-10-00Z-10min-summary",
      "2026-09-08T00-20-00Z-10min-summary",
    ]);
    expect(rollup.markdown).toContain(`covered_history_ids: ${JSON.stringify(rollup.coveredHistoryIds)}`);
    expect(rollup.citedSummaries).toEqual(rollup.coveredHistoryIds.map((id) => `${id}.md`));
    expect(buildSixHourSummary([
      tenMinute("2026-09-08T00-30-00Z", { summaryState: "pending" }),
    ], new Date("2026-09-08T00:00:00Z"))).toBeNull();
  });

  it("passes decisions, activity subsections, and current and legacy user context to the model", async () => {
    const current = tenMinute("2026-09-08T00-10-00Z", {
      title: "Deployment Review", description: "Release build 218 after smoke verification.",
      memory: "Release at 18:00.", nonObvious: "- Alex owns approval for release 218.",
      recording: "### Investigation\n\nBuild 217 failed startup.\n\n### Decision\n\nBuild 218 passed verification.",
    });
    const legacy = tenMinute("2026-09-08T00-20-00Z", { nonObvious: "- The release uses project Maple." });
    legacy.markdown = legacy.markdown.replace("context about the user", "context");
    const rollup = buildSixHourSummary([current, legacy], new Date("2026-09-08T00:00:00Z"))!;
    let modelInput = "";
    await writeSegmentNarrative(() => ({ model: "test", provider: { chatWithRetry: async (request: any) => {
      modelInput = request.messages[1].content;
      return { content: '{"title":"Release","description":"You verified the release.","body":"Verified."}' };
    } } as any }), {
      window: "6h", applications: [], evidence: rollup.markdown.replace(/^---\n[\s\S]*?\n---\n/u, ""),
    });

    for (const fact of ["Release at 18:00", "Alex owns approval", "project Maple", "Build 217 failed startup", "Build 218 passed verification"]) {
      expect(modelInput).toContain(fact);
    }
    expect(modelInput).not.toContain("segments/");
  });

  it("budgets all 36 summaries before narration so the final windows and conclusions survive", async () => {
    const summaries = Array.from({ length: 36 }, (_, index) => {
      const at = new Date(Date.UTC(2026, 8, 8, 0, index * 10));
      const id = at.toISOString().slice(0, 19).replace(/:/gu, "-") + "Z";
      return tenMinute(id, {
        title: `Window ${index} `.padEnd(80, "x"), description: `Decision ${index}: ` + "evidence ".repeat(250),
        prior: "Prior context ".repeat(100), nonObvious: "User context ".repeat(100),
        memory: "Started reviewing. " + "memory ".repeat(350) + `MEMORY_END_${index}`,
        recording: "Investigated the issue. " + "activity ".repeat(350) + `ACTIVITY_END_${index}`,
      });
    });
    const rollup = buildSixHourSummary(summaries, new Date("2026-09-08T00:00:00Z"))!;
    const evidence = rollup.markdown.replace(/^---\n[\s\S]*?\n---\n/u, "").trim();
    expect(evidence.length).toBeLessThanOrEqual(MAX_EVIDENCE_CHARS);
    expect(rollup.coveredHistoryIds).toHaveLength(36);
    let modelInput = "";
    await writeSegmentNarrative(() => ({ model: "test", provider: { chatWithRetry: async (request: any) => {
      modelInput = request.messages[1].content;
      return { content: '{"title":"Review","description":"You reviewed the work."}' };
    } } as any }), { window: "6h", applications: [], evidence });
    for (let index = 0; index < 36; index += 1) {
      expect(modelInput).toContain(`Decision ${index}:`);
      expect(modelInput).toContain(`MEMORY_END_${index}`);
      expect(modelInput).toContain(`ACTIVITY_END_${index}`);
    }
  });
});
