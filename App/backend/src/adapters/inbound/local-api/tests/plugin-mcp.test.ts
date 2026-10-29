import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstalledPlugin } from "@memmy/local-api-contracts";
import { createProgressBus } from "../../../../services/progress-bus.js";
import { buildPluginMcpServer, capabilityToolName, registerPluginMcpRoutes, type PluginMcpService } from "../routes/plugin-mcp.js";

const connections: Array<{ client: Client; server: ReturnType<typeof buildPluginMcpServer> }> = [];

afterEach(async () => {
  await Promise.all(connections.splice(0).flatMap(({ client, server }) => [client.close(), server.close()]));
});

const plugin: InstalledPlugin = {
  id: "com.example.review",
  version: "1.0.0",
  manifest: {
    apiVersion: "memmy/v1",
    id: "com.example.review",
    name: "Review",
    version: "1.0.0",
    runtime: { adapter: "http", config: {} },
    capabilities: [{
      id: "run",
      name: "Run review",
      description: "Search papers and write a review",
      inputSchema: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] },
      outputSchema: { type: "object" },
      execution: "job"
    }],
    permissions: []
  },
  state: "active",
  approvedPermissions: [],
  config: {},
  lastError: null,
  createdAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T00:00:00.000Z"
};

function createPlugins(state: InstalledPlugin["state"] = "active") {
  const invoke = vi.fn(async function* () {
    yield { type: "progress" as const, current: 1, total: 1 };
    yield { type: "result" as const, output: { review: "done" } };
  });
  const service: PluginMcpService = {
    list: () => [{ ...plugin, state }],
    invoke,
    cancel: vi.fn(async () => undefined)
  };
  return { service, invoke };
}

async function connect(
  plugins: PluginMcpService,
  onEvent?: (event: unknown) => void,
  keepaliveIntervalMs?: number
): Promise<Client> {
  const progressBus = createProgressBus();
  if (onEvent) progressBus.on("plugin.capability_event", onEvent);
  const server = buildPluginMcpServer(plugins, progressBus, keepaliveIntervalMs);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  connections.push({ client, server });
  return client;
}

describe("plugin MCP bridge", () => {
  it("forwards tool and turn provenance for migrated process records", async () => {
    const events: unknown[] = [];
    const { service } = createPlugins();
    const client = await connect(service, (event) => events.push(event));
    const tools = await client.listTools();
    await client.callTool({ name: tools.tools[0]!.name, arguments: { topic: "Questions" },
      _meta: { "memmy.dev/session-key": "websocket:c1", "memmy.dev/tool-call-id": "tool-42", "memmy.dev/turn-id": "turn-7" } });
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) expect(event).toMatchObject({
      conversationId: "websocket:c1", agentToolCallId: "tool-42", turnId: "turn-7"
    });
  });

  it("returns plugin-produced file inventory without replacing the result", async () => {
    const service: PluginMcpService = {
      list: () => [plugin],
      invoke: async function* () {
        yield { type: "artifact" as const, artifact: { id: "report", name: "report.docx",
          mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          uri: "/preview", path: "/workspace/report.docx", role: "deliverable" as const } };
        yield { type: "result" as const, output: { nextStep: "done", sessionId: "s1" } };
      },
      cancel: vi.fn(async () => undefined)
    };
    const client = await connect(service);
    const result = await client.callTool({ name: capabilityToolName(plugin.id, "run"), arguments: {} });
    expect(result.structuredContent).toMatchObject({
      publishedFiles: [{ name: "report.docx", path: "/workspace/report.docx" }],
      nextStep: "done"
    });
  });
  it("closes live HTTP MCP sessions before shutting down the Host", async () => {
    const { service } = createPlugins();
    const app = Fastify();
    registerPluginMcpRoutes(app, { plugins: service, progressBus: createProgressBus(), mcpToken: "test-secret" });
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    const transport = new StreamableHTTPClientTransport(new URL("/mcp/plugins", url), {
      requestInit: { headers: { "x-memmy-mcp-token": "test-secret" } }
    });
    const client = new Client({ name: "shutdown-test", version: "1" });
    try {
      await client.connect(transport);
      await expect(client.listTools()).resolves.toMatchObject({ tools: expect.any(Array) });
      await app.close();
    } finally {
      await client.close();
      await app.close();
    }
  });

  it("routes HTTP cancellation to the owning request without cancelling another client's matching request ID", async () => {
    const calls: string[] = [];
    const releases = new Map<string, () => void>();
    const plugins: PluginMcpService = {
      list: () => [plugin],
      invoke: async function* (call) {
        calls.push(call.callId);
        await new Promise<void>(resolve => { releases.set(call.callId, resolve); });
        yield { type: "result", output: { done: true } };
      },
      cancel: vi.fn(async (_pluginId, callId) => { releases.get(callId)?.(); })
    };
    const app = Fastify();
    registerPluginMcpRoutes(app, { plugins, progressBus: createProgressBus(), mcpToken: "test-secret" });
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    const transports = [0, 1].map(() => new StreamableHTTPClientTransport(new URL("/mcp/plugins", url), {
      requestInit: { headers: { "x-memmy-mcp-token": "test-secret" } }
    }));
    const clients = [0, 1].map(() => new Client({ name: "cancellation-test", version: "1" }));
    try {
      await Promise.all(clients.map((client, i) => client.connect(transports[i]!)));
      expect(transports[0]!.sessionId).toBeTruthy();
      expect(transports[0]!.sessionId).not.toBe(transports[1]!.sessionId);
      const abort = new AbortController();
      const first = clients[0]!.callTool({ name: capabilityToolName(plugin.id, "run"), arguments: { topic: "first" } }, undefined, { signal: abort.signal });
      const rejected = expect(first).rejects.toBeDefined();
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      let secondFinished = false;
      const second = clients[1]!.callTool({ name: capabilityToolName(plugin.id, "run"), arguments: { topic: "second" } }).then(result => { secondFinished = true; return result; });
      await vi.waitFor(() => expect(calls).toHaveLength(2));
      abort.abort();
      await rejected;
      await vi.waitFor(() => expect(plugins.cancel).toHaveBeenCalledExactlyOnceWith(plugin.id, calls[0]));
      expect(secondFinished).toBe(false);
      releases.get(calls[1]!)!();
      await expect(second).resolves.toMatchObject({ structuredContent: { done: true } });
    } finally {
      for (const release of releases.values()) release();
      await Promise.all(transports.map(transport => transport.terminateSession()));
      await Promise.all(clients.map(client => client.close()));
      await app.close();
    }
  });

  it("keeps similarly prefixed capability names readable after the Agent MCP prefix is added", () => {
    const updateSelection = capabilityToolName("literature-review", "review_update_paper_selection");
    const resolveMetadata = capabilityToolName("literature-review", "review_resolve_metadata");

    expect(updateSelection).toMatch(/^plugin_review_update_paper_selection_[a-f0-9]{8}$/);
    expect(resolveMetadata).toMatch(/^plugin_review_resolve_metadata_[a-f0-9]{8}$/);
    expect(updateSelection).not.toBe(resolveMetadata);
    expect(`mcp_plugins_${updateSelection}`.length).toBeLessThanOrEqual(64);
    expect(`mcp_plugins_${resolveMetadata}`.length).toBeLessThanOrEqual(64);
  });

  it("exposes and invokes each active capability with the current conversation", async () => {
    const events: unknown[] = [];
    const { service, invoke } = createPlugins();
    const client = await connect(service, (event) => events.push(event));
    const tools = await client.listTools();

    expect(tools.tools).toHaveLength(1);
    expect(tools.tools[0]?.description).toContain("Search papers");
    const result = await client.callTool({
      name: tools.tools[0]!.name,
      arguments: { topic: "Agent Memory" },
      _meta: {
        "memmy.dev/session-key": "desktop:conversation-1",
        "memmy.dev/model-preset": "account-deepseek-v4.1-flash"
      }
    });

    expect(result).toMatchObject({ structuredContent: { review: "done" } });
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: plugin.id,
      capabilityId: "run",
      conversationId: "desktop:conversation-1",
      modelPreset: "account-deepseek-v4.1-flash",
      input: { topic: "Agent Memory" }
    }));
    expect(events).toHaveLength(2);
  });

  it("does not expose disabled plugin capabilities", async () => {
    const client = await connect(createPlugins("disabled").service);
    expect((await client.listTools()).tools).toEqual([]);
  });

  it("does not offer the cloud skill loader for a local packaged skill", async () => {
    const { service } = createPlugins();
    service.list = () => [{
      ...plugin,
      manifest: {
        ...plugin.manifest,
        skills: [{
          id: "review",
          name: "Review",
          description: "Local packaged instructions",
          entry: "skills/review/SKILL.md"
        }]
      }
    }];
    const bus = createProgressBus();
    const reference = vi.fn();
    const server = buildPluginMcpServer(service, bus, undefined, {
      reference,
      resolve: vi.fn(),
      clear: vi.fn()
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    connections.push({ client, server });

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      capabilityToolName(plugin.id, "run")
    ]);
    expect(reference).not.toHaveBeenCalled();
  });

  it("keeps an interactive tool transport active while waiting for the user", async () => {
    let release!: () => void;
    const response = new Promise<void>((resolve) => { release = resolve; });
    const service: PluginMcpService = {
      list: () => [plugin],
      invoke: async function* () {
        yield {
          type: "interaction" as const,
          request: { interactionId: "card-1", type: "custom" as const, payload: {} }
        };
        await response;
        yield { type: "result" as const, output: { review: "done" } };
      },
      cancel: vi.fn(async () => undefined)
    };
    const client = await connect(service, undefined, 5);
    const progress: number[] = [];
    const call = client.callTool(
      { name: capabilityToolName(plugin.id, "run"), arguments: { topic: "Agent Memory" } },
      undefined,
      { timeout: 1_000, onprogress: (update) => progress.push(update.progress), resetTimeoutOnProgress: true }
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(progress.length).toBeGreaterThan(1);
    release();
    await expect(call).resolves.toMatchObject({ structuredContent: { review: "done" } });
  });
});

it("activates metadata only, keeps private text off progress events, and rejects old clients", async () => {
  const ref = { pluginId: plugin.id, skillId: "review", pluginVersion: plugin.version, revision: "r1", sha256: "a".repeat(64) };
  const secret = "PRIVATE-SKILL-MCP-SENTINEL";
  const { service, invoke } = createPlugins();
  const cloudPlugin = { ...plugin, manifest: { ...plugin.manifest, skills: [{ id: "review", name: "Review", description: "Review", entry: "skills/review/SKILL.md", cloud: { revision: ref.revision, sha256: ref.sha256 } }] } };
  service.list = () => [cloudPlugin];
  const events: unknown[] = [];
  const bus = createProgressBus(); bus.on("plugin.capability_event", event => events.push(event));
  const server = buildPluginMcpServer(service, bus, undefined, { reference: () => ref, resolve: async () => secret, clear() {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await server.connect(serverTransport); await client.connect(clientTransport); connections.push({ client, server });
  const tools = (await client.listTools()).tools.map(tool => tool.name);
  expect(tools).toContain("read_plugin_skill"); expect(tools).not.toContain("resolve_plugin_skill_context");
  const oldClient = await client.callTool({ name: "read_plugin_skill", arguments: { pluginId: plugin.id, skillId: "review" } });
  expect(oldClient.isError).toBe(true);
  const activated = await client.callTool({ name: "read_plugin_skill", arguments: { pluginId: plugin.id, skillId: "review" }, _meta: { "memmy.dev/cloud-skills": "1" } });
  expect(JSON.stringify(activated)).not.toContain(secret);
  expect(activated.structuredContent).toEqual({ kind: "memmy_plugin_skill_ref_v1", ref });
  const premature = await client.callTool({ name: capabilityToolName(plugin.id, "run"), arguments: { topic: "test" }, _meta: { "memmy.dev/cloud-skills": "1" } });
  expect(premature.isError).toBe(true); expect(invoke).not.toHaveBeenCalled();
  const internal = await client.callTool({ name: "resolve_plugin_skill_context", arguments: { ref }, _meta: { "memmy.dev/cloud-skills": "1" } });
  expect(internal.content).toEqual([]); expect(JSON.stringify(internal._meta)).toContain(secret);
  const result = await client.callTool({ name: capabilityToolName(plugin.id, "run"), arguments: { topic: "test" },
    _meta: { "memmy.dev/cloud-skills": "1", "memmy.dev/private-skills-ready": JSON.stringify([ref]) } });
  expect(result.isError).not.toBe(true); expect(invoke).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(events)).not.toContain(secret);
});
