import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstalledPlugin } from "@memmy/local-api-contracts";
import { createProgressBus } from "../../../../services/progress-bus.js";
import { buildPluginMcpServer, type PluginMcpService } from "../routes/plugin-mcp.js";

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

async function connect(plugins: PluginMcpService, onEvent?: (event: unknown) => void): Promise<Client> {
  const progressBus = createProgressBus();
  if (onEvent) progressBus.on("plugin.capability_event", onEvent);
  const server = buildPluginMcpServer(plugins, progressBus);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  connections.push({ client, server });
  return client;
}

describe("plugin MCP bridge", () => {
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
});
