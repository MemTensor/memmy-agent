import type { CapabilityEvent } from "@memmy/local-api-contracts";
import { describe, expect, it, vi } from "vitest";
import { createMcpPluginAdapter } from "../mcp-adapter.js";
import type { PluginRuntimeContext } from "../types.js";

function context(): PluginRuntimeContext {
  const now = new Date().toISOString();
  return {
    plugin: {
      id: "com.example.mcp",
      version: "1.0.0",
      manifest: {
        apiVersion: "memmy/v1",
        id: "com.example.mcp",
        name: "MCP plugin",
        version: "1.0.0",
        runtime: {
          adapter: "mcp",
          config: {
            transport: "streamableHttp",
            url: "https://plugin.example/mcp",
            capabilityTools: { search: "search_papers" },
            secretHeaders: { authorization: "api-key" }
          }
        },
        capabilities: [{
          id: "search",
          name: "Search",
          description: "Search papers",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          execution: "request"
        }],
        permissions: [
          { type: "network", hosts: ["plugin.example"] },
          { type: "secret", keys: ["api-key"] }
        ]
      },
      state: "active",
      approvedPermissions: [],
      config: {},
      artifactHash: null,
      rootPath: null,
      lastError: null,
      createdAt: now,
      updatedAt: now
    },
    config: {},
    secrets: { "api-key": "Bearer secret" },
    rootPath: null
  };
}

async function collect(iterable: AsyncIterable<CapabilityEvent>): Promise<CapabilityEvent[]> {
  const events: CapabilityEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("McpPluginAdapter", () => {
  it("maps MCP tools, progress, and structured output", async () => {
    const client = {
      connect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      listTools: vi.fn(async () => ({ tools: [{ name: "search_papers" }] })),
      callTool: vi.fn(async (_params, _schema, options) => {
        options?.onprogress?.({ progress: 1, total: 2, message: "searching" });
        return { structuredContent: { papers: ["one"] } };
      })
    };
    const createTransport = vi.fn(() => ({ transport: "test" }));
    const adapter = createMcpPluginAdapter({ createClient: () => client, createTransport });
    const session = await adapter.activate(context());
    expect(await collect(adapter.invoke(session, {
      callId: "call-1",
      pluginId: context().plugin.id,
      capabilityId: "search",
      conversationId: "conversation-1",
      input: { query: "memory" }
    }))).toEqual([
      { type: "progress", current: 1, total: 2, message: "searching" },
      { type: "result", output: { papers: ["one"] } }
    ]);
    expect(client.callTool).toHaveBeenCalledWith(
      { name: "search_papers", arguments: { query: "memory" } },
      undefined,
      expect.any(Object)
    );
    expect(createTransport).toHaveBeenCalledWith(expect.any(Object), { authorization: "Bearer secret" }, expect.any(Object));
  });

  it("fails activation when a mapped MCP tool is missing", async () => {
    const client = {
      connect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      listTools: vi.fn(async () => ({ tools: [] })),
      callTool: vi.fn()
    };
    const adapter = createMcpPluginAdapter({ createClient: () => client, createTransport: () => ({}) });
    await expect(adapter.activate(context())).rejects.toThrow(/MCP tools not found/);
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("starts local stdio MCP through the shared sandbox transport boundary", async () => {
    const pluginContext = context();
    pluginContext.rootPath = "/plugin";
    pluginContext.plugin.rootPath = "/plugin";
    pluginContext.plugin.manifest.runtime.config = {
      transport: "stdio",
      command: "runtime/server",
      secretEnv: { REVIEW_API_KEY: "api-key" }
    };
    pluginContext.plugin.manifest.permissions = [{ type: "secret", keys: ["api-key"] }];
    const client = {
      connect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      listTools: vi.fn(async () => ({ tools: [{ name: "search" }] })),
      callTool: vi.fn()
    };
    const createTransport = vi.fn(() => ({ transport: "stdio-test" }));
    const adapter = createMcpPluginAdapter({
      createClient: () => client,
      createTransport,
      platform: "darwin"
    });

    await adapter.activate(pluginContext);

    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ transport: "stdio", command: "runtime/server" }),
      {},
      pluginContext
    );
  });

  it("rejects network permission for local stdio MCP", async () => {
    const pluginContext = context();
    pluginContext.rootPath = "/plugin";
    pluginContext.plugin.rootPath = "/plugin";
    pluginContext.plugin.manifest.runtime.config = { transport: "stdio", command: "runtime/server" };
    const adapter = createMcpPluginAdapter({ platform: "darwin" });

    await expect(adapter.activate(pluginContext)).rejects.toThrow(/cannot request network/);
  });
});

function nativeContext(): PluginRuntimeContext {
  const value = context();
  const permission = { type: "host-service" as const, services: ["native-execution", "event-sessions"] };
  value.plugin.manifest.permissions = [permission]; value.plugin.approvedPermissions = [permission];
  value.plugin.manifest.runtime = { adapter: "mcp", config: { transport: "stdio", command: "index.js", interpreter: "node", sandbox: "none", capabilityTools: { search: "search_papers" } } };
  value.plugin.nativeExecutionAllowed = true; value.plugin.registryOrigin = "https://official.example";
  value.plugin.artifactHash = "a".repeat(64); value.rootPath = "/fixture"; value.plugin.rootPath = "/fixture";
  value.secrets = {}; return value;
}

describe("native MCP Host policy and reverse calls", () => {
  it("requires the Host origin policy, release digest and user permission together", async () => {
    const client = { connect: vi.fn(async () => undefined), close: vi.fn(async () => undefined), listTools: async () => ({ tools: [{ name: "search_papers" }] }), callTool: async () => ({}) };
    const adapter = createMcpPluginAdapter({ platform: "win32", trustedNativeOrigins: ["https://official.example"], createClient: () => client, createTransport: () => ({}) });
    for (const mutate of [
      (value: PluginRuntimeContext) => { value.plugin.registryOrigin = "https://untrusted.example"; },
      (value: PluginRuntimeContext) => { value.plugin.nativeExecutionAllowed = false; value.plugin.manifest.runtime.config!.nativeExecutionAllowed = true; },
      (value: PluginRuntimeContext) => { value.plugin.artifactHash = null; },
      (value: PluginRuntimeContext) => { value.plugin.approvedPermissions = []; }
    ]) {
      const value = nativeContext(); mutate(value); await expect(adapter.activate(value)).rejects.toThrow("trusted official release");
    }
    expect(client.connect).not.toHaveBeenCalled();
    const session = await adapter.activate(nativeContext()); expect(client.connect).toHaveBeenCalledOnce(); await adapter.deactivate!(session);
  });
  it("binds reverse requests to an active real call and keeps business event arrays as result data", async () => {
    let reverse!: (request: any) => Promise<{ result: unknown }>;
    const invoke = vi.fn(async () => ({ events: [], marker: "business-data" }));
    const request = (id: string) => ({ method: "memmy/host-service" as const, params: { service: "event-sessions", callId: id, input: { action: "status", conversationId: "forged-chat" } } });
    const client = { connect: async () => undefined, close: async () => undefined,
      setRequestHandler: (_schema: unknown, handler: typeof reverse) => { reverse = handler; },
      listTools: async () => ({ tools: [{ name: "search_papers" }] }),
      callTool: async () => {
        await expect(reverse(request("forged-call"))).rejects.toThrow("active conversation");
        return { structuredContent: (await reverse(request("real-call"))).result };
      } };
    const adapter = createMcpPluginAdapter({ platform: "win32", trustedNativeOrigins: ["https://official.example"], hostServices: { invoke }, createClient: () => client, createTransport: () => ({}) });
    const session = await adapter.activate(nativeContext());
    const events = await collect(adapter.invoke(session, { callId: "real-call", pluginId: "com.example.mcp", capabilityId: "search", conversationId: "websocket:real-chat", modelPreset: "selected-preset", input: {} }));
    expect(invoke).toHaveBeenCalledOnce(); expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ pluginId: "com.example.mcp", callId: "real-call", conversationId: "websocket:real-chat", modelPreset: "selected-preset" }));
    expect(events).toEqual([{ type: "result", output: { events: [], marker: "business-data" } }]);
    await expect(reverse(request("real-call"))).rejects.toThrow("active conversation"); await adapter.deactivate!(session);
  });
});
