import { describe, expect, it } from "vitest";
import {
  SIX_HOUR_MS,
  alignedId,
  buildSixHourSummary,
  instantFromId,
  summariesInWindow,
} from "../../../../src/tools/computer-history/mac/rollup.js";

function tenMinute(id: string, options: {
  title?: string;
  applications?: string[];
  prior?: string;
  nonObvious?: string;
} = {}) {
  return {
    name: `${id}-10min-summary.md`,
    markdown: [
      "---",
      `title: "${options.title ?? id}"`,
      `applications: [${(options.applications ?? ["com.apple.Notes"]).map((a) => `"${a}"`).join(", ")}]`,
      "---",
      "",
      "## Memory summary",
      "",
      "### Relevant prior context",
      "",
      options.prior ?? "- 继续昨天的调研",
      "",
      "### Important non-obvious context",
      "",
      options.nonObvious ?? "- 用户偏好键盘操作",
      "",
      "## Citations",
      "",
      `- segments/${id}`,
      "",
    ].join("\n"),
  };
}

describe("layered summaries", () => {
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
});
