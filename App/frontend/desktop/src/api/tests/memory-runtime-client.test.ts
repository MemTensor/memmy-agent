import { afterEach, describe, expect, it, vi } from "vitest";
import { MEMORY_RUNTIME_ENDPOINTS, createHttpMemoryRuntimeClient } from "../memory-runtime-client.js";

const runtimeConfig = {
  baseUrl: "http://127.0.0.1:18100",
  localToken: "local-token"
};

describe("memory runtime client", () => {
  it("completes consecutive public stats calls without retaining a settled queue entry", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({status:"preparing",serverTime:"2026-10-28T00:00:00Z"})));
    vi.stubGlobal("fetch",fetchMock);
    const client=createHttpMemoryRuntimeClient(runtimeConfig);
    expect((await client.getPanelStats!()).status).toBe("preparing");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      expect(await Promise.race([client.getPanelStats!(),new Promise(resolve=>{timer=setTimeout(()=>resolve("TIMEOUT"),150);})]))
        .toMatchObject({status:"preparing"});
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally { clearTimeout(timer); }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("declares the memory runtime endpoints exposed under /api/v1", () => {
    expect(MEMORY_RUNTIME_ENDPOINTS).toHaveLength(30);
    expect(MEMORY_RUNTIME_ENDPOINTS).toEqual([
      "GET /api/v1/health",
      "POST /api/v1/admin/reload-config",
      "POST /api/v1/sessions/open",
      "POST /api/v1/sessions/:sessionId/close",
      "POST /api/v1/turns/start",
      "POST /api/v1/turns/:turnId/complete",
      "POST /api/v1/memory/search",
      "POST /api/v1/memory/add",
      "POST /api/v1/evidence/skills/:id/approve",
      "PATCH /api/v1/evidence/skills/:id",
      "POST /api/v1/memory/processing/status",
      "POST /api/v1/memory/:id/processing/retry",
      "GET /api/v1/memory/:id",
      "DELETE /api/v1/memory/:id",
      "GET /api/v1/memory/recalls/:queryId",
      "GET /api/v1/memory/logs",
      "POST /api/v1/panel/browse",
      "GET /api/v1/panel/stats",
      "GET /api/v1/panel/overview-stats",
      "POST /api/v1/panel/logs",
      "GET /api/v1/panel/logs/:id",
      "GET /api/v1/panel/overview",
      "GET /api/v1/panel/analysis",
      "GET /api/v1/panel/items",
      "GET /api/v1/panel/tasks",
      "GET /api/v1/panel/task-summaries",
      "GET /api/v1/panel/task-details/:id",
  "GET /api/v1/panel/task-details/:id/check",
      "GET /api/v1/panel/task-details/:id/turns/:turnId/field",
      "DELETE /api/v1/panel/tasks/:id"
    ]);
  });

  it("falls back only for an explicitly unsupported summary route", async () => {
    const legacy = {tasks: [], page:1, pageSize:20, total:0, totalPages:1, hasNext:false, hasPrev:false, serverTime:"2026-10-27T00:00:00Z"};
    for (const message of ["GET /api/v1/panel/task-summaries is not registered", "Route GET:/api/v1/panel/task-summaries not found"]) {
      const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({error:{code:"not_found",message,requestId:"test"}}),{status:404})).mockResolvedValueOnce(new Response(JSON.stringify({error:{code:"not_found",message,requestId:"test"}}),{status:404})).mockResolvedValueOnce(new Response(JSON.stringify(legacy)));
      vi.stubGlobal("fetch",fetchMock);
      expect(await createHttpMemoryRuntimeClient(runtimeConfig).listPanelTaskSummaries!({})).toEqual(legacy);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    }
    for (const [status,code,message] of [[401,"unauthorized","expired"],[403,"forbidden","denied"],[404,"not_found","Task not found"],[503,"memory_layer_unavailable","timeout"]] as const) {
      const fetchMock=vi.fn(async()=>new Response(JSON.stringify({error:{code,message,requestId:"test"}}),{status})); vi.stubGlobal("fetch",fetchMock);
      await expect(createHttpMemoryRuntimeClient(runtimeConfig).listPanelTaskSummaries!({})).rejects.toThrow(message);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("saves observed Skill content with the original version through PATCH", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "skill/1", status: "activated",
      version: 2, serverTime: "2026-10-09T00:00:00Z" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createHttpMemoryRuntimeClient(runtimeConfig);
    const input = { body: "# Revised skill\n\n1. Check current state.", expectedVersion: 1 };
    await expect(client.updateObservedSkill!("skill/1", input)).resolves.toMatchObject({ version: 2, status: "activated" });
    expect(fetchMock).toHaveBeenCalledWith(new URL("/api/v1/evidence/skills/skill%2F1", runtimeConfig.baseUrl),
      expect.objectContaining({ method: "PATCH", body: JSON.stringify(input) }));
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
          models: {
            summary: { provider: "openai_compatible", model: "memory_summary", configured: true, remote: true, routing: "fixed" },
            evolution: { provider: "openai_compatible", model: "memory_evolution", configured: true, remote: true, routing: "fixed" },
            embedding: { provider: "local", model: "hash-embedding-v1", configured: true, remote: false, mode: "local" }
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

  it("cancels the actual health fetch through the supplied AbortSignal", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_url: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createHttpMemoryRuntimeClient(runtimeConfig);
    const failure = new Error("Health probe cancelled");
    const cancelled = expect(client.health(controller.signal)).rejects.toBe(failure);
    controller.abort(failure);
    await cancelled;
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/api/v1/health", runtimeConfig.baseUrl),
      expect.objectContaining({ signal: controller.signal })
    );
  });

  it("reloads memory config through the local API admin route", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          changed: false,
          requiresRestart: false,
          models: {
            summary: { provider: "openai_compatible", model: "memory_summary", configured: true, remote: true, routing: "fixed" },
            evolution: { provider: "openai_compatible", model: "memory_evolution", configured: true, remote: true, routing: "fixed" },
            embedding: { provider: "local", model: "hash-embedding-v1", configured: true, remote: false, mode: "local" }
          },
          reloadedAt: "2026-06-01T00:00:00.000Z"
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createHttpMemoryRuntimeClient(runtimeConfig);
    await expect(client.reloadConfig({ reason: "manual_reload" })).resolves.toMatchObject({
      models: {
        summary: { routing: "fixed" },
        evolution: { routing: "fixed" },
        embedding: { mode: "local" }
      }
    });
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
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new URL(String(_input)).pathname === "/api/v1/panel/browse" ? new Response(JSON.stringify({error:{code:"not_found",message:"POST /api/v1/panel/browse is not registered",requestId:"test"}}),{status:404}) : new Response(
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

    const exactUrl = fetchMock.mock.calls[1]?.[0] as URL;
    expect(exactUrl.searchParams.get("layer")).toBe("L1");
    expect(exactUrl.searchParams.get("sourceAgent")).toBe("cursor");
    expect(exactUrl.searchParams.get("page")).toBe("2");
    const otherUrl = fetchMock.mock.calls[2]?.[0] as URL;
    expect(otherUrl.searchParams.getAll("excludedSourceAgents")).toEqual(["memmy-agent", "cursor"]);
  });
});

it("reuses the prefetched user-memory view on its first real page read", async () => {
  const operations: unknown[] = [];
  const page = {viewId:"users",instanceId:"service",safety:"safe",createdAt:"2026-10-28T00:00:00Z",serverTime:"2026-10-28T00:00:00Z",page:1,pageSize:20,total:0,totalPages:1,hasNext:false,hasPrev:false,items:[]};
  vi.stubGlobal("fetch",vi.fn(async (_url: unknown,init: RequestInit) => {
    const body=JSON.parse(String(init.body));operations.push(body);
    return new Response(JSON.stringify(body.op==="check"?{viewId:"users",instanceId:"service",safety:"safe",updated:false,serverTime:page.serverTime}:page));
  }));
  try {
    const client=createHttpMemoryRuntimeClient(runtimeConfig);
    await client.prefetchPanel!("UserMemory",new AbortController().signal);
    await client.listPanelItems({layer:"UserMemory",page:1,userSummary:true});
    expect(operations).toMatchObject([{op:"create",filter:{layer:"UserMemory",userSummary:true}},{op:"check"}]);
    expect(operations).toHaveLength(2);
  } finally { vi.unstubAllGlobals(); }
});
