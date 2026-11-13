import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LlmClient, LlmMessage, MemmyConfig } from "../../../src/index.js";
import { policyMetaFromMemory, skillMetaFromMemory } from "../../../src/algorithm/plugin-algorithms.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { upsertL2Candidate } from "../../../src/service/evolution/l2-candidate-service.js";
import { assignedEpisodeId, createMemoryServiceFixture, LEGACY_TEST_CONFIG, settleCaptureAssignments } from "../../fixtures/memory-service-fixture.js";
import { insertActivePolicyMemory, insertActiveSkillMemoryForTest, insertTracePolicyLinkForTest,
  makeTraceEligibleForL2, queueSkillCrystallizationJobForTest } from "../../fixtures/evolution-fixture.js";
import { createNoToolSkillLlm } from "./evolution-llm-stubs.js";

const fixture = createMemoryServiceFixture();
afterEach(fixture.cleanup);
const OWNER_A = "retained-skill-owner-a";
const OWNER_B = "retained-policy-owner-b";
const PROFILE = "merge-maintenance-profile";
const PROJECT = "merge-maintenance-project";
const GUIDE = "Run pytest, inspect the failure, retry after fixing issue, then verify the result.";
const REVISED = "Inspect the exact pytest failure before applying the fix and rerun that focused test.";
type Scope = { projectId: string; profileId: string };

async function setup(options: { sameOwner?: boolean; mismatch?: "project" | "profile" } = {}) {
  const state = { reward: 0.9, revision: false, calls: [] as string[],
    l2Response: undefined as ((payload: Record<string, unknown>) => Record<string, unknown>) | undefined };
  const base = createNoToolSkillLlm();
  const model: LlmClient = {
    ...base,
    async completeJson<T extends Record<string, unknown>>(messages: LlmMessage[],
      options: Parameters<LlmClient["completeJson"]>[1]): Promise<T> {
      state.calls.push(options.operation);
      if (options.operation === "reward.reward.r_human.v7") return {
        goal_achievement: state.reward, process_quality: state.reward, user_satisfaction: state.reward,
        reason: "fixed task verdict"
      } as unknown as T;
      if (options.operation === "l2.extraction.v2") {
        const payload = JSON.parse(messages.find(message => message.role === "user")!.content) as Record<string, unknown>;
        return (state.l2Response?.(payload) ?? { operations: [] }) as T;
      }
      if (options.operation.startsWith("skill.")) {
        return {
          name: "pytest_retry_workflow", retrieval_blurb: GUIDE, trigger_context: GUIDE,
          summary: state.revision ? REVISED : GUIDE, parameters: [], preconditions: [], examples: [], tools: [],
          steps: [{ title: "Inspect failure", body: state.revision ? REVISED : "Read the pytest failure output before applying the targeted fix." },
            { title: "Verify result", body: "Rerun the exact focused pytest test and confirm it passes." }],
          tags: ["python", "pytest"], changed_sections: ["steps"]
        } as unknown as T;
      }
      return base.completeJson<T>(messages, options);
    }
  };
  const config: MemmyConfig = structuredClone(LEGACY_TEST_CONFIG);
  config.algorithm.capture.embedAfterCapture = false;
  config.algorithm.capture.synthReflection = false;
  config.algorithm.skill.directFromTrace = false;
  config.algorithm.skill.cooldownMs = 0;
  config.algorithm.skill.minSupport = 1;
  config.algorithm.skill.minGain = 0.001;
  config.algorithm.l2Induction.minEpisodesForActivation = 1;
  config.algorithm.l2Induction.minGain = 0.001;
  config.algorithm.l2Induction.useLlm = false;
  config.algorithm.l3Abstraction.useLlm = false;
  config.algorithm.feedback.valueDistributionRepairEnabled = false;
  const { db, service } = fixture.createTestService({ config, llm: model, skillLlm: model, configLoader: () => ({ config }) });
  const repos = new Repositories(db.db);
  const scopeB = { profileId: PROFILE, projectId: PROJECT };
  const scopeA = { profileId: options.mismatch === "profile" ? "other-profile" : PROFILE,
    projectId: options.mismatch === "project" ? "other-project" : PROJECT };
  const ownerB = options.sameOwner ? OWNER_A : OWNER_B;
  async function capture(id: string, owner: string, scope: Scope) {
    const session = service.openSession({ namespace: { source: "codex", ...scope } });
    const result = await service.completeTurn(id, { sessionId: session.sessionId, episodeId: `episode-${id}`,
      query: GUIDE, answer: `${GUIDE} ${REVISED}` });
    await settleCaptureAssignments(service);
    const episodeId = assignedEpisodeId(service, result);
    makeTraceEligibleForL2(db, result.l1MemoryId);
    repos.runtime.closeEpisode(episodeId, { closeReason: "finalized" });
    repos.runtime.updateEpisodeReward(episodeId, { rTask: 0.9, rewardDetail: { source: "historical-success" } });
    // Model actual retained source records; do not forge any Skill -> Policy edge.
    for (const [table, rowId] of [["sessions", session.sessionId], ["episodes", episodeId],
      ["raw_turns", result.rawTurnId], ["memories", result.l1MemoryId]]) {
      db.db.prepare(`UPDATE ${table} SET user_id = ? WHERE id = ?`).run(owner, rowId);
    }
    return { ...result, sessionId: session.sessionId, episodeId, owner, scope };
  }
  const a = await capture("source-a", OWNER_A, scopeA);
  const b = await capture("source-b", ownerB, scopeB);
  for (const [id, source] of [["policy-a", a], ["policy-b", b]] as const) {
    insertActivePolicyMemory(db, { id, userId: source.owner, sessionId: source.sessionId, agentId: "codex",
      appId: source.scope.projectId, profileId: source.scope.profileId,
      sourceTraceId: source.l1MemoryId, sourceEpisodeId: source.episodeId });
    insertTracePolicyLinkForTest(db, { userId: source.owner, l1MemoryId: source.l1MemoryId, l2MemoryId: id });
    db.db.prepare("UPDATE memories SET info_json = json_set(info_json, '$.project_id', ?) WHERE id = ?")
      .run(source.scope.projectId, id);
  }
  insertActiveSkillMemoryForTest(db, { id: "existing-skill-a", userId: OWNER_A,
    sessionId: a.sessionId, agentId: "codex", appId: scopeA.projectId, profileId: scopeA.profileId,
    sourcePolicyIds: ["policy-a"], evidenceAnchorIds: [a.l1MemoryId], tags: ["skill", "python", "pytest"],
    name: "pytest_retry_workflow", invocationGuide: GUIDE,
    procedureJson: { summary: GUIDE, steps: [{ title: "Original A step", body: GUIDE, supportingPolicyIds: ["policy-a"] }] } });
  db.db.prepare("UPDATE memories SET info_json = json_set(info_json, '$.project_id', ?) WHERE id = 'existing-skill-a'")
    .run(scopeA.projectId);
  db.db.prepare("UPDATE evolution_jobs SET status = 'succeeded'").run();
  let sequence = 0;
  async function reward(value: number) {
    state.reward = value;
    repos.runtime.closeEpisode(b.episodeId, { closeReason: "finalized" });
    const id = `merge-reward-${++sequence}`, at = new Date().toISOString();
    repos.runtime.enqueueJob({ id, jobType: "reward", userId: ownerB, sessionId: b.sessionId,
      episodeId: b.episodeId, targetMemoryId: b.l1MemoryId,
      payload: { l1MemoryId: b.l1MemoryId, polarity: value < 0 ? "negative" : "positive", magnitude: 1, downstreamScheduled: true },
      status: "queued", attempts: 0, maxAttempts: 1, createdAt: at, updatedAt: at });
    await service.runWorkerOnce(1, { targetMemoryIds: [b.l1MemoryId] });
    expect(repos.runtime.getJob(id)).toMatchObject({ status: "succeeded" });
    expect(repos.runtime.getEpisode(b.episodeId)).toMatchObject({ status: "closed", rTask: value });
    // Observe this worker's statistics effects independently of later generation.
    db.db.prepare("UPDATE evolution_jobs SET status = 'succeeded'").run();
  }
  async function rebuild() {
    const id = `merge-rebuild-${++sequence}`;
    queueSkillCrystallizationJobForTest(db, { id, userId: ownerB, sessionId: b.sessionId,
      episodeId: b.episodeId, policyId: "policy-b" });
    await service.runWorkerOnce(1, { targetMemoryIds: ["policy-b"] });
    expect(repos.runtime.getJob(id)).toMatchObject({ status: "succeeded" });
  }
  async function acceptB() {
    expect(skillMetaFromMemory(repos.memories.get("existing-skill-a")!)!.sourcePolicyIds).toEqual(["policy-a"]);
    await reward(0.9);
    const previous = repos.memories.get("existing-skill-a")!;
    await rebuild();
    const accepted = repos.memories.get("existing-skill-a")!;
    expect(state.calls).toContain("skill.rebuild.v6");
    expect(accepted.userId).toBe(OWNER_A);
    expect(accepted.version).toBeGreaterThan(previous.version);
    expect(skillMetaFromMemory(accepted)!.sourcePolicyIds.slice().sort()).toEqual(["policy-a", "policy-b"]);
    expect(repos.memories.list({ memoryLayer: "Skill" }, -1)).toHaveLength(1);
    return accepted;
  }
  return { db, service, repos, config, state, a, b, ownerB, reward, rebuild, acceptB };
}

describe("MEMMY-647 v1.2.8 accepted Skill rebuild edges remain maintainable", () => {
  it.each([true, false])("keeps reward withdrawal and restoration after a real rebuild (same historical owner: %s)", async sameOwner => {
    const c = await setup({ sameOwner });
    const accepted = await c.acceptB();
    const policyABefore = c.repos.memories.get("policy-a");
    const sourceABefore = c.repos.memories.get(c.a.l1MemoryId);
    const snapshot = (phase: string) => {
      const value = { policy: c.repos.memories.get("policy-b"), skill: c.repos.memories.get("existing-skill-a") };
      if (process.env.MEMMY647_EVIDENCE_DIR) {
        mkdirSync(process.env.MEMMY647_EVIDENCE_DIR, { recursive: true });
        writeFileSync(join(process.env.MEMMY647_EVIDENCE_DIR, `merge-reward-${sameOwner}-${phase}.json`), JSON.stringify(value, null, 2) + "\n");
      }
      return value;
    };
    const successful = snapshot("accepted");
    await c.reward(-0.9);
    expect(policyMetaFromMemory(c.repos.memories.get("policy-b")!)!.support).toBe(0);
    const withdrawn = snapshot("withdrawn");
    const contribution = (memory: NonNullable<typeof successful.skill>) => {
      const history = memory.properties.internal_info.skill_revision_history as { events: Array<{ type: string; policyId?: string; disabled?: boolean }> };
      return history.events.filter(event => event.type === "crystallization" && event.policyId === "policy-b");
    };
    expect(contribution(successful.skill!)).toHaveLength(1);
    expect.soft(contribution(withdrawn.skill!), "accepted Policy B's existing contribution must be withdrawn in the retained Skill")
      .toEqual([expect.objectContaining({ disabled: true })]);
    await c.reward(0.9);
    const restored = skillMetaFromMemory(c.repos.memories.get("existing-skill-a")!)!;
    expect(policyMetaFromMemory(c.repos.memories.get("policy-b")!)!.support).toBe(1);
    const recovered = snapshot("restored");
    expect.soft(contribution(recovered.skill!), "restored contribution must reactivate the same existing slot")
      .toEqual(contribution(successful.skill!));
    expect(restored.memory.userId).toBe(OWNER_A);
    expect(restored.sourcePolicyIds.slice().sort()).toEqual(["policy-a", "policy-b"]);
    expect(c.repos.memories.get("policy-a")).toEqual(policyABefore);
    expect(c.repos.memories.get(c.a.l1MemoryId)).toEqual(sourceABefore);
  });

  it.each([true, false])("suspends and repairs an accepted source content revision (same historical owner: %s)", async sameOwner => {
    const c = await setup({ sameOwner });
    await c.acceptB();
    const before = c.repos.memories.get("existing-skill-a")!;
    const policyBefore = c.repos.memories.get("policy-b")!;
    c.config.algorithm.l2Induction.mode = "unified";
    c.config.algorithm.l2Induction.useLlm = true;
    c.service.reloadConfig({ restartFailedProcessing: false });
    const lesson = { type: "check", title: "Inspect pytest before retry", applicability: "When pytest fails",
      content: REVISED, verification: "Confirm the exact pytest test passes.", exclusions: "" };
    c.state.l2Response = () => ({ operations: [{ operation: "revise", l1_ids: [c.b.l1MemoryId],
      target_l2: { id: policyBefore.id, version: policyBefore.version }, revised_l2: lesson }] });
    expect(upsertL2Candidate(c.repos, { sourceMemoryId: c.b.l1MemoryId, userId: c.ownerB, route: "negative" })).not.toBeNull();
    const at = new Date().toISOString();
    c.repos.runtime.enqueueJob({ id: "merge-content-revision", jobType: "l2_induction", userId: c.ownerB,
      sessionId: c.b.sessionId, episodeId: c.b.episodeId, targetMemoryId: c.b.l1MemoryId, payload: { unified: true },
      status: "queued", attempts: 0, maxAttempts: 1, createdAt: at, updatedAt: at });
    await c.service.runWorkerOnce(1, { targetMemoryIds: [c.b.l1MemoryId] });
    expect(c.repos.runtime.getJob("merge-content-revision")).toMatchObject({ status: "succeeded" });
    expect(c.repos.memories.get("policy-b")!.properties.internal_info.policy).toMatchObject({ content_revision: 2, procedure: REVISED });
    const suspended = c.repos.memories.get("existing-skill-a")!;
    expect(suspended.userId).toBe(OWNER_A);
    expect(suspended.properties.internal_info.skill).toMatchObject({ status: "suspended", pending_policy_revisions: { "policy-b": 2 } });
    expect((suspended.properties.internal_info.skill as Record<string, unknown>).procedure_json)
      .toEqual((before.properties.internal_info.skill as Record<string, unknown>).procedure_json);
    c.state.revision = true;
    const jobs = c.repos.runtime.listJobs("queued", -1).filter(job => job.payload.reason === "l2.content_revised" && job.payload.skillId === suspended.id);
    expect(jobs).toHaveLength(1);
    await c.service.runWorkerOnce(1, { targetMemoryIds: ["policy-b"] });
    expect(c.repos.runtime.getJob(jobs[0]!.id)).toMatchObject({ status: "succeeded" });
    const repaired = c.repos.memories.get(suspended.id)!;
    expect(repaired.userId).toBe(OWNER_A);
    expect(JSON.stringify((repaired.properties.internal_info.skill as Record<string, unknown>).procedure_json)).toContain(REVISED);
    expect(repaired.properties.internal_info.skill).toMatchObject({ status: "suspended", eta: 0, support: 0 });
  });

  it.each(["project", "profile"] as const)("does not create a cross-%s edge merely because workflows match", async mismatch => {
    const c = await setup({ mismatch });
    const before = c.repos.memories.get("existing-skill-a")!;
    await c.reward(0.9);
    await c.rebuild();
    expect(c.repos.memories.get("existing-skill-a")).toEqual(before);
    expect(skillMetaFromMemory(c.repos.memories.get("existing-skill-a")!)!.sourcePolicyIds).toEqual(["policy-a"]);
    expect(c.repos.memories.list({ memoryLayer: "Skill" }, -1)).toHaveLength(2);
  });
});
