import type { CapabilityEvent } from "@memmy/local-api-contracts";
import { describe, expect, it, vi } from "vitest";
import { createHttpPluginAdapter } from "../http-adapter.js";
import type { PluginRuntimeContext } from "../types.js";

function context(): PluginRuntimeContext {
  const now = new Date().toISOString();
  return {
    plugin: {
      id: "com.example.review",
      version: "1.0.0",
      manifest: {
        apiVersion: "memmy/v1",
        id: "com.example.review",
        name: "Review",
        version: "1.0.0",
        runtime: {
          adapter: "http",
          config: {
            baseUrl: "https://plugin.example/api/",
            invokePath: "capabilities/{capabilityId}/invoke",
            secretHeaders: { authorization: "api-key" }
          }
        },
        capabilities: [{
          id: "run",
          name: "Run",
          description: "Run a review",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          execution: "job"
        }],
        permissions: [
          { type: "network", hosts: ["plugin.example"] },
          { type: "secret", keys: ["api-key"] }
        ]
      },
      state: "active",
      approvedPermissions: [],
      config: { database: "crossref" },
      artifactHash: null,
      rootPath: null,
      lastError: null,
      createdAt: now,
      updatedAt: now
    },
    config: { database: "crossref" },
    secrets: { "api-key": "Bearer secret" },
    rootPath: null
  };
}

async function collect(iterable: AsyncIterable<CapabilityEvent>): Promise<CapabilityEvent[]> {
  const events: CapabilityEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("HttpPluginAdapter", () => {
  it("maps JSON responses to a result and keeps secrets in headers", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ summary: "done" }), {
      headers: { "content-type": "application/json" }
    }));
    const adapter = createHttpPluginAdapter({ fetchFn: fetchFn as typeof fetch });
    const session = await adapter.activate(context());
    expect(await collect(adapter.invoke(session, {
      callId: "call-1",
      pluginId: context().plugin.id,
      capabilityId: "run",
      conversationId: "conversation-1",
      input: { topic: "memory" }
    }))).toEqual([{ type: "result", output: { summary: "done" } }]);

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe("https://plugin.example/api/capabilities/run/invoke");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer secret");
    expect(String(init?.body)).not.toContain("Bearer secret");
  });

  it("streams NDJSON capability events", async () => {
    const body = [
      JSON.stringify({ type: "progress", current: 1, total: 2 }),
      JSON.stringify({ type: "result", output: { summary: "done" } })
    ].join("\n");
    const adapter = createHttpPluginAdapter({
      fetchFn: vi.fn(async () => new Response(body, { headers: { "content-type": "application/x-ndjson" } })) as typeof fetch
    });
    const session = await adapter.activate(context());
    expect(await collect(adapter.invoke(session, {
      callId: "call-1",
      pluginId: context().plugin.id,
      capabilityId: "run",
      conversationId: "conversation-1",
      input: {}
    }))).toEqual([
      { type: "progress", current: 1, total: 2 },
      { type: "result", output: { summary: "done" } }
    ]);
  });

  it("rejects hosts outside declared network permissions", async () => {
    const denied = context();
    denied.plugin.manifest.permissions = [{ type: "network", hosts: ["other.example"] }];
    await expect(createHttpPluginAdapter().activate(denied)).rejects.toThrow(/does not allow/);
  });

  it("posts interaction responses to the plugin", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 }));
    const adapter = createHttpPluginAdapter({ fetchFn: fetchFn as typeof fetch });
    const session = await adapter.activate(context());
    await adapter.respond?.(session, "call-1", "question-1", { selected: ["memory"] });
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe("https://plugin.example/calls/call-1/interactions/question-1");
    expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))).toMatchObject({
      callId: "call-1",
      interactionId: "question-1",
      response: { selected: ["memory"] }
    });
  });
});
