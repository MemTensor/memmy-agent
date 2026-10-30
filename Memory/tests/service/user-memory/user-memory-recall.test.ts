import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MEMMY_CONFIG, createMemoryHttpServer } from "../../../src/index.js";
import { buildUserMemory } from "../../../src/service/user-memory/user-memory.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { stableHash } from "../../../src/utils/id.js";
import { insertActivePolicyMemory } from "../../fixtures/evolution-fixture.js";
import {
  configWithMemoryGates,
  createFailingLlm,
  createMemoryServiceFixture
} from "../../fixtures/memory-service-fixture.js";

const { cleanup, createTestService } = createMemoryServiceFixture();
afterEach(cleanup);

const userId = "user-memory-recall-user";
const userMemoryId = "user_memory_recall_gate";
const query = "我最喜欢的水果 苹果";
const sources = ["memmy-agent", "codex", "claude_code", "deepseek_harness", "workbuddy", "cursor", "openclaw", "opencode", "hermes"];

function seedUserMemory(db: ReturnType<typeof createTestService>["db"]) {
  const repos = new Repositories(db.db);
  repos.userMemories.upsertExact(buildUserMemory({
    id: userMemoryId,
    userId,
    sourceTurnId: "raw_preference",
    memoryTypes: ["User Preference"],
    content: "我最喜欢的水果是苹果",
    createdAt: "2026-10-01T00:00:00.000Z"
  }));
  return repos;
}

describe("User Memory recall gate", () => {
  it.each([
    { mode: "search", poolSize: 12, includeL1: true, expectedCandidates: 8 },
    { mode: "turn_start", poolSize: 12, includeL1: true, expectedCandidates: 8 },
    { mode: "search", poolSize: 2, includeL1: true, expectedCandidates: 2 },
    { mode: "turn_start", poolSize: 2, includeL1: true, expectedCandidates: 2 },
    { mode: "search", poolSize: 12, includeL1: false, expectedCandidates: 5 },
    { mode: "turn_start", poolSize: 12, includeL1: false, expectedCandidates: 5 }
  ] as const)("preserves the Agent candidate budget across gate changes: $mode, pool=$poolSize, L1=$includeL1", async ({ mode, poolSize, includeL1, expectedCandidates }) => {
    let config = configWithMemoryGates({ enableUserMemoryRecall: false });
    config.algorithm.retrieval = {
      ...config.algorithm.retrieval,
      tier1TopK: 0,
      tier2TopK: 5,
      tier3TopK: 0,
      relativeThresholdFloor: 0,
      minRecallScore: 0,
      smartSeed: false,
      llmFilterEnabled: false
    };
    const { db, service } = createTestService({ config, configLoader: () => ({ config }) });
    const namespace = { source: "codex", profileId: "default", userId };
    const { sessionId } = service.openSession({ namespace });
    seedUserMemory(db);
    for (let index = 0; index < poolSize; index += 1) {
      insertActivePolicyMemory(db, {
        id: `policy_recall_quota_${index}`,
        userId,
        sessionId,
        agentId: namespace.source,
        appId: "memmy",
        profileId: namespace.profileId,
        sourceTraceId: `trace_quota_${index}`,
        sourceEpisodeId: `episode_quota_${index}`
      });
    }
    for (const enabled of [false, true, false]) {
      config = { ...config, algorithm: { ...config.algorithm, enableUserMemoryRecall: enabled } };
      expect(service.reloadConfig({ restartFailedProcessing: false }).requiresRestart).toBe(false);
      const request = {
        sessionId,
        query: "python pytest failure inspection retry",
        layers: includeL1 ? ["L1", "L2"] as const : ["L2"] as const
      };
      const result = mode === "turn_start"
        ? await service.startTurn({ ...request, layers: [...request.layers] })
        : await service.search({ ...request, layers: [...request.layers] });
      const log = service.apiLogs({ tools: ["memory_search"], limit: 1 }).logs[0]!;
      const output = JSON.parse(log.outputJson) as { candidates: Array<{ tier: string }> };
      expect(output.candidates.filter((candidate) => candidate.tier === "L2")).toHaveLength(expectedCandidates);
      expect(result.hits.length).toBeLessThanOrEqual(5);
      if (!enabled) {
        expect(result.hits).toHaveLength(Math.min(poolSize, 5));
        expect(JSON.stringify(result)).not.toContain(userMemoryId);
        expect(output.candidates).toHaveLength(expectedCandidates);
      }
    }
    await service.stop();
  });

  it.each(sources)("applies to turn start and both search formats for %s", async (source) => {
    let config = configWithMemoryGates({});
    const { db, service } = createTestService({ config, configLoader: () => ({ config }) });
    seedUserMemory(db);
    const namespace = { source, profileId: "default", userId };
    const { sessionId } = service.openSession({ namespace });
    const server = createMemoryHttpServer({ service });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected TCP address");
      const post = async (path: string, extra: Record<string, unknown>) => {
        const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ namespace, sessionId, query, ...extra })
        });
        expect(response.status).toBe(200);
        return await response.json();
      };
      for (const enabled of [false, true, false]) {
        config = configWithMemoryGates({ enableUserMemoryRecall: enabled });
        expect(service.reloadConfig({ restartFailedProcessing: false }).requiresRestart).toBe(false);
        const results = [
          await post("turns/start", { turnId: `turn-${enabled}` }),
          await post("memory/search", {}),
          await post("memory/search", { verbose: true })
        ];
        for (const result of results) {
          if (enabled) {
            expect(JSON.stringify(result)).toContain(userMemoryId);
            expect(JSON.stringify(result)).toContain("## User Memories");
          } else {
            expect(JSON.stringify(result)).not.toContain(userMemoryId);
            expect(JSON.stringify(result)).not.toContain("## User Memories");
            expect(JSON.stringify(result)).not.toContain("我最喜欢的水果是苹果");
          }
        }
      }
      expect(service.panelItems({ namespace, layer: "UserMemory" }).items)
        .toEqual([expect.objectContaining({ id: userMemoryId })]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await service.stop();
    }
  });

  it("keeps same-turn L1 recall and internal maintenance candidates when disabled", async () => {
    const { db, service } = createTestService();
    const namespace = { source: "codex", profileId: "default", userId };
    const writer = service.openSession({ namespace });
    const completed = await service.completeTurn("code-feedback", {
      sessionId: writer.sessionId,
      query: "你刚才写了很多兜底代码，我更喜欢简洁的代码，以后不要写不必要的兜底代码",
      answer: "已精简实现并通过测试。"
    });
    await service.runWorkerOnce(50);
    const reader = service.openSession({ namespace });
    const userIdForTurn = completed.userMemoryIds[0]!;
    const l1Id = completed.l1MemoryIds[0]!;
    expect(userIdForTurn).toBeTruthy();
    expect(l1Id).toBeTruthy();
    const request = { sessionId: reader.sessionId, query: "简洁代码 不必要兜底代码" };
    const results = [await service.search(request), await service.startTurn({ ...request, turnId: "read-code-feedback" })];
    for (const result of results) {
      expect(JSON.stringify(result)).not.toContain(userIdForTurn);
      expect(result.sourceMemoryIds).toContain(l1Id);
      expect(result.injectedContext.markdown).toContain("## L1 Trace Memories");
      const event = new Repositories(db.db).runtime.getRecallEvent(result.searchEventId)!;
      expect(event.userMemoryCandidateIds).toContain(userIdForTurn);
      expect(event.candidateMemoryIds).not.toContain(userIdForTurn);
      expect(event.hitMemoryIds).not.toContain(userIdForTurn);
    }
    await service.stop();
  });

  it("returns no agent memories for an empty database or a User-Memory-only match", async () => {
    const { db, service } = createTestService();
    const namespace = { source: "memmy-agent", profileId: "default", userId };
    const { sessionId } = service.openSession({ namespace });
    for (const seed of [false, true]) {
      if (seed) seedUserMemory(db);
      const result = await service.search({ sessionId, query });
      expect(result.hits).toEqual([]);
      expect(result.sourceMemoryIds).toEqual([]);
      expect(result.candidateMemoryIds).toEqual([]);
      expect(result.injectedContext.sections).toEqual([]);
    }
    await service.stop();
  });

  it("does not expose User Memory when model calls fall back", async () => {
    const { db, service } = createTestService({ llm: createFailingLlm() });
    seedUserMemory(db);
    const result = await service.search({ namespace: { source: "codex", profileId: "default", userId }, query });
    expect(result.hits).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(userMemoryId);
    await service.stop();
  });

  it.each(["turn.start", "memory.search"])("isolates legacy and opposite-gate cached %s responses", async (operation) => {
    let config = configWithMemoryGates({ enableUserMemoryRecall: true });
    const { db, service } = createTestService({ config, configLoader: () => ({ config }) });
    const repos = seedUserMemory(db);
    const namespace = { source: "codex", profileId: "default", userId };
    const { sessionId } = service.openSession({ namespace });
    const request = { namespace, sessionId, query, turnId: "cached-turn", adapterId: "gate-test", requestId: "same-request" };
    const run = async () => operation === "turn.start" ? service.startTurn(request) : service.search(request);
    const legacyResponse = await run();
    expect(JSON.stringify(legacyResponse)).toContain(userMemoryId);
    repos.runtime.saveIdempotency(
      `${operation}:${request.adapterId}:${request.requestId}`,
      stableHash({ operation, fingerprint: request }),
      legacyResponse
    );
    const eventsByGate = new Map<boolean, string>();
    for (const enabled of [false, false, true, true, false]) {
      config = configWithMemoryGates({ enableUserMemoryRecall: enabled });
      service.reloadConfig({ restartFailedProcessing: false });
      const result = await service.idempotent(operation, request, request, run);
      if (enabled) expect(JSON.stringify(result)).toContain(userMemoryId);
      else expect(JSON.stringify(result)).not.toContain(userMemoryId);
      expect(result.searchEventId).not.toBe(legacyResponse.searchEventId);
      if (eventsByGate.has(enabled)) expect(result.searchEventId).toBe(eventsByGate.get(enabled));
      eventsByGate.set(enabled, result.searchEventId);
    }
    expect(eventsByGate.get(true)).not.toBe(eventsByGate.get(false));
    await expect(service.idempotent(operation, request, { ...request, query: "different" }, run))
      .rejects.toThrow("idempotency key reused with different request body");
    expect(DEFAULT_MEMMY_CONFIG.algorithm.enableUserMemoryRecall).toBe(false);
    await service.stop();
  });
});
