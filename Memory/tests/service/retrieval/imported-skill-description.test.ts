import { describe, expect, it } from "vitest";
import { buildInjectedContext } from "../../../src/service/retrieval/retrieval-service.js";
import type { MemoryRow, RecallHit } from "../../../src/types.js";

function injectedDescription(guide: string, description?: string, procedure: Record<string, unknown> = {}): string {
  const id = "report-writer";
  const hit: RecallHit = {
    id, kind: "skill", memoryLayer: "Skill", status: "activated", title: id,
    snippet: guide, score: 1, tags: [], source: "skill"
  };
  const memory: MemoryRow = {
    id, timeline: "2026-11-03T00:00:00Z", userId: "test", memoryType: "SkillMemory",
    status: "activated", visibility: "private", memoryKey: id, memoryValue: guide, tags: [], info: {},
    properties: { internal_info: {
      memory_layer: "Skill", memory_kind: "skill", read_only: true,
      ...(description === undefined ? {} : { skill_description: description }),
      skill: { name: id, invocation_guide: guide, procedure_json: procedure }
    } },
    memoryLayer: "Skill", version: 1, createdAt: "2026-11-03T00:00:00Z", updatedAt: "2026-11-03T00:00:00Z"
  };
  return buildInjectedContext([hit], 10000, [memory]).injectedContext.sections[0]!.content;
}

describe("imported Skill injection descriptions", () => {
  it("keeps the source description ahead of a stale retrieval blurb", () => {
    const content = injectedDescription("# report-writer\n\nGuide fallback.", "Source description.", {
      retrievalBlurb: "Stale retrieval description.", triggerContext: "Trigger fallback."
    });
    expect(content).toContain("Description:\nSource description.");
    expect(content).not.toContain("Stale retrieval description.");
  });

  it.each([
    ["frontmatter", "---\nname: report-writer\ndescription: >-\n  Write a report\n  with evidence.\n---\n# report-writer", "Write a report with evidence."],
    ["prose", "# report-writer\n\nWrite a report with evidence.", "Write a report with evidence."],
    ["missing description", "# report-writer\n\nreport-writer", "(not provided)"]
  ])("uses the upstream %s fallback when imported description metadata is absent", (_label, guide, expected) => {
    expect(injectedDescription(guide)).toContain(`Description:\n${expected}`);
  });
});
