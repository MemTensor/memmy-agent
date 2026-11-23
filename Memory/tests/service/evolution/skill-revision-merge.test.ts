import { DEVICE_MEMORY_OWNER } from "../../../src/service/namespace/memory-owner.js";
import { afterEach, describe, expect, it } from "vitest";
import type { LlmClient } from "../../../src/model/types.js";
import { Repositories, type EvolutionJobRecord } from "../../../src/storage/repositories.js";
import { SkillPipeline } from "../../../src/service/evolution/skill-pipeline.js";
import { DEFAULT_MEMMY_CONFIG } from "../../../src/config/index.js";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";
import { insertActivePolicyMemory, insertActiveSkillMemoryForTest, makeTraceEligibleForL2, upsertMemoryVectorForTest } from "../../fixtures/evolution-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();
afterEach(cleanup);
const guide = "Run pytest, inspect the failure, retry after fixing issue, then verify the result.";
const oldStep = "Obsolete instruction: retry pytest blindly before inspecting the failure.";
const newStep = "Inspect the pytest failure before retrying the exact failing test.";

describe("pending L2 revisions and compatible Skill merges", () => {
  it.each(["failure", "skip"] as const)("defers another source's merge after revision %s, then resumes after repair", async outcome => {
    let mode: "failure" | "skip" | "success" = outcome;
    let calls = 0;
    const llm: LlmClient = {
      config: DEFAULT_MEMMY_CONFIG.evolution, isConfigured: () => true, complete: async () => "{}",
      status: () => ({ provider: "host", model: "test", configured: true, remote: false }),
      completeJson: async <T extends Record<string, unknown>>() => {
        calls++;
        if (mode === "failure") throw new Error("revision provider unavailable");
        if (mode === "skip") return { skip: true } as unknown as T;
        return { name: "pytest_retry_workflow", retrieval_blurb: guide, trigger_context: guide,
          summary: guide, preconditions: [], parameters: [],
          steps: [{ title: "Inspect failure", body: newStep }, { title: "Verify result", body: "Verify that pytest passes after the retry." }],
          tools: [], examples: [], tags: ["python", "pytest"], changed_sections: ["steps"] } as unknown as T;
      }
    };
    const { db, service } = createTestService({ skillLlm: llm });
    const repos = new Repositories(db.db), at = new Date().toISOString();
    const common = { userId: DEVICE_MEMORY_OWNER, sessionId: "s", agentId: "codex", appId: "workspace", profileId: "default" };
    repos.memories.insert({ id: "evidence", userId: DEVICE_MEMORY_OWNER, sessionId: "s", agentId: "codex", appId: "workspace",
      timeline: at, memoryLayer: "L1", memoryType: "LongTermMemory", status: "activated", visibility: "private",
      memoryValue: `${newStep} Verify that pytest passes after the retry.`, tags: ["python", "pytest"], info: { profile_id: "default" },
      properties: { internal_info: { memory_layer: "L1", memory_kind: "trace", trace: {
        summary: guide, userText: "Inspect the pytest failure and retry the exact failing test", agentText: `${newStep} Verify that pytest passes after the retry.`, value: 1
      } } }, version: 1, createdAt: at, updatedAt: at });
    makeTraceEligibleForL2(db, "evidence");
    for (const id of ["policy-a", "policy-b"]) insertActivePolicyMemory(db, { ...common, id, sourceTraceId: "evidence", sourceEpisodeId: "episode" });
    const policy = repos.memories.get("policy-a")!;
    repos.memories.update({ ...policy, properties: { ...policy.properties, internal_info: { ...policy.properties.internal_info,
      policy: { ...(policy.properties.internal_info.policy as Record<string, unknown>), content_revision: 2, procedure: newStep }
    } } });
    for (const id of ["a", "b"]) insertActiveSkillMemoryForTest(db, { ...common, id: `skill-${id}`,
      sourcePolicyIds: [`policy-${id}`], evidenceAnchorIds: ["evidence"], tags: ["skill", "python", "pytest"],
      name: "pytest_retry_workflow", invocationGuide: guide,
      procedureJson: { summary: guide, steps: [{ title: id === "a" ? "Obsolete retry" : "Verify result",
        body: id === "a" ? oldStep : "Verify that pytest passes after the retry.", supportingPolicyIds: [`policy-${id}`] }] }
    });
    const revisionJobs: EvolutionJobRecord[] = [];
    const suspension = new SkillPipeline({ repos, config: DEFAULT_MEMMY_CONFIG, namespaceIdFromMemory: () => "test",
      enqueueJob: (job: Parameters<ConstructorParameters<typeof SkillPipeline>[0]["enqueueJob"]>[0]) => { revisionJobs.push(job as EvolutionJobRecord); return job as EvolutionJobRecord; }
    } as unknown as ConstructorParameters<typeof SkillPipeline>[0]);
    suspension.suspendForPolicyRevision("policy-a", at);
    const suspended = repos.memories.get("skill-a")!;
    const active = repos.memories.get("skill-b")!;
    expect(suspended.properties.internal_info.skill).toMatchObject({ status: "suspended", pending_policy_revisions: { "policy-a": 2 } });
    let sequence = 0;
    async function run(policyId: string, payload: Record<string, unknown> = {}) {
      const id = `review-job-${++sequence}`;
      repos.runtime.enqueueJob({ id, jobType: "skill_crystallization", userId: DEVICE_MEMORY_OWNER, targetMemoryId: policyId, payload,
        status: "queued", attempts: 0, maxAttempts: 1, createdAt: at, updatedAt: at });
      return service.runWorkerOnce(1, { targetMemoryIds: [policyId] });
    }
    function assertUnchanged() {
      expect(repos.memories.get("skill-a")).toEqual(suspended);
      expect(repos.memories.get("skill-b")).toEqual(active);
      expect(JSON.stringify(repos.memories.get("skill-b"))).not.toContain(oldStep);
      expect(db.db.prepare("SELECT 1 FROM memory_change_log WHERE change_type = 'skill_compatible_merge'").get()).toBeUndefined();
    }
    // The ordinary job belongs to B; the pending revision belongs to merge alias A.
    await run("policy-b");
    assertUnchanged();
    expect(calls).toBe(0);
    // A targeted fan-out must not bypass the pending check either.
    await run("policy-a", { skillId: "skill-a", reason: "policy.skill_fanout" });
    assertUnchanged();
    expect(calls).toBe(0);
    const failed = await run("policy-a", revisionJobs[0]!.payload);
    expect(failed).toMatchObject(outcome === "failure" ? { failed: 1 } : { succeeded: 1 });
    expect(calls).toBeGreaterThan(0);
    await run("policy-b");
    assertUnchanged();

    mode = "success";
    expect(await run("policy-a", revisionJobs[0]!.payload)).toMatchObject({ succeeded: 1, failed: 0 });
    const repaired = repos.memories.get("skill-a")!;
    expect(repaired.status).toBe("archived");
    expect(JSON.stringify(repaired.properties.internal_info.skill)).not.toContain(oldStep);
    expect(JSON.stringify(repaired.properties.internal_info.skill)).toContain(newStep);
    // Repair clears obsolete embeddings. Re-enter via the queued validation job
    // before representing the fresh embedding with the same deterministic fixture.
    expect(await service.runWorkerOnce(1, { targetMemoryIds: ["policy-a"] })).toMatchObject({ succeeded: 1, failed: 0 });
    upsertMemoryVectorForTest(db, "skill-a", "vec", [1, 0, 0]);
    expect(await run("policy-b")).toMatchObject({ succeeded: 1, failed: 0 });
    const merged = repos.memories.get("skill-b")!;
    expect(merged.properties.internal_info.skill).toMatchObject({ source_policy_ids: expect.arrayContaining(["policy-a", "policy-b"]) });
    expect(merged.properties.internal_info.skill).not.toHaveProperty("pending_policy_revisions");
    expect(JSON.stringify(merged.properties.internal_info.skill)).not.toContain(oldStep);
    expect(JSON.stringify(merged.properties.internal_info.skill)).toContain(newStep);
    expect(repos.memories.get("skill-a")!.properties.internal_info).toHaveProperty("merged_into_skill_id", "skill-b");
  });
});
