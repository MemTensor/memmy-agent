import type { CapabilityEvent } from "@memmy/local-api-contracts";
import { describe, expect, it, vi } from "vitest";
import { PluginAdapterRegistry } from "../registry.js";
import { createPluginRuntimeHost } from "../runtime-host.js";
import type { PluginAdapter, PluginRuntimeRecord } from "../types.js";

function plugin(): PluginRuntimeRecord {
  const now = new Date().toISOString();
  return {
    id: "com.example.echo",
    version: "1.0.0",
    manifest: {
      apiVersion: "memmy/v1",
      id: "com.example.echo",
      name: "Echo",
      version: "1.0.0",
      runtime: { adapter: "http" },
      capabilities: [{
        id: "echo",
        name: "Echo",
        description: "Echoes text",
        inputSchema: {
          type: "object",
          required: ["text"],
          properties: { text: { type: "string" } },
          additionalProperties: false
        },
        outputSchema: {
          type: "object",
          required: ["text"],
          properties: { text: { type: "string" } }
        },
        execution: "request"
      }],
      permissions: []
    },
    state: "active",
    approvedPermissions: [],
    config: {},
    artifactHash: null,
    rootPath: null,
    lastError: null,
    createdAt: now,
    updatedAt: now
  };
}

function adapter(events: CapabilityEvent[]): PluginAdapter {
  return {
    id: "http",
    validate: vi.fn(),
    activate: vi.fn(async (context) => ({ pluginId: context.plugin.id })),
    async *invoke() {
      for (const event of events) yield event;
    },
    respond: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    deactivate: vi.fn(async () => undefined)
  };
}

async function collect(iterable: AsyncIterable<CapabilityEvent>): Promise<CapabilityEvent[]> {
  const events: CapabilityEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("PluginRuntimeHost", () => {
  it("validates input and output around adapter execution", async () => {
    const runtimeAdapter = adapter([
      { type: "progress", current: 1, total: 1 },
      { type: "result", output: { text: "done" } }
    ]);
    const host = createPluginRuntimeHost(new PluginAdapterRegistry([runtimeAdapter]));
    await host.activate(plugin(), {});

    expect(await collect(host.invoke({
      callId: "call-1",
      pluginId: "com.example.echo",
      capabilityId: "echo",
      conversationId: "conversation-1",
      input: { text: "hello" }
    }))).toEqual([
      { type: "progress", current: 1, total: 1 },
      { type: "result", output: { text: "done" } }
    ]);

    expect(await collect(host.invoke({
      callId: "call-2",
      pluginId: "com.example.echo",
      capabilityId: "echo",
      conversationId: "conversation-1",
      input: {}
    }))).toEqual([expect.objectContaining({ type: "error", code: "plugin_invalid" })]);
  });

  it("rejects invalid plugin output", async () => {
    const host = createPluginRuntimeHost(new PluginAdapterRegistry([
      adapter([{ type: "result", output: { text: 42 } }])
    ]));
    await host.activate(plugin(), {});
    expect(await collect(host.invoke({
      callId: "call-1",
      pluginId: "com.example.echo",
      capabilityId: "echo",
      conversationId: "conversation-1",
      input: { text: "hello" }
    }))).toEqual([expect.objectContaining({ type: "error", code: "plugin_runtime_error" })]);
  });

  it("removes the active session before adapter shutdown", async () => {
    const runtimeAdapter = adapter([{ type: "result", output: { text: "done" } }]);
    const host = createPluginRuntimeHost(new PluginAdapterRegistry([runtimeAdapter]));
    await host.activate(plugin(), {});
    await host.deactivate("com.example.echo");
    expect(runtimeAdapter.deactivate).toHaveBeenCalledOnce();
    expect(await collect(host.invoke({
      callId: "call-1",
      pluginId: "com.example.echo",
      capabilityId: "echo",
      conversationId: "conversation-1",
      input: { text: "hello" }
    }))).toEqual([expect.objectContaining({ type: "error", code: "plugin_unavailable" })]);
  });

  it("validates and forwards a pending interaction response", async () => {
    let releaseResult: (() => void) | undefined;
    const runtimeAdapter = adapter([]);
    runtimeAdapter.invoke = async function* () {
      const gate = new Promise<void>((resolve) => {
        releaseResult = resolve;
      });
      yield {
        type: "interaction",
        request: {
          interactionId: "question-1",
          type: "question",
          payload: { title: "Scope" },
          responseSchema: { type: "string", minLength: 1 }
        }
      };
      await gate;
      yield { type: "result", output: { text: "done" } };
    };
    const host = createPluginRuntimeHost(new PluginAdapterRegistry([runtimeAdapter]));
    await host.activate(plugin(), {});
    const iterator = host.invoke({
      callId: "call-1",
      pluginId: "com.example.echo",
      capabilityId: "echo",
      conversationId: "conversation-1",
      input: { text: "hello" }
    })[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: "interaction" });
    await expect(host.respond("com.example.echo", "call-1", "question-1", "")).rejects.toThrow(/Invalid/);
    await host.respond("com.example.echo", "call-1", "question-1", "focused");
    expect(runtimeAdapter.respond).toHaveBeenCalledWith(expect.any(Object), "call-1", "question-1", "focused");
    releaseResult?.();
    expect((await iterator.next()).value).toMatchObject({ type: "result" });
  });
});
