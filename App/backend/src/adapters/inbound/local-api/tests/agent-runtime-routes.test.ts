/** Agent runtime routes tests. */
import { afterEach, describe, expect, it } from "vitest";
import { createProgressBus } from "../../../../services/progress-bus.js";
import { createLocalApiServer } from "../server.js";
import type { FastifyInstance } from "fastify";
import type { PermissionManager } from "../../../../permission/index.js";
import type { BackendServices } from "../../../../services/index.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("agent runtime local api routes", () => {
  it("exposes the current memory runtime routes behind the runtime token", async () => {
    app = createServer();

    const requests = [
      { method: "GET", url: "/api/v1/health" },
      { method: "POST", url: "/api/v1/admin/reload-config", payload: { reason: "manual_restart" } },
      { method: "POST", url: "/api/v1/sessions/open", payload: openSessionInput() },
      { method: "POST", url: "/api/v1/sessions/session-1/close", payload: closeSessionInput() },
      { method: "POST", url: "/api/v1/turns/start", payload: startTurnInput() },
      { method: "POST", url: "/api/v1/turns/turn-1/complete", payload: completeTurnInput() },
      { method: "POST", url: "/api/v1/memory/search", payload: searchInput() },
      { method: "POST", url: "/api/v1/memory/add", payload: addMemoryInput() },
      { method: "POST", url: "/api/v1/memory/processing/status", payload: { memoryIds: ["memory-1"] } },
      { method: "POST", url: "/api/v1/memory/memory-1/processing/retry", payload: {} },
      { method: "GET", url: "/api/v1/memory/memory-1" },
      { method: "DELETE", url: "/api/v1/memory/memory-1" },
      { method: "GET", url: "/api/v1/memory/logs?tools=memory_add,memory_search&limit=20&offset=0" },
      { method: "GET", url: "/api/v1/panel/overview" },
      { method: "GET", url: "/api/v1/panel/analysis" },
      { method: "GET", url: "/api/v1/panel/items?layer=L1&status=activated&page=1" },
      { method: "GET", url: "/api/v1/panel/tasks?page=1" },
      { method: "DELETE", url: "/api/v1/panel/tasks/episode-1" }
    ];

    for (const request of requests) {
      const response = await app.inject({
        method: request.method,
        url: request.url,
        headers: { "x-memmy-local-token": "test-token" },
        payload: request.payload
      });

      expect(response.statusCode, `${request.method} ${request.url}`).toBe(200);
    }
  });

  it("rejects runtime routes without a valid token", async () => {
    app = createServer();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/memory/search",
      payload: searchInput()
    });

    expect(response.statusCode).toBe(401);
  });

  it("reloads the latest model config before retrying one failed memory", async () => {
    const calls: unknown[] = [];
    app = createServer({
      memoryClient: {
        async reloadConfig(input: unknown) {
          calls.push({ reload: input });
          return {
            activeProfile: "byok" as const,
            changed: true,
            requiresRestart: false,
            models: memoryModels(),
            reloadedAt: now()
          };
        },
        async retryMemoryProcessing(memoryId: string) {
          calls.push({ retry: memoryId });
          return {
            accepted: true,
            processing: {
              memoryId,
              state: "summary_pending" as const,
              stage: "summary" as const,
              activeJobId: "job-retry",
              attemptCount: 0,
              manualRetryCount: 1,
              retryAction: "retry" as const,
              errorCode: null,
              errorMessage: null,
              failedAt: null,
              updatedAt: now()
            },
            job: {
              jobId: "job-retry",
              jobType: "trace_summary" as const,
              status: "queued" as const
            },
            serverTime: now()
          };
        }
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/memory/memory-1/processing/retry",
      headers: { "x-memmy-local-token": "test-token" },
      payload: {}
    });

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([
      {
        reload: {
          reason: "manual_processing_retry",
          restartFailedProcessing: false
        }
      },
      { retry: "memory-1" }
    ]);
  });

  it("parses source Agent filters for memory logs", async () => {
    const receivedInputs: unknown[] = [];
    app = createServer({
      panel: {
        async memoryApiLogs(input: unknown) {
          receivedInputs.push(input);
          return { logs: [], total: 0, limit: 20, offset: 0, serverTime: now() };
        }
      }
    });

    const exactResponse = await app.inject({
      method: "GET",
      url: "/api/v1/memory/logs?tools=memory_search&sourceAgent=cursor&limit=20&offset=0",
      headers: { "x-memmy-local-token": "test-token" }
    });
    const otherResponse = await app.inject({
      method: "GET",
      url: "/api/v1/memory/logs?tools=memory_add&excludedSourceAgents=memmy-agent&excludedSourceAgents=cursor&limit=20&offset=0",
      headers: { "x-memmy-local-token": "test-token" }
    });

    expect(exactResponse.statusCode).toBe(200);
    expect(otherResponse.statusCode).toBe(200);
    expect(receivedInputs).toEqual([
      {
        tools: ["memory_search"],
        sourceAgent: "cursor",
        limit: 20,
        offset: 0
      },
      {
        tools: ["memory_add"],
        excludedSourceAgents: ["memmy-agent", "cursor"],
        limit: 20,
        offset: 0
      }
    ]);
  });

  it("parses source Agent filters for L1 panel items", async () => {
    const receivedInputs: unknown[] = [];
    app = createServer({
      panel: {
        async items(input: unknown) {
          receivedInputs.push(input);
          return panelItemsOutput();
        }
      }
    });

    const exactResponse = await app.inject({
      method: "GET",
      url: "/api/v1/panel/items?layer=L1&sourceAgent=cursor&page=2",
      headers: { "x-memmy-local-token": "test-token" }
    });
    const otherResponse = await app.inject({
      method: "GET",
      url: "/api/v1/panel/items?layer=L1&excludedSourceAgents=memmy-agent&excludedSourceAgents=cursor&page=1",
      headers: { "x-memmy-local-token": "test-token" }
    });

    expect(exactResponse.statusCode).toBe(200);
    expect(otherResponse.statusCode).toBe(200);
    expect(receivedInputs).toEqual([
      { layer: "L1", sourceAgent: "cursor", page: 2 },
      { layer: "L1", excludedSourceAgents: ["memmy-agent", "cursor"], page: 1 }
    ]);
  });

  it("returns invalid_argument for zod parse failures", async () => {
    app = createServer();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/memory/search",
      headers: { "x-memmy-local-token": "test-token", "x-request-id": "req-1" },
      payload: { query: 1 }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: "invalid_argument",
        requestId: "req-1"
      }
    });
  });

  it("unwraps duplicate service responses", async () => {
    app = createServer({
      turn: {
        async start() { return startTurnOutput(); },
        async complete() {
          return {
            kind: "duplicate" as const,
            response: { ...completeTurnOutput(), duplicate: true }
          };
        }
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/turns/turn-1/complete",
      headers: { "x-memmy-local-token": "test-token" },
      payload: completeTurnInput()
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ duplicate: true });
  });

  it("uses error-envelope for service errors", async () => {
    app = createServer({
      search: {
        async search() {
          throw Object.assign(new Error("memory layer unavailable"), { code: "memory_layer_unavailable" });
        }
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/memory/search",
      headers: { "x-memmy-local-token": "test-token", "x-request-id": "req-7" },
      payload: searchInput()
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: {
        code: "memory_layer_unavailable",
        message: "memory layer unavailable",
        requestId: "req-7"
      }
    });
  });
});

function createServer(overrides: Record<string, unknown> = {}): FastifyInstance {
  const services = {
    memoryClient: {
      async health() {
        return {
          ok: true,
          version: "test-0.0.0",
          uptimeMs: 1,
          mode: "dev",
          storage: { backend: "sqlite", schemaVersion: "test", ready: true },
          capabilities: {
            routes: ["/api/v1/health"],
            tools: [],
            memoryLayers: ["L1", "L2", "L3", "Skill"],
            supportsCli: true
          },
          activeProfile: "byok",
          models: memoryModels(),
          serverTime: now()
        };
      },
      async reloadConfig() {
        return {
          activeProfile: "byok" as const,
          changed: false,
          requiresRestart: false,
          models: memoryModels(),
          reloadedAt: now()
        };
      },
      async getMemoryProcessingStatus(memoryIds: string[]) {
        return {
          items: memoryIds.map((memoryId) => ({
            memoryId,
            state: "failed" as const,
            stage: "summary" as const,
            activeJobId: null,
            attemptCount: 3,
            manualRetryCount: 0,
            retryAction: "retry" as const,
            errorCode: "processing_failed",
            errorMessage: "provider unavailable",
            failedAt: now(),
            updatedAt: now()
          })),
          serverTime: now()
        };
      },
      async retryMemoryProcessing(memoryId: string) {
        return {
          accepted: true,
          processing: {
            memoryId,
            state: "summary_pending" as const,
            stage: "summary" as const,
            activeJobId: "job-retry",
            attemptCount: 0,
            manualRetryCount: 1,
            retryAction: "retry" as const,
            errorCode: null,
            errorMessage: null,
            failedAt: null,
            updatedAt: now()
          },
          job: {
            jobId: "job-retry",
            jobType: "trace_summary" as const,
            status: "queued" as const
          },
          serverTime: now()
        };
      }
    },
    agentAdapterRegistry: { listAdapters: () => [] },
    bootstrap: {
      async getBootstrap() {
        throw new Error("bootstrap not used");
      }
    },
    appConfig: {},
    account: {},
    integrations: {},
    localData: {},
    agentSources: {},
    progressBus: createProgressBus(),
    session: {
      async open() { return { kind: "executed" as const, response: openSessionOutput() }; },
      async close() { return { kind: "executed" as const, response: closeSessionOutput() }; }
    },
    turn: {
      async start() { return startTurnOutput(); },
      async complete() { return { kind: "executed" as const, response: completeTurnOutput() }; }
    },
    search: { async search() { return searchOutput(); } },
    memoryDetail: {
      async add() { return addMemoryOutput(); },
      async getById() { return getMemoryOutput(); },
      async delete() { return deleteMemoryOutput(); }
    },
    panel: {
      async overview() { return panelOverviewOutput(); },
      async analysis() { return panelAnalysisOutput(); },
      async items() { return panelItemsOutput(); },
      async tasks() { return panelTasksOutput(); },
      async deleteTask(id: string) { return { ok: true as const, id, deletedMemoryIds: [], serverTime: now() }; },
      async memoryApiLogs() { return { logs: [], total: 0, limit: 20, offset: 0, serverTime: now() }; }
    },
    ...overrides
  } as unknown as BackendServices;

  return createLocalApiServer({
    permissionManager: createPermissionManager(),
    services,
    heartbeatIntervalMs: 20
  });
}

function memoryModels() {
  return {
    summary: { provider: "openai_compatible", model: "memory_summary", configured: true, remote: true },
    evolution: { provider: "openai_compatible", model: "memory_evolution", configured: true, remote: true },
    embedding: { provider: "local", model: "hash-embedding-v1", configured: true, remote: false }
  };
}

function createPermissionManager(): PermissionManager {
  return {
    async getRuntimeToken() { return "test-token"; },
    async verifyRuntimeToken(token) { return token === "test-token"; },
    async getScanPermission() { return "scan_and_write_skill"; },
    async setScanPermission() { return undefined; },
    async canDetectAgentSources() { return true; },
    async canScanAgentSource() { return true; },
    async canWriteAgentSkill() { return true; },
    async canSearchMemory() { return true; },
    async revokeAgentSource() { return undefined; }
  };
}

function openSessionInput() {
  return { sessionId: "host-session-1", source: "codex" };
}

function closeSessionInput() {
  return { source: "codex" };
}

function startTurnInput() {
  return { sessionId: "session-1", query: "question", source: "codex" };
}

function completeTurnInput() {
  return { sessionId: "session-1", query: "question", answer: "answer", source: "codex" };
}

function searchInput() {
  return { query: "retry", source: "codex" };
}

function addMemoryInput() {
  return { content: "remember this", source: "codex" };
}

function openSessionOutput() {
  return { sessionId: "session-1", status: "open", resumed: false, serverTime: now() };
}

function closeSessionOutput() {
  return { ok: true, sessionId: "session-1", status: "closed", closedEpisodeIds: [], serverTime: now() };
}

function startTurnOutput() {
  return {
    turnId: "turn-1",
    contextPacketId: "context-1",
    sessionId: "session-1",
    episodeId: "episode-1",
    injectedContext: { markdown: "", sections: [] },
    searchEventId: "search-1",
    sourceMemoryIds: [],
    hits: [],
    status: [],
    serverTime: now()
  };
}

function completeTurnOutput() {
  return {
    turnId: "turn-1",
    sessionId: "session-1",
    l1MemoryId: "memory-1",
    rawTurnId: "raw-1",
    episodeId: "episode-1",
    scheduledEvolution: false,
    jobs: [],
    changeSeq: 1,
    serverTime: now()
  };
}

function searchOutput() {
  return {
    injectedContext: "",
    debug: {
      searchEventId: "search-1",
      hits: [],
      sourceMemoryIds: [],
      status: [],
      sections: [],
      serverTime: now()
    }
  };
}

function addMemoryOutput() {
  return {
    id: "memory-1",
    kind: "trace",
    memoryLayer: "L1",
    status: "activated",
    title: "remember this",
    summary: "remember this",
    tags: ["codex"],
    createdAt: now(),
    serverTime: now()
  };
}

function getMemoryOutput() {
  return {
    item: {
      id: "memory-1",
      kind: "trace",
      memoryLayer: "L1",
      status: "activated",
      title: "memory-1",
      summary: "",
      tags: ["codex"],
      updatedAt: now(),
      version: 1,
      body: "",
      createdAt: now(),
      sourceMemoryIds: [],
      metadata: { source: "codex" }
    },
    version: 1
  };
}

function deleteMemoryOutput() {
  return {
    ok: true,
    id: "memory-1",
    kind: "trace",
    status: "deleted",
    changeSeq: 2,
    syncCursor: "cursor-2",
    auditId: "audit-1",
    serverTime: now()
  };
}

function panelOverviewOutput() {
  return {
    counts: { memories: 0, skills: 0, experiences: 0, worldModels: 0 },
    dailyActivity: panelDays(),
    sourceDistribution: []
  };
}

function panelAnalysisOutput() {
  return {
    metrics: {
      avgRecallScore: 0,
      recallEvents: 0,
      activeSkills: 0,
      recentlyUsedSkills: 0,
      avgToolLatencyMs: 0,
      p95ToolLatencyMs: 0
    },
    dailyMemoryWrites: panelDays(),
    dailySkillEvolutions: panelDays(),
    toolLatency: { tools: [], series: [] }
  };
}

function panelItemsOutput() {
  return {
    items: [],
    page: 1,
    pageSize: 20,
    total: 0,
    totalPages: 1,
    hasNext: false,
    hasPrev: false,
    serverTime: now()
  };
}

function panelTasksOutput() {
  return {
    tasks: [],
    page: 1,
    pageSize: 20 as const,
    total: 0,
    totalPages: 1,
    hasNext: false,
    hasPrev: false,
    serverTime: now()
  };
}

function now() {
  return "2026-05-29T10:00:00.000Z";
}

function panelDays() {
  return [
    "2026-05-23",
    "2026-05-24",
    "2026-05-25",
    "2026-05-26",
    "2026-05-27",
    "2026-05-28",
    "2026-05-29"
  ].map((date) => ({ date, count: 0 }));
}
