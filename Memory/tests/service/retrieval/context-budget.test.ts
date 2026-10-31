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

describe("Injected context budget", () => {
  const tuning = { skillInjectionMode: "full" as const };
  const packet = (rows: ReturnType<typeof skill>[], budget: number, query?: string) => buildInjectedContext(
    rows.map(row => row.hit), budget, rows.map(row => row.memory), "turn_start", undefined, query, tuning);

  it("keeps sufficient-budget output and counts the final markdown", () => {
    const rows = [skill("one", "Short complete guide"), skill("two", "Second guide")];
    const ample = packet(rows, 10000);
    const exact = Math.ceil(ample.injectedContext.markdown.length / 4);
    const bounded = packet(rows, exact);
    expect(bounded.injectedContext.markdown).toBe(ample.injectedContext.markdown);
    expect(bounded.injectedContext.tokenEstimate).toBe(exact);
    expect(bounded.droppedDueToBudget).toEqual([]);
    expect(bounded.sourceMemoryIds).toEqual(["one", "two"]);
  });

  it.each([0, 1, 5])("returns no oversized content at budget %s", budget => {
    const result = packet([skill("long", "procedure ".repeat(1000))], budget);
    expect(result.injectedContext.markdown).toBe("");
    expect(result.injectedContext.sections).toEqual([]);
    expect(result.sourceMemoryIds).toEqual([]);
    expect(result.droppedDueToBudget).toEqual([expect.objectContaining({ id: "long", reason: "token_budget" })]);
  });

  it("skips a long full skill and keeps a later short one without mutating hits", () => {
    const rows = [skill("long", "procedure ".repeat(1500)), skill("short", "Useful small guide")];
    const original = structuredClone(rows);
    const result = packet(rows, 800);
    expect(result.sourceMemoryIds).toEqual(["short"]);
    expect(result.injectedContext.markdown).not.toContain("procedure ");
    expect(result.injectedContext.tokenEstimate).toBeLessThanOrEqual(800);
    expect(result.droppedDueToBudget.map(item => item.id)).toEqual(["long"]);
    expect(rows).toEqual(original);
  });

  it("includes attached decision guidance in admission and removes its source on rejection", () => {
    const rows = [skill("guided", "Short guide", { decisionGuidance: {
      preference: ["Always preserve the user's verified report requirements before writing"],
      antiPattern: ["Do not invent successful tests"]
    } })];
    const full = packet(rows, 10000);
    expect(full.injectedContext.markdown).toContain("Decision guidance");
    const result = packet(rows, Math.ceil(full.injectedContext.markdown.length / 4) - 1);
    expect(result.sourceMemoryIds).toEqual([]);
    expect(result.injectedContext.markdown).not.toContain("Decision guidance");
    expect(result.droppedDueToBudget.map(item => item.id)).toEqual(["guided"]);
  });

  it("budgets failure-avoidance reminders together with their source", () => {
    const row = skill("avoidance", "Verify the backup before migration");
    row.hit.kind = "policy"; row.hit.memoryLayer = "L2"; row.hit.source = "search";
    row.memory.memoryLayer = "L2";
    row.memory.properties.internal_info = { memory_layer: "L2", memory_kind: "policy", policy: {
      title: "Migration guardrail", trigger: "Before migrating a database", confidence: 0.9, status: "active", experience_type: "failure_avoidance",
      evidence_polarity: "negative", procedure: "Verify the backup before migration",
      decision_guidance: { preference: ["Verify backup integrity"], anti_pattern: ["Never delete the only backup"] }
    } };
    const full = packet([row], 10000);
    expect(full.injectedContext.markdown).toContain("Failure avoidance");
    const bounded = packet([row], Math.ceil(full.injectedContext.markdown.length / 4) - 1);
    expect(bounded.injectedContext.markdown).not.toContain("Failure avoidance");
    expect(bounded.sourceMemoryIds).toEqual([]);
    expect(bounded.droppedDueToBudget).toEqual([expect.objectContaining({ id: "avoidance", kind: "policy" })]);
  });

  it("does not report a shared retained source as dropped", () => {
    const rows = [skill("large", "very long guide ".repeat(1000)), skill("small", "Small guide")];
    rows[0]!.hit.memberMemoryIds = ["shared", "large-only"];
    rows[1]!.hit.memberMemoryIds = ["shared"];
    const bounded = packet(rows, 800);
    expect(bounded.sourceMemoryIds).toEqual(["shared"]);
    expect(bounded.droppedDueToBudget.map(item => item.id)).toEqual(["large-only"]);
  });

  it("preserves fixed task instructions at zero budget but excludes recalled sources", () => {
    const query = "You need to fix a bug in the example repository.\n\n## Issue Description\nA lookup filter subquery returns too many columns because annotations leak into the select list projection.";
    const fixed = packet([], 10000, query);
    expect(fixed.injectedContext.markdown).toContain("Repository repair task protocol");
    const bounded = packet([skill("long", "guide ".repeat(2000))], 0, query);
    expect(bounded.injectedContext.markdown).toBe(fixed.injectedContext.markdown);
    expect(bounded.sourceMemoryIds).toEqual([]);
    expect(bounded.droppedDueToBudget.map(item => item.id)).toEqual(["long"]);
    const allowed = packet([skill("short", "Short guide")], 800, query);
    expect(allowed.sourceMemoryIds).toEqual(["short"]);
    expect(Math.ceil((allowed.injectedContext.markdown.length - fixed.injectedContext.markdown.length) / 4)).toBeLessThanOrEqual(800);
  });
});
