import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMMY_CONFIG, type LlmClient, type LlmMessage, type LlmCompletionOptions } from "../../../src/index.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { evolutionJobDedupeKey } from "../../../src/service/worker/job-handlers.js";
import { createCapturingEmbedder, createMemoryServiceFixture, runWorkerRounds } from "../../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();
let sequence = 0;
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.parse("2026-10-24T00:00:00Z")); sequence = 0; });
afterEach(() => { fixture.cleanup(); vi.useRealTimers(); });

function setup() {
  const state = {
    variant: false,
    operations: [] as string[],
    spans: [
      { start: 0, end: 3, spanGoal: "Inspect TLS certificate", summary: "Inspected nginx certificate configuration" },
      { start: 4, end: 10, spanGoal: "Verify TLS endpoint", summary: "Verified the nginx secure endpoint" }
    ]
  };
  const llm: LlmClient = {
    config: { ...DEFAULT_MEMMY_CONFIG.summary, provider: "host", model: "scoped-647-fixes" },
    isConfigured: () => true,
    complete: async () => "{}",
    async completeJson<T extends Record<string, unknown>>(messages: LlmMessage[], options: LlmCompletionOptions): Promise<T> {
      state.operations.push(options.operation);
      const user = messages.find(message => message.role === "user")?.content ?? "{}";
      let payload: { steps?: Array<{ idx: number }>; evidence_trace_ids?: string[] } = {};
      try { payload = JSON.parse(user); } catch { /* Capture uses plain text. */ }
      let output: Record<string, unknown> = {};
      if (options.operation === "capture.summarize") output = {
        l1: { title: "nginx TLS verification", summary: "Inspect nginx and verify TLS certificates.",
          evidence: [{ quote: user.match(/\bUSER:\s*(.*?)\s+ASSISTANT:/)?.[1]?.trim() ?? "", role: "user", kind: "task_outcome" }] }, user: null
      };
      if (options.operation === "capture.reflection.batch.v13") output = {
        scores: (payload.steps ?? []).map(step => ({ idx: step.idx, relevance: "PIVOTAL", reason: "verified TLS work" }))
      };
      if (options.operation === "span.big_turn.v1") output = { spans: state.spans };
      if (options.operation === "failure.experience.sink.v5") output = {
        title: "Avoid premature nginx completion", trigger: "When configuring nginx TLS endpoints.",
        procedure: "Configure port 443, validate the certificate, then report the verified endpoint.",
        verification: "An HTTPS request verifies the certificate successfully.", boundary: "nginx TLS certificate configuration.",
        experience_type: "failure_avoidance", confidence: 0.9, support_trace_ids: payload.evidence_trace_ids ?? [],
        decision_guidance: {
          prefer: [state.variant ? "Validate the full certificate chain before declaring nginx ready." : "Check nginx TLS before reporting completion."],
          avoid: ["Do not declare nginx TLS complete with an unverified certificate."]
        }
      };
      return output as T;
    },
    status: () => ({ provider: "host", model: "scoped-647-fixes", configured: true, remote: false })
  };
  const config = structuredClone(DEFAULT_MEMMY_CONFIG);
  config.algorithm.retrieval.smartSeed = false;
  config.algorithm.retrieval.llmFilterEnabled = false;
  config.algorithm.skill.directFromTrace = false;
  config.algorithm.l2Induction.useLlm = false;
  config.algorithm.l3Abstraction.useLlm = false;
  const base = fixture.createTestService({ llm, skillLlm: llm, config, embedder: createCapturingEmbedder([]) });
  return { ...base, state, repos: new Repositories(base.db.db) };
}
type Context = ReturnType<typeof setup>;
async function prepare(c: Context, tools = 1) {
  const namespace = { source: "codex", profileId: "scoped-647", userId: "scoped-647" };
  const session = c.service.openSession({ namespace: { ...namespace, sessionKey: `session-${++sequence}` } });
  const turn = c.service.completeTurn(`turn-${++sequence}`, {
    sessionId: session.sessionId, query: "Inspect nginx TLS certificate and configure port 443",
    answer: "Configured nginx TLS and verified the endpoint.",
    toolCalls: Array.from({ length: tools }, (_, index) => ({ id: `call-${index}`, name: "run_tests", input: { index }, output: { ok: true }, success: true }))
  });
  await runWorkerRounds(c.service, 4);
  expect(c.repos.memories.get(turn.l1MemoryId)?.status).toBe("activated");
  return { namespace, session, turn };
}
type Prepared = Awaited<ReturnType<typeof prepare>>;
async function execute(c: Context, p: Prepared, type: "span_big_turn" | "negative_experience") {
  const at = new Date().toISOString();
  const input = { jobType: type, episodeId: p.turn.episodeId,
    targetMemoryId: type === "span_big_turn" ? p.turn.l1MemoryId : undefined,
    payload: type === "span_big_turn" ? { rawTurnId: p.turn.rawTurnId, rTask: 0.9 }
      : { source: "episode_reward", sourceEventId: p.turn.episodeId } };
  const job = c.repos.runtime.enqueueJob({ ...input, dedupeKey: evolutionJobDedupeKey(input), id: `fix647-${++sequence}`,
    userId: p.namespace.userId, sessionId: p.session.sessionId, status: "queued", attempts: 0, maxAttempts: 1, createdAt: at, updatedAt: at });
  for (let i = 0; i < 15 && c.repos.runtime.getJob(job.id)?.status === "queued"; i++) await c.service.runWorkerOnce(1);
  expect(c.repos.runtime.getJob(job.id)).toMatchObject({ status: "succeeded" });
  return job;
}
async function negative(c: Context, p: Prepared) {
  c.repos.runtime.closeEpisode(p.turn.episodeId, { closeReason: "idle_timeout" });
  c.repos.runtime.updateEpisodeReward(p.turn.episodeId, { rTask: -0.9, rewardDetail: { reason: "certificate unchecked" } });
  await execute(c, p, "negative_experience");
}
function policies(c: Context) { return c.repos.memories.list({ memoryLayer: "L2" }, 100); }

// These scenarios exercise persisted retirement and attribution through the actual worker.
describe("MEMMY-647 scoped Span retirement fix", () => {
  it.each(["empty", "changed-boundaries"])("restores original boundaries after %s and repeated retirement", async change => {
    const c = setup(); const p = await prepare(c, 11);
    const original = structuredClone(c.state.spans);
    await execute(c, p, "span_big_turn"); await runWorkerRounds(c.service, 3);
    const initial = c.repos.memories.listSpansForTrace(p.turn.l1MemoryId);
    expect(initial).toHaveLength(2);
    expect(c.repos.vectors.getMany(initial.map(row => row.id)).size).toBe(2);
    const indexedOriginalIds = () => (c.db.db.prepare("SELECT id FROM memories_fts WHERE memories_fts MATCH 'certificate'")
      .all() as Array<{ id: string }>).filter(row => initial.some(memory => memory.id === row.id));
    expect(indexedOriginalIds().length).toBeGreaterThan(0);
    for (let pass = 0; pass < 2; pass++) {
      c.state.spans = change === "empty" ? [] : [
        { start: 0, end: 5, spanGoal: "Inspect alternate boundary", summary: "Revised grouping of certificate work" },
        { start: 6, end: 10, spanGoal: "Verify alternate boundary", summary: "Revised grouping of endpoint work" }
      ];
      await execute(c, p, "span_big_turn");
      for (const old of initial) {
        expect(c.repos.memories.get(old.id)).toBeUndefined();
        expect(c.repos.memories.getIncludingDeleted(old.id)?.status).toBe("deleted");
      }
      expect(c.repos.vectors.getMany(initial.map(row => row.id)).size).toBe(0);
      expect(indexedOriginalIds()).toHaveLength(0);
      // Automatic retirement remains recoverable after routine change-log pruning.
      c.db.db.prepare("DELETE FROM memory_change_log WHERE change_type = 'span_retired'").run();
      c.state.spans = original;
      await execute(c, p, "span_big_turn"); await runWorkerRounds(c.service, 3);
      const restored = c.repos.memories.listSpansForTrace(p.turn.l1MemoryId);
      expect(restored.map(row => row.id).sort()).toEqual(initial.map(row => row.id).sort());
      expect(c.repos.vectors.getMany(initial.map(row => row.id)).size).toBe(2);
      expect(indexedOriginalIds().length).toBeGreaterThan(0);
    }
  });

  it("recovers an older automatic tombstone only while its matching retirement log exists", async () => {
    const c = setup(); const p = await prepare(c, 11);
    await execute(c, p, "span_big_turn");
    const originals = c.repos.memories.listSpansForTrace(p.turn.l1MemoryId);
    for (const [index, memory] of originals.entries()) {
      const deleted = c.repos.memories.softDelete(memory.id)!;
      if (index === 0) c.repos.runtime.appendChange({ memoryId: memory.id, userId: memory.userId, changeType: "span_retired",
        source: "worker.span_big_turn.v1", before: memory, after: deleted, createdAt: deleted.deletedAt! });
    }
    await execute(c, p, "span_big_turn");
    expect(c.repos.memories.get(originals[0]!.id)?.status).toBe("activated");
    expect(c.repos.memories.get(originals[1]!.id)).toBeUndefined();
    expect(c.repos.memories.listSpansForTrace(p.turn.l1MemoryId)).toHaveLength(1);
  });

  it("keeps a user deletion deleted even after the Span was automatically restored once", async () => {
    const c = setup(); const p = await prepare(c, 11);
    const original = structuredClone(c.state.spans);
    await execute(c, p, "span_big_turn");
    const ids = c.repos.memories.listSpansForTrace(p.turn.l1MemoryId).map(row => row.id);
    c.state.spans = []; await execute(c, p, "span_big_turn");
    c.state.spans = original; await execute(c, p, "span_big_turn");
    const restored = c.repos.memories.get(ids[0]!)!;
    expect(restored.properties.internal_info.span).not.toHaveProperty("retired_by");
    c.service.deleteMemory(ids[0]!, { namespace: p.namespace });
    await execute(c, p, "span_big_turn");
    expect(c.repos.memories.get(ids[0]!)).toBeUndefined();
    expect(c.repos.memories.get(ids[1]!)?.status).toBe("activated");
    expect(c.repos.memories.listSpansForTrace(p.turn.l1MemoryId)).toHaveLength(1);
  });
});

describe("MEMMY-647 scoped mixed legacy contribution fix", () => {
  it.each(["revision", "recovery"])("protects legacy A/B on %s while modern C remains independently revisable", async change => {
    const c = setup(); const a = await prepare(c); const b = await prepare(c);
    await negative(c, a); await negative(c, b);
    const aggregate = policies(c)[0]!;
    const { negative_contributions: _map, ...legacyInternal } = aggregate.properties.internal_info;
    c.repos.memories.update({ ...aggregate, properties: { ...aggregate.properties, internal_info: legacyInternal } });
    for (const p of [a,b]) c.repos.runtime.updateEpisodeMeta(p.turn.episodeId, { negativeExperienceSources: {} });
    const third = await prepare(c); await negative(c, third);
    expect(policies(c)).toHaveLength(1);
    const shared = policies(c)[0]!;
    expect(shared.info.support).toBe(3);
    const modelCalls = c.state.operations.filter(operation => operation === "failure.experience.sink.v5").length;
    c.state.variant = true;
    c.repos.runtime.updateEpisodeReward(a.turn.episodeId, { rTask: change === "recovery" ? 0.9 : -0.8, rewardDetail: { reason: "revised evidence" } });
    await execute(c, a, "negative_experience");
    expect(policies(c)).toHaveLength(1);
    expect(policies(c)[0]!.memoryValue).toBe(shared.memoryValue);
    expect(c.state.operations.filter(operation => operation === "failure.experience.sink.v5")).toHaveLength(modelCalls);
    expect(c.repos.runtime.getEpisode(a.turn.episodeId)?.meta.negativeExperienceSources).toMatchObject({
      [`episode_reward:${a.turn.episodeId}`]: { memoryId: shared.id, legacySharedNeedsReview: true }
    });
    c.repos.runtime.updateEpisodeReward(third.turn.episodeId, { rTask: -0.8, rewardDetail: { reason: "new C evidence" } });
    await execute(c, third, "negative_experience");
    const revised = policies(c);
    expect(revised).toHaveLength(2);
    const keptLegacy = revised.find(row => row.id === shared.id)!;
    const movedC = revised.find(row => row.id !== shared.id)!;
    expect(keptLegacy.info.support).toBe(2);
    expect(keptLegacy.properties.internal_info.source_event_ids).toEqual([a.turn.episodeId, b.turn.episodeId]);
    expect(movedC.info.support).toBe(1);
    expect(movedC.properties.internal_info.source_event_ids).toEqual([third.turn.episodeId]);
    c.repos.runtime.updateEpisodeReward(third.turn.episodeId, { rTask: 0.9, rewardDetail: { reason: "C recovered" } });
    await execute(c, third, "negative_experience");
    expect(policies(c).map(row => row.id)).toEqual([shared.id]);
  });
});

it("revises and withdraws an attributable single-source legacy row after C merges", async () => {
  const c = setup(); const a = await prepare(c); await negative(c, a);
  const before = policies(c)[0]!;
  const { negative_contributions: _map, ...legacyInternal } = before.properties.internal_info;
  c.repos.memories.update({ ...before, properties: { ...before.properties, internal_info: legacyInternal } });
  c.repos.runtime.updateEpisodeMeta(a.turn.episodeId, { negativeExperienceSources: {} });
  const third = await prepare(c); await negative(c, third);
  expect(policies(c)).toHaveLength(1);
  expect(policies(c)[0]!.info.support).toBe(2);
  c.state.variant = true;
  c.repos.runtime.updateEpisodeReward(a.turn.episodeId, { rTask: -0.8, rewardDetail: { reason: "revised A evidence" } });
  await execute(c, a, "negative_experience");
  expect(policies(c)).toHaveLength(2);
  const fromA = policies(c).filter(row => (row.properties.internal_info.source_event_ids as string[]).includes(a.turn.episodeId));
  expect(fromA).toHaveLength(1);
  expect(fromA[0]!.info.support).toBe(1);
  expect(c.repos.memories.get(before.id)?.properties.internal_info.source_event_ids).toEqual([third.turn.episodeId]);
  c.repos.runtime.updateEpisodeReward(a.turn.episodeId, { rTask: 0.9, rewardDetail: { reason: "A recovered" } });
  await execute(c, a, "negative_experience");
  expect(policies(c).map(row => row.id)).toEqual([before.id]);
  expect(policies(c)[0]!.info.support).toBe(1);
});
