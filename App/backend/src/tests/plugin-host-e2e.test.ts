import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPluginMcpServer } from "../adapters/inbound/local-api/routes/plugin-mcp.js";
import { createInMemoryPluginRegistry } from "../adapters/outbound/plugin-registry/index.js";
import {
  createHttpPluginAdapter,
  createPluginRuntimeHost,
  PluginAdapterRegistry
} from "../adapters/outbound/plugin-runtime/index.js";
import { createAppStateStore, type AppStateStore } from "../infrastructure/app-state-store/index.js";
import { createPluginService } from "../services/plugin-service.js";
import { createProgressBus } from "../services/progress-bus.js";

let root: string | undefined;
let store: AppStateStore | undefined;
let client: Client | undefined;
let mcpServer: ReturnType<typeof buildPluginMcpServer> | undefined;

afterEach(async () => {
  await client?.close();
  await mcpServer?.close();
  client = undefined;
  mcpServer = undefined;
  store?.close();
  store = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("plugin host end to end", () => {
  it("installs a generic review plugin and invokes it from Agent", async () => {
    const fetchFn = vi.fn(async () => new Response([
      JSON.stringify({ type: "progress", current: 1, total: 1, message: "searching" }),
      JSON.stringify({ type: "result", output: { review: "Agent Memory review" } })
    ].join("\n"), { headers: { "content-type": "application/x-ndjson" } }));
    root = mkdtempSync(join(tmpdir(), "memmy-plugin-e2e-"));
    store = createAppStateStore({ databasePath: join(root, "app.sqlite") });
    const runtimeHost = createPluginRuntimeHost(new PluginAdapterRegistry([
      createHttpPluginAdapter({ fetchFn: fetchFn as typeof fetch })
    ]));
    const service = createPluginService({
      repository: store.repositories.plugins,
      secretStore: store.secretStore,
      registry: createInMemoryPluginRegistry([{
        manifest: {
          apiVersion: "memmy/v1",
          id: "com.example.review",
          name: "Literature Review",
          version: "1.0.0",
          runtime: {
            adapter: "http",
            config: {
              baseUrl: "https://review.example",
              secretHeaders: { authorization: "api-key" }
            }
          },
          capabilities: [{
            id: "write-review",
            name: "Write review",
            description: "Search papers and write a literature review",
            inputSchema: {
              type: "object",
              properties: { topic: { type: "string" } },
              required: ["topic"]
            },
            outputSchema: {
              type: "object",
              properties: { review: { type: "string" } },
              required: ["review"]
            },
            execution: "job"
          }],
          permissions: [
            { type: "network", hosts: ["review.example"] },
            { type: "secret", keys: ["api-key"] }
          ],
          configSchema: {
            type: "object",
            properties: { database: { type: "string" } },
            required: ["database"]
          }
        }
      }]),
      runtimeHost,
      artifactManager: {
        install: async () => ({ artifactHash: null, rootPath: null }),
        remove: async () => undefined
      }
    });

    await service.install("com.example.review");
    service.configure("com.example.review", {
      config: { database: "crossref" },
      secrets: { "api-key": "Bearer secret" }
    });
    await service.approvePermissions("com.example.review", service.get("com.example.review").manifest.permissions);
    await service.enable("com.example.review");

    mcpServer = buildPluginMcpServer(service, createProgressBus());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "agent-test", version: "1.0.0" });
    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    const result = await client.callTool({
      name: tools.tools[0]!.name,
      arguments: { topic: "Agent Memory" },
      _meta: { "memmy.dev/session-key": "desktop:review-session" }
    });

    expect(result).toMatchObject({ structuredContent: { review: "Agent Memory review" } });
    const [, request] = fetchFn.mock.calls[0]!;
    expect((request?.headers as Record<string, string>).authorization).toBe("Bearer secret");
    expect(JSON.parse(String(request?.body))).toMatchObject({
      conversationId: "desktop:review-session",
      input: { topic: "Agent Memory" },
      config: { database: "crossref" }
    });
    expect(store.db.prepare("SELECT outcome FROM plugin_call_logs").get()).toEqual({ outcome: "success" });
  });
});
