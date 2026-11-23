import { describe, expect, it } from "vitest";
import { buildInjectedContext } from "../../../src/service/retrieval/retrieval-service.js";
import type { MemoryRow, RecallHit } from "../../../src/types.js";

function skill(id: string, guide: string, procedure: Record<string, unknown> = {}) {
  const hit: RecallHit = { id, kind: "skill", memoryLayer: "Skill", status: "activated", title: id,
    snippet: guide, score: 1, tags: [], source: "skill" };
  const memory: MemoryRow = { id, timeline: "2026-10-28T00:00:00Z", userId: "test", memoryType: "SkillMemory",
    status: "activated", visibility: "private", memoryKey: id, memoryValue: guide, tags: [], info: {},
    properties: { internal_info: { memory_layer: "Skill", memory_kind: "skill",
      skill: { name: id, invocation_guide: guide, procedure_json: procedure } } },
    memoryLayer: "Skill", version: 1, createdAt: "2026-10-28T00:00:00Z", updatedAt: "2026-10-28T00:00:00Z" };
  return { hit, memory };
}

describe("Skill injection descriptions", () => {
  it.each([
    ["generated", "# report-writer\n\nWrite a repair report.", {}, "Write a repair report."],
    ["blurb priority", "# report-writer\n\nBody fallback", { retrievalBlurb: "Preferred summary", triggerContext: "Trigger fallback" }, "Preferred summary"],
    ["trigger fallback", "# report-writer\n\nBody fallback", { retrievalBlurb: " ", triggerContext: "Trigger summary" }, "Trigger summary"],
    ["frontmatter", "---\nname: report-writer\ndescription: Write a repair report.\n---\n# report-writer", {}, "Write a repair report."],
    ["multiline YAML", "---\r\nname: report-writer\r\ndescription: >-\r\n  Write a report\r\n  with evidence.\r\n---\r\n# report-writer", {}, "Write a report with evidence."],
    ["skip title and name", "# report-writer\n\nreport-writer\n\n## Usage\nExplain verified changes.", {}, "Explain verified changes."],
    ["missing", "# report-writer\n\nreport-writer", {}, "(not provided)"],
    ["invalid YAML", "---\nname: [broken\n---\n# report-writer\n\nBody survives.", {}, "Body survives."]
  ])("uses the expected description for %s", (_label, guide, procedure, expected) => {
    const { hit, memory } = skill("report-writer", guide, procedure);
    const packet = buildInjectedContext([hit], 10000, [memory]);
    const content = packet.injectedContext.sections[0]!.content;
    expect(content).toContain(`Description:\n${expected}`);
    expect(packet.sourceMemoryIds).toEqual([hit.id]);
  });

  it("keeps full guides and applies the summary length limit", () => {
    const guide = "# report-writer\n\nComplete procedure text.";
    const { hit, memory } = skill("report-writer", guide, { retrievalBlurb: "x".repeat(400) });
    const full = buildInjectedContext([hit], 10000, [memory], "search", undefined, undefined, { skillInjectionMode: "full" });
    expect(full.injectedContext.sections[0]!.content).toContain(guide);
    expect(full.injectedContext.sections[0]!.content).not.toContain("x".repeat(20));
    const summary = buildInjectedContext([hit], 10000, [memory], "search", undefined, undefined, { skillSummaryChars: 20 });
    expect(summary.injectedContext.sections[0]!.content).toContain("x".repeat(19) + "…");
  });
});
