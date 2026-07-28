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
    expect(MEMORY_RUNTIME_ENDPOINTS).toHaveLength(18);
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
      "DELETE /api/v1/memory/:id",
      "GET /api/v1/memory/logs",
      "GET /api/v1/panel/overview",
      "GET /api/v1/panel/analysis",
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
});
