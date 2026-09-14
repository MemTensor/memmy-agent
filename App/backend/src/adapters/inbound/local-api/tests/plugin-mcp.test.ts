import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstalledPlugin } from "@memmy/local-api-contracts";
import { createProgressBus } from "../../../../services/progress-bus.js";
import { buildPluginMcpServer, capabilityToolName, type PluginMcpService } from "../routes/plugin-mcp.js";

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
      _meta: { "memmy.dev/session-key": "desktop:conversation-1" }
    });

    expect(result).toMatchObject({ structuredContent: { review: "done" } });
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: plugin.id,
      capabilityId: "run",
      conversationId: "desktop:conversation-1",
      input: { topic: "Agent Memory" }
    }));
    expect(events).toHaveLength(2);
  });

  it("does not expose disabled plugin capabilities", async () => {
    const client = await connect(createPlugins("disabled").service);
    expect((await client.listTools()).tools).toEqual([]);
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
