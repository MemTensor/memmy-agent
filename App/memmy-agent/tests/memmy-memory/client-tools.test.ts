import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMOS_MEMORY_TIMEOUT_MS, MemmyMemoryClient, MemmyMemoryHttpError } from "../../src/memmy-memory/client.js";
import { MEMOS_MEMORY_TOOL_SPECS, registerMemmyMemoryTools } from "../../src/memmy-memory/tools.js";
import type { MemmyMemoryToolRuntime } from "../../src/memmy-memory/types.js";
import { RequestContext } from "../../src/core/agent-runtime/tools/context.js";
import { ToolRegistry } from "../../src/core/agent-runtime/tools/registry.js";

function response(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function deferred(): [Promise<void>, () => void] {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return [promise, resolve];
}

function setRegistryContext(registry: ToolRegistry, ctx: RequestContext): void {
  for (const name of registry.toolNames) {
    const tool: any = registry.get(name);
    if (typeof tool?.setContext === "function") tool.setContext(ctx);
  }
}

describe("MemmyMemoryClient", () => {
  it("uses a 20s default request timeout", () => {
    const client = new MemmyMemoryClient({ baseUrl: "http://memory.test" });

    expect(client.timeoutMs).toBe(DEFAULT_MEMOS_MEMORY_TIMEOUT_MS);
  });

  it("sends bearer token and JSON request bodies", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new MemmyMemoryClient(
      { baseUrl: "http://memory.test/", token: "secret", timeoutMs: 1000 },
      vi.fn(async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return response({ ok: true, sessionId: "s1" });
      }) as any,
    );

    await client.openSession({ requestId: "req-1", sessionId: "s1" });

    expect(calls[0].url).toBe("http://memory.test/api/v1/sessions/open");
    expect((calls[0].init.headers as any).authorization).toBe("Bearer secret");
    expect((calls[0].init.headers as any)["x-request-id"]).toBe("req-1");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ requestId: "req-1", sessionId: "s1" });
  });

  it("throws structured HTTP errors", async () => {
    const client = new MemmyMemoryClient({ baseUrl: "http://memory.test", timeoutMs: 1000 }, vi.fn(async () => response({ error: { message: "bad token" } }, 401)) as any);

    await expect(client.health()).rejects.toMatchObject({
      name: "MemmyMemoryHttpError",
      status: 401,
      message: "bad token",
    } satisfies Partial<MemmyMemoryHttpError>);
  });
});

describe("memmy memory tools", () => {
  it("declares explicit array item types for Moonshot-compatible tool schemas", () => {
    const search = MEMOS_MEMORY_TOOL_SPECS.find((spec) => spec.name === "memmy_memory_search");
    const parameters = search?.parameters as any;

    expect(parameters?.properties?.layers).toEqual({
      type: "array",
      items: { type: "string", enum: ["L1", "L2", "L3", "Skill"] },
    });
  });

  it("registers only search/get tools and sends runtime defaults", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new MemmyMemoryClient(
      { baseUrl: "http://memory.test", timeoutMs: 1000 },
      vi.fn(async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return response({ ok: true, path: new URL(String(url)).pathname });
      }) as any,
    );
    const runtime: MemmyMemoryToolRuntime = {
      requestEnvelope: (sessionKey) => ({
        requestId: "tool-req",
        adapterId: "memmy-agent",
        source: "memmy-agent",
        namespace: {
          source: "memmy-agent",
          profileId: "default",
          sessionKey: sessionKey ?? undefined,
        },
      }),
      currentSessionId: () => "memmy-agent::cli:direct",
      currentEpisodeId: () => "ep-1",
      currentTurnId: () => "turn-1",
      currentUserText: () => "Summarize the current README",
    };
    const registry = new ToolRegistry();
    registerMemmyMemoryTools(registry, client, runtime);
    setRegistryContext(registry, new RequestContext({ sessionKey: "cli:direct" }));

    const searchResult = await registry.get("memmy_memory_search")!.execute({
      query: "previous task",
      layers: ["L1"]
    });
    const getResult = await registry.get("memmy_memory_get")!.execute({ id: "trace_123" });

    expect(registry.has("memmy_memory_search")).toBe(true);
    expect(registry.has("memmy_memory_get")).toBe(true);
    expect(searchResult).toContain('<memmy_memory_context source="tool_search">');
    expect(searchResult).toContain("No relevant Memmy memories found.");
    expect(searchResult).toContain("<current_user_request>\nSummarize the current README\n</current_user_request>");
    expect(getResult).toContain('<memmy_memory_context source="tool_get">');
    expect(getResult).toContain("/api/v1/memory/trace_123");
    expect(getResult).toContain("<current_user_request>\nSummarize the current README\n</current_user_request>");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({
      query: "previous task",
      source: "memmy-agent",
      sessionId: "memmy-agent::cli:direct",
      layers: ["L1"]
    });
    expect(body).not.toHaveProperty("episodeId");
    expect(body).not.toHaveProperty("turnId");
    expect(body).not.toHaveProperty("requestId");
    expect(body).not.toHaveProperty("adapterId");
    expect(calls[1].url).toBe("http://memory.test/api/v1/memory/trace_123");
  });

  it("formats memory get tool output as compact agent context", async () => {
    const client = new MemmyMemoryClient(
      { baseUrl: "http://memory.test", timeoutMs: 1000 },
      vi.fn(async () => response({
        id: "trace_123",
        kind: "trace",
        memoryLayer: "L1",
        title: "Checked memory",
        body: [
          "Summary: Checked memory",
          "RawTurn: raw_1",
          "TraceStep: 0",
          "User:",
          "check memory",
          "Tool calls:",
          "- exec",
          "Agent:",
          "16 GB",
          "Alpha: 0",
          "Value: 0",
          "Priority: 0.5"
        ].join("\n"),
        refs: {
          rawTurn: {
            userText: "check memory",
            assistantText: "16 GB",
            toolCalls: [
              {
                id: "call_exec",
                name: "exec",
                input: { command: "sysctl hw.memsize" },
              }
            ],
            toolResults: [
              {
                toolCallId: "call_exec",
                name: "exec",
                output: "hw.memsize: 17179869184\n\nExit code: 0",
              }
            ],
          },
        },
        metadata: {
          properties: {
            embedding: [1, 0, 0],
          },
        },
      })) as any,
    );
    const runtime: MemmyMemoryToolRuntime = {
      requestEnvelope: () => ({}),
      currentSessionId: () => "session-1",
      currentEpisodeId: () => "episode-1",
      currentTurnId: () => "turn-1",
      currentUserText: () => "current task",
    };
    const registry = new ToolRegistry();
    registerMemmyMemoryTools(registry, client, runtime);

    const getResult = await registry.get("memmy_memory_get")!.execute({ id: "trace_123" });

    expect(getResult).toContain('<memmy_memory_context source="tool_get">');
    expect(getResult).toContain("User:\ncheck memory");
    expect(getResult).toContain("Tool calls:");
    expect(getResult).toContain('input: {"command":"sysctl hw.memsize"}');
    expect(getResult).toContain("output:\n    hw.memsize: 17179869184");
    expect(getResult).toContain("Assistant:\n16 GB");
    expect(getResult).not.toContain("RawTurn:");
    expect(getResult).not.toContain("TraceStep:");
    expect(getResult).not.toContain("Alpha:");
    expect(getResult).not.toContain("Value:");
    expect(getResult).not.toContain("Priority:");
    expect(getResult).not.toContain("embedding");
  });

  it("maps empty search runtime session id to the active memory runtime session", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new MemmyMemoryClient(
      { baseUrl: "http://memory.test", timeoutMs: 1000 },
      vi.fn(async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return response({ ok: true });
      }) as any,
    );
    const runtime: MemmyMemoryToolRuntime = {
      requestEnvelope: () => ({}),
      currentSessionId: () => "memmy-agent::cli:direct",
      currentEpisodeId: () => "ep-1",
      currentTurnId: () => "turn-1",
      currentUserText: () => "current task",
    };
    const registry = new ToolRegistry();
    registerMemmyMemoryTools(registry, client, runtime);
    setRegistryContext(registry, new RequestContext({ sessionKey: "cli:direct" }));

    await registry.get("memmy_memory_search")!.execute({
      query: "current task",
      sessionId: ""
    });

    const searchBody = JSON.parse(String(calls[0].init.body));
    expect(searchBody).toMatchObject({
      sessionId: "memmy-agent::cli:direct"
    });
  });

  it("keeps memory search session key local to each async task", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new MemmyMemoryClient(
      { baseUrl: "http://memory.test", timeoutMs: 1000 },
      vi.fn(async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return response({ ok: true });
      }) as any,
    );
    const runtime: MemmyMemoryToolRuntime = {
      requestEnvelope: (sessionKey) => ({
        namespace: {
          source: "memmy-agent",
          profileId: "default",
          sessionKey: sessionKey ?? undefined,
        },
      }),
      currentSessionId: (sessionKey) => sessionKey ? `memmy-agent::${sessionKey}` : null,
      currentEpisodeId: () => null,
      currentTurnId: () => null,
      currentUserText: () => "current task",
    };
    const registry = new ToolRegistry();
    registerMemmyMemoryTools(registry, client, runtime);
    const search = registry.get("memmy_memory_search")!;
    const [entered, markEntered] = deferred();
    const [release, markRelease] = deferred();

    async function taskOne(): Promise<void> {
      (search as any).setContext(new RequestContext({ sessionKey: "cli:a" }));
      markEntered();
      await release;
      await search.execute({ query: "one", sessionId: "" });
    }

    async function taskTwo(): Promise<void> {
      await entered;
      (search as any).setContext(new RequestContext({ sessionKey: "cli:b" }));
      markRelease();
      await search.execute({ query: "two", sessionId: "" });
    }

    await Promise.all([taskOne(), taskTwo()]);

    const sessionIds = calls.map((call) => JSON.parse(String(call.init.body)).sessionId);
    expect(new Set(sessionIds)).toEqual(new Set(["memmy-agent::cli:a", "memmy-agent::cli:b"]));
  });
});
