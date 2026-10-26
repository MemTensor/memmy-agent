import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMMY_CONFIG, type LlmClient, type LlmMessage } from "../../../src/index.js";
import { policyMetaFromMemory, skillMetaFromMemory, traceMetaFromMemory } from "../../../src/algorithm/plugin-algorithms.js";
import { Repositories, type EvolutionJobRecord } from "../../../src/storage/repositories.js";
import { evolutionJobDedupeKey } from "../../../src/service/worker/job-handlers.js";
import { episodeSkillStatus } from "../../../src/service/read-model/episode.js";
import { createCapturingEmbedder, createMemoryServiceFixture, runWorkerRounds } from "../../fixtures/memory-service-fixture.js";
import { insertActivePolicyMemory, insertActiveSkillMemoryForTest, insertTracePolicyLinkForTest, makeTraceEligibleForL2, setTraceSignatureAndVectorForTest } from "../../fixtures/evolution-fixture.js";

// Regression assertions failed on the untouched baseline. Evidence output uses synthetic data only.
const fixture = createMemoryServiceFixture();
const FIXED_TIME = Date.parse("2026-10-22T02:00:00Z");
let sequence = 0;
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(FIXED_TIME); sequence = 0; });
afterEach(() => { fixture.cleanup(); vi.useRealTimers(); });

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
  const config = structuredClone(DEFAULT_MEMMY_CONFIG);
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
  const first = service.completeTurn(`turn-${++sequence}`, {
    sessionId: session.sessionId, query: `${label}: inspect nginx TLS certificate and fix port 443`,
    answer: "Configured nginx TLS on port 443 and verified the endpoint.",
    toolCalls: Array.from({ length: tools }, (_, index) => ({ id: `call-${index}`, name: "run_tests", input: { index }, output: { ok: true }, success: true }))
  });
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

describe("MEMMY-647 regression", () => {
  it("CONTROL: a legal revision reopens the same closed episode and records a distinct feedback event", async () => {
    const c = setup(); const p = await prepare(c);
    c.repos.runtime.closeEpisode(p.first.episodeId, { closeReason: "idle_timeout" });
    c.repos.runtime.updateEpisodeReward(p.first.episodeId, { rTask: 0.9, rewardDetail: { phase: "final", traceIds: [p.first.l1MemoryId] } });
    c.state.relation = "revision";
    await c.service.startTurn({ turnId: "revision", sessionId: p.session.sessionId, query: "wrong, verify nginx TLS certificate instead" });
    const revised = c.service.completeTurn("revision", { sessionId: p.session.sessionId, query: "wrong, verify nginx TLS certificate instead", answer: "Corrected and verified TLS certificate." });
    const after = snapshot(c, p);
    evidence("01-service-reopen", { closure: "repository fixture; reopening uses startTurn/completeTurn", revised, after });
    expect(revised.episodeId).toBe(p.first.episodeId);
    expect(after.episode).toMatchObject({ status: "open", rTask: undefined });
    expect(after.episode!.feedbackIds.length).toBe(1);
  });

  it("CONTROL: end_topic closes are not reopened by revision", async () => {
    const c = setup(); const p = await prepare(c);
    c.repos.runtime.closeEpisode(p.first.episodeId, { closeReason: "end_topic" });
    c.state.relation = "revision";
    await c.service.startTurn({ turnId: "revision", sessionId: p.session.sessionId, query: "wrong, verify nginx TLS certificate instead" });
    const revised = c.service.completeTurn("revision", { sessionId: p.session.sessionId, query: "wrong, verify nginx TLS certificate instead", answer: "Verified TLS." });
    evidence("02-end-topic-control", { old: p.first.episodeId, revised: revised.episodeId });
    expect(revised.episodeId).not.toBe(p.first.episodeId);
  });

  it("CONTROL: a fresh revision after more than two idle hours creates a new episode", async () => {
    const c = setup(); const p = await prepare(c);
    c.repos.runtime.closeEpisode(p.first.episodeId, { closeReason: "idle_timeout" });
    vi.setSystemTime(FIXED_TIME + 2 * 60 * 60_000 + 1000);
    c.state.relation = "revision";
    await c.service.startTurn({ turnId: "late-revision", sessionId: p.session.sessionId, query: "wrong, verify nginx TLS certificate instead" });
    const revised = c.service.completeTurn("late-revision", { sessionId: p.session.sessionId, query: "wrong, verify nginx TLS certificate instead", answer: "Verified TLS." });
    evidence("12-idle-gap-control", { old: p.first.episodeId, revised: revised.episodeId, operations: c.state.operations });
    expect(revised.episodeId).not.toBe(p.first.episodeId);
  });

  it("CONTROL: real idle-close jobs and a pending realtime revision produce two reward passes on the same episode", async () => {
    const c = setup(); const p = await prepare(c);
    await c.service.feedback({ sessionId: p.session.sessionId, episodeId: p.first.episodeId, l1MemoryId: p.first.l1MemoryId,
      channel: "explicit", polarity: "positive", magnitude: 1, rationale: "verified nginx TLS" });
    await runWorkerRounds(c.service, 3);
    c.state.relation = "revision";
    vi.setSystemTime(FIXED_TIME + 60_000);
    await c.service.startTurn({ turnId: "long-revision", sessionId: p.session.sessionId, query: "wrong, verify nginx TLS certificate instead" });
    vi.setSystemTime(FIXED_TIME + 2 * 60 * 60_000 + 120_000);
    await prepare(c, "unrelated trigger B");
    await runWorkerRounds(c.service, 8);
    const firstClosed = snapshot(c, p);
    expect(firstClosed.episode).toMatchObject({ status: "closed", meta: { closeReason: "idle_timeout" }, rTask: 0.9 });
    const firstRewardCount = c.state.operations.filter((op) => op === "reward.reward.r_human.v7").length;
    const revised = c.service.completeTurn("long-revision", { sessionId: p.session.sessionId,
      query: "wrong, verify nginx TLS certificate instead", answer: "Corrected TLS verification after completing the long-running check." });
    const reopened = snapshot(c, p);
    expect(revised.episodeId).toBe(p.first.episodeId);
    expect(reopened.episode).toMatchObject({ status: "open", rTask: undefined });
    await runWorkerRounds(c.service, 4);
    vi.setSystemTime(FIXED_TIME + 4 * 60 * 60_000 + 240_000);
    await prepare(c, "unrelated trigger C");
    await runWorkerRounds(c.service, 8);
    const secondClosed = snapshot(c, p);
    evidence("10-real-idle-reopen-reclose", { firstClosed, reopened, secondClosed, firstRewardCount, operations: c.state.operations });
    expect(secondClosed.episode).toMatchObject({ status: "closed", rTask: 0.9 });
    const rewardJobs = secondClosed.jobs.filter((row) => row.job_type === "reward" && row.status === "succeeded");
    expect(rewardJobs.length).toBeGreaterThanOrEqual(2);
    expect(c.state.operations.filter((op) => op === "reward.reward.r_human.v7").length).toBeGreaterThan(firstRewardCount);
  });

  it.each([false, true])("REGRESSION: reward started before reopening must not commit stale effects (reclose=%s)", async (reclose) => {
    const c = setup(); const p = await prepare(c);
    insertActiveSkillMemoryForTest(c.db, { id: "race-skill", userId: p.namespace.userId, sessionId: p.session.sessionId,
      agentId: "codex", profileId: p.namespace.profileId, evidenceAnchorIds: [p.first.l1MemoryId] });
    c.service.useSkill("race-skill", { adapterId: "647-test", requestId: "race-trial", sessionId: p.session.sessionId,
      episodeId: p.first.episodeId, rawTurnId: p.first.rawTurnId, turnId: p.first.turnId });
    c.repos.runtime.closeEpisode(p.first.episodeId, { closeReason: "idle_timeout" });
    c.state.rewardStarted = gate(); c.state.rewardRelease = gate();
    // Payload feedback bypasses the one-turn reward skip gate; no synthetic feedback row is added.
    const job = enqueue(c, p, "reward", { l1MemoryId: p.first.l1MemoryId, polarity: "positive", magnitude: 1, phase: "final" });
    const running = c.service.runWorkerOnce(1);
    let beforeReturn: ReturnType<typeof snapshot> | undefined;
    c.state.relation = "revision";
    try {
      await waitForGate(c.state.rewardStarted);
      expect(c.repos.runtime.getJob(job.id)?.status).toBe("leased");
      await c.service.startTurn({ turnId: "race-revision", sessionId: p.session.sessionId, query: "wrong, verify nginx TLS certificate instead" });
      const revised = c.service.completeTurn("race-revision", { sessionId: p.session.sessionId, query: "wrong, verify nginx TLS certificate instead", answer: "Corrected TLS verification." });
      expect(revised.episodeId).toBe(p.first.episodeId);
      if (reclose) c.repos.runtime.closeEpisode(p.first.episodeId, { closeReason: "idle_timeout" });
      beforeReturn = snapshot(c, p);
    } finally { c.state.rewardRelease.release(); await running; }
    // No new worker run: all differences below are from the old leased reward job.
    if (!beforeReturn) throw new Error("Missing pre-return fixture snapshot");
    const after = snapshot(c, p);
    evidence(`03-stale-reward-${reclose ? "reclosed" : "open"}`, { beforeReturn, after, operations: c.state.operations });
    expect.soft(after.episode!.rTask).toBeUndefined();
    expect.soft(after.trace!.value).toBe(beforeReturn.trace!.value);
    expect.soft(after.jobs.filter((row) => row.job_type === "l2_association")).toHaveLength(0);
    expect.soft(after.trials).toEqual(beforeReturn.trials);
  });

  it("REGRESSION: reopening clears obsolete abandonment metadata and skill skipped state", async () => {
    const c = setup(); const p = await prepare(c);
    c.repos.runtime.closeEpisode(p.first.episodeId, { closeReason: "abandoned", abandonReason: "insufficient_turns" });
    c.state.relation = "revision";
    await c.service.startTurn({ turnId: "revision", sessionId: p.session.sessionId, query: "wrong, verify nginx TLS certificate instead" });
    c.service.completeTurn("revision", { sessionId: p.session.sessionId, query: "wrong, verify nginx TLS certificate instead", answer: "Corrected TLS." });
    const episode = c.repos.runtime.getEpisode(p.first.episodeId)!;
    evidence("04-abandonment-state", { episode, skillStatus: episodeSkillStatus(episode) });
    expect.soft(episode.status).toBe("open");
    expect.soft(episode.meta.abandonReason).toBeUndefined();
    expect.soft(episodeSkillStatus(episode)).not.toBe("skipped");
  });

  it("REGRESSION: the same source event with changed wording contributes only once", async () => {
    const c = setup(); const p = await prepare(c);
    c.repos.runtime.closeEpisode(p.first.episodeId, { closeReason: "idle_timeout" });
    c.repos.runtime.updateEpisodeReward(p.first.episodeId, { rTask: -0.9, rewardDetail: { reason: "nginx certificate not verified" } });
    const payload = { source: "episode_reward", sourceEventId: p.first.episodeId };
    const firstJob = enqueue(c, p, "negative_experience", payload); await executeQueued(c, firstJob);
    const before = c.repos.memories.list({ memoryLayer: "L2" }, 100);
    c.state.variant = 1;
    const secondJob = enqueue(c, p, "negative_experience", payload); await executeQueued(c, secondJob);
    const after = c.repos.memories.list({ memoryLayer: "L2" }, 100);
    evidence("05-negative-wording", { firstJob, secondJob, before, after });
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(1);
  });

  it("CONTROL: identical wording and event are deduplicated after a succeeded job", async () => {
    const c = setup(); const p = await prepare(c);
    c.repos.runtime.updateEpisodeReward(p.first.episodeId, { rTask: -0.9, rewardDetail: {} });
    const payload = { source: "episode_reward", sourceEventId: p.first.episodeId };
    const a = enqueue(c, p, "negative_experience", payload); await executeQueued(c, a);
    const b = enqueue(c, p, "negative_experience", payload); await executeQueued(c, b);
    evidence("06-negative-control", { jobs: [a.id, b.id], memories: c.repos.memories.list({ memoryLayer: "L2" }, 100) });
    expect(b.id).not.toBe(a.id);
    expect(c.repos.memories.list({ memoryLayer: "L2" }, 100)).toHaveLength(1);
  });

  it("REGRESSION: real idle/reopen/reclose path duplicates the same automatic negative source event when wording changes", async () => {
    const c = setup(); const p = await prepare(c);
    c.service.completeTurn("extra-evidence", { sessionId: p.session.sessionId, episodeId: p.first.episodeId,
      query: "Also inspect nginx certificate chain verification", answer: "Inspected certificate chain and secure endpoint." });
    await runWorkerRounds(c.service, 4);
    c.state.reward = -0.9;
    c.state.relation = "follow_up";
    vi.setSystemTime(FIXED_TIME + 60_000);
    await c.service.startTurn({ turnId: "pending-followup", sessionId: p.session.sessionId, query: "Also verify nginx TLS certificate chain" });
    vi.setSystemTime(FIXED_TIME + 2 * 60 * 60_000 + 120_000);
    await prepare(c, "trigger B");
    vi.setSystemTime(Date.now() + 31_000); await runWorkerRounds(c.service, 8);
    const getContributions = () => c.repos.memories.list({ memoryLayer: "L2" }, 100)
      .filter((memory) => (memory.properties.internal_info.source_event_ids as string[] | undefined)?.includes(p.first.episodeId));
    const before = getContributions();
    expect(before).toHaveLength(1);
    c.state.variant = 1;
    const revised = c.service.completeTurn("pending-followup", { sessionId: p.session.sessionId,
      query: "Also verify nginx TLS certificate chain", answer: "Verified the full nginx certificate chain." });
    expect(revised.episodeId).toBe(p.first.episodeId);
    expect(c.repos.runtime.getEpisode(p.first.episodeId)!.feedbackIds).toHaveLength(0);
    await runWorkerRounds(c.service, 4);
    vi.setSystemTime(Date.now() + 2 * 60 * 60_000 + 60_000);
    await prepare(c, "trigger C");
    vi.setSystemTime(Date.now() + 31_000); await runWorkerRounds(c.service, 8);
    const after = getContributions();
    evidence("11-real-negative-duplicate", { before, after, episode: snapshot(c, p), operations: c.state.operations });
    expect(after).toHaveLength(1);
  });

  it.each(["boundaries", "empty"])("REGRESSION: replacing span set retires stale searchable spans (%s)", async (change) => {
    const c = setup(); const p = await prepare(c, "member A", 11);
    const payload = { rawTurnId: p.first.rawTurnId, rTask: 0.9 };
    await executeQueued(c, enqueue(c, p, "span_big_turn", payload, p.first.l1MemoryId));
    await runWorkerRounds(c.service, 3);
    const oldSpans = c.service.panelItems({ namespace: p.namespace, layer: "L1" }).items.filter((item) => item.kind === "span");
    expect(oldSpans).toHaveLength(2);
    const warm = await c.service.search({ namespace: p.namespace, query: "TLS old inspect nginx certificate", layers: ["L1"] });
    expect(warm.hits.map(hit => hit.id)).toContain(oldSpans[0]!.id);
    c.state.spans = change === "empty" ? [] : [
      { start: 0, end: 5, spanGoal: "TLS new inspect", summary: "Inspect and configure the secure nginx port" },
      { start: 6, end: 10, spanGoal: "TLS new verify", summary: "Verify the certificate for the secure endpoint" }
    ];
    await executeQueued(c, enqueue(c, p, "span_big_turn", payload, p.first.l1MemoryId));
    await runWorkerRounds(c.service, 3);
    const active = c.service.panelItems({ namespace: p.namespace, layer: "L1" }).items.filter((item) => item.kind === "span");
    const recalled = await c.service.search({ namespace: p.namespace, query: "TLS old inspect nginx certificate", layers: ["L1"] });
    evidence(`07-span-${change}`, { oldSpans, active, trace: traceMetaFromMemory(c.repos.memories.get(p.first.l1MemoryId)!), recalled: recalled.hits });
    expect.soft(active).toHaveLength(change === "empty" ? 0 : 2);
    expect.soft(recalled.hits.map((item) => item.id)).not.toEqual(expect.arrayContaining([oldSpans[0]!.id]));
  });

  it("REGRESSION: real reward replay after idle/reopen/reclose leaves the first turn's old span boundaries active", async () => {
    const c = setup(); const p = await prepare(c, "member A", 11);
    c.service.completeTurn("extra-evidence", { sessionId: p.session.sessionId, episodeId: p.first.episodeId,
      query: "Also inspect nginx certificate chain verification", answer: "Inspected certificate chain and secure endpoint." });
    await runWorkerRounds(c.service, 4);
    vi.setSystemTime(FIXED_TIME + 60_000);
    await c.service.startTurn({ turnId: "pending-followup", sessionId: p.session.sessionId, query: "Also verify nginx TLS certificate chain" });
    vi.setSystemTime(FIXED_TIME + 2 * 60 * 60_000 + 120_000);
    await prepare(c, "trigger B");
    vi.setSystemTime(Date.now() + 31_000); await runWorkerRounds(c.service, 8);
    const getSpans = () => c.repos.memories.list({ memoryLayer: "L1" }, 100)
      .filter((memory) => memory.properties.internal_info.memory_kind === "span");
    const before = getSpans(); expect(before).toHaveLength(2);
    c.state.spans = [{ start: 0, end: 5, spanGoal: "TLS new inspect", summary: "Inspect secure nginx configuration" },
      { start: 6, end: 10, spanGoal: "TLS new verify", summary: "Verify the secure nginx certificate chain" }];
    const revised = c.service.completeTurn("pending-followup", { sessionId: p.session.sessionId, query: "Also verify nginx TLS certificate chain", answer: "Verified the full nginx certificate chain." });
    expect(revised.episodeId).toBe(p.first.episodeId);
    await runWorkerRounds(c.service, 4);
    vi.setSystemTime(Date.now() + 2 * 60 * 60_000 + 60_000);
    await prepare(c, "trigger C");
    vi.setSystemTime(Date.now() + 31_000); await runWorkerRounds(c.service, 8);
    const after = getSpans();
    const recalled = await c.service.search({ namespace: p.namespace, query: "TLS old inspect nginx certificate", layers: ["L1"] });
    evidence("13-real-span-replay", { before, after, recalled: recalled.hits, episode: snapshot(c, p), operations: c.state.operations });
    expect.soft(after).toHaveLength(2);
    expect.soft(recalled.hits.map((hit) => hit.id).some((id) => before.some((memory) => memory.id === id))).toBe(false);
  });

  it("REGRESSION: assigning member A twice preserves a two-member cluster centroid", async () => {
    const c = setup(); const a = await prepare(c, "member A"); const b = await prepare(c, "member B");
    for (const p of [a, b]) {
      c.repos.runtime.closeEpisode(p.first.episodeId, { closeReason: "idle_timeout" });
      c.repos.runtime.updateEpisodeReward(p.first.episodeId, { rTask: -0.9, rewardDetail: {} });
      await executeQueued(c, enqueue(c, p, "skill_cluster_assign"));
      await runWorkerRounds(c.service, 2);
    }
    const before = c.repos.runtime.getSkillClusterForEpisode(a.first.episodeId)!;
    expect(c.repos.runtime.getSkillClusterForEpisode(b.first.episodeId)?.id).toBe(before.id);
    expect(before.memberCount).toBe(2);
    await executeQueued(c, enqueue(c, a, "skill_cluster_assign"));
    const after = c.repos.runtime.getSkillCluster(before.id)!;
    evidence("08-cluster-centroid", { before, after, members: c.repos.runtime.listSkillClusterMembers(before.id), expected: [0.9, 0.3, 0] });
    expect.soft(after.memberCount).toBe(2);
    expect.soft(after.centroid![0]).toBeCloseTo(before.centroid![0]!);
    expect.soft(after.centroid![1]).toBeCloseTo(before.centroid![1]!);
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
});


function negatives(c: Context) {
  return c.repos.memories.list({ memoryLayer: "L2" }, 100).filter(memory => memory.properties.internal_info.negative_contributions);
}
async function negative(c: Context, p: Prepared) {
  c.repos.runtime.closeEpisode(p.first.episodeId, { closeReason: "idle_timeout" });
  c.repos.runtime.updateEpisodeReward(p.first.episodeId, { rTask: -0.9, rewardDetail: { reason: "certificate unchecked" } });
  await executeQueued(c, enqueue(c, p, "negative_experience", { source: "episode_reward", sourceEventId: p.first.episodeId }));
}

describe("MEMMY-647 revision boundaries", () => {
  it("checks a stable negative source before spending another model call", async () => {
    const c = setup(); const p = await prepare(c); await negative(c, p);
    const count = c.state.operations.filter(op => op === "failure.experience.sink.v5").length;
    await executeQueued(c, enqueue(c, p, "negative_experience", { source: "episode_reward", sourceEventId: p.first.episodeId }));
    expect(c.state.operations.filter(op => op === "failure.experience.sink.v5")).toHaveLength(count);
  });

  it("revises one shared negative source without removing another source's content", async () => {
    const c = setup(); const a = await prepare(c); const b = await prepare(c, "member B");
    await negative(c, a); await negative(c, b);
    expect(negatives(c)).toHaveLength(1);
    expect(negatives(c)[0]!.info.support).toBe(2);
    c.state.variant = 1;
    c.repos.runtime.updateEpisodeReward(a.first.episodeId, { rTask: -0.8, rewardDetail: { reason: "revised evidence" } });
    await executeQueued(c, enqueue(c, a, "negative_experience", { source: "episode_reward", sourceEventId: a.first.episodeId }));
    const policies = negatives(c);
    expect(policies).toHaveLength(2);
    const fromA = policies.find(row => (row.properties.internal_info.source_event_ids as string[]).includes(a.first.episodeId))!;
    const fromB = policies.find(row => (row.properties.internal_info.source_event_ids as string[]).includes(b.first.episodeId))!;
    expect(fromA.id).not.toBe(fromB.id);
    expect((fromA.properties.internal_info.policy as { decision_guidance: { preference: string[] } }).decision_guidance.preference.join(" ")).toContain("Validate the certificate");
    expect((fromB.properties.internal_info.policy as { decision_guidance: { preference: string[] } }).decision_guidance.preference.join(" ")).toContain("Check nginx TLS");
    expect(fromA.info.support).toBe(1); expect(fromB.info.support).toBe(1);
  });

  it("retires only the superseded automatic low-score contribution after recovery", async () => {
    const c = setup(); const a = await prepare(c); const b = await prepare(c, "member B");
    await negative(c, a); await negative(c, b);
    c.repos.runtime.updateEpisodeReward(a.first.episodeId, { rTask: 0.8, rewardDetail: { reason: "recovered" } });
    await executeQueued(c, enqueue(c, a, "negative_experience", { source: "episode_reward", sourceEventId: a.first.episodeId }));
    expect(negatives(c)).toHaveLength(1);
    expect(negatives(c)[0]!.properties.internal_info.source_event_ids).toEqual([b.first.episodeId]);
    expect(c.repos.runtime.listRawTurnsByEpisode(a.first.episodeId)).toHaveLength(1);
  });

  it("keeps the old negative result when replacement generation fails", async () => {
    const c = setup(); const p = await prepare(c); await negative(c, p);
    const before = negatives(c)[0]!;
    c.repos.runtime.updateEpisodeReward(p.first.episodeId, { rTask: -0.8, rewardDetail: { reason: "revised" } });
    c.state.failOperation = "failure.experience.sink.v5";
    const job = enqueue(c, p, "negative_experience", { source: "episode_reward", sourceEventId: p.first.episodeId });
    await runWorkerRounds(c.service, 4);
    expect(c.repos.runtime.getJob(job.id)?.status).toBe("dead_letter");
    expect(negatives(c)[0]!.memoryValue).toBe(before.memoryValue);
    c.state.failOperation = "";
    await executeQueued(c, enqueue(c, p, "negative_experience", { source: "episode_reward", sourceEventId: p.first.episodeId }));
    expect(negatives(c)).toHaveLength(1);
  });

  it("retains complete source identity beyond the display cap", async () => {
    const c = setup(); let first!: Prepared;
    for (let i = 0; i < 22; i++) {
      const p = await prepare(c, `source ${i}`); if (i === 0) first = p;
      await negative(c, p);
    }
    expect(negatives(c)).toHaveLength(1);
    expect(negatives(c)[0]!.info.support).toBe(22);
    expect(Object.keys(negatives(c)[0]!.properties.internal_info.negative_contributions as object)).toHaveLength(22);
    c.state.variant = 1;
    const last = await prepare(c, "source 22"); await negative(c, last);
    await executeQueued(c, enqueue(c, first, "negative_experience", { source: "episode_reward", sourceEventId: first.first.episodeId }));
    expect(negatives(c)).toHaveLength(2);
    expect(negatives(c).map(row => Number(row.info.support)).sort((a,b) => a-b)).toEqual([1,22]);
  });

  it.each(["negative_experience", "span_big_turn"])("rejects stale %s output after reopen and reclose", async type => {
    const c = setup(); const p = await prepare(c, "member A", 11);
    c.repos.runtime.closeEpisode(p.first.episodeId, { closeReason: "idle_timeout" });
    c.repos.runtime.updateEpisodeReward(p.first.episodeId, { rTask: -0.9, rewardDetail: {} });
    c.state.blockOperation = type === "negative_experience" ? "failure.experience.sink.v5" : "span.big_turn.v1";
    c.state.modelStarted = gate(); c.state.modelRelease = gate();
    const payload = type === "negative_experience" ? { source: "episode_reward", sourceEventId: p.first.episodeId }
      : { rawTurnId: p.first.rawTurnId, rTask: 0.9 };
    const job = enqueue(c, p, type, payload, type === "span_big_turn" ? p.first.l1MemoryId : undefined);
    const running = c.service.runWorkerOnce(1);
    try {
      await waitForGate(c.state.modelStarted);
      c.repos.runtime.reopenEpisode(p.first.episodeId);
      c.repos.runtime.closeEpisode(p.first.episodeId, { closeReason: "idle_timeout" });
    } finally { c.state.modelRelease.release(); await running; }
    expect(c.repos.runtime.getJob(job.id)?.status).toBe("succeeded");
    expect(negatives(c)).toHaveLength(0);
    expect(c.repos.memories.listSpansForTrace(p.first.l1MemoryId)).toHaveLength(0);
  });

  it("preserves spans on invalid output and isolates a different source trace", async () => {
    const c = setup(); const a = await prepare(c, "member A", 11); const b = await prepare(c, "member B", 11);
    for (const p of [a,b]) await executeQueued(c, enqueue(c, p, "span_big_turn", { rawTurnId: p.first.rawTurnId, rTask: 0.9 }, p.first.l1MemoryId));
    const before = c.repos.memories.listSpansForTrace(a.first.l1MemoryId).map(row => row.id);
    c.state.spans = [{ start: 9, end: 4, spanGoal: "invalid", summary: "invalid" }];
    const job = enqueue(c, a, "span_big_turn", { rawTurnId: a.first.rawTurnId, rTask: 0.9 }, a.first.l1MemoryId);
    await runWorkerRounds(c.service, 4);
    expect(c.repos.runtime.getJob(job.id)?.status).toBe("dead_letter");
    expect(c.repos.memories.listSpansForTrace(a.first.l1MemoryId).map(row => row.id)).toEqual(before);
    c.state.spans = [];
    await executeQueued(c, enqueue(c, a, "span_big_turn", { rawTurnId: a.first.rawTurnId, rTask: 0.9 }, a.first.l1MemoryId));
    expect(c.repos.memories.listSpansForTrace(a.first.l1MemoryId)).toHaveLength(0);
    expect(c.repos.memories.listSpansForTrace(b.first.l1MemoryId)).toHaveLength(2);
  });

  it("rolls reward and trial writes back together when a downstream enqueue fails", async () => {
    const c = setup(); const p = await prepare(c);
    c.repos.runtime.closeEpisode(p.first.episodeId, { closeReason: "idle_timeout" });
    const job = enqueue(c, p, "reward", { l1MemoryId: p.first.l1MemoryId, polarity: "positive", magnitude: 1 });
    c.db.db.exec(`CREATE TEMP TRIGGER fail_647_enqueue BEFORE INSERT ON evolution_jobs
      WHEN NEW.job_type = 'l2_association' BEGIN SELECT RAISE(ABORT, 'synthetic enqueue failure'); END`);
    await runWorkerRounds(c.service, 3);
    expect(c.repos.runtime.getJob(job.id)?.status).toBe("dead_letter");
    expect(c.repos.runtime.getEpisode(p.first.episodeId)?.rTask).toBeUndefined();
    expect(traceMetaFromMemory(c.repos.memories.get(p.first.l1MemoryId)!)?.value).toBe(0);
    c.db.db.exec("DROP TRIGGER fail_647_enqueue");
    await executeQueued(c, enqueue(c, p, "reward", { l1MemoryId: p.first.l1MemoryId, polarity: "positive", magnitude: 1 }));
    expect(c.repos.runtime.getEpisode(p.first.episodeId)?.rTask).toBe(0.9);
  });
});

async function numericFixture(c: Context) {
  const a = await prepare(c); const b = await prepare(c, "member B"); const d = await prepare(c, "member C");
  for (const p of [a,b,d]) {
    makeTraceEligibleForL2(c.db, p.first.l1MemoryId);
    setTraceSignatureAndVectorForTest(c.db, p.first.l1MemoryId, "python|pytest|_|_", [1,0,0]);
  }
  const source = c.repos.memories.get(a.first.l1MemoryId)!;
  insertActivePolicyMemory(c.db, { id: "revision-policy", userId: a.namespace.userId, sessionId: a.session.sessionId,
    agentId: source.agentId ?? "codex", appId: source.appId ?? "647-test", profileId: a.namespace.profileId,
    sourceTraceId: a.first.l1MemoryId, sourceEpisodeId: a.first.episodeId });
  insertActiveSkillMemoryForTest(c.db, { id: "revision-skill", userId: a.namespace.userId, sessionId: a.session.sessionId,
    agentId: source.agentId ?? "codex", profileId: a.namespace.profileId, sourcePolicyIds: ["revision-policy"] });
  for (const p of [a,b,d]) insertTracePolicyLinkForTest(c.db, { userId: a.namespace.userId, l1MemoryId: p.first.l1MemoryId, l2MemoryId: "revision-policy" });
  const updateValue = (p: Prepared, value: number) => {
    const memory = c.repos.memories.get(p.first.l1MemoryId)!;
    c.repos.memories.update({ ...memory, properties: { ...memory.properties, internal_info: { ...memory.properties.internal_info,
      trace: { ...(memory.properties.internal_info.trace as Record<string, unknown>), value } } } });
  };
  return { a,b,d, updateValue, associate: (p: Prepared) => executeQueued(c, enqueue(c, p, "l2_association", {}, p.first.l1MemoryId)),
    read: () => ({ policy: policyMetaFromMemory(c.repos.memories.get("revision-policy")!)!, skill: skillMetaFromMemory(c.repos.memories.get("revision-skill")!)! }) };
}

// Independent scalar calculation of the existing estimator for three evidence traces and no reference-only traces.
function expectedRawGain(values: number[]) {
  const maximum = Math.max(...values);
  const weights = values.map(value => Math.exp((value - maximum) / 0.5));
  const weighted = values.reduce((sum, value, i) => sum + value * weights[i]!, 0) / weights.reduce((a,b) => a+b,0);
  const baseline = Math.max(0.2, Math.min(0.5, values.reduce((a,b) => a+b,0) / values.length));
  return weighted - baseline;
}

describe("MEMMY-647 interleaved numerical updates", () => {
  it("preserves first-pass values and replays A / trial / B with revised A evidence", async () => {
    const c = setup(); const f = await numericFixture(c);
    await f.associate(f.a);
    expect(f.read().policy.gain).toBeCloseTo(0.68);
    expect(f.read().skill.eta).toBeCloseTo(0.764);
    c.service.useSkill("revision-skill", { adapterId: "647-test", requestId: "interleaved-trial", sessionId: f.a.session.sessionId,
      episodeId: f.a.first.episodeId, rawTurnId: f.a.first.rawTurnId, turnId: f.a.first.turnId });
    const feedback = await c.service.feedback({ sessionId: f.a.session.sessionId, episodeId: f.a.first.episodeId, rawTurnId: f.a.first.rawTurnId,
      channel: "explicit", polarity: "positive", magnitude: 1, rationale: "verified trial" });
    const trialJob = feedback.jobs.find(job => job.jobType === "skill_trial_resolve")!;
    await executeQueued(c, c.repos.runtime.getJob(trialJob.jobId)!);
    expect(f.read().skill.eta).toBeCloseTo((0.764 + 1) / 2);
    f.updateValue(f.b, 0.6); await f.associate(f.b);
    f.updateValue(f.a, 0.4); await f.associate(f.a);
    const correctedA = 0.6 * 0.8 + 0.4 * expectedRawGain([0.4,1,1]);
    const correctedB = 0.6 * correctedA + 0.4 * expectedRawGain([0.4,0.6,1]);
    const expectedEta = 0.7 * ((0.7 * 0.8 + 0.3 * correctedA + 1) / 2) + 0.3 * correctedB;
    expect(f.read().policy.gain).toBeCloseTo(correctedB);
    expect(f.read().skill.eta).toBeCloseTo(expectedEta);
    expect(f.read().skill.trialsAttempted).toBe(1); expect(f.read().skill.trialsPassed).toBe(1);
    const before = f.read(); await f.associate(f.a);
    expect(f.read().policy.gain).toBe(before.policy.gain); expect(f.read().skill.eta).toBe(before.skill.eta);
  });

  it("revises the resulting Skill state as well as eta", async () => {
    const c = setup(0.76);
    const f = await numericFixture(c);
    f.updateValue(f.a, 0.4); await f.associate(f.a);
    expect(f.read().skill.status).toBe("archived");
    f.updateValue(f.a, 1); await f.associate(f.a);
    expect(f.read().skill.eta).toBeCloseTo(0.764);
    expect(f.read().skill.status).toBe("active");
  });

  it("does not persist gain without its corresponding eta update on failure", async () => {
    const c = setup(); const f = await numericFixture(c); const before = f.read();
    c.db.db.exec(`CREATE TEMP TRIGGER fail_647_skill BEFORE UPDATE ON memories
      WHEN NEW.id = 'revision-skill' BEGIN SELECT RAISE(ABORT, 'synthetic skill failure'); END`);
    const job = enqueue(c, f.a, "l2_association", {}, f.a.first.l1MemoryId);
    await runWorkerRounds(c.service, 4);
    expect(c.repos.runtime.getJob(job.id)?.status).toBe("dead_letter");
    expect(f.read().policy.gain).toBe(before.policy.gain); expect(f.read().skill.eta).toBe(before.skill.eta);
    c.db.db.exec("DROP TRIGGER fail_647_skill");
    await f.associate(f.a);
    expect(f.read().policy.gain).toBeCloseTo(0.68); expect(f.read().skill.eta).toBeCloseTo(0.764);
  });
});

describe("MEMMY-647 task replacement and cluster revisions", () => {
  it("keeps a new reward task while the old generation is leased", async () => {
    const c = setup(); const p = await prepare(c);
    c.repos.runtime.closeEpisode(p.first.episodeId, { closeReason: "idle_timeout" });
    const first = await c.service.feedback({ sessionId: p.session.sessionId, episodeId: p.first.episodeId,
      l1MemoryId: p.first.l1MemoryId, channel: "explicit", polarity: "positive", magnitude: 1, rationale: "first assessment" });
    const oldJob = c.repos.runtime.getJob(first.jobs.find(job => job.jobType === "reward")!.jobId)!;
    c.state.rewardStarted = gate(); c.state.rewardRelease = gate();
    const running = c.service.runWorkerOnce(1);
    let nextJob: EvolutionJobRecord | undefined;
    try {
      await waitForGate(c.state.rewardStarted);
      c.repos.runtime.reopenEpisode(p.first.episodeId);
      c.repos.runtime.closeEpisode(p.first.episodeId, { closeReason: "idle_timeout" });
      const second = await c.service.feedback({ sessionId: p.session.sessionId, episodeId: p.first.episodeId,
        l1MemoryId: p.first.l1MemoryId, channel: "explicit", polarity: "positive", magnitude: 1, rationale: "revised assessment" });
      nextJob = c.repos.runtime.getJob(second.jobs.find(job => job.jobType === "reward")!.jobId)!;
      expect(nextJob.id).not.toBe(oldJob.id);
      expect(nextJob.dedupeKey).not.toBe(oldJob.dedupeKey);
      expect(c.repos.runtime.getJob(oldJob.id)?.status).toBe("leased");
      expect(nextJob.status).toBe("queued");
    } finally { c.state.rewardRelease.release(); await running; }
    expect(c.repos.runtime.getEpisode(p.first.episodeId)?.rTask).toBeUndefined();
    c.state.rewardStarted = undefined; c.state.rewardRelease = undefined;
    await executeQueued(c, nextJob!);
    expect(c.repos.runtime.getEpisode(p.first.episodeId)?.rTask).toBe(0.9);
  });

  it("removes obsolete member tools while retaining other members and their weights", async () => {
    const c = setup(); const a = await prepare(c); const b = await prepare(c, "member B");
    for (const p of [a,b]) {
      c.repos.runtime.closeEpisode(p.first.episodeId, { closeReason: "idle_timeout" });
      c.repos.runtime.updateEpisodeReward(p.first.episodeId, { rTask: -0.9, rewardDetail: {} });
      await executeQueued(c, enqueue(c, p, "skill_cluster_assign"));
      await runWorkerRounds(c.service, 2);
    }
    const clusterId = c.repos.runtime.getSkillClusterForEpisode(a.first.episodeId)!.id;
    for (const [i,p] of [a,b].entries()) {
      vi.setSystemTime(Date.now() + 1000);
      c.db.db.prepare("UPDATE raw_turns SET tool_calls_json = ? WHERE id = ?")
        .run(JSON.stringify([{ name: "curl", input: {}, output: { ok: true }, success: true }]), p.first.rawTurnId);
      await executeQueued(c, enqueue(c, p, "skill_cluster_assign"));
      const cluster = c.repos.runtime.getSkillCluster(clusterId)!;
      expect(cluster.tools).toEqual(i === 0 ? ["curl", "run_tests"] : ["curl"]);
      expect(cluster.memberCount).toBe(2);
      expect(cluster.centroid![0]).toBeCloseTo(0.9); expect(cluster.centroid![1]).toBeCloseTo(0.3);
    }
  });
});

describe("MEMMY-647 legacy source compatibility", () => {
  function makeLegacy(c: Context, memoryId: string, episodes: Prepared[]) {
    const memory = c.repos.memories.get(memoryId)!;
    const { negative_contributions: _contributions, ...internal } = memory.properties.internal_info;
    c.repos.memories.update({ ...memory, properties: { ...memory.properties, internal_info: internal } });
    for (const p of episodes) c.repos.runtime.updateEpisodeMeta(p.first.episodeId, { negativeExperienceSources: {} });
  }

  it("adopts a legacy single-source record by its existing source ID", async () => {
    const c = setup(); const p = await prepare(c); await negative(c, p);
    const before = negatives(c)[0]!; makeLegacy(c, before.id, [p]);
    c.state.variant = 1;
    c.repos.runtime.updateEpisodeReward(p.first.episodeId, { rTask: -0.8, rewardDetail: { reason: "revised evidence" } });
    await executeQueued(c, enqueue(c, p, "negative_experience", { source: "episode_reward", sourceEventId: p.first.episodeId }));
    expect(negatives(c)).toHaveLength(1);
    expect(negatives(c)[0]!.id).toBe(before.id);
    expect(Object.keys(negatives(c)[0]!.properties.internal_info.negative_contributions as object)).toEqual([`episode_reward:${p.first.episodeId}`]);
  });

  it("does not invent attribution or add duplicates for a legacy shared record", async () => {
    const c = setup(); const a = await prepare(c); const b = await prepare(c, "member B");
    await negative(c, a); await negative(c, b);
    const before = negatives(c)[0]!; makeLegacy(c, before.id, [a,b]);
    c.state.variant = 1;
    c.repos.runtime.updateEpisodeReward(a.first.episodeId, { rTask: -0.8, rewardDetail: { reason: "revised evidence" } });
    await executeQueued(c, enqueue(c, a, "negative_experience", { source: "episode_reward", sourceEventId: a.first.episodeId }));
    const policies = c.repos.memories.list({ memoryLayer: "L2" }, 100);
    expect(policies).toHaveLength(1); expect(policies[0]!.memoryValue).toBe(before.memoryValue);
    expect(c.repos.runtime.getEpisode(a.first.episodeId)!.meta.negativeExperienceSources).toMatchObject({
      [`episode_reward:${a.first.episodeId}`]: { memoryId: before.id, legacySharedNeedsReview: true }
    });
  });
});

it("keeps an independent feedback event eligible after the Episode reopens", async () => {
  const c = setup(); const p = await prepare(c);
  const feedback = await c.service.feedback({ sessionId: p.session.sessionId, episodeId: p.first.episodeId,
    l1MemoryId: p.first.l1MemoryId, channel: "explicit", polarity: "negative", magnitude: 1, rationale: "verify TLS before claiming completion" });
  c.repos.runtime.reopenEpisode(p.first.episodeId);
  const job = enqueue(c, p, "negative_experience", { source: "negative_feedback", sourceEventId: feedback.feedbackId,
    feedbackId: feedback.feedbackId, episodeRevision: "old-queued-context", episodeGeneration: 0 });
  await executeQueued(c, job);
  expect(negatives(c).some(row => (row.properties.internal_info.source_event_ids as string[]).includes(feedback.feedbackId))).toBe(true);
});

it("attributes a queued assessment to the latest feedback actually used for scoring", async () => {
  const c = setup(); const p = await prepare(c);
  c.repos.runtime.closeEpisode(p.first.episodeId, { closeReason: "idle_timeout" });
  // Finish reflection first so these two queued rewards have identical effective inputs.
  await executeQueued(c, enqueue(c, p, "reflection", { targetKind: "episode" }, p.first.l1MemoryId));
  c.state.reward = -0.9;
  await c.service.feedback({ sessionId: p.session.sessionId, episodeId: p.first.episodeId, l1MemoryId: p.first.l1MemoryId,
    channel: "explicit", polarity: "negative", magnitude: 0.5, rationale: "first incomplete assessment" });
  const latest = await c.service.feedback({ sessionId: p.session.sessionId, episodeId: p.first.episodeId, l1MemoryId: p.first.l1MemoryId,
    channel: "explicit", polarity: "negative", magnitude: 1, rationale: "latest: certificate verification failed" });
  await runWorkerRounds(c.service, 8);
  expect(c.state.operations.filter(op => op === "reward.reward.r_human.v7")).toHaveLength(1);
  expect(negatives(c).some(row => (row.properties.internal_info.source_event_ids as string[]).includes(latest.feedbackId))).toBe(true);
});

it("retries optional value-distribution repair independently after reward commits", async () => {
  const c = setup(undefined, true); const high = await prepare(c); const low = await prepare(c, "member B");
  for (const p of [high, low]) setTraceSignatureAndVectorForTest(c.db, p.first.l1MemoryId, "same-tls-context", [1, 0, 0]);
  const lowMemory = c.repos.memories.get(low.first.l1MemoryId)!;
  c.repos.memories.update({ ...lowMemory, properties: { ...lowMemory.properties, internal_info: { ...lowMemory.properties.internal_info,
    trace: { ...(lowMemory.properties.internal_info.trace as Record<string, unknown>), value: -1 } } } });
  c.repos.runtime.closeEpisode(high.first.episodeId, { closeReason: "idle_timeout" });
  await executeQueued(c, enqueue(c, high, "reward", {}, high.first.l1MemoryId));
  const rewardCalls = c.state.operations.filter(op => op === "reward.reward.r_human.v7").length;
  const repairJob = snapshot(c, high).jobs.find(job => JSON.parse(job.payload_json).afterRewardRepair === true)!;
  expect(repairJob).toBeDefined();
  c.db.db.exec("CREATE TEMP TRIGGER fail_647_repair BEFORE INSERT ON decision_repairs BEGIN SELECT RAISE(ABORT, 'synthetic repair failure'); END");
  for (let round = 0; round < 20 && !c.repos.runtime.getJob(repairJob.id)?.attempts; round++) await c.service.runWorkerOnce(1);
  expect(c.repos.runtime.getEpisode(high.first.episodeId)?.rTask).toBe(0.9);
  expect(c.repos.runtime.getJob(repairJob.id)?.attempts).toBeGreaterThan(0);
  expect(c.repos.runtime.getJob(repairJob.id)?.lastError).toContain("synthetic repair failure");
  expect(c.repos.runtime.listDecisionRepairs({ userId: high.namespace.userId })).toHaveLength(0);
  c.db.db.exec("DROP TRIGGER fail_647_repair");
  vi.setSystemTime(Date.now() + 60_000);
  await runWorkerRounds(c.service, 6);
  expect(c.repos.runtime.getJob(repairJob.id)?.status).toBe("succeeded");
  expect(c.repos.runtime.listDecisionRepairs({ userId: high.namespace.userId })).toHaveLength(1);
  await executeQueued(c, enqueue(c, high, "reward", { afterRewardRepair: true }, high.first.l1MemoryId));
  expect(c.repos.runtime.listDecisionRepairs({ userId: high.namespace.userId })).toHaveLength(1);
  expect(c.state.operations.filter(op => op === "reward.reward.r_human.v7")).toHaveLength(rewardCalls);
});


describe("MEMMY-647 review follow-up", () => {
  it("refreshes revised B while assigning A, invalidates B processing, and keeps later B idempotent", async () => {
    const { stableHash, stableStringify } = await import("../../../src/utils/id.js");
    const c = setup(); const a = await prepare(c); const b = await prepare(c, "member B");
    for (const p of [a,b]) {
      c.repos.runtime.closeEpisode(p.first.episodeId, { closeReason: "idle_timeout" });
      c.repos.runtime.updateEpisodeReward(p.first.episodeId, { rTask: -0.9, rewardDetail: {} });
      await executeQueued(c, enqueue(c, p, "skill_cluster_assign"));
      await runWorkerRounds(c.service, 2);
      const episode = c.repos.runtime.getEpisode(p.first.episodeId)!;
      c.repos.runtime.updateEpisodeMeta(episode.id, { clusterProcessedFeatures: stableHash(stableStringify(episode.meta.clusterFeatures)) });
    }
    const cluster = c.repos.runtime.getSkillClusterForEpisode(a.first.episodeId)!;
    expect(c.repos.runtime.getSkillClusterForEpisode(b.first.episodeId)!.id).toBe(cluster.id);
    c.repos.runtime.updateSkillCluster({ ...cluster, processedEpisodeIds: [a.first.episodeId,b.first.episodeId] });
    c.db.db.prepare("UPDATE raw_turns SET tool_calls_json = ? WHERE id = ?")
      .run(JSON.stringify([{ name: "curl", input: {}, output: { ok: true }, success: true }]), b.first.rawTurnId);
    c.repos.runtime.updateEpisodeReward(b.first.episodeId, { rTask: -0.7, rewardDetail: {} });
    await executeQueued(c, enqueue(c, a, "skill_cluster_assign"));
    expect(c.repos.runtime.getSkillCluster(cluster.id)!.processedEpisodeIds).toEqual([a.first.episodeId]);
    expect(c.repos.runtime.listSkillClusterMembers(cluster.id).find(member => member.episodeId === b.first.episodeId)?.rTask).toBe(-0.7);
    for (let i = 0; i < 2; i++) {
      await executeQueued(c, enqueue(c, b, "skill_cluster_assign"));
      const revised = c.repos.runtime.getSkillCluster(cluster.id)!;
      expect(revised.tools).toEqual(["curl", "run_tests"]);
      expect(revised.memberCount).toBe(2);
      expect(revised.centroid![0]).toBeCloseTo(0.9);
      expect(revised.centroid![1]).toBeCloseTo(0.3);
    }
  });

  it.each(["sign", "value", "status", "membership"] as const)("rejects changed repair %s and retries against current evidence", async (change) => {
    const { DECISION_REPAIR_OPERATION } = await import("../../../src/service/feedback/feedback-experience.js");
    const { updateTraceScore } = await import("../../../src/service/evolution/reward-pipeline.js");
    const c = setup(undefined, true); const high = await prepare(c); const low = await prepare(c, "member B");
    const extra = change === "membership" ? await prepare(c, "member C") : undefined;
    for (const p of [high,low,...(extra ? [extra] : [])]) setTraceSignatureAndVectorForTest(c.db, p.first.l1MemoryId, "same-tls-context", [1,0,0]);
    const setValue = (p: Prepared, value: number) => {
      const m = c.repos.memories.get(p.first.l1MemoryId)!;
      return c.repos.memories.update(updateTraceScore(m, { value, alpha: 1, priority: Math.max(0,value), rHuman: value, rewardReason: "audit", updatedAt: new Date().toISOString() }));
    };
    setValue(high,1); const originalLow = setValue(low,-1);
    c.state.blockOperation = DECISION_REPAIR_OPERATION;
    c.state.modelStarted = gate(); c.state.modelRelease = gate();
    const job = enqueue(c, high, "reward", { afterRewardRepair: true }, high.first.l1MemoryId);
    c.db.db.prepare("UPDATE evolution_jobs SET max_attempts = 3 WHERE id = ?").run(job.id);
    const callsBefore = c.state.operations.filter(op => op === DECISION_REPAIR_OPERATION).length;
    const running = (async () => {
      for (let i = 0; i < 20 && !c.repos.runtime.getJob(job.id)?.attempts; i++) await c.service.runWorkerOnce(1);
    })();
    try {
      await waitForGate(c.state.modelStarted);
      if (change === "status") c.repos.memories.update({ ...originalLow, status: "archived" });
      else if (change === "membership") setValue(extra!, -0.8);
      else setValue(low, change === "sign" ? 1 : -0.8);
      // The old content-hash-only guard cannot distinguish any of these mutations.
      expect(c.repos.memories.get(low.first.l1MemoryId)!.contentHash).toBe(originalLow.contentHash);
    } finally { c.state.modelRelease.release(); await running; }
    expect(c.repos.runtime.listDecisionRepairs({ userId: high.namespace.userId })).toHaveLength(0);
    expect(c.repos.runtime.getJob(job.id)?.lastError).toContain("evidence changed");
    c.state.blockOperation = "";
    vi.setSystemTime(Date.now() + 60_000);
    await runWorkerRounds(c.service, 6);
    expect(c.repos.runtime.getJob(job.id)?.status).toBe("succeeded");
    const repairs = c.repos.runtime.listDecisionRepairs({ userId: high.namespace.userId });
    const stillEligible = change === "value" || change === "membership";
    expect(repairs).toHaveLength(stillEligible ? 1 : 0);
    expect(c.state.operations.filter(op => op === DECISION_REPAIR_OPERATION).length - callsBefore).toBe(stillEligible ? 2 : 1);
    if (extra) expect(repairs[0]!.lowValueMemoryIds).toContain(extra.first.l1MemoryId);
    await executeQueued(c, enqueue(c, high, "reward", { afterRewardRepair: true }, high.first.l1MemoryId));
    expect(c.repos.runtime.listDecisionRepairs({ userId: high.namespace.userId })).toHaveLength(stillEligible ? 1 : 0);
    expect(c.state.operations.filter(op => op === DECISION_REPAIR_OPERATION).length - callsBefore).toBe(stillEligible ? 2 : 1);
  });

  it.each(["duplicate", "revision", "new source"] as const)("preserves Policy intervention discovered with %s and replays later sources in order", async (discovery) => {
    const { updatePolicyStats } = await import("../../../src/service/evolution/policy-induction.js");
    const c = setup(); const f = await numericFixture(c);
    await f.associate(f.a);
    const m = c.repos.memories.get("revision-policy")!; const p = policyMetaFromMemory(m)!;
    c.repos.memories.update(updatePolicyStats(m, { support: p.support, gain: 0.95, rawGain: 0.5, status: p.status,
      sourceEpisodeIds: p.sourceEpisodeIds, sourceTraceIds: p.sourceTraceIds, updatedAt: new Date().toISOString() }));
    if (discovery === "revision") f.updateValue(f.a,0.4);
    if (discovery === "new source") f.updateValue(f.b,0.6);
    await f.associate(discovery === "new source" ? f.b : f.a);
    const firstA = discovery === "revision" ? 0.6 * 0.8 + 0.4 * expectedRawGain([0.4,1,1]) : 0.68;
    const afterCheckpointEta = 0.7 * (0.7 * 0.8 + 0.3 * firstA) + 0.3 * 0.95;
    const expectedGain = discovery === "new source" ? 0.6 * 0.95 + 0.4 * expectedRawGain([1,0.6,1]) : 0.95;
    expect(f.read().policy.gain).toBeCloseTo(expectedGain);
    expect(f.read().skill.eta).toBeCloseTo(discovery === "new source" ? 0.7 * afterCheckpointEta + 0.3 * expectedGain : afterCheckpointEta);
    // A revision before the checkpoint cannot erase it; B continues after it.
    f.updateValue(f.a,0.4); await f.associate(f.a);
    f.updateValue(f.b,0.6); await f.associate(f.b);
    const revisedA = 0.6 * 0.8 + 0.4 * expectedRawGain([0.4,1,1]);
    const revisedB = 0.6 * 0.95 + 0.4 * expectedRawGain([0.4,0.6,1]);
    expect(f.read().policy.gain).toBeCloseTo(revisedB);
    expect(f.read().skill.eta).toBeCloseTo(0.7 * (0.7 * (0.7 * 0.8 + 0.3 * revisedA) + 0.3 * 0.95) + 0.3 * revisedB);
    const before = f.read(); await f.associate(f.b);
    expect(f.read().policy.gain).toBe(before.policy.gain); expect(f.read().skill.eta).toBe(before.skill.eta);
  });
});

describe("MEMMY-647 review follow-up", () => {
  it("re-derives an already resolved skill trial when the episode is rescored", async () => {
    const c = setup(); const p = await prepare(c);
    const source = c.repos.memories.get(p.first.l1MemoryId)!;
    insertActiveSkillMemoryForTest(c.db, { id: "reresolve-skill", userId: p.namespace.userId,
      sessionId: p.session.sessionId, agentId: source.agentId ?? "codex", profileId: p.namespace.profileId,
      sourcePolicyIds: [] });
    c.service.useSkill("reresolve-skill", { adapterId: "647-test", requestId: "reresolve-trial",
      sessionId: p.session.sessionId, episodeId: p.first.episodeId, rawTurnId: p.first.rawTurnId,
      turnId: p.first.turnId });
    const trial = (c.db.db.prepare("SELECT * FROM skill_trials WHERE episode_id = ?")
      .get(p.first.episodeId) as { id: string } | undefined)!;
    expect(trial.id).toBeTruthy();

    // First close scores the episode as a success and settles the trial.
    const settle = () => c.repos.runtime.listSkillTrials({ episodeId: p.first.episodeId, limit: 100 })
      .find(item => item.id === trial.id)!;
    c.repos.runtime.closeEpisode(p.first.episodeId, { closeReason: "idle_timeout" });
    await executeQueued(c, enqueue(c, p, "reward", { l1MemoryId: p.first.l1MemoryId, polarity: "positive", magnitude: 1 }));
    expect(settle().outcome).toBe("success");
    const passedEta = skillMetaFromMemory(c.repos.memories.get("reresolve-skill")!)!.eta;

    // Reopening and scoring it as a failure must flip the verdict and lower eta again,
    // instead of leaving the outdated success in place.
    c.repos.runtime.reopenEpisode(p.first.episodeId);
    c.repos.runtime.closeEpisode(p.first.episodeId, { closeReason: "idle_timeout" });
    c.state.reward = -0.9;
    await executeQueued(c, enqueue(c, p, "reward", { l1MemoryId: p.first.l1MemoryId, polarity: "negative", magnitude: 1 }));

    expect(settle().outcome).toBe("failure");
    const failedEta = skillMetaFromMemory(c.repos.memories.get("reresolve-skill")!)!.eta;
    expect(failedEta).toBeLessThan(passedEta);
  });
  it("recomputes eta when a settled trial becomes unknown after rescoring", async () => {
    const c = setup(); const p = await prepare(c);
    const source = c.repos.memories.get(p.first.l1MemoryId)!;
    insertActiveSkillMemoryForTest(c.db, { id: "unknown-skill", userId: p.namespace.userId,
      sessionId: p.session.sessionId, agentId: source.agentId ?? "codex", profileId: p.namespace.profileId,
      sourcePolicyIds: [] });
    const eta = () => skillMetaFromMemory(c.repos.memories.get("unknown-skill")!)!;
    const seed = eta();
    c.service.useSkill("unknown-skill", { adapterId: "647-test", requestId: "unknown-trial",
      sessionId: p.session.sessionId, episodeId: p.first.episodeId, rawTurnId: p.first.rawTurnId,
      turnId: p.first.turnId });
    c.repos.runtime.closeEpisode(p.first.episodeId, { closeReason: "idle_timeout" });
    await executeQueued(c, enqueue(c, p, "reward", { l1MemoryId: p.first.l1MemoryId, polarity: "positive", magnitude: 1 }));
    expect(eta().trialsAttempted).toBe(1);

    // Rescored between the failure and success thresholds: the verdict is withdrawn.
    c.repos.runtime.reopenEpisode(p.first.episodeId);
    c.repos.runtime.closeEpisode(p.first.episodeId, { closeReason: "idle_timeout" });
    c.state.reward = 0;
    await executeQueued(c, enqueue(c, p, "reward", { l1MemoryId: p.first.l1MemoryId }));

    const trial = c.repos.runtime.listSkillTrials({ episodeId: p.first.episodeId, limit: 10 })[0]!;
    expect(trial.outcome).toBe("unknown");
    expect(eta().trialsAttempted).toBe(0);
    expect(eta().eta).toBeCloseTo(seed.eta);
  });
});


describe("MEMMY-647 trial revision follow-up", () => {
  function addSkill(c: Context, p: Prepared, id = "trial-revision-skill") {
    const source = c.repos.memories.get(p.first.l1MemoryId)!;
    insertActiveSkillMemoryForTest(c.db, { id, userId: p.namespace.userId, sessionId: p.session.sessionId,
      agentId: source.agentId ?? "codex", profileId: p.namespace.profileId, sourcePolicyIds: [] });
    return id;
  }
  async function settle(c: Context, p: Prepared, skillId: string, feedbackId?: string) {
    vi.setSystemTime(Date.now() + 1);
    const trial = c.service.useSkill(skillId, { adapterId: "647-trial-revision", requestId: `trial-${++sequence}`,
      sessionId: p.session.sessionId, episodeId: p.first.episodeId, rawTurnId: p.first.rawTurnId, turnId: p.first.turnId });
    await executeQueued(c, enqueue(c, p, "skill_trial_resolve", { trialId: trial.trialId, rHuman: 0.9, feedbackId }));
    expect(c.repos.runtime.getSkillTrial(trial.trialId)!.outcome).toBe("success");
    return trial.trialId;
  }
  async function rescore(c: Context, p: Prepared, reward: number, feedbackId?: string) {
    if (c.repos.runtime.getEpisode(p.first.episodeId)!.status === "closed") c.repos.runtime.reopenEpisode(p.first.episodeId);
    c.repos.runtime.closeEpisode(p.first.episodeId, { closeReason: "idle_timeout" });
    c.state.reward = reward;
    await executeQueued(c, enqueue(c, p, "reward", { l1MemoryId: p.first.l1MemoryId, feedbackId,
      polarity: reward < 0 ? "negative" : "positive", magnitude: 1 }));
  }
  function read(c: Context, skillId: string) {
    const memory = c.repos.memories.get(skillId)!;
    const skill = skillMetaFromMemory(memory)!;
    const history = memory.properties.internal_info.skill_revision_history as {
      events: Array<{ id: string; type: string; attempted?: number; passed?: number;
        state?: { eta: number; status: string; trialsAttempted: number; trialsPassed: number } }>;
      last: { eta: number; status: string; trialsAttempted: number; trialsPassed: number };
    };
    expect(history.last).toEqual({ eta: skill.eta, status: skill.status,
      trialsAttempted: skill.trialsAttempted, trialsPassed: skill.trialsPassed });
    expect(memory.info).toMatchObject({ eta: skill.eta, trials_attempted: skill.trialsAttempted, trials_passed: skill.trialsPassed });
    return { memory, skill, history };
  }
  function feedback(c: Context, p: Prepared, channel: "implicit" | "explicit", polarity: "positive" | "negative") {
    return c.repos.runtime.insertFeedback({ id: `trial-feedback-${++sequence}`, userId: p.namespace.userId,
      sessionId: p.session.sessionId, episodeId: p.first.episodeId, l1MemoryId: p.first.l1MemoryId,
      rawTurnId: p.first.rawTurnId, channel, polarity, magnitude: 1, rationale: "synthetic trial verdict",
      rawPayload: {}, createdAt: new Date().toISOString() });
  }

  it.each(["failure", "unknown"] as const)("corrects an earlier %s verdict across episodes without retaining later stale snapshots", async outcome => {
    const c = setup(); const a = await prepare(c); const b = await prepare(c, "member B");
    const skillId = addSkill(c, a);
    const trialA = await settle(c, a, skillId); const trialB = await settle(c, b, skillId);
    expect(read(c, skillId).skill.eta).toBeCloseTo((0.8 + 2) / 3);
    await rescore(c, a, outcome === "failure" ? -0.9 : 0);
    const { skill, history } = read(c, skillId);
    expect(c.repos.runtime.getSkillTrial(trialA)!.outcome).toBe(outcome);
    expect(c.repos.runtime.getSkillTrial(trialB)!.outcome).toBe("success");
    expect(skill.trialsAttempted).toBe(outcome === "failure" ? 2 : 1);
    expect(skill.trialsPassed).toBe(1);
    expect(skill.eta).toBeCloseTo(outcome === "failure" ? 0.6 : 0.9);
    expect(history.events.filter(event => event.type === "trial").map(event => [event.attempted, event.passed]))
      .toEqual(outcome === "failure" ? [[1, 0], [2, 1]] : [[0, 0], [1, 1]]);
    await rescore(c, a, outcome === "failure" ? -0.9 : 0);
    expect(read(c, skillId).skill).toEqual(skill);
    expect(read(c, skillId).history).toEqual(history);
  });

  it.each(["failure", "unknown"] as const)("corrects multiple trials in one episode in repository reverse order to %s", async outcome => {
    const c = setup(); const p = await prepare(c); const skillId = addSkill(c, p);
    const trialA = await settle(c, p, skillId); const trialB = await settle(c, p, skillId);
    expect(c.repos.runtime.listSkillTrials({ episodeId: p.first.episodeId, limit: 10 }).map(trial => trial.id)).toEqual([trialB, trialA]);
    await rescore(c, p, outcome === "failure" ? -0.9 : 0);
    const { skill, history } = read(c, skillId);
    expect(skill.trialsAttempted).toBe(outcome === "failure" ? 2 : 0);
    expect(skill.trialsPassed).toBe(0);
    expect(skill.eta).toBeCloseTo(outcome === "failure" ? 0.8 / 3 : 0.8);
    await rescore(c, p, outcome === "failure" ? -0.9 : 0);
    expect(read(c, skillId).history).toEqual(history);
  });

  it("keeps a Policy update between two trials when replacing the earlier verdict", async () => {
    const c = setup(); const f = await numericFixture(c);
    const trialA = await settle(c, f.a, "revision-skill");
    await f.associate(f.d);
    await settle(c, f.b, "revision-skill");
    const before = read(c, "revision-skill").history.events.map(event => [event.id, event.type]);
    expect(before.map(event => event[1])).toEqual(["trial", "policy", "trial"]);
    await rescore(c, f.a, -0.9);
    const { skill, history } = read(c, "revision-skill");
    expect(c.repos.runtime.getSkillTrial(trialA)!.outcome).toBe("failure");
    expect(history.events.map(event => [event.id, event.type])).toEqual(before);
    // A's revised failure: .8/2=.4; then Policy gain=.68 gives .484;
    // B succeeds, with prior=.484*2 and two attempted trials in total.
    expect(skill.eta).toBeCloseTo(((0.7 * 0.4 + 0.3 * 0.68) * 2 + 1) / 3);
    expect(skill.trialsAttempted).toBe(2); expect(skill.trialsPassed).toBe(1);
  });

  it("keeps intervention eta and status while correcting counts through a later trial", async () => {
    const c = setup(); const a = await prepare(c); const b = await prepare(c, "member B");
    const skillId = addSkill(c, a); await settle(c, a, skillId);
    const memory = c.repos.memories.get(skillId)!;
    const internal = memory.properties.internal_info;
    c.repos.memories.update({ ...memory, info: { ...memory.info, eta: 0.7 }, properties: { ...memory.properties,
      internal_info: { ...internal, eta: 0.7, skill: { ...(internal.skill as Record<string, unknown>), eta: 0.7 } } } });
    await settle(c, b, skillId);
    const checkpoint = read(c, skillId).history.events.find(event => event.type === "checkpoint")!;
    expect(checkpoint.state).toMatchObject({ eta: 0.7, status: "active", trialsAttempted: 1, trialsPassed: 1 });
    await rescore(c, a, -0.9);
    const { skill, history } = read(c, skillId);
    expect(history.events.find(event => event.type === "checkpoint")!.state)
      .toEqual({ eta: 0.7, status: "active", trialsAttempted: 1, trialsPassed: 0 });
    expect(skill.eta).toBeCloseTo((Math.min(1, 0.7 * 2) + 1) / 3);
    expect(skill.trialsAttempted).toBe(2); expect(skill.trialsPassed).toBe(1);
  });

  it.each(["implicit", "explicit"] as const)("allows new feedback to replace only an old %s verdict as specified", async channel => {
    const c = setup(); const p = await prepare(c); const skillId = addSkill(c, p);
    const first = feedback(c, p, channel, "positive");
    const trialId = await settle(c, p, skillId, first.id);
    const second = feedback(c, p, "explicit", "negative");
    await rescore(c, p, -0.9, second.id);
    const trial = c.repos.runtime.getSkillTrial(trialId)!;
    expect(trial.outcome).toBe(channel === "implicit" ? "failure" : "success");
    expect(trial.feedbackId).toBe(channel === "implicit" ? second.id : first.id);
    expect(read(c, skillId).skill.eta).toBeCloseTo(channel === "implicit" ? 0.4 : 0.9);
  });

  it("adopts explicit feedback even when its verdict matches an implicit result, then protects it", async () => {
    const c = setup(); const p = await prepare(c); const skillId = addSkill(c, p);
    const first = feedback(c, p, "implicit", "positive");
    const trialId = await settle(c, p, skillId, first.id);
    const second = feedback(c, p, "explicit", "positive");
    const before = read(c, skillId);
    await rescore(c, p, 0.9, second.id);
    expect(c.repos.runtime.getSkillTrial(trialId)!.feedbackId).toBe(second.id);
    expect(read(c, skillId).history).toEqual(before.history);
    expect(read(c, skillId).skill).toEqual(before.skill);
    const third = feedback(c, p, "explicit", "negative");
    await rescore(c, p, -0.9, third.id);
    expect(c.repos.runtime.getSkillTrial(trialId)!).toMatchObject({ feedbackId: second.id, outcome: "success" });
    expect(read(c, skillId).history).toEqual(before.history);
    expect(read(c, skillId).skill).toEqual(before.skill);
  });
  function removeLegacyHistory(c: Context, skillId: string) {
    const memory = c.repos.memories.get(skillId)!;
    const { skill_revision_history: _old, ...internal } = memory.properties.internal_info;
    c.repos.memories.update({ ...memory, properties: { ...memory.properties, internal_info: internal } });
    // Pre-history versions did retain before/after snapshots, without revision events.
    for (const change of c.repos.runtime.listChanges(undefined, -1, undefined, undefined, skillId)) {
      const strip = (value: unknown) => {
        const row = value as { properties?: { internal_info?: Record<string, unknown> } } | undefined;
        if (row?.properties?.internal_info) delete row.properties.internal_info.skill_revision_history;
        return value === undefined ? null : JSON.stringify(value);
      };
      c.db.db.prepare("UPDATE memory_change_log SET before_json = ?, after_json = ? WHERE seq = ?")
        .run(strip(change.before), strip(change.after), change.seq);
    }
  }

  it.each([
    { legacy: false, initial: 0.9, reward: -0.9, channel: "implicit", outcome: "failure", eta: 0.4 },
    { legacy: true, initial: 0.9, reward: -0.9, channel: "implicit", outcome: "failure", eta: 0.4 },
    { legacy: true, initial: -0.9, reward: 0.9, channel: "implicit", outcome: "success", eta: 0.9 },
    { legacy: true, initial: 0.9, reward: 0, channel: "implicit", outcome: "unknown", eta: 0.8 },
    { legacy: true, initial: 0.9, reward: -0.9, channel: "explicit", outcome: "success", eta: 0.9 }
  ] as const)("revises after attribution-only updates (legacy: $legacy, initial: $initial, reward: $reward, channel: $channel)", async item => {
    const c = setup(); const a = await prepare(c); const skillId = addSkill(c, a);
    const { trialId } = c.service.useSkill(skillId, { sessionId: a.session.sessionId, episodeId: a.first.episodeId,
      rawTurnId: a.first.rawTurnId, turnId: a.first.turnId });
    await executeQueued(c, enqueue(c, a, "skill_trial_resolve", { trialId, rHuman: item.initial }));
    if (item.legacy) removeLegacyHistory(c, skillId);
    const before = c.repos.memories.get(skillId)!;
    let attributionId = "";
    // Repeated implicit attribution changes must not create numerical contributions.
    for (const channel of ["implicit", item.channel] as const) {
      const attribution = feedback(c, a, channel, item.initial > 0 ? "positive" : "negative");
      c.repos.runtime.appendEpisodeFeedback(a.first.episodeId, attribution.id);
      await rescore(c, a, item.initial, attribution.id);
      attributionId = attribution.id;
      expect(c.repos.runtime.getSkillTrial(trialId)).toMatchObject({
        outcome: item.initial > 0 ? "success" : "failure", feedbackId: attributionId });
      expect(c.repos.memories.get(skillId)).toEqual(before);
    }
    // Another explicit feedback must not replace the explicit attribution already adopted.
    const revision = feedback(c, a, item.channel, item.reward < 0 ? "negative" : "positive");
    c.repos.runtime.appendEpisodeFeedback(a.first.episodeId, revision.id);
    await rescore(c, a, item.reward, revision.id);
    expect(c.repos.runtime.getSkillTrial(trialId)).toMatchObject({ outcome: item.outcome,
      feedbackId: item.channel === "explicit" ? attributionId : revision.id });
    const memory = c.repos.memories.get(skillId)!;
    expect(skillMetaFromMemory(memory)!.eta).toBeCloseTo(item.eta);
    if (item.channel === "explicit") expect(memory).toEqual(before);
    else {
      const { skill, history } = read(c, skillId);
      expect(skill).toMatchObject({ trialsAttempted: item.outcome === "unknown" ? 0 : 1,
        trialsPassed: item.outcome === "success" ? 1 : 0 });
      expect(history.events.map(event => [event.type, event.id])).toEqual([["trial", `trial:${trialId}`]]);
    }
  });

  it.each(["prior-verdict-change", "missing-statistics"])("keeps the legacy recovery guard after attribution-only updates (%s)", async scenario => {
    const c = setup(); const a = await prepare(c); const skillId = addSkill(c, a);
    const trialId = await settle(c, a, skillId);
    const reward = scenario === "prior-verdict-change" ? -0.9 : 0.9;
    if (reward < 0) await rescore(c, a, reward);
    removeLegacyHistory(c, skillId);
    const attribution = feedback(c, a, "implicit", reward < 0 ? "negative" : "positive");
    await rescore(c, a, reward, attribution.id);
    if (scenario === "missing-statistics") {
      c.db.db.prepare("DELETE FROM memory_change_log WHERE memory_id = ? AND change_type = ?")
        .run(skillId, "skill_trial_update");
    }
    const before = c.repos.memories.get(skillId)!;
    const trialBefore = c.repos.runtime.getSkillTrial(trialId)!;
    await rescore(c, a, -reward);
    expect(c.repos.runtime.getSkillTrial(trialId)).toEqual(trialBefore);
    expect(c.repos.memories.get(skillId)).toEqual(before);
  });

  it.each([false, true])("ASTRA REVIEW: withdraws a legacy success included in history.base (later trial: %s)", async laterTrial => {
    const c = setup(); const a = await prepare(c); const b = await prepare(c, "member B");
    const skillId = addSkill(c, a); const trialA = await settle(c, a, skillId);
    removeLegacyHistory(c, skillId);
    if (laterTrial) await settle(c, b, skillId);
    await rescore(c, a, 0);
    const memory = c.repos.memories.get(skillId)!; const skill = skillMetaFromMemory(memory)!;

    expect(c.repos.runtime.getSkillTrial(trialA)!.outcome).toBe("unknown");
    expect(skill.trialsAttempted).toBe(laterTrial ? 1 : 0);
    expect(skill.eta).toBeCloseTo(laterTrial ? 0.9 : 0.8);
  });

  it("ASTRA REVIEW: preserves public manual archive after a settled trial is rescored", async () => {
    const c = setup(); const a = await prepare(c); const skillId = addSkill(c, a);
    await settle(c, a, skillId);
    c.service.archiveMemory(skillId, { namespace: a.namespace, reason: "user withdrew this skill" });
    expect(c.repos.memories.get(skillId)!.status).toBe("archived");
    await rescore(c, a, 0);
    expect(read(c, skillId).skill).toMatchObject({ status: "archived", trialsAttempted: 0, trialsPassed: 0 });
    expect(read(c, skillId).skill.eta).toBeCloseTo(0.8);
    await rescore(c, a, 0.9);
    expect(c.repos.memories.get(skillId)!.status).toBe("archived");
  });

  it("ASTRA REVIEW: resolves an old pending trial despite 100 newer resolved trials", async () => {
    const c = setup(); const a = await prepare(c); const skillId = addSkill(c, a);
    const pending = c.service.useSkill(skillId, { sessionId: a.session.sessionId, episodeId: a.first.episodeId,
      rawTurnId: a.first.rawTurnId, turnId: a.first.turnId });
    // 100 real useSkill + skill_trial_resolve calls; the older skill remains pending.
    const otherSkillId = addSkill(c, a, "another-skill");
    for (let i = 0; i < 100; i++) await settle(c, a, otherSkillId);
    await rescore(c, a, 0.9);
    expect(c.repos.runtime.getSkillTrial(pending.trialId)!.status).toBe("pass");
    await rescore(c, a, 0);
    expect(c.repos.runtime.getSkillTrial(pending.trialId)!.outcome).toBe("unknown");
    expect(read(c, skillId).skill.eta).toBeCloseTo(0.8);
    expect(read(c, otherSkillId).skill).toMatchObject({ trialsAttempted: 0, trialsPassed: 0 });
  });

  it.each([false, true])("retains archive intent independently of automatic archive (manual: %s)", async manual => {
    const c = setup(0.5); const a = await prepare(c); const skillId = addSkill(c, a);
    await settle(c, a, skillId);
    await rescore(c, a, -0.9);
    expect(read(c, skillId).skill.status).toBe("archived");
    if (manual) c.service.archiveMemory(skillId, { namespace: a.namespace });
    await rescore(c, a, 0.9);
    expect(read(c, skillId).skill.status).toBe(manual ? "archived" : "active");
    expect(read(c, skillId).skill.eta).toBeCloseTo(0.9);
  });

  it("preserves an outer manual archive created before the archive marker existed", async () => {
    const c = setup(); const a = await prepare(c); const skillId = addSkill(c, a);
    await settle(c, a, skillId);
    const memory = c.repos.memories.get(skillId)!;
    c.repos.memories.update({ ...memory, status: "archived", properties: { ...memory.properties, status: "archived" } });
    await rescore(c, a, 0);
    expect(read(c, skillId).skill).toMatchObject({ status: "archived", trialsAttempted: 0 });
    expect(read(c, skillId).skill.eta).toBeCloseTo(0.8);
  });

  it.each([false, true])("recovers multiple legacy trials regardless of correction order (newest first: %s)", async newestFirst => {
    const c = setup(); const a = await prepare(c); const b = await prepare(c, "member B");
    const skillId = addSkill(c, a);
    await settle(c, a, skillId); await settle(c, b, skillId); removeLegacyHistory(c, skillId);
    const order = newestFirst ? [b, a] : [a, b];
    await rescore(c, order[0]!, 0);
    expect(read(c, skillId).skill.eta).toBeCloseTo(0.9);
    await rescore(c, order[1]!, 0);
    expect(read(c, skillId).skill).toMatchObject({ trialsAttempted: 0, trialsPassed: 0 });
    expect(read(c, skillId).skill.eta).toBeCloseTo(0.8);
    await rescore(c, a, -0.9); await rescore(c, b, 0.9);
    expect(read(c, skillId).skill.eta).toBeCloseTo(0.6);
  });

  it("replays a recorded Policy update after a recovered legacy trial", async () => {
    const c = setup(); const f = await numericFixture(c);
    await settle(c, f.a, "revision-skill"); removeLegacyHistory(c, "revision-skill");
    await f.associate(f.d); await settle(c, f.b, "revision-skill");
    await rescore(c, f.a, -0.9);
    const { skill, history } = read(c, "revision-skill");
    expect(history.events.map(event => event.type)).toEqual(["trial", "policy", "trial"]);
    expect(skill.eta).toBeCloseTo(((0.7 * 0.4 + 0.3 * 0.68) * 2 + 1) / 3);
  });

  it.each(["recorded", "legacy", "legacy-pruned"])("requires replayable Policy history when correcting earlier trials (%s)", async mode => {
    const c = setup(); const f = await numericFixture(c);
    const trialA = await settle(c, f.a, "revision-skill");
    await f.associate(f.d);
    expect(read(c, "revision-skill").skill.eta).toBeCloseTo(0.7 * 0.9 + 0.3 * 0.68);
    const trialB = await settle(c, f.b, "revision-skill");
    if (mode !== "recorded") removeLegacyHistory(c, "revision-skill");
    if (mode === "legacy-pruned") {
      // A later trial snapshot must not turn a missing automatic write into a manual checkpoint.
      const removed = c.db.db.prepare("DELETE FROM memory_change_log WHERE memory_id = ? AND change_type = ?")
        .run("revision-skill", "skill_reward_drift");
      expect(removed.changes).toBeGreaterThan(0);
    }
    const before = c.repos.memories.get("revision-skill")!;
    const trialsBefore = [trialA, trialB].map(id => c.repos.runtime.getSkillTrial(id));
    await rescore(c, f.a, -0.9);
    if (mode === "recorded") {
      expect(c.repos.runtime.getSkillTrial(trialA)!.outcome).toBe("failure");
      expect(read(c, "revision-skill").skill.eta).toBeCloseTo(((0.7 * 0.4 + 0.3 * 0.68) * 2 + 1) / 3);
    } else {
      expect([trialA, trialB].map(id => c.repos.runtime.getSkillTrial(id))).toEqual(trialsBefore);
      expect(c.repos.memories.get("revision-skill")).toEqual(before);
    }
  });

  it("retains an audited legacy manual eta adjustment as a checkpoint", async () => {
    const c = setup(); const a = await prepare(c); const b = await prepare(c, "member B");
    const skillId = addSkill(c, a); await settle(c, a, skillId); removeLegacyHistory(c, skillId);
    const before = c.repos.memories.get(skillId)!;
    const internal = before.properties.internal_info;
    const after = c.repos.memories.update({ ...before, info: { ...before.info, eta: 0.7 }, properties: { ...before.properties,
      internal_info: { ...internal, eta: 0.7, skill: { ...(internal.skill as Record<string, unknown>), eta: 0.7 } } } });
    c.repos.runtime.appendChange({ memoryId: skillId, userId: before.userId, changeType: "update", before, after,
      source: "panel.update", createdAt: new Date().toISOString() });
    await settle(c, b, skillId);
    await rescore(c, a, 0);
    expect(read(c, skillId).skill.eta).toBeCloseTo((0.7 + 1) / 2);
    expect(read(c, skillId).skill).toMatchObject({ trialsAttempted: 1, trialsPassed: 1 });
  });

  it.each(["all", "settlement", "statistics"])("preserves verdict and statistics when legacy %s records were pruned", async missing => {
    const c = setup(); const a = await prepare(c); const skillId = addSkill(c, a);
    const trialId = await settle(c, a, skillId); removeLegacyHistory(c, skillId);
    if (missing === "all") c.db.db.prepare("DELETE FROM memory_change_log WHERE memory_id = ?").run(skillId);
    else c.db.db.prepare("DELETE FROM memory_change_log WHERE memory_id = ? AND change_type = ?")
      .run(skillId, missing === "settlement" ? "skill_trial_resolved" : "skill_trial_update");
    const before = c.repos.memories.get(skillId)!; const trialBefore = c.repos.runtime.getSkillTrial(trialId)!;
    await rescore(c, a, 0);
    expect(c.repos.runtime.getSkillTrial(trialId)).toEqual(trialBefore);
    expect(c.repos.memories.get(skillId)).toEqual(before);
    // The safe fallback does not prevent a new, independent trial from settling.
    const b = await prepare(c, "member B"); await settle(c, b, skillId);
    expect(read(c, skillId).skill).toMatchObject({ trialsAttempted: 2, trialsPassed: 2 });
  });

  it("does not infer a legacy prior from an unrecorded manual eta change", async () => {
    const c = setup(); const a = await prepare(c); const skillId = addSkill(c, a);
    const trialId = await settle(c, a, skillId); removeLegacyHistory(c, skillId);
    const memory = c.repos.memories.get(skillId)!; const internal = memory.properties.internal_info;
    const before = c.repos.memories.update({ ...memory, info: { ...memory.info, eta: 0.7 }, properties: { ...memory.properties,
      internal_info: { ...internal, eta: 0.7, skill: { ...(internal.skill as Record<string, unknown>), eta: 0.7 } } } });
    const trialBefore = c.repos.runtime.getSkillTrial(trialId)!;
    await rescore(c, a, 0);
    expect(c.repos.runtime.getSkillTrial(trialId)).toEqual(trialBefore);
    expect(c.repos.memories.get(skillId)).toEqual(before);
  });

  it("counts old contributions beyond 1000 newer unknown trials", async () => {
    const c = setup(); const a = await prepare(c); const b = await prepare(c, "member B");
    const skillId = addSkill(c, a); const first = await settle(c, a, skillId);
    const template = c.repos.runtime.getSkillTrial(first)!;
    for (let i = 0; i < 1000; i++) {
      vi.setSystemTime(Date.now() + 1);
      c.repos.runtime.insertSkillTrial({ ...template, id: `unknown-${i}`, status: "unknown", outcome: "unknown",
        createdAt: new Date().toISOString(), episodeId: b.first.episodeId });
    }
    await settle(c, b, skillId);
    const { skill } = read(c, skillId);
    expect(skill).toMatchObject({ trialsAttempted: 2, trialsPassed: 2 });
    expect(skill.eta).toBeCloseTo((0.8 + 2) / 3);
  });
});
