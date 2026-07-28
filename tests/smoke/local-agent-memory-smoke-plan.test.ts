import { describe, expect, it } from "vitest";
import { API_ROUTES } from "../../Memory/src/index.js";
import { RequestContext } from "../../App/memmy-agent/src/core/agent-runtime/tools/context.js";
import { ToolRegistry } from "../../App/memmy-agent/src/core/agent-runtime/tools/registry.js";
import { MemmyMemoryClient } from "../../App/memmy-agent/src/memmy-memory/client.js";
import { registerMemmyMemoryTools } from "../../App/memmy-agent/src/memmy-memory/tools.js";
import type { MemmyMemoryToolRuntime } from "../../App/memmy-agent/src/memmy-memory/types.js";

describe("local agent memory smoke plan", () => {
  it("drives the agent memory lifecycle and recall tools through the public API contract", async () => {
    const requests: CapturedRequest[] = [];
    const client = new MemmyMemoryClient(
      {
        baseUrl: "https://memory.example.invalid",
        token: "test-token",
        timeoutMs: 1_000
      },
      createMemoryFetch(requests)
    );

    await client.openSession({
      requestId: "smoke-open",
      adapterId: "memmy-agent",
      source: "memmy-agent",
      sessionId: "memmy-agent::cli:smoke"
    });
    await client.startTurn("turn-smoke", {
      requestId: "smoke-start",
      adapterId: "memmy-agent",
      source: "memmy-agent",
      sessionId: "memmy-agent::cli:smoke",
      query: "Publish v1.0.2 safely"
    });
    await client.completeTurn("turn-smoke", {
      requestId: "smoke-complete",
      adapterId: "memmy-agent",
      source: "memmy-agent",
      sessionId: "memmy-agent::cli:smoke",
      query: "Publish v1.0.2 safely",
      answer: "Verify every release attachment before publishing."
    });

    const runtime = createToolRuntime();
    const registry = new ToolRegistry();
    registerMemmyMemoryTools(registry, client, runtime);
    const context = new RequestContext({ sessionKey: "cli:smoke" });
    setToolContext(registry, "memmy_memory_search", context);
    setToolContext(registry, "memmy_memory_get", context);

    const searchResult = await registry.execute("memmy_memory_search", {
      query: "release attachments",
      layers: ["L1"]
    });
    const getResult = await registry.execute("memmy_memory_get", {
      id: "trace/smoke"
    });

    await client.closeSession("memmy-agent::cli:smoke", {
      requestId: "smoke-close",
      adapterId: "memmy-agent",
      source: "memmy-agent"
    });

    expect(registry.toolNames.sort()).toEqual(["memmy_memory_get", "memmy_memory_search"]);
    expect(searchResult).toContain('<memmy_memory_context source="tool_search">');
    expect(searchResult).toContain("Verified release attachment history.");
    expect(searchResult).toContain("<current_user_request>\nPublish v1.0.2 safely\n</current_user_request>");
    expect(getResult).toContain('<memmy_memory_context source="tool_get">');
    expect(getResult).toContain("User:\nWhich files ship in v1.0.2?");
    expect(getResult).toContain("Assistant:\nFour signed desktop installers.");
    expect(getResult).not.toContain("embedding");

    expect(API_ROUTES).toEqual(expect.arrayContaining([
      "POST /api/v1/sessions/open",
      "POST /api/v1/turns/start",
      "POST /api/v1/turns/:turnId/complete",
      "POST /api/v1/memory/search",
      "GET /api/v1/memory/:id",
      "POST /api/v1/sessions/:sessionId/close"
    ]));
    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "POST /api/v1/sessions/open",
      "POST /api/v1/turns/start",
      "POST /api/v1/turns/turn-smoke/complete",
      "POST /api/v1/memory/search",
      "GET /api/v1/memory/trace%2Fsmoke",
      "POST /api/v1/sessions/memmy-agent%3A%3Acli%3Asmoke/close"
    ]);
    expect(requests.every((request) => request.authorization === "Bearer test-token")).toBe(true);
    expect(requests[3]?.body).toEqual({
      query: "release attachments",
      source: "memmy-agent",
      sessionId: "memmy-agent::cli:smoke",
      layers: ["L1"]
    });
  });
});

interface CapturedRequest {
  method: string;
  path: string;
  authorization: string | null;
  body?: unknown;
}

interface ContextAwareTool {
  setContext(context: RequestContext): void;
}

function createToolRuntime(): MemmyMemoryToolRuntime {
  return {
    requestEnvelope: (sessionKey) => ({
      requestId: "smoke-tool",
      adapterId: "memmy-agent",
      source: "memmy-agent",
      namespace: {
        source: "memmy-agent",
        profileId: "default",
        sessionKey: sessionKey ?? undefined
      }
    }),
    currentSessionId: () => "memmy-agent::cli:smoke",
    currentEpisodeId: () => "episode-smoke",
    currentTurnId: () => "turn-smoke",
    currentUserText: () => "Publish v1.0.2 safely"
  };
}

function setToolContext(registry: ToolRegistry, name: string, context: RequestContext): void {
  const tool = registry.get(name);
  if (!tool || !("setContext" in tool)) {
    throw new Error(`${name} is not context-aware`);
  }
  (tool as unknown as ContextAwareTool).setContext(context);
}

function createMemoryFetch(requests: CapturedRequest[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    const url = new URL(rawUrl);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    requests.push({
      method,
      path: url.pathname,
      authorization: headers.get("authorization"),
      body
    });

    return jsonResponse(responseFor(method, url.pathname));
  }) as typeof fetch;
}

function responseFor(method: string, path: string): unknown {
  if (method === "POST" && path === "/api/v1/sessions/open") {
    return { sessionId: "memmy-agent::cli:smoke" };
  }
  if (method === "POST" && path === "/api/v1/turns/start") {
    return { turnId: "turn-smoke", episodeId: "episode-smoke" };
  }
  if (method === "POST" && path === "/api/v1/turns/turn-smoke/complete") {
    return { rawTurnId: "raw-smoke", l1MemoryId: "trace/smoke" };
  }
  if (method === "POST" && path === "/api/v1/memory/search") {
    return { injectedContext: "Verified release attachment history." };
  }
  if (method === "GET" && path === "/api/v1/memory/trace%2Fsmoke") {
    return {
      id: "trace/smoke",
      kind: "trace",
      memoryLayer: "L1",
      title: "Release artifacts",
      refs: {
        rawTurn: {
          userText: "Which files ship in v1.0.2?",
          assistantText: "Four signed desktop installers."
        }
      },
      metadata: {
        properties: { embedding: [1, 0, 0] }
      }
    };
  }
  if (method === "POST" && path === "/api/v1/sessions/memmy-agent%3A%3Acli%3Asmoke/close") {
    return { ok: true };
  }
  throw new Error(`Unexpected memory request: ${method} ${path}`);
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
