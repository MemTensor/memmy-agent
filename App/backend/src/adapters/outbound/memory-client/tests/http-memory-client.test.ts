/** Http memory client tests. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpMemoryClient } from "../http-memory-client.js";
import { buildMemoryLayerUrl, MEMORY_LAYER_PATHS } from "../memory-layer-endpoints.js";
import { MemoryLayerError, MemoryLayerNetworkError } from "../errors.js";

let server: Server | undefined;

afterEach(async () => {
  await closeServer();
});

describe("HttpMemoryClient", () => {
  it("only defines path templates for the final memory HTTP APIs", () => {
    expect(Object.values(MEMORY_LAYER_PATHS)).toEqual([
      "/api/v1/health",
      "/api/v1/admin/reload-config",
      "/api/v1/sessions/open",
      "/api/v1/sessions/:sessionId/close",
      "/api/v1/turns/start",
      "/api/v1/turns/:turnId/complete",
      "/api/v1/memory/search",
      "/api/v1/memory/add",
      "/api/v1/memory/:id",
      "/api/v1/memory/:id",
      "/api/v1/worker/run",
      "/api/v1/worker/import-summaries/enqueue",
      "/api/v1/memory/processing/status",
      "/api/v1/memory/:id/processing/retry",
      "/api/v1/memory/logs",
      "/api/v1/panel/overview",
      "/api/v1/panel/analysis",
      "/api/v1/panel/items",
      "/api/v1/panel/tasks",
      "/api/v1/panel/tasks/:id"
    ]);
    expect(
      buildMemoryLayerUrl("http://127.0.0.1:8765/", "closeSession", {
        sessionId: "session 1"
      })
    ).toBe("http://127.0.0.1:8765/api/v1/sessions/session%201/close");
    expect(() => buildMemoryLayerUrl("http://127.0.0.1:8765", "closeSession")).toThrow("Missing path param");
  });

  it("calls every final runtime path and parses schema-valid responses", async () => {
    const requests: Array<{
      method: string;
      path: string;
      authorization: string | undefined;
      body: unknown;
    }> = [];
    const baseUrl = await startServer(async (request, response) => {
      const body = await readJson(request);
      requests.push({
        method: request.method ?? "",
        path: new URL(request.url ?? "/", "http://localhost").pathname,
        authorization: request.headers.authorization,
        body
      });
      sendJson(response, fixtureFor(request.method ?? "", new URL(request.url ?? "/", "http://localhost").pathname, body));
    });
    const client = createHttpMemoryClient({
      baseUrl,
      token: "memory-token",
      timeoutMs: 500,
      maxRetries: 0
    });

    await expect(client.health()).resolves.toMatchObject({ ok: true });
    await expect(client.reloadConfig({ reason: "profile_switched" })).resolves.toMatchObject({
      activeProfile: "byok",
      changed: true
    });
    await expect(client.openSession(openSessionInput())).resolves.toMatchObject({ status: "open" });
    await expect(client.closeSession(closeSessionInput())).resolves.toMatchObject({ status: "closed" });
    await expect(client.startTurn(startTurnInput())).resolves.toMatchObject({ status: [] });
    await expect(client.completeTurn(completeTurnInput())).resolves.toMatchObject({ scheduledEvolution: false });
    await expect(client.search(searchInput())).resolves.toEqual({ injectedContext: "" });
    await expect(client.search({ ...searchInput(), verbose: true })).resolves.toMatchObject({ debug: { hits: [] } });
    await expect(client.addMemory(addMemoryInput())).resolves.toMatchObject({ id: "memory-1" });
    await expect(client.getMemory({ memoryId: "memory-1" })).resolves.toMatchObject({ item: { id: "memory-1" } });
    await expect(client.deleteMemory({ memoryId: "memory-1", source: "codex" })).resolves.toMatchObject({ status: "deleted" });
    await expect(
      client.memoryApiLogs({ tools: ["memory_add", "memory_search"], limit: 20, offset: 0 })
    ).resolves.toMatchObject({ logs: [] });
    await expect(client.panelOverview()).resolves.toMatchObject({ counts: { memories: 0 } });
    await expect(client.panelAnalysis()).resolves.toMatchObject({ metrics: { avgRecallScore: 0 } });
    await expect(client.panelItems(panelItemsInput())).resolves.toMatchObject({ items: [] });
    await expect(client.panelTasks({ page: 1 })).resolves.toMatchObject({ tasks: [] });
    await expect(client.deletePanelTask("episode-1")).resolves.toMatchObject({ ok: true, id: "episode-1" });

    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "GET /api/v1/health",
      "POST /api/v1/admin/reload-config",
      "POST /api/v1/sessions/open",
      "POST /api/v1/sessions/session-1/close",
      "POST /api/v1/turns/start",
      "POST /api/v1/turns/turn-1/complete",
      "POST /api/v1/memory/search",
      "POST /api/v1/memory/search",
      "POST /api/v1/memory/add",
      "GET /api/v1/memory/memory-1",
      "DELETE /api/v1/memory/memory-1",
      "GET /api/v1/memory/logs",
      "GET /api/v1/panel/overview",
      "GET /api/v1/panel/analysis",
      "GET /api/v1/panel/items",
      "GET /api/v1/panel/tasks",
      "DELETE /api/v1/panel/tasks/episode-1"
    ]);
    expect(requests.every((request) => request.authorization === "Bearer memory-token")).toBe(true);
    expect(
      requests
        .filter((request) => requestBodySource(request.body) !== undefined)
        .map((request) => `${request.method} ${request.path}:${requestBodySource(request.body)}`)
    ).toEqual([
      "POST /api/v1/sessions/open:codex",
      "POST /api/v1/sessions/session-1/close:codex",
      "POST /api/v1/turns/start:codex",
      "POST /api/v1/turns/turn-1/complete:codex",
      "POST /api/v1/memory/search:codex",
      "POST /api/v1/memory/search:codex",
      "POST /api/v1/memory/add:codex",
      "DELETE /api/v1/memory/memory-1:codex"
    ]);
    expect(requests.find((request) => request.path === "/api/v1/admin/reload-config")?.body).toEqual({
      reason: "profile_switched"
    });
    expect(requests.find((request) => request.path === "/api/v1/memory/add")?.body).toMatchObject({
      content: "remember this",
      source: "codex"
    });
  });

  it("forwards memory log Agent filters to the Memory service", async () => {
    const requestUrls: URL[] = [];
    const baseUrl = await startServer(async (request, response) => {
      requestUrls.push(new URL(request.url ?? "/", "http://localhost"));
      sendJson(response, memoryApiLogsOutput());
    });
    const client = createHttpMemoryClient({ baseUrl, token: "", timeoutMs: 500, maxRetries: 0 });

    await client.memoryApiLogs({
      tools: ["memory_search"],
      sourceAgent: "cursor",
      limit: 20,
      offset: 0
    });
    await client.memoryApiLogs({
      tools: ["memory_search"],
      excludedSourceAgents: ["memmy-agent", "cursor"],
      limit: 20,
      offset: 0
    });

    expect(requestUrls[0]?.searchParams.get("tools")).toBe("memory_search");
    expect(requestUrls[0]?.searchParams.get("sourceAgent")).toBe("cursor");
    expect(requestUrls[1]?.searchParams.getAll("excludedSourceAgents")).toEqual(["memmy-agent", "cursor"]);
  });

  it("forwards L1 panel item Agent filters to the Memory service", async () => {
    const requestUrls: URL[] = [];
    const baseUrl = await startServer(async (request, response) => {
      requestUrls.push(new URL(request.url ?? "/", "http://localhost"));
      sendJson(response, panelItemsOutput());
    });
    const client = createHttpMemoryClient({ baseUrl, token: "", timeoutMs: 500, maxRetries: 0 });

    await client.panelItems({ layer: "L1", sourceAgent: "cursor", page: 2 });
    await client.panelItems({ layer: "L1", excludedSourceAgents: ["memmy-agent", "cursor"], page: 1 });

    expect(requestUrls[0]?.searchParams.get("layer")).toBe("L1");
    expect(requestUrls[0]?.searchParams.get("sourceAgent")).toBe("cursor");
    expect(requestUrls[0]?.searchParams.get("page")).toBe("2");
    expect(requestUrls[1]?.searchParams.getAll("excludedSourceAgents")).toEqual(["memmy-agent", "cursor"]);
  });

  it("limits worker requests to the scan's imported memories", async () => {
    let requestBody: unknown;
    const baseUrl = await startServer(async (request, response) => {
      requestBody = await readJson(request);
      sendJson(response, {
        leased: 0,
        succeeded: 0,
        failed: 0,
        jobs: [],
        embeddingRetries: { leased: 0, succeeded: 0, failed: 0, items: [] },
        changeSeq: 0,
        syncCursor: "cursor-0",
        serverTime: now()
      });
    });
    const client = createHttpMemoryClient({ baseUrl, token: "", timeoutMs: 500, maxRetries: 0 });

    await client.runWorker({ limit: 20, targetMemoryIds: ["memory-a", "memory-b"] });

    expect(requestBody).toEqual({
      limit: 20,
      targetMemoryIds: ["memory-a", "memory-b"]
    });
  });

  it("retries 5xx responses and succeeds before max retries is exhausted", async () => {
    let calls = 0;
    const baseUrl = await startServer(async (_request, response) => {
      calls += 1;
      if (calls < 3) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end("{}");
        return;
      }

      sendJson(response, healthOutput());
    });
    const client = createHttpMemoryClient({ baseUrl, token: "", timeoutMs: 500, maxRetries: 3 });

    await expect(client.health()).resolves.toMatchObject({ ok: true });
    expect(calls).toBe(3);
  });

  it("throws memory_layer_unavailable when 5xx retries are exhausted", async () => {
    let calls = 0;
    const baseUrl = await startServer(async (_request, response) => {
      calls += 1;
      response.writeHead(500, { "content-type": "application/json" });
      response.end("{}");
    });
    const client = createHttpMemoryClient({ baseUrl, token: "", timeoutMs: 500, maxRetries: 3 });

    await expect(client.health()).rejects.toMatchObject({
      code: "memory_layer_unavailable",
      status: 503
    });
    expect(calls).toBe(4);
  });

  it("does not retry 4xx responses and maps the API error body", async () => {
    let calls = 0;
    const baseUrl = await startServer(async (_request, response) => {
      calls += 1;
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "invalid_argument", message: "x", requestId: "req-1" } }));
    });
    const client = createHttpMemoryClient({ baseUrl, token: "", timeoutMs: 500, maxRetries: 3 });

    await expect(client.health()).rejects.toMatchObject({
      code: "invalid_argument",
      status: 400,
      message: "x"
    });
    expect(calls).toBe(1);
  });

  it("downgrades unrecognized 4xx error bodies instead of leaking zod enum text", async () => {
    // The memory layer returns a code not in the local ApiErrorCode enum (and lacks a requestId):
    // the old implementation used strict parse to throw a ZodError → the upper-layer envelope passed "Invalid option: expected one of ..." through to the UI.
    const baseUrl = await startServer(async (_request, response) => {
      response.writeHead(422, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "memory_layer_specific_code", message: "上游原始细节" } }));
    });
    const client = createHttpMemoryClient({ baseUrl, token: "", timeoutMs: 500, maxRetries: 0 });

    const error = await client.health().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(MemoryLayerError);
    const memoryError = error as MemoryLayerError;
    expect(memoryError.code).toBe("internal");
    expect(memoryError.status).toBe(422);
    expect(memoryError.message).toBe("memory layer returned an unrecognized error response");
    // Never treat raw Zod validation text or raw upstream copy as the upper-layer-facing message.
    expect(memoryError.message).not.toMatch(/Invalid option/);
    expect(memoryError.message).not.toContain("上游原始细节");
  });

  it("downgrades malformed 5xx-shaped error bodies to memory_layer_unavailable", async () => {
    const baseUrl = await startServer(async (_request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "weird" } }));
    });
    const client = createHttpMemoryClient({ baseUrl, token: "", timeoutMs: 500, maxRetries: 0 });

    // 503 already throws memory_layer_unavailable in the 5xx branch; this confirms it is still a stable code.
    await expect(client.health()).rejects.toMatchObject({ code: "memory_layer_unavailable" });
  });

  it("throws MemoryLayerNetworkError for connection failures", async () => {
    const baseUrl = await startServer(async (_request, response) => {
      sendJson(response, healthOutput());
    });
    await closeServer();
    const client = createHttpMemoryClient({ baseUrl, token: "", timeoutMs: 100, maxRetries: 0 });

    await expect(client.health()).rejects.toBeInstanceOf(MemoryLayerNetworkError);
  });

  it("throws MemoryLayerError 503 for request timeouts", async () => {
    const baseUrl = await startServer(async () => {
      return undefined;
    });
    const client = createHttpMemoryClient({ baseUrl, token: "", timeoutMs: 50, maxRetries: 0 });

    await expect(client.health()).rejects.toBeInstanceOf(MemoryLayerError);
    await expect(client.health()).rejects.toMatchObject({
      code: "memory_layer_unavailable",
      status: 503
    });
  });
});

async function startServer(handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>): Promise<string> {
  server = createServer((request, response) => {
    handler(request, response).catch((error: unknown) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "server error" }));
    });
  });

  await new Promise<void>((resolve) => {
    server?.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server did not bind a port");
  }

  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(): Promise<void> {
  const active = server;
  server = undefined;
  if (!active?.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    active.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.method === "GET" || request.method === "HEAD") {
    return undefined;
  }

  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
  }

  return body ? JSON.parse(body) : undefined;
}

function sendJson(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function requestBodySource(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const source = (body as Record<string, unknown>).source;
  return typeof source === "string" ? source : undefined;
}

function fixtureFor(method: string, path: string, body: unknown): unknown {
  if (method === "GET" && path === "/api/v1/health") return healthOutput();
  if (method === "POST" && path === "/api/v1/admin/reload-config") return reloadConfigOutput();
  if (method === "POST" && path === "/api/v1/sessions/open") return openSessionOutput();
  if (method === "POST" && path === "/api/v1/sessions/session-1/close") return closeSessionOutput();
  if (method === "POST" && path === "/api/v1/turns/start") return startTurnOutput(body);
  if (method === "POST" && path === "/api/v1/turns/turn-1/complete") return completeTurnOutput();
  if (method === "POST" && path === "/api/v1/memory/search") return searchOutput(body);
  if (method === "POST" && path === "/api/v1/memory/add") return addMemoryOutput(body);
  if (method === "GET" && path === "/api/v1/memory/memory-1") return getMemoryOutput();
  if (method === "DELETE" && path === "/api/v1/memory/memory-1") return deleteMemoryOutput();
  if (method === "GET" && path === "/api/v1/memory/logs") return memoryApiLogsOutput();
  if (method === "GET" && path === "/api/v1/panel/overview") return panelOverviewOutput();
  if (method === "GET" && path === "/api/v1/panel/analysis") return panelAnalysisOutput();
  if (method === "GET" && path === "/api/v1/panel/items") return panelItemsOutput();
  if (method === "GET" && path === "/api/v1/panel/tasks") return panelTasksOutput();
  if (method === "DELETE" && path === "/api/v1/panel/tasks/episode-1") {
    return { ok: true, id: "episode-1", deletedMemoryIds: [], serverTime: now() };
  }

  throw new Error(`unexpected route ${method} ${path}`);
}

function healthOutput() {
  return {
    ok: true,
    version: "1.0.0",
    uptimeMs: 1,
    mode: "local",
    storage: { backend: "sqlite", schemaVersion: "3", ready: true },
    capabilities: { routes: ["/api/v1/health"], tools: [], memoryLayers: ["L1", "L2", "L3", "Skill"], supportsCli: true },
    activeProfile: "byok",
    models: modelStatuses(),
    serverTime: now()
  };
}

function reloadConfigOutput() {
  return {
    activeProfile: "byok",
    changed: true,
    requiresRestart: false,
    models: modelStatuses(),
    reloadedAt: now()
  };
}

function modelStatuses() {
  return {
    summary: { provider: "openai_compatible", model: "memory_summary", configured: true, remote: true },
    evolution: { provider: "openai_compatible", model: "memory_evolution", configured: true, remote: true },
    embedding: { provider: "local", model: "hash-embedding-v1", configured: true, remote: false }
  };
}

function openSessionOutput() {
  return { sessionId: "session-1", status: "open", episodeId: "episode-1", resumed: false, serverTime: now() };
}

function closeSessionOutput() {
  return { ok: true, sessionId: "session-1", status: "closed", closedEpisodeIds: ["episode-1"], serverTime: now() };
}

function startTurnOutput(body: unknown) {
  const input = body as { sessionId: string; turnId?: string };
  return {
    turnId: input.turnId ?? "turn-1",
    contextPacketId: "context-1",
    sessionId: input.sessionId,
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

function searchOutput(body: unknown) {
  const input = typeof body === "object" && body !== null ? body as { verbose?: boolean } : {};
  if (input.verbose !== true) {
    return { injectedContext: "" };
  }
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

function addMemoryOutput(body: unknown) {
  const input = body as { content: string; source?: string };
  return {
    id: "memory-1",
    kind: "trace",
    memoryLayer: "L1",
    status: "activated",
    title: input.content,
    summary: input.content,
    tags: input.source ? [input.source] : [],
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
      createdAt: now(),
      updatedAt: now(),
      version: 1,
      body: "",
      sourceMemoryIds: [],
      metadata: { source: "codex" }
    },
    version: 1
  };
}

function deleteMemoryOutput() {
  return { ok: true, id: "memory-1", kind: "trace", status: "deleted", changeSeq: 2, syncCursor: "cursor-2", auditId: "audit-1", serverTime: now() };
}

/**
 * Builds a schema-valid empty Memory API logs response.
 *
 * @returns the empty log-list output.
 */
function memoryApiLogsOutput() {
  return { logs: [], total: 0, limit: 20, offset: 0, serverTime: now() };
}

function panelOverviewOutput() {
  return { counts: { memories: 0, skills: 0, experiences: 0, worldModels: 0 }, dailyActivity: panelDays(), sourceDistribution: [] };
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
  return { items: [], page: 1, pageSize: 20, total: 0, totalPages: 1, hasNext: false, hasPrev: false, serverTime: now() };
}

function panelTasksOutput() {
  return { tasks: [], page: 1, pageSize: 20, total: 0, totalPages: 1, hasNext: false, hasPrev: false, serverTime: now() };
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

function openSessionInput() {
  return { sessionId: "host-session-1", source: "codex" };
}

function closeSessionInput() {
  return { sessionId: "session-1", source: "codex" };
}

function startTurnInput() {
  return { turnId: "turn-1", sessionId: "session-1", query: "question", source: "codex" };
}

function completeTurnInput() {
  return { turnId: "turn-1", sessionId: "session-1", query: "question", answer: "answer", source: "codex" };
}

function searchInput() {
  return { query: "retry", source: "codex" };
}

function addMemoryInput() {
  return { content: "remember this", source: "codex" };
}

function panelItemsInput() {
  return { layer: "L1" as const, status: "activated" as const, page: 1 };
}
