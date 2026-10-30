import { traceMetaFromMemory } from "../../src/algorithm/plugin-algorithms.js";
import type { EvolutionJobRecord } from "../../src/storage/repositories.js";
import { MemoryDb } from "../../src/storage/db.js";
import { Repositories } from "../../src/storage/repositories.js";
import { SkillPipeline } from "../../src/service/evolution/skill-pipeline.js";
import { DEFAULT_MEMMY_CONFIG } from "../../src/config/index.js";
import { afterEach, describe, expect, it } from "vitest";
import { revisedL2Memory, l2ContentRevision, l2SupportRelation } from "../../src/service/evolution/l2-content-revision.js";
import { validateL2ExtractionResult, type NewL2Lesson } from "../../src/service/evolution/l2-extraction-contract.js";
import type { MemoryRow } from "../../src/types.js";

const lesson: NewL2Lesson = { type: "principle", title: "Completion", applicability: "Async work", content: "Submission is not completion.", verification: "", exclusions: "" };
const target = new Map([["p", 3]]);
const revise = { operation: "revise", l1_ids: ["l1"], target_l2: { id: "p", version: 3 }, revised_l2: lesson };
describe("L2 content revision", () => {
  it("accepts a complete revision and rejects legacy refutation, empty content and conflicting evidence", () => {
    expect(validateL2ExtractionResult({ operations: [revise] }, ["l1"], target)).toEqual([revise]);
    for (const operations of [
      [{ operation: "refute", l1_ids: ["l1"], target_l2: revise.target_l2 }],
      [{ ...revise, revised_l2: null }],
      [{ ...revise, revised_l2: { ...lesson, content: " " } }],
      [revise, { operation: "support", l1_ids: ["l1"], target_l2: revise.target_l2 }],
      [revise, revise]
    ]) expect(() => validateL2ExtractionResult({ operations }, ["l1"], target)).toThrow();
  });

  it("separates current evidence and statistics from historical successful content", () => {
    const memory = { id: "p", version: 3, status: "activated", tags: ["policy", "check"], info: {},
      properties: { internal_info: { policy: { status: "active", support: 20, gain: 0.9,
        successful_source_trace_ids: ["old"], source_trace_ids: ["old"], source_episode_ids: ["old-episode"],
        decision_guidance: { preference: ["old rule"] } } } } } as unknown as MemoryRow;
    const updated = revisedL2Memory(memory, lesson, ["new"], ["new-episode"], "now");
    expect(l2ContentRevision(memory)).toBe(1);
    expect(l2ContentRevision(updated)).toBe(2);
    expect(l2SupportRelation(updated)).toBe("supports:r2");
    expect(updated.id).toBe(memory.id);
    expect(updated.properties.internal_info.policy).toMatchObject({ status: "candidate", gain: 0,
      source_trace_ids: ["new"], source_episode_ids: ["new-episode"], successful_source_trace_ids: [], skill_eligible: false,
      procedure: lesson.content, trigger: lesson.applicability, lesson_type: "principle" });
    expect((memory.properties.internal_info.policy as Record<string, unknown>).gain).toBe(0.9);
    expect(updated.tags).not.toContain("check");
  });
});

describe("revision persistence and dependants", () => {
  let db: MemoryDb | undefined;
  afterEach(() => db?.close());
  function setup() {
    db = new MemoryDb({ path: ":memory:" });
    const repos = new Repositories(db.db);
    const base = { id: "p", userId: "u", timeline: "2026-10-30T00:00:00Z", memoryLayer: "L2", memoryType: "LongTermMemory",
      status: "activated", visibility: "private", memoryValue: "old", tags: [], info: {}, version: 1,
      createdAt: "2026-10-30T00:00:00Z", updatedAt: "2026-10-30T00:00:00Z",
      properties: { internal_info: { memory_layer: "L2", policy: { status: "active", title: "old", procedure: "old", content_revision: 2 } } } } as MemoryRow;
    repos.memories.insert(base);
    return { repos, base };
  }
  it("rejects stale CAS without changing content or version", () => {
    const { repos, base } = setup();
    repos.memories.update({ ...base, memoryValue: "concurrent change" });
    expect(() => repos.memories.updateIfVersion({ ...base, memoryValue: "stale" }, 1)).toThrow("version changed");
    expect(repos.memories.get("p")).toMatchObject({ version: 2, memoryValue: "concurrent change" });
  });
  it("suspends only generated dependants while preserving their steps and source IDs", () => {
    const { repos, base } = setup();
    for (const [id, sources, generated] of [["derived", ["p"], true], ["direct", [], true], ["external", ["p"], false]] as const) {
      repos.memories.insert({ ...base, id, memoryLayer: "Skill", memoryType: "SkillMemory", memoryValue: "original steps",
        properties: { internal_info: { memory_layer: "Skill", generated_by_memory_base: generated,
          skill: { name: id, status: "active", source_policy_ids: [...sources], procedure_json: { steps: [{ title: "Keep me" }] } } } } });
    }
    const pipeline = new SkillPipeline({ repos, config: DEFAULT_MEMMY_CONFIG,
      namespaceIdFromMemory: () => "test", enqueueJob: () => ({}) } as unknown as ConstructorParameters<typeof SkillPipeline>[0]);
    pipeline.suspendForPolicyRevision("p", base.updatedAt);
    expect(repos.memories.get("derived")).toMatchObject({ status: "archived", memoryValue: "original steps",
      properties: { internal_info: { skill: { status: "suspended", source_policy_ids: ["p"],
        pending_policy_revisions: { p: 2 }, procedure_json: { steps: [{ title: "Keep me" }] } } } } });
    expect(repos.memories.get("direct")?.version).toBe(1);
    expect(repos.memories.get("external")?.version).toBe(1);
  });
  it.each(["apply", "skip", "stale", "evidence-stale", "failure", "independent-source"])("handles dependent Skill revision safely: %s", async (scenario) => {
    const { repos, base } = setup();
    const policy = revisedL2Memory(base, { ...lesson, title: "Check totals", content: "Compare unrounded totals before export." }, ["revision-evidence"], [], base.updatedAt);
    repos.memories.update(policy);
    repos.memories.insert({ ...base, id: "evidence", memoryLayer: "L1", memoryValue: "Compare unrounded totals before export.",
      properties: { internal_info: { memory_layer: "L1", trace: { userText: "Check totals before export", agentText: "Compare unrounded totals and verify export totals.", summary: "Check totals", value: 1 } } } });
    repos.memories.insert({ ...base, id: "revision-evidence", memoryLayer: "L1", memoryValue: "Use raw precision to verify totals.",
      properties: { internal_info: { memory_layer: "L1", trace: { userText: "Correct rounded totals", agentText: "Compare unrounded totals before export with inspect_totals.", summary: "Correct totals", value: -1,
        tool_calls: [{ name: "inspect_totals", arguments: {}, result: "Original precision verified" }] } } } });
    repos.memories.insert({ ...base, id: "derived", memoryLayer: "Skill", memoryType: "SkillMemory", memoryValue: "Compare rounded totals",
      properties: { internal_info: { memory_layer: "Skill", generated_by_memory_base: true,
        skill: { name: "check_totals", status: "active", source_policy_ids: ["p"], evidence_anchor_ids: ["evidence"],
          trials_attempted: 10, trials_passed: 10, procedure_json: { summary: "Compare rounded totals", steps: [{ title: "Old totals", body: "Compare rounded totals" }, ...(scenario === "independent-source" ? [{ title: "Archive export", body: "Keep the export receipt", supportingPolicyIds: ["other-policy"] }] : [])] } } } } });
    const jobs: EvolutionJobRecord[] = [];
    let input: Record<string, any> = {};
    const pipeline = new SkillPipeline({ repos, config: DEFAULT_MEMMY_CONFIG, traceMeta: traceMetaFromMemory,
      namespaceIdFromMemory: () => "test", enqueueJob: (job: unknown) => { jobs.push(job as EvolutionJobRecord); return job; },
      skillLlm: { isConfigured: () => true, completeJson: async (messages: Array<{ content: string }>) => {
        input = JSON.parse(messages[2]!.content);
        if (scenario === "skip") return { skip: true };
        if (scenario === "failure") throw new Error("provider temporarily unavailable");
        if (scenario === "stale") {
          const changed = repos.memories.get("p")!;
          repos.memories.update({ ...changed, memoryValue: "Concurrent edit" });
        }
        if (scenario === "evidence-stale") {
          const changed = repos.memories.get("revision-evidence")!;
          repos.memories.update({ ...changed, memoryValue: "Source changed" });
        }
        return { name: "check_totals", retrieval_blurb: "Check totals before export", trigger_context: "Check totals before export",
          summary: "Compare unrounded totals and verify export totals", preconditions: [], parameters: [],
          steps: [{ title: "Compare totals", body: "Compare unrounded totals before export" }, { title: "Verify totals", body: "Verify export totals" }],
          tools: ["inspect_totals"], examples: [], tags: [], changed_sections: ["steps"] };
      } } } as unknown as ConstructorParameters<typeof SkillPipeline>[0]);
    pipeline.suspendForPolicyRevision("p", base.updatedAt);
    expect(jobs).toHaveLength(1);
    if (scenario === "failure") {
      await expect(pipeline.crystallizeSkill(jobs[0]!)).rejects.toThrow("provider temporarily unavailable");
      expect(repos.memories.get("derived")!.memoryValue).toBe("Compare rounded totals");
      expect(repos.memories.get("derived")!.status).toBe("archived");
      return;
    }
    if (scenario === "evidence-stale") {
      await expect(pipeline.crystallizeSkill(jobs[0]!)).rejects.toThrow("evidence changed");
      return;
    }
    if (scenario === "stale") {
      await expect(pipeline.crystallizeSkill(jobs[0]!)).rejects.toThrow("source changed");
      expect(repos.memories.get("derived")!.memoryValue).toBe("Compare rounded totals");
      return;
    }
    await pipeline.crystallizeSkill(jobs[0]!);
    if (scenario === "skip") {
      expect(repos.memories.get("derived")!.memoryValue).toBe("Compare rounded totals");
      expect(repos.memories.get("derived")!.status).toBe("archived");
      return;
    }
    expect(input.policy.lesson_type).toBe("principle");
    expect(input.policy.content_revision).toBe(3);
    expect(input.revision_evidence).toEqual(expect.arrayContaining([expect.objectContaining({ id: "revision-evidence", role: expect.stringContaining("not a successful") })]));
    expect(input.evidence_tools).toContain("inspect_totals");
    const saved = repos.memories.get("derived")!;
    expect(saved.memoryValue).toContain("Compare unrounded totals");
    expect(saved.memoryValue).not.toContain("Compare rounded totals");
    expect(saved.memoryValue).not.toContain("Old totals");
    expect(input.replace_policy_steps).toBe(true);
    if (scenario === "independent-source") expect(saved.memoryValue).toContain("Keep the export receipt");
    expect(saved.properties.internal_info.skill).toMatchObject({ status: "suspended", trials_attempted: 0,
      trials_passed: 0, source_policy_ids: ["p"], evidence_anchor_ids: [] });
    const version = saved.version;
    await pipeline.crystallizeSkill(jobs[0]!);
    expect(repos.memories.get("derived")!.version).toBe(version);
  });

});
