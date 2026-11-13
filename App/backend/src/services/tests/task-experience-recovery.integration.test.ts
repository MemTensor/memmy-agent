import type { Server } from "node:http";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryHttpServer, type LlmClient, type LlmMessage } from "../../../../../Memory/src/index.js";
import { closeMemoryHttpServer } from "../../../../../Memory/src/server/http.js";
import type { AgentSourceExecutor } from "../../../../../Memory/src/agent-source/runtime.js";
import { DEVICE_MEMORY_OWNER } from "../../../../../Memory/src/service/namespace/memory-owner.js";
import { Repositories } from "../../../../../Memory/src/storage/repositories.js";
import { upsertL2Candidate } from "../../../../../Memory/src/service/evolution/l2-candidate-service.js";
import { byokRuntimeConfig, createMemoryServiceFixture } from "../../../../../Memory/tests/fixtures/memory-service-fixture.js";
import { createHttpMemoryRuntimeClient } from "../../../../frontend/desktop/src/api/memory-runtime-client.js";
import { createHttpMemoryClient } from "../../adapters/outbound/memory-client/http-memory-client.js";
import { createLocalApiServer } from "../../adapters/inbound/local-api/server.js";
import type { PermissionManager } from "../../permission/index.js";
import type { BackendServices } from "../index.js";
import { createPanelService } from "../panel-service.js";
import { createProgressBus } from "../progress-bus.js";

const fixture = createMemoryServiceFixture();
const memoryServers: Server[] = [], localServers: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(localServers.splice(0).map(app => app.close()));
  await Promise.all(memoryServers.splice(0).map(closeMemoryHttpServer));
  await fixture.cleanup();
});

async function harness(owner = DEVICE_MEMORY_OWNER) {
  const config = byokRuntimeConfig();
  config.algorithm.capture.embedAfterCapture = false;
  config.algorithm.l2Induction.mode = "unified";
  const calls: LlmMessage[][] = [];
  let output: (messages: LlmMessage[]) => Promise<Record<string, unknown>> = async () => ({ operations: [] });
  const llm = { config: config.evolution, isConfigured: () => true, complete: async () => "{}",
    completeJson: async (messages: LlmMessage[]) => { calls.push(messages); return output(messages); },
    status: () => ({ provider: config.evolution.provider, model: config.evolution.model, configured: true, remote: true }) } as LlmClient;
  const { db, service } = fixture.createTestService({ config, llm, skillLlm: llm });
  const repos = new Repositories(db.db), at = new Date().toISOString(), episodeId = "episode/one";
  repos.runtime.createSession({ id: "session", userId: DEVICE_MEMORY_OWNER, source: "memmy", profileId: "default", status: "closed", meta: {}, openedAt: at, updatedAt: at });
  repos.runtime.createEpisode({ id: episodeId, sessionId: "session", userId: DEVICE_MEMORY_OWNER, status: "closed", l1MemoryIds: ["trace"],
    rawTurnIds: [], feedbackIds: [], decisionRepairIds: [], l2PolicyIds: [], l3WorldModelIds: [], skillMemoryIds: [], turnCount: 1,
    rewardDetail: {}, pipelineStatus: "idle", meta: {}, openedAt: at, closedAt: at, updatedAt: at });
  repos.memories.insert({ id: "trace", userId: DEVICE_MEMORY_OWNER, sessionId: "session", timeline: at, memoryLayer: "L1", memoryType: "LongTermMemory",
    status: "activated", visibility: "private", memoryValue: "Check the parser using the actual requested input.", tags: [], info: {}, version: 1,
    createdAt: at, updatedAt: at, properties: { internal_info: { memory_layer: "L1", memory_kind: "trace", trace: {
      episode_id: episodeId, summary: "Verify actual input", userText: "Check this parser", agentText: "It failed", value: -1
    } } } });
  if (owner !== DEVICE_MEMORY_OWNER) {
    for (const [table, id] of [["sessions", "session"], ["episodes", episodeId], ["memories", "trace"]])
      db.db.prepare(`UPDATE ${table} SET user_id=? WHERE id=?`).run(owner, id);
  }
  upsertL2Candidate(repos, { sourceMemoryId: "trace", userId: owner, route: "negative", at });
  repos.runtime.enqueueJob({ id: "original", jobType: "l2_induction", userId: owner, episodeId, sessionId: "session", targetMemoryId: "trace",
    payload: { unified: true }, status: "queued", attempts: 0, maxAttempts: 3, createdAt: at, updatedAt: at });
  await service.runWorkerOnce(1, { targetMemoryIds: ["trace"] });
  expect(calls).toHaveLength(3);
  const memory = createMemoryHttpServer({ service, apiKey: "memory-token", startAgentSourceAutomation: false,
    agentSourceExecutor: { dispose() {}, startAutomation() {} } as unknown as AgentSourceExecutor, workerStartupFallbackMs: 60_000 });
  memoryServers.push(memory);
  await new Promise<void>(resolve => memory.listen(0, "127.0.0.1", resolve));
  const address = memory.address(); if (!address || typeof address === "string") throw Error("expected port");
  const memoryClient = createHttpMemoryClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: "memory-token", timeoutMs: 5000, maxRetries: 0 });
  let userId = DEVICE_MEMORY_OWNER;
  const panel = createPanelService({ memoryClient, getUserId: () => userId });
  const app = createLocalApiServer({
    permissionManager: { verifyRuntimeToken: async token => token === "renderer-token" } as PermissionManager,
    services: { memoryClient, panel, progressBus: createProgressBus(), appConfig: {} } as BackendServices,
    composioMcpToken: "unused-test-token"
  });
  localServers.push(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const local = app.server.address(); if (!local || typeof local === "string") throw Error("expected local port");
  const baseUrl = `http://127.0.0.1:${local.port}`;
  return { service, repos, calls, episodeId, baseUrl, client: createHttpMemoryRuntimeClient({ baseUrl, localToken: "renderer-token" }),
    setOutput: (next: typeof output) => { output = next; }, setUser: (next: string) => { userId = next; } };
}

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) { if (Date.now() > deadline) throw Error("worker did not settle"); await new Promise(resolve => setTimeout(resolve, 5)); }
}

describe("desktop experience recovery through the complete HTTP chain", () => {
  it("reads a failed task through the renderer client and both HTTP servers without changing it", async () => {
    const h = await harness();
    const before = h.repos.runtime.getJob("original");
    await expect(h.client.taskExperienceProcessing!(h.episodeId)).resolves.toMatchObject({ episodeId: h.episodeId, state: "failed", pendingCount: 1, canRetry: true });
    expect(h.repos.runtime.getJob("original")).toEqual(before);
    expect(h.calls).toHaveLength(3);
  });

  it.each([DEVICE_MEMORY_OWNER, "historical-owner"])("recovers %s through the renderer POST, coalesces concurrent clicks and consumes sources once", async owner => {
    const h = await harness(owner);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    h.setOutput(async messages => {
      await gate;
      const input = JSON.parse(messages[2]!.content);
      return { operations: [{ operation: "create", l1_ids: input.L1_RECORDS.map((r: { id: string }) => r.id), new_l2: {
        type: "check", title: "Check actual input", applicability: "Numeric parser acceptance", content: "Run real accepted and rejected inputs.", verification: "Run tests.", exclusions: ""
      } }] };
    });
    try {
      const responses = await Promise.all([1, 2].map(() => h.client.retryTaskExperienceProcessing!(h.episodeId)));
      expect(responses.filter(r => r.accepted)).toHaveLength(1);
      expect(new Set(responses.map(r => r.jobId)).size).toBe(1);
      release();
      await waitFor(() => h.service.taskExperienceProcessing(h.episodeId).state === "complete");
      await expect(h.client.taskExperienceProcessing!(h.episodeId)).resolves.toMatchObject({ state: "complete", pendingCount: 0, canRetry: false });
      await expect(h.client.retryTaskExperienceProcessing!(h.episodeId)).resolves.toMatchObject({ state: "complete", accepted: false });
      expect(h.calls).toHaveLength(4);
      expect(h.repos.runtime.getEpisode(h.episodeId)?.userId).toBe(owner);
      expect(h.repos.memories.list({ memoryLayer: "L2" })).toHaveLength(1);
      expect(h.repos.runtime.getJob("original")!.status).toBe("dead_letter");
    } finally { release(); }
  });

  it("keeps renderer authentication while the local device library survives account changes", async () => {
    const h = await harness();
    const unauthorized = createHttpMemoryRuntimeClient({ baseUrl: h.baseUrl, localToken: "wrong-token" });
    await expect(unauthorized.taskExperienceProcessing!(h.episodeId)).rejects.toMatchObject({ status: 401 });
    await expect(unauthorized.retryTaskExperienceProcessing!(h.episodeId)).rejects.toMatchObject({ status: 401 });
    h.setUser("different-user");
    await expect(h.client.taskExperienceProcessing!(h.episodeId)).resolves.toMatchObject({ state: "failed" });
    // The local account is not the stored owner in v1.2.8. Scoped API ownership is covered separately.
    expect(h.repos.runtime.getEpisode(h.episodeId)?.userId).toBe(DEVICE_MEMORY_OWNER);
    expect(h.calls).toHaveLength(3);
    expect(h.repos.runtime.listL2JobsForEpisode(DEVICE_MEMORY_OWNER, h.episodeId)).toHaveLength(1);
  });
});
