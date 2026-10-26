import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMMY_CONFIG, type LlmClient, type LlmMessage } from "../../../src/index.js";
import { policyMetaFromMemory, skillMetaFromMemory } from "../../../src/algorithm/plugin-algorithms.js";
import { Repositories, type EvolutionJobRecord } from "../../../src/storage/repositories.js";
import { evolutionJobDedupeKey } from "../../../src/service/worker/job-handlers.js";
import { createCapturingEmbedder, createMemoryServiceFixture, runWorkerRounds } from "../../fixtures/memory-service-fixture.js";
import { insertActivePolicyMemory, insertTracePolicyLinkForTest, makeTraceEligibleForL2, setTraceSignatureAndVectorForTest } from "../../fixtures/evolution-fixture.js";

const fixture = createMemoryServiceFixture();
let sequence = 0;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-10-22T02:00:00Z"));
  sequence = 0;
});
afterEach(() => { fixture.cleanup(); vi.useRealTimers(); });

function setup() {
  const state = { operations: [] as string[], rebuildText: false };
  const llm: LlmClient = {
    config: { ...DEFAULT_MEMMY_CONFIG.summary, provider: "host", model: "647-crystallization" },
    isConfigured: () => true,
    complete: async (_messages, options) => options.operation.startsWith("episode_title.")
      ? JSON.stringify({ title: "nginx TLS verification", summary: "Configure and verify nginx TLS securely." }) : "{}",
    async completeJson<T extends Record<string, unknown>>(messages: LlmMessage[], options: { operation: string }): Promise<T> {
      state.operations.push(options.operation);
      let payload: { steps?: Array<{ idx: number }> } = {};
      try { payload = JSON.parse([...messages].reverse().find(item => item.role === "user")?.content ?? "{}"); }
      catch { /* Capture prompts can contain plain text. */ }
      let output: Record<string, unknown> = {};
      if (options.operation === "relation.classify.v1") output = { relation: "follow_up", confidence: 0.99, reason: "fixed relation" };
      if (options.operation === "capture.summarize") {
        const quote = (messages.find(item => item.role === "user")?.content ?? "").match(/\bUSER:\s*(.*?)\s+ASSISTANT:/)?.[1]?.trim() ?? "";
        output = { l1: { title: "nginx TLS verification", summary: "Inspect nginx configuration, fix port and verify TLS certificates.",
          evidence: [{ quote, role: "user", kind: "task_outcome" }] }, user: null };
      }
      if (options.operation === "capture.reflection.batch.v13") output = {
        scores: (payload.steps ?? []).map(step => ({ idx: step.idx, relevance: "PIVOTAL", reason: "verified TLS work" }))
      };
      if (options.operation === "skill.crystallize" || options.operation === "skill.rebuild.v3") output = {
        name: "nginx_tls_verification", retrieval_blurb: "Inspect nginx TLS certificate and fix port 443; verify the secure endpoint.",
        trigger_context: "When configuring nginx TLS certificate and port 443.",
        summary: "Inspect nginx TLS configuration, fix port 443, then verify the certificate and secure endpoint.",
        parameters: [], preconditions: ["nginx TLS configuration needs verification"], tools: [],
        steps: [{ title: "Inspect nginx TLS", body: "Inspect nginx configuration and fix port 443." },
          { title: "Verify nginx TLS", body: state.rebuildText
            ? "Verify the certificate and secure endpoint, and record the successful HTTPS response before declaring completion."
            : "Verify the certificate and secure endpoint before declaring completion." }],
        examples: [], tags: ["nginx", "TLS"],
        decision_guidance: { preference: ["Verify nginx TLS certificate"], anti_pattern: [] },
        changed_sections: ["steps", "decisionGuidance"]
      };
      return output as T;
    },
    status: () => ({ provider: "host", model: "647-crystallization", configured: true, remote: false })
  };
  const embedder = createCapturingEmbedder([]);
  embedder.embedOne = async () => [1, 0, 0];
  embedder.embed = async texts => texts.map(() => [1, 0, 0]);
  const config = structuredClone(DEFAULT_MEMMY_CONFIG);
  config.algorithm.skill.directFromTrace = false;
  config.algorithm.l2Induction.useLlm = false;
  config.algorithm.l3Abstraction.useLlm = false;
  config.algorithm.feedback.valueDistributionRepairEnabled = false;
  const base = fixture.createTestService({ llm, skillLlm: llm, config, embedder });
  return { ...base, state, repos: new Repositories(base.db.db) };
}
type Context = ReturnType<typeof setup>;
async function prepare(context: Context) {
  const namespace = { source: "codex", profileId: "memmy647", userId: "memmy647-synthetic" };
  const session = context.service.openSession({ namespace: { ...namespace, sessionKey: `session-${++sequence}` } });
  const first = context.service.completeTurn(`turn-${++sequence}`, {
    sessionId: session.sessionId, query: "Inspect nginx TLS certificate and fix port 443",
    answer: "Configured nginx TLS on port 443 and verified the endpoint.",
    toolCalls: [{ id: "call-1", name: "run_tests", input: {}, output: { ok: true }, success: true }]
  });
  await runWorkerRounds(context.service, 4);
  expect(context.repos.memories.get(first.l1MemoryId)?.status).toBe("activated");
  return { namespace, session, first };
}
type Prepared = Awaited<ReturnType<typeof prepare>>;
function enqueue(context: Context, prepared: Prepared, type: EvolutionJobRecord["jobType"], payload: Record<string, unknown> = {}, targetMemoryId?: string) {
  const at = new Date().toISOString();
  const input = { jobType: type, episodeId: prepared.first.episodeId, targetMemoryId, payload };
  return context.repos.runtime.enqueueJob({ ...input, dedupeKey: evolutionJobDedupeKey(input), id: `647-crystallization-${++sequence}`,
    userId: prepared.namespace.userId, sessionId: prepared.session.sessionId, status: "queued", attempts: 0, maxAttempts: 1, createdAt: at, updatedAt: at });
}
async function executeQueued(context: Context, job: EvolutionJobRecord) {
  for (let i = 0; i < 15 && context.repos.runtime.getJob(job.id)?.status === "queued"; i++) await context.service.runWorkerOnce(1);
  expect(context.repos.runtime.getJob(job.id)).toMatchObject({ status: "succeeded" });
}
async function numericFixture(context: Context) {
  const a = await prepare(context); const b = await prepare(context); const c = await prepare(context);
  for (const prepared of [a, b, c]) {
    makeTraceEligibleForL2(context.db, prepared.first.l1MemoryId);
    setTraceSignatureAndVectorForTest(context.db, prepared.first.l1MemoryId, "python|pytest|_|_", [1, 0, 0]);
  }
  insertActivePolicyMemory(context.db, { id: "revision-policy", userId: a.namespace.userId, sessionId: a.session.sessionId,
    agentId: "codex", appId: "647-test", profileId: a.namespace.profileId,
    sourceTraceId: a.first.l1MemoryId, sourceEpisodeId: a.first.episodeId });
  for (const prepared of [a, b, c]) insertTracePolicyLinkForTest(context.db, {
    userId: a.namespace.userId, l1MemoryId: prepared.first.l1MemoryId, l2MemoryId: "revision-policy"
  });
  return { a, associate: () => executeQueued(context, enqueue(context, a, "l2_association", {}, a.first.l1MemoryId)),
    updateValue: (value: number) => {
      const memory = context.repos.memories.get(a.first.l1MemoryId)!;
      context.repos.memories.update({ ...memory, properties: { ...memory.properties, internal_info: { ...memory.properties.internal_info,
        trace: { ...(memory.properties.internal_info.trace as Record<string, unknown>), value } } } });
    }
  };
}

describe("MEMMY-647 crystallization service regressions", () => {
  it("does not duplicate the already crystallized source on a revision", async () => {
    const context = setup(); const f = await numericFixture(context);
    await f.associate(); await runWorkerRounds(context.service, 12);
    const skills = context.repos.memories.list({ memoryLayer: "Skill" }, 100);
    expect(skills).toHaveLength(1);
    const skill = skills[0]!;
    expect((skill.properties.internal_info.skill_revision_history as { events: unknown[] }).events).toHaveLength(1);
    f.updateValue(0.6); await f.associate(); await runWorkerRounds(context.service, 12);
    const current = context.repos.memories.get(skill.id)!;
    const gain = policyMetaFromMemory(context.repos.memories.get("revision-policy")!)!.gain;
    expect(skillMetaFromMemory(current)!.eta).toBeCloseTo(0.5 + 0.5 * gain);
  });

  it("does not use an old passed trial to activate a newly rebuilt candidate", async () => {
    const context = setup(); const f = await numericFixture(context);
    await f.associate(); await runWorkerRounds(context.service, 12);
    const skill = context.repos.memories.list({ memoryLayer: "Skill" }, 100)[0]!;
    expect(skill).toBeTruthy();
    const used = context.service.useSkill(skill.id, { adapterId: "647-crystallization", requestId: "success",
      sessionId: f.a.session.sessionId, episodeId: f.a.first.episodeId, rawTurnId: f.a.first.rawTurnId, turnId: f.a.first.turnId });
    await executeQueued(context, enqueue(context, f.a, "skill_trial_resolve", { trialId: used.trialId, rHuman: 0.9 }));
    expect(skillMetaFromMemory(context.repos.memories.get(skill.id)!)!.status).toBe("active");
    const policy = context.repos.memories.get("revision-policy")!;
    context.repos.memories.update({ ...policy, properties: { ...policy.properties, internal_info: { ...policy.properties.internal_info,
      policy: { ...(policy.properties.internal_info.policy as object),
        procedure: "Inspect nginx TLS configuration and verify the certificate before reporting the secure endpoint." } } } });
    context.state.rebuildText = true;
    const beforeCalls = context.state.operations.filter(operation => operation === "skill.rebuild.v3").length;
    await executeQueued(context, enqueue(context, f.a, "skill_crystallization", {}, "revision-policy"));
    expect(context.state.operations.filter(operation => operation === "skill.rebuild.v3").length).toBe(beforeCalls + 1);
    const current = context.repos.memories.get(skill.id)!;
    expect(current.memoryValue).not.toBe(skill.memoryValue);
    expect(current.memoryValue).toContain("record the successful HTTPS response");
    expect(skillMetaFromMemory(current)!.status).toBe("candidate");
  });
});
