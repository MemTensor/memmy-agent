import type { Server } from "node:http";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryHttpServer, MemoryDb, type MemoryService, type LlmClient, type LlmMessage } from "../../../../../Memory/src/index.js";
import { closeMemoryHttpServer } from "../../../../../Memory/src/server/http.js";
import { policyMetaFromMemory, skillMetaFromMemory } from "../../../../../Memory/src/algorithm/plugin-algorithms.js";
import type { AgentSourceExecutor } from "../../../../../Memory/src/agent-source/runtime.js";
import { DEVICE_MEMORY_OWNER } from "../../../../../Memory/src/service/namespace/memory-owner.js";
import { Repositories } from "../../../../../Memory/src/storage/repositories.js";
import { upsertL2Candidate } from "../../../../../Memory/src/service/evolution/l2-candidate-service.js";
import type { MemoryRow } from "../../../../../Memory/src/types.js";
import { byokRuntimeConfig, createMemoryServiceFixture } from "../../../../../Memory/tests/fixtures/memory-service-fixture.js";
import { createHttpMemoryRuntimeClient } from "../../../../frontend/desktop/src/api/memory-runtime-client.js";
import { createHttpMemoryClient } from "../../adapters/outbound/memory-client/http-memory-client.js";
import { createLocalApiServer } from "../../adapters/inbound/local-api/server.js";
import type { PermissionManager } from "../../permission/index.js";
import type { BackendServices } from "../index.js";
import { createPanelService } from "../panel-service.js";
import { createProgressBus } from "../progress-bus.js";

const fixture = createMemoryServiceFixture();
const memoryServers: Server[] = [];
const localServers: FastifyInstance[] = [];
const OWNER = DEVICE_MEMORY_OWNER;

afterEach(async () => {
  await Promise.all(localServers.splice(0).map(app => app.close()));
  await Promise.all(memoryServers.splice(0).map(closeMemoryHttpServer));
  await fixture.cleanup();
});

function row(id: string, layer: "L1" | "L2" | "Skill", at: string, fields: Record<string, unknown>): MemoryRow {
  return {
    id, userId: OWNER, memoryLayer: layer, memoryType: "LongTermMemory", status: "activated", visibility: "private",
    timeline: at, memoryValue: "Verify the actual requested input before accepting a parser result.",
    tags: [], info: {}, version: 1, createdAt: at, updatedAt: at,
    properties: { internal_info: { memory_layer: layer, generated_by_memory_base: true,
      [layer === "L1" ? "trace" : layer === "L2" ? "policy" : "skill"]: fields } }
  };
}

async function connectHttp(service: MemoryService) {
  // All HTTP traffic stays on ephemeral loopback ports. The model and embedding
  // dependencies are fixed offline implementations, and the DB is disposable.
  const memory = createMemoryHttpServer({ service, apiKey: "memory-token", startAgentSourceAutomation: false,
    agentSourceExecutor: { dispose() {}, startAutomation() {} } as unknown as AgentSourceExecutor,
    workerStartupFallbackMs: 60_000 });
  memoryServers.push(memory);
  await new Promise<void>(resolve => memory.listen(0, "127.0.0.1", resolve));
  const address = memory.address();
  if (!address || typeof address === "string") throw new Error("expected Memory loopback port");
  const memoryClient = createHttpMemoryClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: "memory-token",
    timeoutMs: 5000, maxRetries: 0 });
  const panel = createPanelService({ memoryClient, getUserId: () => OWNER });
  const app = createLocalApiServer({
    permissionManager: { verifyRuntimeToken: async token => token === "renderer-token" } as PermissionManager,
    services: { memoryClient, panel, progressBus: createProgressBus(), appConfig: {} } as BackendServices,
    composioMcpToken: "unused-test-token"
  });
  localServers.push(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const local = app.server.address();
  if (!local || typeof local === "string") throw new Error("expected Local API loopback port");
  return {
    client: createHttpMemoryRuntimeClient({ baseUrl: `http://127.0.0.1:${local.port}`, localToken: "renderer-token" }),
    close: async () => {
      await app.close();
      const appIndex = localServers.indexOf(app);
      if (appIndex >= 0) localServers.splice(appIndex, 1);
      await closeMemoryHttpServer(memory);
      const memoryIndex = memoryServers.indexOf(memory);
      if (memoryIndex >= 0) memoryServers.splice(memoryIndex, 1);
    }
  };
}

async function harness() {
  const config = structuredClone(byokRuntimeConfig());
  config.algorithm.capture.embedAfterCapture = false;
  config.algorithm.l2Induction.mode = "unified";
  config.algorithm.l2Induction.minEpisodesForActivation = 1;
  config.algorithm.l2Induction.minEpisodesForInduction = 1;
  config.algorithm.l3FieldCognition.enabled = false;
  // This test exercises statistics propagation into an existing Skill. Keep
  // unrelated Skill text generation ineligible without replacing its handler.
  config.algorithm.skill.minSupport = 100;
  const calls: LlmMessage[][] = [];
  let output: (messages: LlmMessage[]) => Promise<Record<string, unknown>> = async () => ({ operations: [] });
  const llm = {
    config: config.evolution, isConfigured: () => true,
    complete: async () => { throw new Error("unexpected text model call in offline support fixture"); },
    completeJson: async (messages: LlmMessage[]) => { calls.push(messages); return output(messages); },
    status: () => ({ provider: config.evolution.provider, model: config.evolution.model, configured: true, remote: false })
  } as LlmClient;
  const { root, db, service } = fixture.createTestService({ config, llm, skillLlm: llm });
  const repos = new Repositories(db.db);
  const at = new Date().toISOString();
  const episodeId = "episode/support-recovery";
  repos.runtime.createSession({ id: "session", userId: OWNER, source: "memmy", profileId: "default", status: "closed",
    meta: {}, openedAt: at, updatedAt: at });
  repos.runtime.createEpisode({ id: episodeId, sessionId: "session", userId: OWNER, status: "closed", l1MemoryIds: ["trace"],
    rawTurnIds: [], feedbackIds: [], decisionRepairIds: [], l2PolicyIds: [], l3WorldModelIds: [], skillMemoryIds: [], turnCount: 1,
    rewardDetail: {}, pipelineStatus: "idle", meta: {}, openedAt: at, closedAt: at, updatedAt: at });
  repos.memories.insert({ ...row("trace", "L1", at, { episode_id: episodeId, summary: "Verify actual input",
    userText: "Check this parser", agentText: "The actual input passes", value: 1, alpha: 1, vec_summary: [1, 0, 0] }),
    sessionId: "session" });
  repos.memories.insert(row("prior-trace", "L1", at, { episode_id: "prior-episode", summary: "Verify actual input",
    userText: "Check the previous parser", agentText: "The actual input passes", value: 1, alpha: 1, vec_summary: [1, 0, 0] }));
  repos.memories.insert(row("policy", "L2", at, {
    schema_version: 2, content_revision: 1, lesson_type: "check", title: "Actual input verification",
    trigger: "Before accepting a parser result", procedure: "Run the actual requested input.",
    verification: "Check the assertions", boundary: "", generation_method: "model", experience_type: "success_pattern",
    evidence_polarity: "positive", skill_eligible: true, status: "active", gain: 0.8, raw_gain: 0.8, support: 1,
    successful_episode_count: 1, source_trace_ids: ["prior-trace"], successful_source_trace_ids: ["prior-trace"],
    source_episode_ids: ["prior-episode"]
  }));
  repos.runtime.insertTracePolicyLink({ userId: OWNER, l1MemoryId: "prior-trace", l2MemoryId: "policy", relation: "supports" });
  repos.memories.insert(row("skill", "Skill", at, { eta: 0.8, status: "active", source_policy_ids: ["policy"],
    trials_attempted: 0, trials_passed: 0 }));
  repos.memories.insert(row("unrelated-skill", "Skill", at, { eta: 0.73, status: "active", source_policy_ids: ["unrelated-policy"],
    trials_attempted: 2, trials_passed: 1 }));
  upsertL2Candidate(repos, { sourceMemoryId: "trace", userId: OWNER, route: "ordinary", at });
  repos.runtime.enqueueJob({ id: "original-support-job", jobType: "l2_induction", userId: OWNER,
    episodeId, sessionId: "session", targetMemoryId: "trace", payload: { unified: true },
    status: "queued", attempts: 0, maxAttempts: 3, createdAt: at, updatedAt: at });
  await service.runWorkerOnce(1, { targetMemoryIds: ["trace"] });
  expect(calls).toHaveLength(3);
  expect(policyMetaFromMemory(repos.memories.get("policy")!)!.gain).toBe(0.8);
  expect(skillMetaFromMemory(repos.memories.get("skill")!)!.eta).toBe(0.8);

  const http = await connectHttp(service);
  return { service, repos, calls, episodeId,
    client: http.client,
    restart: async () => {
      await http.close();
      await service.stop();
      db.close();
      // Reopen the same temporary SQLite file with entirely new service/server
      // objects. No in-memory service cache survives this restart boundary.
      const restartedDb = new MemoryDb({ path: join(root, "memory.sqlite") });
      const restartedService = fixture.createTestMemoryService({ db: restartedDb, mode: "dev", config, llm, skillLlm: llm });
      const restartedHttp = await connectHttp(restartedService);
      return { service: restartedService, repos: new Repositories(restartedDb.db), client: restartedHttp.client };
    },
    setOutput: (next: typeof output) => { output = next; } };
}

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("real recovery worker did not settle");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

describe("desktop recovery supports an existing policy through the complete HTTP and worker chain", () => {
  it("updates L2 and its Skill once, preserving other tasks and coalescing repeated renderer recovery requests", async () => {
    const h = await harness();
    const priorTrace = h.repos.memories.get("prior-trace");
    const unrelatedSkill = h.repos.memories.get("unrelated-skill");
    await expect(h.client.taskExperienceProcessing!(h.episodeId)).resolves.toMatchObject({
      episodeId: h.episodeId, state: "failed", pendingCount: 1, canRetry: true
    });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    h.setOutput(async messages => {
      await gate;
      const input = JSON.parse(messages[2]!.content) as {
        L1_RECORDS: Array<{ id: string; episode_id: string }>;
        HISTORICAL_L2_CANDIDATES: Array<{ id: string; version: number }>;
      };
      const target = input.HISTORICAL_L2_CANDIDATES.find(candidate => candidate.id === "policy");
      if (!target) throw new Error("the real extraction pipeline did not retrieve the existing policy");
      expect(input.L1_RECORDS.map(record => record.id)).toEqual(["trace"]);
      expect(input.L1_RECORDS.map(record => record.episode_id)).toEqual([h.episodeId]);
      return { operations: [{ operation: "support", l1_ids: ["trace"], target_l2: { id: target.id, version: target.version } }] };
    });
    try {
      const responses = await Promise.all([1, 2].map(() => h.client.retryTaskExperienceProcessing!(h.episodeId)));
      expect(responses.filter(response => response.accepted)).toHaveLength(1);
      expect(new Set(responses.map(response => response.jobId)).size).toBe(1);
      release();
      await waitFor(() => h.service.taskExperienceProcessing(h.episodeId).state === "complete");
      await expect(h.client.taskExperienceProcessing!(h.episodeId)).resolves.toMatchObject({
        state: "complete", pendingCount: 0, canRetry: false
      });
      const policy = policyMetaFromMemory(h.repos.memories.get("policy")!)!;
      const skill = skillMetaFromMemory(h.repos.memories.get("skill")!)!;
      // Both successful traces score 1 against a baseline of .5. A single EMA
      // update gives .4*.5 + .6*.8 = .68, then Skill drift gives .7*.8 + .3*.68.
      expect(policy.gain).toBeCloseTo(0.68, 12);
      expect(policy.support).toBe(2);
      expect([...policy.sourceTraceIds].sort()).toEqual(["prior-trace", "trace"]);
      expect([...policy.sourceEpisodeIds].sort()).toEqual([h.episodeId, "prior-episode"].sort());
      expect(skill.eta).toBeCloseTo(0.764, 12);
      expect(h.repos.memories.list({ memoryLayer: "L2" })).toHaveLength(1);
      expect(h.repos.memories.list({ memoryLayer: "Skill" })).toHaveLength(2);
      expect(h.repos.memories.get("prior-trace")).toEqual(priorTrace);
      expect(h.repos.memories.get("unrelated-skill")).toEqual(unrelatedSkill);
      expect(h.repos.runtime.listChanges(OWNER, 100).map(change => change.changeType)).toEqual(expect.arrayContaining([
        "unified_l2_supported", "skill_reward_drift"
      ]));
      expect(h.calls).toHaveLength(4);
      expect(h.repos.runtime.getJob("original-support-job")!.status).toBe("dead_letter");

      const beforeRepeatedRetry = {
        policy: h.repos.memories.get("policy"), skill: h.repos.memories.get("skill"),
        l2Jobs: h.repos.runtime.listL2JobsForEpisode(OWNER, h.episodeId)
      };
      for (let click = 0; click < 3; click += 1) {
        await expect(h.client.retryTaskExperienceProcessing!(h.episodeId)).resolves.toMatchObject({ state: "complete", accepted: false });
      }
      expect(h.calls).toHaveLength(4);
      expect(h.repos.memories.get("policy")).toEqual(beforeRepeatedRetry.policy);
      expect(h.repos.memories.get("skill")).toEqual(beforeRepeatedRetry.skill);
      expect(h.repos.runtime.listL2JobsForEpisode(OWNER, h.episodeId)).toEqual(beforeRepeatedRetry.l2Jobs);
      expect(h.repos.memories.get("unrelated-skill")).toEqual(unrelatedSkill);

      const restarted = await h.restart();
      // Exercise the same reconciliation and real worker used by server startup
      // explicitly, rather than waiting for its one-minute fallback timer.
      restarted.service.reconcileWorkerStartup();
      await restarted.service.runWorkerOnce(100);
      await expect(restarted.client.taskExperienceProcessing!(h.episodeId)).resolves.toMatchObject({
        state: "complete", pendingCount: 0, canRetry: false
      });
      await expect(restarted.client.retryTaskExperienceProcessing!(h.episodeId)).resolves.toMatchObject({
        state: "complete", accepted: false
      });
      expect(h.calls).toHaveLength(4);
      expect(restarted.repos.memories.get("policy")).toEqual(beforeRepeatedRetry.policy);
      expect(restarted.repos.memories.get("skill")).toEqual(beforeRepeatedRetry.skill);
      expect(restarted.repos.memories.get("prior-trace")).toEqual(priorTrace);
      expect(restarted.repos.memories.get("unrelated-skill")).toEqual(unrelatedSkill);
    } finally {
      release();
    }
  }, 10_000);
});
