import { afterEach, describe, expect, it, vi } from "vitest";
import { MEMORY_RUNTIME_ENDPOINTS, createHttpMemoryRuntimeClient } from "../memory-runtime-client.js";

const runtimeConfig = {
  baseUrl: "http://127.0.0.1:18100",
  localToken: "local-token"
};

describe("memory runtime client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("declares the memory runtime endpoints exposed under /api/v1", () => {
    expect(MEMORY_RUNTIME_ENDPOINTS).toHaveLength(28);
    expect(MEMORY_RUNTIME_ENDPOINTS).toEqual([
      "GET /api/v1/health",
      "POST /api/v1/admin/reload-config",
      "POST /api/v1/sessions/open",
      "POST /api/v1/sessions/:sessionId/close",
      "POST /api/v1/turns/start",
      "POST /api/v1/turns/:turnId/complete",
      "POST /api/v1/memory/search",
      "POST /api/v1/memory/add",
      "POST /api/v1/memory/processing/status",
      "POST /api/v1/memory/:id/processing/retry",
      "GET /api/v1/memory/:id",
      "GET /api/v1/memory/:id/history",
      "POST /api/v1/memory/:id/history/:version/restore",
      "DELETE /api/v1/memory/:id",
      "GET /api/v1/memory/logs",
      "GET /api/v1/panel/overview",
      "GET /api/v1/panel/analysis",
      "GET /api/v1/panel/context-pack",
      "GET /api/v1/project-context/state",
      "POST /api/v1/project-context/goals/propose",
      "POST /api/v1/project-context/goals/:id/approve",
      "POST /api/v1/project-context/goals/:id/reject",
      "POST /api/v1/project-context/work-items",
      "PATCH /api/v1/project-context/work-items/:id",
      "PUT /api/v1/project-context/focus",
      "GET /api/v1/panel/items",
      "GET /api/v1/panel/tasks",
      "DELETE /api/v1/panel/tasks/:id"
    ]);
  });

  it("calls memory health with runtime token through requestJson", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          ok: true,
          version: "0.1.0",
          uptimeMs: 10,
          mode: "local",
          storage: {
            backend: "sqlite",
            schemaVersion: "1",
            ready: true
          },
          capabilities: {
            routes: ["/api/v1/health"],
            tools: [],
            memoryLayers: ["L1", "L2", "L3", "Skill"],
            supportsCli: true
          },
          activeProfile: "byok",
          models: {
        summary: { provider: "openai_compatible", model: "memory_summary", configured: true, remote: true },
            evolution: { provider: "openai_compatible", model: "memory_evolution", configured: true, remote: true },
            embedding: { provider: "local", model: "hash-embedding-v1", configured: true, remote: false }
          },
          serverTime: "2026-06-01T00:00:00.000Z"
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createHttpMemoryRuntimeClient(runtimeConfig);
    await expect(client.health()).resolves.toMatchObject({ ok: true, storage: { ready: true } });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/api/v1/health", runtimeConfig.baseUrl),
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-memmy-local-token": "local-token"
        })
      })
    );
  });

  it("reloads memory config through the local API admin route", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          activeProfile: "byok",
          changed: false,
          requiresRestart: false,
          models: {
        summary: { provider: "openai_compatible", model: "memory_summary", configured: true, remote: true },
            evolution: { provider: "openai_compatible", model: "memory_evolution", configured: true, remote: true },
            embedding: { provider: "local", model: "hash-embedding-v1", configured: true, remote: false }
          },
          reloadedAt: "2026-06-01T00:00:00.000Z"
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createHttpMemoryRuntimeClient(runtimeConfig);
    await expect(client.reloadConfig({ reason: "manual_reload" })).resolves.toMatchObject({ activeProfile: "byok" });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/api/v1/admin/reload-config", runtimeConfig.baseUrl),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ reason: "manual_reload" }),
        headers: expect.objectContaining({
          "content-type": "application/json",
          "x-memmy-local-token": "local-token"
        })
      })
    );
  });

  it("serializes exact and other Agent filters for memory logs", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(
      JSON.stringify({
        logs: [{
          id: 1,
          toolName: "memory_search",
          sourceAgent: "cursor",
          inputJson: "{}",
          outputJson: "{}",
          durationMs: 1,
          success: true,
          calledAt: "2026-07-12T09:59:00.000Z"
        }],
        total: 1,
        limit: 20,
        offset: 0,
        serverTime: "2026-07-12T10:00:00.000Z"
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    ));
    vi.stubGlobal("fetch", fetchMock);

    const client = createHttpMemoryRuntimeClient(runtimeConfig);
    const exactLogs = await client.listMemoryLogs({
      tools: ["memory_search"],
      sourceAgent: "cursor",
      limit: 20,
      offset: 0
    });
    await client.listMemoryLogs({
      tools: ["memory_search"],
      excludedSourceAgents: ["memmy-agent", "cursor"],
      limit: 20,
      offset: 0
    });

    const exactUrl = fetchMock.mock.calls[0]?.[0] as URL;
    expect(exactLogs.logs[0]?.sourceAgent).toBe("cursor");
    expect(exactUrl.searchParams.getAll("tools")).toEqual(["memory_search"]);
    expect(exactUrl.searchParams.get("sourceAgent")).toBe("cursor");
    const otherUrl = fetchMock.mock.calls[1]?.[0] as URL;
    expect(otherUrl.searchParams.getAll("excludedSourceAgents")).toEqual(["memmy-agent", "cursor"]);
  });

  it("serializes exact and other Agent filters for L1 panel items", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(
      JSON.stringify({
        items: [],
        page: 1,
        pageSize: 20,
        total: 0,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
        serverTime: "2026-07-12T10:00:00.000Z"
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    ));
    vi.stubGlobal("fetch", fetchMock);

    const client = createHttpMemoryRuntimeClient(runtimeConfig);
    await client.listPanelItems({ layer: "L1", sourceAgent: "cursor", page: 2 });
    await client.listPanelItems({ layer: "L1", excludedSourceAgents: ["memmy-agent", "cursor"], page: 1 });

    const exactUrl = fetchMock.mock.calls[0]?.[0] as URL;
    expect(exactUrl.searchParams.get("layer")).toBe("L1");
    expect(exactUrl.searchParams.get("sourceAgent")).toBe("cursor");
    expect(exactUrl.searchParams.get("page")).toBe("2");
    const otherUrl = fetchMock.mock.calls[1]?.[0] as URL;
    expect(otherUrl.searchParams.getAll("excludedSourceAgents")).toEqual(["memmy-agent", "cursor"]);
  });

  it("loads a project context pack through the scoped local API route", async () => {
    const fetchMock = vi.fn(async (_input: URL | RequestInfo) => new Response(JSON.stringify({
      namespace: { projectId: "project-1" },
      conventions: [],
      commands: [],
      architectureFacts: [],
      recentTasks: [],
      userPreferences: [],
      graph: { nodes: [], edges: [] },
      markdown: "# Project Memory Pack: project-1",
      generatedAt: "2026-08-08T12:00:00.000Z"
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createHttpMemoryRuntimeClient(runtimeConfig);
    await expect(client.getProjectContextPack("project-1")).resolves.toMatchObject({ namespace: { projectId: "project-1" } });

    const url = fetchMock.mock.calls[0]?.[0] as URL;
    expect(url.pathname).toBe("/api/v1/panel/context-pack");
    expect(url.searchParams.get("projectId")).toBe("project-1");
  });

  it("reads and mutates authoritative project context through typed routes", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo, _init?: RequestInit) => {
      const path = (input as URL).pathname;
      const body = path.endsWith("/state")
        ? { namespaceId: "namespace-1", activeGoal: null, goals: [], workItems: [], focusedWorkItem: null, facts: [] }
        : path.endsWith("/focus")
          ? null
          : { id: "goal-1", namespaceId: "namespace-1", userId: "user-1", projectId: "project-1", title: "Goal", summary: "", detail: "", acceptanceCriteria: [], constraints: [], status: "active", version: 1, sourceMemoryIds: [], provenance: {}, createdAt: "2026-08-08T12:00:00.000Z", updatedAt: "2026-08-08T12:00:00.000Z" };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = createHttpMemoryRuntimeClient(runtimeConfig);
    const namespace = { source: "desktop", profileId: "default", projectId: "project-1" };
    const mutation = { namespace, source: "desktop", adapterId: "memmy-desktop", requestId: "request-1", provenance: { sourceAgent: "memmy-desktop", sourceMemoryIds: [], capturedAt: "2026-08-08T12:00:00.000Z", projectId: "project-1" } };

    await client.getProjectContextState(namespace);
    await client.approveProjectGoal("goal/1", mutation);
    await client.setProjectFocus({ ...mutation, workItemId: null });

    expect((fetchMock.mock.calls[0]?.[0] as URL).pathname).toBe("/api/v1/project-context/state");
    expect((fetchMock.mock.calls[0]?.[0] as URL).searchParams.get("namespace")).toBe(JSON.stringify(namespace));
    expect((fetchMock.mock.calls[1]?.[0] as URL).pathname).toBe("/api/v1/project-context/goals/goal%2F1/approve");
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ body: JSON.stringify(mutation) }));
    expect((fetchMock.mock.calls[2]?.[0] as URL).pathname).toBe("/api/v1/project-context/focus");
  });

  it("passes a memory detail abort signal through to fetch", async () => {
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, _init?: RequestInit) => new Response(JSON.stringify({
      item: {
        id: "memory-1",
        kind: "trace",
        memoryLayer: "L1",
        status: "activated",
        title: "Memory one",
        summary: "",
        tags: [],
        createdAt: "2026-08-08T10:00:00.000Z",
        updatedAt: "2026-08-08T12:00:00.000Z",
        version: 1,
        body: "Body",
        sourceMemoryIds: [],
        metadata: {}
      },
      version: 1
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await createHttpMemoryRuntimeClient(runtimeConfig).getMemory("memory-1", { signal: controller.signal });

    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ signal: controller.signal }));
  });

  it("loads history and restores a selected source version", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo, _init?: RequestInit) => {
      const url = input as URL;
      const restoring = url.pathname.endsWith("/restore");
      return new Response(JSON.stringify(restoring ? {
        ok: true,
        id: "memory-1",
        version: 4,
        restoredVersion: 1,
        changeSeq: 4,
        auditId: "audit-restore-1",
        serverTime: "2026-08-08T13:00:00.000Z"
      } : {
        id: "memory-1",
        currentVersion: 3,
        items: [{ seq: 1, version: 1, changeType: "created", source: "turn_complete", createdAt: "2026-08-07T10:00:00.000Z", after: {} }],
        serverTime: "2026-08-08T12:00:00.000Z"
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = createHttpMemoryRuntimeClient(runtimeConfig);

    await expect(client.getMemoryHistory("memory-1")).resolves.toMatchObject({ currentVersion: 3 });
    await expect(client.restoreMemory("memory-1", 1, { version: 3, reason: "restored from desktop context pack" }))
      .resolves.toMatchObject({ version: 4, restoredVersion: 1 });

    const restoreUrl = fetchMock.mock.calls[1]?.[0] as URL;
    const restoreInit = fetchMock.mock.calls[1]?.[1];
    expect(restoreUrl.pathname).toBe("/api/v1/memory/memory-1/history/1/restore");
    expect(restoreInit).toEqual(expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ version: 3, reason: "restored from desktop context pack" })
    }));
  });
});
