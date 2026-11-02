import { episodeInputRevision } from "../../../src/service/evolution/episode-revision.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMMY_CONFIG, type LlmClient, type LlmMessage } from "../../../src/index.js";
import { policyMetaFromMemory, skillMetaFromMemory, traceMetaFromMemory } from "../../../src/algorithm/plugin-algorithms.js";
import { Repositories, RuntimeRepository, type EvolutionJobRecord } from "../../../src/storage/repositories.js";
import { evolutionJobDedupeKey } from "../../../src/service/worker/job-handlers.js";
import { episodeSkillStatus } from "../../../src/service/read-model/episode.js";
import { assignedEpisodeId, settleCaptureAssignments, LEGACY_TEST_CONFIG, createCapturingEmbedder, createMemoryServiceFixture, runWorkerRounds } from "../../fixtures/memory-service-fixture.js";
import { insertActivePolicyMemory, insertActiveSkillMemoryForTest, insertTracePolicyLinkForTest, makeTraceEligibleForL2, setTraceSignatureAndVectorForTest } from "../../fixtures/evolution-fixture.js";

// Synthetic fixture adapted from yxyi123 PR #740 (660b3b9c); assertions below target current v1.2.7.
// Capture completion and asynchronous Episode assignment use the current public API.
const fixture = createMemoryServiceFixture();
const FIXED_TIME = Date.parse("2026-10-22T02:00:00Z");
let sequence = 0;
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(FIXED_TIME); sequence = 0; });
afterEach(async () => { await fixture.cleanup(); vi.useRealTimers(); });

function evidence(name: string, value: unknown) {
  const directory = process.env.MEMMY647_EVIDENCE_DIR;
  if (directory) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${name}.json`), JSON.stringify(value, null, 2) + "\n");
  }
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
async function waitForGate(signal: ReturnType<typeof gate>) {
  let timeout!: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([signal.promise, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("Reward model was not reached; this is a fixture failure, not defect evidence.")), 2000);
    })]);
  } finally { clearTimeout(timeout); }
}
function setup(archiveEta?: number, valueDistributionRepairEnabled = false) {
  const state = {
    operations: [] as string[], relation: "follow_up", reward: 0.9, variant: 0,
    spans: [{ start: 0, end: 3, spanGoal: "TLS old inspect", summary: "Inspect nginx TLS certificate configuration" },
      { start: 4, end: 10, spanGoal: "TLS old verify", summary: "Verify nginx TLS secure endpoint" }],
    blockOperation: "", failOperation: "",
    modelStarted: undefined as ReturnType<typeof gate> | undefined,
    modelRelease: undefined as ReturnType<typeof gate> | undefined,
    rewardStarted: undefined as ReturnType<typeof gate> | undefined,
    rewardRelease: undefined as ReturnType<typeof gate> | undefined
  };
  const llm: LlmClient = {
    config: { ...DEFAULT_MEMMY_CONFIG.summary, provider: "host", model: "memmy647-fixed" },
    isConfigured: () => true,
    complete: async (_messages, options) => {
      state.operations.push(options.operation);
      return options.operation.startsWith("episode_title.") ? JSON.stringify({ title: "nginx TLS verification", summary: "Configure and verify nginx TLS securely." }) : "{}";
    },
    async completeJson<T extends Record<string, unknown>>(messages: LlmMessage[], options: { operation: string }): Promise<T> {
      state.operations.push(options.operation);
      if (state.blockOperation === options.operation) {
        state.modelStarted?.release();
        await state.modelRelease?.promise;
      }
      if (state.failOperation === options.operation) throw new Error("synthetic model failure");
      let payload: { steps?: Array<{ idx: number }>; evidence_trace_ids?: string[] } = {};
      try { payload = JSON.parse([...messages].reverse().find((item) => item.role === "user")?.content ?? "{}"); } catch { /* Some capture prompts use plain text. */ }
      let output: Record<string, unknown> = {};
      if (options.operation === "episode.select.v1") output = { episodeId: null, title: "TLS test", summary: "TLS verification" };
      if (options.operation === "relation.classify.v1") output = { relation: state.relation, confidence: 0.99, reason: "fixed diagnostic relation" };
      if (options.operation === "capture.summarize") {
        const userQuote = (messages.find((item) => item.role === "user")?.content ?? "").match(/\bUSER:\s*(.*?)\s+ASSISTANT:/)?.[1]?.trim() ?? "";
        output = { l1: { title: "nginx TLS verification", summary: "Inspect nginx configuration, fix port and verify TLS certificates.", evidence: [{ quote: userQuote, role: "user", kind: "task_outcome" }] }, user: null };
      }
      if (options.operation === "capture.reflection.batch.v13") output = { scores: (payload.steps ?? []).map((step: { idx: number }) => ({ idx: step.idx, relevance: "PIVOTAL", reason: "verified TLS work" })) };
      if (options.operation === "reward.reward.r_human.v7") {
        state.rewardStarted?.release();
        if (state.rewardRelease) await state.rewardRelease.promise;
        output = { goal_achievement: state.reward, process_quality: state.reward, user_satisfaction: state.reward, reason: "fixed diagnostic reward" };
      }
      if (options.operation === "span.big_turn.v1") output = { spans: state.spans };
      if (options.operation === "failure.experience.sink.v5") {
        const variant = state.variant ? "Validate the certificate and secure endpoint before declaring nginx ready." : "Check nginx TLS certificate verification before reporting completion.";
        output = {
          title: "Avoid premature nginx completion", trigger: "When configuring nginx TLS endpoints.",
          procedure: "Configure port 443, validate the certificate, then report the verified endpoint.",
          verification: "An HTTPS request verifies the certificate successfully.", boundary: "nginx TLS configuration with certificate verification requirements.",
          experience_type: "failure_avoidance", decision_guidance: { prefer: [variant], avoid: ["Do not declare nginx TLS complete with a wrong port or unverified certificate."] },
          support_trace_ids: payload.evidence_trace_ids ?? [], confidence: 0.9
        };
      }
      return output as T;
    },
    status: () => ({ provider: "host", model: "memmy647-fixed", configured: true, remote: false })
  };
  const embedder = createCapturingEmbedder([]);
  embedder.embedOne = async (text) => text.includes("member B") ? [0.8, 0.6, 0] : [1, 0, 0];
  embedder.embed = async (texts) => texts.map((text) => text.includes("TLS new") ? [0, 1, 0] : [1, 0, 0]);
  const config = structuredClone(LEGACY_TEST_CONFIG);
  config.algorithm.retrieval.smartSeed = false;
  config.algorithm.retrieval.llmFilterEnabled = false;
  config.algorithm.retrieval.relativeThresholdFloor = 0;
  config.algorithm.skill.directFromTrace = false;
  if (archiveEta !== undefined) config.algorithm.skill.archiveEta = archiveEta;
  config.algorithm.l2Induction.useLlm = false;
  config.algorithm.l3Abstraction.useLlm = false;
  config.algorithm.feedback.valueDistributionRepairEnabled = valueDistributionRepairEnabled;
  if (valueDistributionRepairEnabled) config.algorithm.feedback.cooldownMs = 0;
  const base = fixture.createTestService({ llm, skillLlm: llm, config, embedder });
  return { ...base, state, config, repos: new Repositories(base.db.db) };
}
type Context = ReturnType<typeof setup>;
async function prepare(context: Context, label = "member A", tools = 1) {
  const { service, repos } = context;
  const namespace = { source: "codex", profileId: "memmy647", userId: "memmy647-synthetic" };
  const session = service.openSession({ namespace: { ...namespace, sessionKey: `session-${++sequence}` } });
  const captured = await service.completeTurn(`turn-${++sequence}`, {
    sessionId: session.sessionId, query: `${label}: inspect nginx TLS certificate and fix port 443`,
    answer: "Configured nginx TLS on port 443 and verified the endpoint.",
    toolCalls: Array.from({ length: tools }, (_, index) => ({ id: `call-${index}`, name: "run_tests", input: { index }, output: { ok: true }, success: true }))
  });
  await settleCaptureAssignments(service);
  const first = { ...captured, episodeId: assignedEpisodeId(service, captured) };
  await runWorkerRounds(service, 4);
  expect(repos.memories.get(first.l1MemoryId)?.status).toBe("activated");
  return { namespace, session, first };
}
type Prepared = Awaited<ReturnType<typeof prepare>>;
function enqueue(context: Context, prepared: Prepared, type: string, payload: Record<string, unknown> = {}, targetMemoryId?: string) {
  const at = new Date().toISOString();
  const input = { jobType: type as EvolutionJobRecord["jobType"], episodeId: prepared.first.episodeId, targetMemoryId, payload };
  return context.repos.runtime.enqueueJob({ ...input, dedupeKey: evolutionJobDedupeKey(input), id: `647-job-${++sequence}`, userId: prepared.namespace.userId,
    sessionId: prepared.session.sessionId, status: "queued", attempts: 0, maxAttempts: 1, createdAt: at, updatedAt: at });
}
async function executeQueued(context: Context, job: EvolutionJobRecord) {
  for (let i = 0; i < 15 && context.repos.runtime.getJob(job.id)?.status === "queued"; i++) await context.service.runWorkerOnce(1);
  expect(context.repos.runtime.getJob(job.id), `job ${job.jobType} must execute successfully`).toMatchObject({ status: "succeeded" });
}
function snapshot(context: Context, prepared: Prepared) {
  return {
    episode: context.repos.runtime.getEpisode(prepared.first.episodeId),
    trace: traceMetaFromMemory(context.repos.memories.get(prepared.first.l1MemoryId)!),
    jobs: context.db.db.prepare("SELECT id, job_type, status, payload_json FROM evolution_jobs WHERE episode_id = ? ORDER BY rowid").all(prepared.first.episodeId) as Array<{ id: string; job_type: string; status: string; payload_json: string }>,
    trials: context.db.db.prepare("SELECT * FROM skill_trials").all()
  };
}

describe("MEMMY-647 current baseline acceptance", () => {
  it("clears stale closure reasons on reopen without changing routing", async () => {
    const c = setup(); const p = await prepare(c);
    c.repos.runtime.closeEpisode(p.first.episodeId, { closeReason: "abandoned", abandonReason: "old closure" });
    c.repos.runtime.reopenEpisode(p.first.episodeId);
    const episode = c.repos.runtime.getEpisode(p.first.episodeId)!;
    expect(episode.status).toBe("open");
    expect(episode.meta.closeReason).toBeUndefined();
    expect(episode.meta.abandonReason).toBeUndefined();
    expect(episodeSkillStatus(episode)).not.toBe("skipped");
  });

  it.each([false, true])("discards an in-flight reward after reopen (reclose=%s)", async reclose => {
    const c = setup(); const p = await prepare(c);
    c.repos.runtime.closeEpisode(p.first.episodeId, { closeReason: "idle_timeout" });
    c.state.rewardStarted = gate(); c.state.rewardRelease = gate();
    const job = enqueue(c, p, "reward", { polarity: "positive", magnitude: 1, l1MemoryId: p.first.l1MemoryId });
    const before = traceMetaFromMemory(c.repos.memories.get(p.first.l1MemoryId)!)!.value;
    const running = c.service.runWorkerOnce(1);
    try {
      await waitForGate(c.state.rewardStarted);
      c.repos.runtime.reopenEpisode(p.first.episodeId);
      if (reclose) c.repos.runtime.closeEpisode(p.first.episodeId, { closeReason: "idle_timeout" });
    } finally { c.state.rewardRelease.release(); await running; }
    expect(c.repos.runtime.getEpisode(p.first.episodeId)!.rTask).toBeUndefined();
    expect(traceMetaFromMemory(c.repos.memories.get(p.first.l1MemoryId)!)!.value).toBe(before);
    expect(c.db.db.prepare("SELECT COUNT(*) n FROM evolution_jobs WHERE episode_id = ? AND job_type = 'l2_association'").get(p.first.episodeId)).toEqual({ n: 0 });
  });

  it("replaces superseded spans and retires their searchable records", async () => {
    const c = setup(); const p = await prepare(c, "span source", 11);
    c.repos.runtime.closeEpisode(p.first.episodeId);
    await executeQueued(c, enqueue(c, p, "span_big_turn", {rawTurnId:p.first.rawTurnId}, p.first.l1MemoryId));
    const ids = () => (c.db.db.prepare("SELECT id FROM memories WHERE deleted_at IS NULL AND status != 'deleted' AND json_extract(properties_json, '$.internal_info.span.source_trace_id') = ?").all(p.first.l1MemoryId) as Array<{id:string}>).map(m => m.id);
    const before = ids(); evidence("span-baseline", { raw: c.repos.runtime.getRawTurn(p.first.rawTurnId), memories: c.repos.memories.list({},100), operations: c.state.operations }); expect(before).toHaveLength(2);
    c.state.spans = [{ start: 0, end: 5, spanGoal: "TLS new inspect", summary: "New inspection boundary" },
      { start: 6, end: 10, spanGoal: "TLS new verify", summary: "New verification boundary" }];
    await executeQueued(c, enqueue(c, p, "span_big_turn", {rawTurnId:p.first.rawTurnId}, p.first.l1MemoryId));
    expect(ids()).toHaveLength(2);
    for (const id of before) expect(c.repos.memories.get(id)).toBeUndefined();
  });

  it("does not weight the same cluster member twice", async () => {
    const c = setup(); const a = await prepare(c, "member A"); const b = await prepare(c, "member B");
    for (const p of [a, b]) {
      c.repos.runtime.closeEpisode(p.first.episodeId);
      c.repos.runtime.updateEpisodeReward(p.first.episodeId, { rTask: 0.9, rewardDetail: {} });
      await executeQueued(c, enqueue(c, p, "skill_cluster_assign"));
    }
    const cluster = c.repos.runtime.getSkillClusterForEpisode(a.first.episodeId)!;
    expect(cluster.memberCount).toBe(2);
    await executeQueued(c, enqueue(c, a, "skill_cluster_assign"));
    const after = c.repos.runtime.getSkillClusterForEpisode(a.first.episodeId)!;
    expect(after.memberCount).toBe(2);
    expect(after.centroid).toEqual(cluster.centroid);
  });
  it("REGRESSION: the same association input does not smooth policy gain or skill eta again", async () => {
    const c = setup(); const p = await prepare(c);
    const b = await prepare(c, "member B"); const d = await prepare(c, "member C");
    for (const item of [p, b, d]) {
      makeTraceEligibleForL2(c.db, item.first.l1MemoryId);
      setTraceSignatureAndVectorForTest(c.db, item.first.l1MemoryId, "python|pytest|_|_", [1, 0, 0]);
    }
    const session = c.repos.runtime.getSession(p.session.sessionId)!;
    const source = c.repos.memories.get(p.first.l1MemoryId)!;
    insertActivePolicyMemory(c.db, { id: "647-policy", userId: p.namespace.userId, sessionId: session.id, agentId: source.agentId ?? "codex", appId: source.appId ?? "647-test",
      profileId: p.namespace.profileId, sourceTraceId: p.first.l1MemoryId, sourceEpisodeId: p.first.episodeId });
    insertActiveSkillMemoryForTest(c.db, { id: "647-skill", userId: p.namespace.userId, sessionId: session.id, agentId: source.agentId ?? "codex",
      profileId: p.namespace.profileId, sourcePolicyIds: ["647-policy"] });
    for (const item of [p, b, d]) insertTracePolicyLinkForTest(c.db, { userId: p.namespace.userId, l1MemoryId: item.first.l1MemoryId, l2MemoryId: "647-policy" });
    const read = () => ({ policy: policyMetaFromMemory(c.repos.memories.get("647-policy")!), skill: skillMetaFromMemory(c.repos.memories.get("647-skill")!) });
    const seed = read();
    const firstJob = enqueue(c, p, "l2_association", {}, p.first.l1MemoryId); await executeQueued(c, firstJob);
    const before = read();
    const secondJob = enqueue(c, p, "l2_association", {}, p.first.l1MemoryId); await executeQueued(c, secondJob);
    const after = read();
    evidence("09-gain-eta", { seed, before, after, firstJob, secondJob, links: c.repos.runtime.listTracePolicyLinks({ l2MemoryId: "647-policy", limit: 100 }) });
    expect(before.policy!.gain).not.toBe(seed.policy!.gain);
    expect.soft(after.policy!.support).toBe(before.policy!.support);
    expect.soft(after.policy!.gain).toBeCloseTo(before.policy!.gain);
    expect.soft(after.skill!.eta).toBeCloseTo(before.skill!.eta);
  });
  it("keeps one negative contribution when the same failure is reworded", async () => {
    const c = setup(); const p = await prepare(c);
    c.repos.runtime.closeEpisode(p.first.episodeId);
    c.repos.runtime.updateEpisodeReward(p.first.episodeId, { rTask: -0.9, rewardDetail: {} });
    await executeQueued(c, enqueue(c, p, "negative_experience", { source: "episode_reward", sourceEventId: p.first.episodeId }, p.first.l1MemoryId));
    const read = () => c.repos.memories.list({ memoryLayer: "L2" }, 100);
    expect(read()).toHaveLength(1);
    c.state.variant = 1;
    c.repos.runtime.reopenEpisode(p.first.episodeId);
    c.repos.runtime.closeEpisode(p.first.episodeId);
    c.repos.runtime.updateEpisodeReward(p.first.episodeId, { rTask: -0.9, rewardDetail: {} });
    await executeQueued(c, enqueue(c, p, "negative_experience", { source: "episode_reward", sourceEventId: p.first.episodeId }, p.first.l1MemoryId));
    expect(read()).toHaveLength(1);
  });
  it("does not score identical reward evidence twice", async () => {
    const c = setup(); const p = await prepare(c);
    c.repos.runtime.closeEpisode(p.first.episodeId);
    const payload = { polarity: "positive", magnitude: 1, l1MemoryId: p.first.l1MemoryId };
    await executeQueued(c, enqueue(c, p, "reward", payload));
    // Closure can schedule reflection, which legitimately changes scoring evidence.
    await runWorkerRounds(c.service, 12);
    await executeQueued(c, enqueue(c, p, "reward", payload));
    await runWorkerRounds(c.service, 12);
    const first = c.repos.memories.get(p.first.l1MemoryId)!;
    evidence("reward-idempotence-before", { ...snapshot(c,p), input: episodeInputRevision(c.repos,p.first.episodeId) });
    const calls = c.state.operations.filter(x => x === "reward.reward.r_human.v7").length;
    await executeQueued(c, enqueue(c, p, "reward", payload));
    evidence("reward-idempotence-after", { ...snapshot(c,p), input: episodeInputRevision(c.repos,p.first.episodeId) });
    expect(c.state.operations.filter(x => x === "reward.reward.r_human.v7")).toHaveLength(calls);
    expect(c.repos.memories.get(p.first.l1MemoryId)!.version).toBe(first.version);
  });

  it("withdraws automatic failure evidence when the Episode succeeds", async () => {
    const c = setup(); const p = await prepare(c);
    c.repos.runtime.closeEpisode(p.first.episodeId);
    c.repos.runtime.updateEpisodeReward(p.first.episodeId, { rTask: -0.9, rewardDetail: {} });
    await executeQueued(c, enqueue(c, p, "negative_experience", { source: "episode_reward", sourceEventId: p.first.episodeId }));
    expect(c.repos.memories.list({ memoryLayer: "L2" }, 100)).toHaveLength(1);
    c.repos.runtime.reopenEpisode(p.first.episodeId);
    c.repos.runtime.closeEpisode(p.first.episodeId);
    c.repos.runtime.updateEpisodeReward(p.first.episodeId, { rTask: 0.9, rewardDetail: {} });
    await executeQueued(c, enqueue(c, p, "negative_experience", { source: "episode_reward", sourceEventId: p.first.episodeId }));
    expect(c.repos.memories.list({ memoryLayer: "L2" }, 100)).toHaveLength(0);
  });

  it("restores retired span ranges but respects a later user deletion", async () => {
    const c = setup(); const p = await prepare(c, "span restoration", 11);
    c.repos.runtime.closeEpisode(p.first.episodeId);
    const split = () => executeQueued(c, enqueue(c, p, "span_big_turn", { rawTurnId: p.first.rawTurnId }, p.first.l1MemoryId));
    const original = c.state.spans;
    await split();
    const ids = c.repos.memories.listSpansForTrace(p.first.l1MemoryId).map(row => row.id);
    c.state.spans = []; await split();
    expect(c.repos.memories.listSpansForTrace(p.first.l1MemoryId)).toHaveLength(0);
    c.state.spans = original; await split();
    expect(c.repos.memories.listSpansForTrace(p.first.l1MemoryId).map(row => row.id).sort()).toEqual(ids.sort());
    c.repos.memories.softDelete(ids[0]!);
    await split();
    expect(c.repos.memories.get(ids[0]!)).toBeUndefined();
    expect(c.repos.memories.listSpansForTrace(p.first.l1MemoryId)).toHaveLength(1);
  });

  it("discards span generation crossing a reopen and reclose", async () => {
    const c = setup(); const p = await prepare(c, "stale span", 11);
    c.repos.runtime.closeEpisode(p.first.episodeId);
    c.state.blockOperation = "span.big_turn.v1";
    c.state.modelStarted = gate(); c.state.modelRelease = gate();
    enqueue(c, p, "span_big_turn", { rawTurnId: p.first.rawTurnId }, p.first.l1MemoryId);
    const running = c.service.runWorkerOnce(1);
    try {
      await waitForGate(c.state.modelStarted);
      c.repos.runtime.reopenEpisode(p.first.episodeId); c.repos.runtime.closeEpisode(p.first.episodeId);
    } finally { c.state.modelRelease.release(); await running; }
    expect(c.repos.memories.listSpansForTrace(p.first.l1MemoryId)).toHaveLength(0);
  });

  it("rolls back the entire reward pass when a downstream write fails", async () => {
    const c = setup(); const p = await prepare(c);
    c.repos.runtime.closeEpisode(p.first.episodeId);
    const before = c.repos.memories.get(p.first.l1MemoryId)!;
    const original = RuntimeRepository.prototype.appendChange;
    const fault = vi.spyOn(RuntimeRepository.prototype, "appendChange").mockImplementation(function (this: RuntimeRepository, change) {
      if (change.changeType === "reward_update") throw new Error("synthetic write failure");
      return original.call(this, change);
    });
    try {
      const job = enqueue(c, p, "reward", { polarity: "positive", l1MemoryId: p.first.l1MemoryId });
      await c.service.runWorkerOnce(1);
      expect(c.repos.runtime.getJob(job.id)!.status).toBe("dead_letter");
      expect(c.repos.runtime.getEpisode(p.first.episodeId)!.rTask).toBeUndefined();
      expect(c.repos.memories.get(p.first.l1MemoryId)!.version).toBe(before.version);
      expect(c.db.db.prepare("SELECT COUNT(*) n FROM memory_change_log WHERE change_type = 'episode_reward_update'").get()).toEqual({ n: 0 });
    } finally { fault.mockRestore(); }
  });

  it("keeps a new cluster revision separate from an already leased batch", () => {
    const common = { jobType: "skill_batch_evolve" as const, episodeId: "A" };
    const first = evolutionJobDedupeKey({ ...common, payload: { clusterId: "cluster", clusterRevision: "old" } });
    const next = evolutionJobDedupeKey({ ...common, payload: { clusterId: "cluster", clusterRevision: "new" } });
    expect(first).not.toBe(next);
    expect(next).toBe(evolutionJobDedupeKey({ ...common, payload: { clusterId: "cluster", clusterRevision: "new" } }));
  });

});
