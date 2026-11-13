import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMMY_CONFIG, type MemmyConfig, type LlmClient, type LlmMessage } from "../../../src/index.js";
import { policyMetaFromMemory, skillMetaFromMemory, traceMetaFromMemory } from "../../../src/algorithm/plugin-algorithms.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { MemoryDb } from "../../../src/storage/db.js";
import { DEVICE_MEMORY_OWNER } from "../../../src/service/namespace/memory-owner.js";
import { listL2Candidates, upsertL2Candidate } from "../../../src/service/evolution/l2-candidate-service.js";
import { policyRevisionHistory } from "../../../src/service/evolution/revision-stats.js";
import { assignedEpisodeId, settleCaptureAssignments, LEGACY_TEST_CONFIG, createCapturingEmbedder, createMemoryServiceFixture, runWorkerRounds } from "../../fixtures/memory-service-fixture.js";
import { insertActivePolicyMemory, insertActiveSkillMemoryForTest, insertTracePolicyLinkForTest, makeTraceEligibleForL2, setTraceSignatureAndVectorForTest } from "../../fixtures/evolution-fixture.js";

// Actual file SQLite + MemoryService/worker/Policy/Skill wiring. Only external
// model and embedding responses are synthetic. Historical owner SQL below
// represents preserved pre-device-owner rows, never a product migration.
const fixture = createMemoryServiceFixture();
const LEGACY_OWNER = "historical-account";
const PROFILE = "memmy647-v128";
let sequence = 0;
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.parse("2026-11-12T02:00:00Z")); sequence = 0; });
afterEach(async () => { await fixture.cleanup(); vi.useRealTimers(); });
function evidence(name: string, value: unknown) {
  const dir = process.env.MEMMY647_EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `v128-${name}.json`), JSON.stringify(value, null, 2) + "\n");
}
function setup() {
  const state = { reward: 0.9, selectedEpisodeId: null as string | null, relation: "new_task", operations: [] as string[], l2Response: undefined as ((payload: Record<string, unknown>) => Record<string, unknown>) | undefined, skillDraft: undefined as Record<string, unknown> | undefined };
  const llm: LlmClient = {
    config: { ...DEFAULT_MEMMY_CONFIG.summary, provider: "host", model: "v128-ownership-fixed" },
    isConfigured: () => true,
    async complete(_messages, options) {
      state.operations.push(options.operation);
      return options.operation.startsWith("episode_title.") ? JSON.stringify({ title: "pytest verification", summary: "Inspect and verify pytest results" }) : "{}";
    },
    async completeJson<T extends Record<string, unknown>>(messages: LlmMessage[], options: { operation: string }): Promise<T> {
      state.operations.push(options.operation);
      let payload: Record<string, unknown> & { steps?: Array<{ idx: number }> } = {};
      try { payload = JSON.parse([...messages].reverse().find(m => m.role === "user")?.content ?? "{}"); } catch { /* capture prompt is text */ }
      let output: Record<string, unknown> = {};
      if (options.operation === "episode.select.v1") output = { episodeId: state.selectedEpisodeId, title: "pytest verification", summary: "Verify pytest" };
      if (options.operation === "relation.classify.v1") output = { relation: state.relation, confidence: 0.99, reason: "synthetic routing" };
      if (options.operation === "capture.summarize") {
        const quote = (messages.find(m => m.role === "user")?.content ?? "").match(/\bUSER:\s*(.*?)\s+ASSISTANT:/)?.[1]?.trim() ?? "";
        output = { l1: { title: "pytest verification", summary: "Run pytest, inspect the failure and verify the corrected result.", evidence: [{ quote, role: "user", kind: "task_outcome" }] }, user: null };
      }
      if (options.operation === "capture.reflection.batch.v13") output = { scores: (payload.steps ?? []).map(step => ({ idx: step.idx, relevance: "PIVOTAL", reason: "verified test work" })) };
      if (options.operation === "reward.reward.r_human.v7") output = { goal_achievement: state.reward, process_quality: state.reward, user_satisfaction: state.reward, reason: "synthetic reward" };
      // Retain the real statistics consumers, but don't create unrelated model-generated text.
      if (options.operation.startsWith("skill.")) output = state.skillDraft ?? { skip: true };
      if (options.operation === "l2.extraction.v2") output = state.l2Response?.(payload) ?? { operations: [] };
      return output as T;
    },
    status: () => ({ provider: "host", model: "v128-ownership-fixed", configured: true, remote: false })
  };
  const config: MemmyConfig = structuredClone(LEGACY_TEST_CONFIG);
  config.algorithm.retrieval.smartSeed = false;
  config.algorithm.retrieval.llmFilterEnabled = false;
  config.algorithm.skill.directFromTrace = false;
  config.algorithm.l2Induction.useLlm = false;
  config.algorithm.l3Abstraction.useLlm = false;
  config.algorithm.feedback.valueDistributionRepairEnabled = false;
  const embedder = createCapturingEmbedder([]);
  embedder.embed = async texts => texts.map(() => [1, 0, 0]);
  embedder.embedOne = async () => [1, 0, 0];
  const options = { llm, skillLlm: llm, config, embedder, configLoader: () => ({ config }) };
  const base = fixture.createTestService(options);
  return { ...base, state, config, options, repos: new Repositories(base.db.db) };
}
type Context = ReturnType<typeof setup>;
async function capture(c: Context, label: string, scope = { profileId: PROFILE, projectId: "project-main" }) {
  c.state.selectedEpisodeId = null; c.state.relation = "new_task";
  const session = c.service.openSession({ namespace: { source: "codex", ...scope, sessionKey: `v128-${++sequence}` } });
  const result = await c.service.completeTurn(`v128-turn-${++sequence}`, { sessionId: session.sessionId,
    query: `${label}: run pytest, inspect the failure, fix it and verify the test suite`,
    answer: "Ran pytest and verified the tests pass.", toolCalls: [{ id: "pytest", name: "run_tests", input: {}, output: { ok: true }, success: true }] });
  await settleCaptureAssignments(c.service); await runWorkerRounds(c.service, 4);
  const episodeId = assignedEpisodeId(c.service, result);
  makeTraceEligibleForL2(c.db, result.l1MemoryId);
  setTraceSignatureAndVectorForTest(c.db, result.l1MemoryId, "python|pytest|_|_", [1, 0, 0]);
  return { ...result, episodeId, sessionId: session.sessionId };
}
type Source = Awaited<ReturnType<typeof capture>>;
function preserveHistoricalSource(c: Context, s: Source) {
  for (const [table, id] of [["sessions", s.sessionId], ["episodes", s.episodeId], ["raw_turns", s.rawTurnId], ["memories", s.l1MemoryId]]) {
    c.db.db.prepare(`UPDATE ${table} SET user_id=? WHERE id=?`).run(LEGACY_OWNER, id);
  }
}
function graph(c: Context, members: Source[], policyOwner: string) {
  const first = members[0]!;
  const common = { sessionId: first.sessionId, agentId: "codex", profileId: PROFILE, appId: "v128-test" };
  insertActivePolicyMemory(c.db, { ...common, id: "ownership-policy", userId: policyOwner, sourceTraceId: first.l1MemoryId, sourceEpisodeId: first.episodeId });
  insertActiveSkillMemoryForTest(c.db, { ...common, id: "ownership-skill", userId: DEVICE_MEMORY_OWNER, sourcePolicyIds: ["ownership-policy"] });
  // Current-content proof carries each source's actual historical/device owner.
  for (const member of members) insertTracePolicyLinkForTest(c.db, { userId: c.repos.memories.get(member.l1MemoryId)!.userId, l1MemoryId: member.l1MemoryId, l2MemoryId: "ownership-policy" });
  for (const id of ["ownership-policy", "ownership-skill"]) c.db.db.prepare("UPDATE memories SET info_json=json_set(info_json,'$.project_id','project-main') WHERE id=?").run(id);
}
async function reward(c: Context, source: Source, value: number) {
  c.state.reward = value;
  c.repos.runtime.closeEpisode(source.episodeId, { closeReason: "finalized" });
  const at = new Date().toISOString(), token = ++sequence;
  // This is the ordinary worker entry. The caller has already scheduled the
  // downstream text-generation phase, so this test observes existing consumers.
  const job = c.repos.runtime.enqueueJob({ id: `v128-reward-${token}`, dedupeKey: `v128-reward-${token}`, jobType: "reward",
    userId: c.repos.memories.get(source.l1MemoryId)!.userId, sessionId: source.sessionId, episodeId: source.episodeId, targetMemoryId: source.l1MemoryId,
    payload: { l1MemoryId: source.l1MemoryId, polarity: value < 0 ? "negative" : "positive", magnitude: 1, downstreamScheduled: true },
    status: "queued", attempts: 0, maxAttempts: 1, createdAt: at, updatedAt: at });
  for (let i = 0; i < 30 && c.repos.runtime.getJob(job.id)?.status === "queued"; i++) {
    vi.setSystemTime(Date.now() + 1000); await c.service.runWorkerOnce(1);
  }
  expect(c.repos.runtime.getJob(job.id), "real reward worker must complete").toMatchObject({ status: "succeeded" });
  expect(c.repos.runtime.getEpisode(source.episodeId)).toMatchObject({ status: "closed", rTask: value });
}
async function revise(c: Context, source: Source, value: number) {
  c.state.reward = value; c.state.selectedEpisodeId = source.episodeId; c.state.relation = "revision";
  const result = await c.service.completeTurn(`v128-revision-${++sequence}`, { sessionId: source.sessionId, episodeId: source.episodeId,
    query: "Recheck this same pytest task: the result must be revised after inspecting the test outcome.",
    answer: "Rechecked the same pytest task and recorded the updated result.", toolCalls: [] });
  await settleCaptureAssignments(c.service); await runWorkerRounds(c.service, 4);
  expect(c.repos.runtime.getRawTurn(result.rawTurnId)?.episodeId).toBe(source.episodeId);
  expect(c.repos.runtime.getEpisode(source.episodeId)?.status).toBe("open");
  await reward(c, source, value);
  await drain(c);
  await reward(c, source, value);
  await drain(c);
  return { ...result, episodeId: source.episodeId, sessionId: source.sessionId };
}
function read(c: Context) {
  const policyRow = c.repos.memories.get("ownership-policy")!, skillRow = c.repos.memories.get("ownership-skill")!;
  return { policy: policyMetaFromMemory(policyRow)!, skill: skillMetaFromMemory(skillRow)!,
    policyHistory: policyRevisionHistory(policyRow), skillHistory: skillRow.properties.internal_info.skill_revision_history,
    owners: { policy: policyRow.userId, skill: skillRow.userId } };
}
function eventIds(c: Context) { return read(c).policyHistory?.events.map(e => e.id); }
function otherSources(c: Context, members: Source[]) {
  return members.map(s => {
    const episode = c.repos.runtime.getEpisode(s.episodeId)!;
    const row = c.repos.memories.get(s.l1MemoryId)!, trace = traceMetaFromMemory(row)!;
    return { episodeId: episode.id, episodeOwner: episode.userId, episodeStatus: episode.status, reward: episode.rTask,
      traceId: row.id, traceOwner: row.userId, value: trace.value, alpha: trace.alpha, rawTurnId: trace.rawTurnId,
      userText: trace.userText, agentText: trace.agentText };
  });
}
async function drain(c: Context) {
  for (let i = 0; i < 12; i++) { vi.setSystemTime(Date.now() + 1000); await c.service.runWorkerOnce(30); }
}
async function restart(c: Context) {
  await c.service.stop(); c.db.close();
  c.db = new MemoryDb({ path: join(c.root, "memory.sqlite") });
  c.service = fixture.createTestMemoryService({ ...c.options, db: c.db, mode: "dev" });
  c.repos = new Repositories(c.db.db);
  c.service.reconcileWorkerStartup();
}

describe("MEMMY-647 v1.2.8 real ownership lifecycle", () => {
  it.each(["historical-source", "historical-policy"] as const)("%s: reward withdrawal/restoration, deletion and restart preserve the other tasks and derived Skill", async direction => {
    const c = setup();
    const members = [await capture(c, "A"), await capture(c, "B"), await capture(c, "C")];
    const a = members[0]!;
    if (direction === "historical-source") preserveHistoricalSource(c, a);
    const policyOwner = direction === "historical-policy" ? LEGACY_OWNER : DEVICE_MEMORY_OWNER;
    graph(c, members, policyOwner);
    for (const source of members) await reward(c, source, 0.9);
    // Closure can enqueue title/reflection jobs; settle them before freezing B/C.
    await drain(c);
    for (const source of members) await reward(c, source, 0.9);
    await drain(c);
    const success = read(c), originalEvents = eventIds(c), protectedBC = otherSources(c, members.slice(1));
    evidence(`${direction}-success`, success);
    expect(success.policy.support).toBe(3);
    expect(success.policy.sourceEpisodeIds.slice().sort()).toEqual(members.map(s => s.episodeId).sort());
    expect(success.skill.eta).not.toBe(0.8);
    expect(originalEvents).toHaveLength(1);
    expect(success.policyHistory?.events.flatMap(e => e.type === undefined || e.type === "update" ? e.sources ?? [] : []).sort())
      .toEqual(members.map(s => s.episodeId).sort());
    expect(success.owners).toEqual({ policy: policyOwner, skill: DEVICE_MEMORY_OWNER });
    const failedCorrection = await revise(c, a, -0.9);
    const failure = read(c); evidence(`${direction}-failure`, failure);
    expect(failure.policy.support).toBe(2);
    expect(failure.policyHistory?.latestInput?.reference.map(trace => trace.id),
      "a valid device-owned correction still belongs to the historical task reference set")
      .toContain(failedCorrection.l1MemoryId);
    expect(failure.policy.sourceEpisodeIds).not.toContain(a.episodeId);
    expect(failure.policy.sourceEpisodeIds.slice().sort()).toEqual(members.slice(1).map(s => s.episodeId).sort());
    expect(failure.skill.eta).not.toBe(success.skill.eta);
    expect(eventIds(c)).toEqual(originalEvents);
    expect(otherSources(c, members.slice(1))).toEqual(protectedBC);
    await revise(c, a, 0.9);
    const restored = read(c); evidence(`${direction}-restored`, restored);
    expect(restored.policy.support).toBe(3);
    expect(restored.policy.sourceEpisodeIds.slice().sort()).toEqual(members.map(s => s.episodeId).sort());
    expect(restored.skill.eta).not.toBe(failure.skill.eta);
    expect(eventIds(c)).toEqual(originalEvents);
    expect(otherSources(c, members.slice(1))).toEqual(protectedBC);
    await reward(c, a, 0.9);
    expect(read(c)).toEqual(restored);
    c.service.deleteMemory(a.l1MemoryId);
    const deleted = read(c); evidence(`${direction}-deleted`, deleted);
    expect(deleted.policy.support).toBe(2);
    expect(deleted.policy.sourceEpisodeIds).not.toContain(a.episodeId);
    expect(deleted.skill.eta).not.toBe(restored.skill.eta);
    expect(otherSources(c, members.slice(1))).toEqual(protectedBC);
    await restart(c);
    expect(read(c)).toEqual(deleted);
    expect(otherSources(c, members.slice(1))).toEqual(protectedBC);
    expect(c.repos.runtime.getEpisode(a.episodeId)?.userId).toBe(direction === "historical-source" ? LEGACY_OWNER : DEVICE_MEMORY_OWNER);
  });

  it("rewards every old task source after more than 1000 unrelated newer L1 records", async () => {
    const c = setup();
    const members = [await capture(c, "A"), await capture(c, "B"), await capture(c, "C")];
    const a = members[0]!;
    preserveHistoricalSource(c, a);
    graph(c, members, DEVICE_MEMORY_OWNER);
    for (const source of members) await reward(c, source, 0.9);
    await drain(c);
    for (const source of members) await reward(c, source, 0.9);
    await drain(c);
    const success = read(c), originalEvents = eventIds(c);
    expect(success.policy.support).toBe(3);

    // Real capture supplies an unrelated task's valid L1 shape; ordinary inserts
    // supply volume without starting 1001 unrelated model jobs. Every inserted
    // record is newer than A/B/C and belongs to this other project/profile/task.
    const unrelated = await capture(c, "unrelated task", { profileId: "noise", projectId: "noise-project" });
    const seed = c.repos.memories.get(unrelated.l1MemoryId)!;
    c.repos.transaction(() => {
      for (let i = 0; i < 1001; i++) {
        vi.setSystemTime(Date.now() + 1);
        const at = new Date().toISOString();
        c.repos.memories.insert({ ...structuredClone(seed), id: `v128-unrelated-${i}`, memoryKey: undefined,
          contentHash: `v128-unrelated-${i}`, timeline: at, createdAt: at, updatedAt: at });
      }
    });
    const protectedBC = otherSources(c, members.slice(1));
    expect(c.repos.memories.list({ memoryLayer: "L1", status: "activated" }, 1000)
      .map(row => row.id)).not.toContain(a.l1MemoryId);

    // Use the same normal capture/reopen/close/reward worker path as the small
    // lifecycle test. A new correction must also update the old accepted trace.
    await revise(c, a, -0.9);
    const failed = read(c), failedTrace = traceMetaFromMemory(c.repos.memories.get(a.l1MemoryId)!)!;
    evidence("large-history-reward-failed", { success, failed, failedTrace, protectedBC, currentBC: otherSources(c, members.slice(1)) });
    expect.soft(failedTrace.value, "the old accepted L1 must receive the task's revised reward").toBeLessThan(0);
    expect.soft(failed.policy.support).toBe(2);
    expect.soft(failed.policy.sourceEpisodeIds).not.toContain(a.episodeId);
    expect.soft(failed.skill.eta).not.toBe(success.skill.eta);
    expect.soft(eventIds(c)).toEqual(originalEvents);
    expect.soft(otherSources(c, members.slice(1))).toEqual(protectedBC);

    await revise(c, a, 0.9);
    const restored = read(c), restoredTrace = traceMetaFromMemory(c.repos.memories.get(a.l1MemoryId)!)!;
    evidence("large-history-reward-restored", { failed, restored, restoredTrace, protectedBC, currentBC: otherSources(c, members.slice(1)) });
    expect.soft(restoredTrace.value).toBeGreaterThan(0);
    expect.soft(restored.policy.support).toBe(3);
    expect.soft(restored.policy.sourceEpisodeIds.slice().sort()).toEqual(members.map(source => source.episodeId).sort());
    expect.soft(restored.skill.eta).not.toBe(failed.skill.eta);
    expect.soft(eventIds(c)).toEqual(originalEvents);
    expect.soft(otherSources(c, members.slice(1))).toEqual(protectedBC);
    await reward(c, a, 0.9);
    expect.soft(read(c)).toEqual(restored);
  }, 30000);

  it("a historical Policy content revision suspends and repairs its device Skill through the unified worker", async () => {
    const c = setup(), members = [await capture(c, "A"), await capture(c, "B"), await capture(c, "C")], a = members[0]!;
    graph(c, members, LEGACY_OWNER);
    for (const source of members) await reward(c, source, 0.9);
    await drain(c);
    for (const source of members) await reward(c, source, 0.9);
    await drain(c);
    const before = c.repos.memories.get("ownership-skill")!;
    const policyBefore = c.repos.memories.get("ownership-policy")!;
    c.config.algorithm.l2Induction.mode = "unified";
    c.config.algorithm.l2Induction.useLlm = true;
    c.service.reloadConfig({ restartFailedProcessing: false });
    const lesson = { type: "check", title: "Inspect before retrying pytest", applicability: "When pytest fails",
      content: "Inspect the pytest failure before retrying the exact failing test.", verification: "Verify that pytest passes after the retry.", exclusions: "" };
    c.state.l2Response = () => ({ operations: [{ operation: "revise", l1_ids: [a.l1MemoryId],
      target_l2: { id: policyBefore.id, version: policyBefore.version }, revised_l2: lesson }] });
    expect(upsertL2Candidate(c.repos, { userId: DEVICE_MEMORY_OWNER, sourceMemoryId: a.l1MemoryId, route: "negative", at: new Date().toISOString() })).not.toBeNull();
    const at = new Date().toISOString();
    const extraction = c.repos.runtime.enqueueJob({ id: "v128-content-revision", jobType: "l2_induction", userId: DEVICE_MEMORY_OWNER,
      episodeId: a.episodeId, sessionId: a.sessionId, targetMemoryId: a.l1MemoryId, payload: { unified: true },
      status: "queued", attempts: 0, maxAttempts: 1, createdAt: at, updatedAt: at });
    await c.service.runWorkerOnce(1, { targetMemoryIds: [a.l1MemoryId] });
    evidence("content-revision-extraction", { job: c.repos.runtime.getJob(extraction.id), operations: c.state.operations });
    expect(c.repos.runtime.getJob(extraction.id)).toMatchObject({ status: "succeeded" });
    const revised = c.repos.memories.get("ownership-policy")!, suspended = c.repos.memories.get("ownership-skill")!;
    evidence("content-revision-suspended", { policy: revised, skill: suspended });
    expect(revised.userId).toBe(LEGACY_OWNER);
    expect(revised.properties.internal_info.policy).toMatchObject({ content_revision: 2, procedure: lesson.content });
    expect(suspended.userId).toBe(DEVICE_MEMORY_OWNER);
    expect(suspended.properties.internal_info.skill).toMatchObject({ status: "suspended", pending_policy_revisions: { "ownership-policy": 2 } });
    expect((suspended.properties.internal_info.skill as Record<string, unknown>).procedure_json)
      .toEqual((before.properties.internal_info.skill as Record<string, unknown>).procedure_json);
    // Let the actual queued fan-out enter reviseDependentSkill. A skip must retain
    // suspension; a later valid response may repair text without pretending success.
    await c.service.runWorkerOnce(1, { targetMemoryIds: ["ownership-policy"] });
    expect(c.repos.memories.get("ownership-skill")?.status).toBe("archived");
    c.state.skillDraft = { name: "pytest_retry_workflow", retrieval_blurb: lesson.content, trigger_context: lesson.applicability,
      summary: lesson.content, preconditions: [], parameters: [], tools: [], examples: [], tags: ["python", "pytest"], changed_sections: ["steps"],
      steps: [{ title: "Inspect failure", body: lesson.content, evidence_ids: [a.l1MemoryId] },
        { title: "Verify result", body: lesson.verification, evidence_ids: [a.l1MemoryId] }] };
    const repair = c.repos.runtime.enqueueJob({ id: "v128-content-repair", jobType: "skill_crystallization", userId: LEGACY_OWNER,
      targetMemoryId: revised.id, sessionId: a.sessionId, payload: { reason: "l2.content_revised", skillId: suspended.id, contentRevision: 2 },
      status: "queued", attempts: 0, maxAttempts: 1, createdAt: at, updatedAt: at });
    for (let i = 0; i < 10 && c.repos.runtime.getJob(repair.id)?.status === "queued"; i++) await c.service.runWorkerOnce(1, { targetMemoryIds: ["ownership-policy"] });
    evidence("content-revision-repaired", { job: c.repos.runtime.getJob(repair.id), skill: c.repos.memories.get("ownership-skill") });
    expect(c.repos.runtime.getJob(repair.id)).toMatchObject({ status: "succeeded" });
    const repaired = c.repos.memories.get("ownership-skill")!;
    expect(repaired.userId).toBe(DEVICE_MEMORY_OWNER);
    expect(repaired.status).toBe("archived");
    expect(JSON.stringify((repaired.properties.internal_info.skill as Record<string, unknown>).procedure_json)).toContain(lesson.content);
    expect(repaired.properties.internal_info.skill).toMatchObject({ trials_attempted: 0, eta: 0, support: 0 });
    const procedure = (repaired.properties.internal_info.skill as Record<string, unknown>).procedure_json as { steps: Record<string, unknown>[] };
    for (const step of procedure.steps) {
      expect(step).not.toHaveProperty("evidenceIds");
      expect(step).not.toHaveProperty("evidence_ids");
      expect(step.supportingPolicyIds).toEqual(["ownership-policy"]);
    }
    expect(c.state.operations.filter(operation => operation.startsWith("skill."))).not.toHaveLength(0);
  });

  it("startup does not promote unlinked cross-owner source IDs into trusted contributions", async () => {
    const c = setup(), members = [await capture(c, "B"), await capture(c, "C"), await capture(c, "D")];
    const outsider = await capture(c, "unlinked A"); preserveHistoricalSource(c, outsider);
    graph(c, members, DEVICE_MEMORY_OWNER);
    for (const source of members) await reward(c, source, 0.9);
    await drain(c);
    const before = read(c);
    // Raw historical data may claim source IDs, but only an attributed current
    // support relation can establish this cross-owner contribution.
    c.db.db.prepare("UPDATE memories SET properties_json=json_set(properties_json,'$.internal_info.policy.source_trace_ids',json(?)) WHERE id=?")
      .run(JSON.stringify([...members.map(s => s.l1MemoryId), outsider.l1MemoryId]), "ownership-policy");
    expect(c.repos.runtime.listTracePolicyLinks({ l1MemoryId: outsider.l1MemoryId, l2MemoryId: "ownership-policy", limit: -1 })).toEqual([]);
    await restart(c);
    const after = read(c), links = c.repos.runtime.listTracePolicyLinks({ l1MemoryId: outsider.l1MemoryId, l2MemoryId: "ownership-policy", limit: -1 });
    evidence("startup-unlinked-cross-owner", { before, after, links });
    expect(links).toEqual([]);
    expect(after.policy.support).toBe(before.policy.support);
    expect(after.policy.sourceEpisodeIds).not.toContain(outsider.episodeId);
    expect(after.policyHistory).toEqual(before.policyHistory);
    expect(after.skillHistory).toEqual(before.skillHistory);
  });

  it("a new device correction in a historical Episode reaches the unified negative candidate path", async () => {
    const c = setup(), original = await capture(c, "historical A"); preserveHistoricalSource(c, original);
    const members = [original, await capture(c, "B"), await capture(c, "C")];
    graph(c, members, DEVICE_MEMORY_OWNER);
    for (const member of members) await reward(c, member, 0.9);
    await drain(c);
    for (const member of members) await reward(c, member, 0.9);
    await drain(c);
    const protectedBC = otherSources(c, members.slice(1)), originalEvents = eventIds(c);
    const correction = await revise(c, original, -0.9);
    const row = c.repos.memories.get(correction.l1MemoryId)!;
    expect(row.userId).toBe(DEVICE_MEMORY_OWNER);
    expect(c.repos.runtime.getEpisode(original.episodeId)?.userId).toBe(LEGACY_OWNER);
    expect(c.repos.runtime.getRawTurn(correction.rawTurnId)?.episodeId).toBe(original.episodeId);
    c.config.algorithm.l2Induction.mode = "unified";
    c.config.algorithm.l2Induction.useLlm = true;
    c.service.reloadConfig({ restartFailedProcessing: false });
    const batches: string[][] = [];
    c.state.l2Response = payload => {
      const records = payload.L1_RECORDS as Array<{ id: string }>;
      batches.push(records.map(record => record.id));
      // The correction adds no new lesson text. Existing contributions are still
      // maintained by the real reward path, independently of this model decision.
      return { operations: [{ operation: "ignore", l1_ids: records.map(record => record.id) }] };
    };
    const at = new Date().toISOString(), job = c.repos.runtime.enqueueJob({ id: "v128-new-correction-negative", jobType: "negative_experience",
      userId: LEGACY_OWNER, sessionId: original.sessionId, episodeId: original.episodeId, targetMemoryId: row.id,
      payload: { source: "episode_reward", sourceEventId: original.episodeId }, status: "queued", attempts: 0, maxAttempts: 1, createdAt: at, updatedAt: at });
    for (let i = 0; i < 10 && c.repos.runtime.getJob(job.id)?.status === "queued"; i++) await c.service.runWorkerOnce(1, { targetMemoryIds: [row.id] });
    const candidates = listL2Candidates(c.repos, { userId: DEVICE_MEMORY_OWNER, episodeId: original.episodeId });
    evidence("new-device-negative-in-history", { job: c.repos.runtime.getJob(job.id), candidates, source: row, episode: c.repos.runtime.getEpisode(original.episodeId), raw: c.repos.runtime.getRawTurn(correction.rawTurnId) });
    expect(c.repos.runtime.getJob(job.id)).toMatchObject({ status: "succeeded" });
    expect(candidates.map(candidate => candidate.sourceMemoryId)).toContain(row.id);
    await drain(c);
    expect(batches.flat()).toContain(row.id);
    expect(batches.flat()).toContain(original.l1MemoryId);
    const failed = read(c);
    expect(failed.policy.support).toBe(2);
    expect(failed.policy.sourceEpisodeIds).not.toContain(original.episodeId);
    expect(eventIds(c)).toEqual(originalEvents);
    expect(otherSources(c, members.slice(1))).toEqual(protectedBC);
    const recoveredTurn = await revise(c, original, 0.9);
    expect(c.repos.memories.get(recoveredTurn.l1MemoryId)?.userId).toBe(DEVICE_MEMORY_OWNER);
    const recovered = read(c);
    evidence("negative-owner-batches-recovered", { failed, recovered, batches, originalEvents });
    expect(recovered.policy.support).toBe(3);
    expect(recovered.policy.sourceEpisodeIds.slice().sort()).toEqual(members.map(member => member.episodeId).sort());
    expect(recovered.skill.eta).not.toBe(failed.skill.eta);
    expect(eventIds(c)).toEqual(originalEvents);
    expect(otherSources(c, members.slice(1))).toEqual(protectedBC);
    expect(c.repos.runtime.getEpisode(original.episodeId)).toMatchObject({ status: "closed", rTask: 0.9, userId: LEGACY_OWNER });
    await reward(c, original, 0.9); await drain(c);
    expect(read(c)).toEqual(recovered);
    for (const owner of [LEGACY_OWNER, DEVICE_MEMORY_OWNER]) {
      for (const candidate of c.repos.runtime.listUnifiedL2Candidates({ userId: owner, episodeId: original.episodeId })) {
        const signals = (candidate.evidence as { signals: Array<{ eventId: string; route: string }> }).signals;
        expect(new Set(signals.map(signal => `${signal.route}:${signal.eventId}`)).size).toBe(signals.length);
      }
    }
  });

  it.each(["no-link", "forged-link-owner", "profile", "project", "forged-raw", "deleted-raw", "redacted-raw"] as const)("%s cannot become accepted cross-owner support through reward or startup reconciliation", async invalid => {
    const c = setup(), valid = await capture(c, "B");
    const outsider = await capture(c, "A", { profileId: invalid === "profile" ? "other-profile" : PROFILE, projectId: invalid === "project" ? "other-project" : "project-main" });
    preserveHistoricalSource(c, outsider);
    graph(c, [valid], DEVICE_MEMORY_OWNER);
    if (invalid !== "no-link") insertTracePolicyLinkForTest(c.db, { userId: invalid === "forged-link-owner" ? "forged-owner" : LEGACY_OWNER, l1MemoryId: outsider.l1MemoryId, l2MemoryId: "ownership-policy" });
    if (invalid === "forged-raw") c.db.db.prepare("UPDATE memories SET properties_json=json_set(properties_json,'$.internal_info.source_raw_turn_id',?) WHERE id=?").run(valid.rawTurnId, outsider.l1MemoryId);
    if (invalid === "deleted-raw" || invalid === "redacted-raw") c.db.db.prepare(`UPDATE raw_turns SET ${invalid === "deleted-raw" ? "deleted_at" : "redacted_at"}=? WHERE id=?`).run(new Date().toISOString(), outsider.rawTurnId);
    await reward(c, valid, 0.9);
    const before = read(c); evidence(`${invalid}-before`, before);
    expect(before.policy.support).toBe(1);
    expect(before.policy.sourceEpisodeIds).toEqual([valid.episodeId]);
    await reward(c, outsider, -0.9);
    expect(read(c)).toEqual(before);
    await restart(c);
    const after = read(c); evidence(`${invalid}-after`, after);
    expect(after.policy.support).toBe(1);
    expect(after.policy.sourceEpisodeIds).toEqual([valid.episodeId]);
    expect(after.policyHistory).toEqual(before.policyHistory);
    expect(after.skillHistory).toEqual(before.skillHistory);
    expect(after.skill.eta).toBe(before.skill.eta);
  });
});
