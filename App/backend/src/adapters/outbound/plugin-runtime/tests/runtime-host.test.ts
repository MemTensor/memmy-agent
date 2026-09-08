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
  it("validates input and output without sharing plugin schema ids", async () => {
    const runtimeAdapter = adapter([
      { type: "progress", current: 1, total: 1 },
      { type: "result", output: { text: "done" } }
    ]);
    const installed = plugin();
    installed.manifest.capabilities[0]!.inputSchema.$id = "shared";
    installed.manifest.capabilities[0]!.outputSchema.$id = "shared";
    const host = createPluginRuntimeHost(new PluginAdapterRegistry([runtimeAdapter]));
    await host.activate(installed, {});

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

  it("routes a declared cancellation capability to one active run", async () => {
    const targetGate = Promise.withResolvers<void>();
    const runtimeAdapter = adapter([]);
    runtimeAdapter.invoke = async function* (_session, call) {
      if (call.capabilityId === "echo") {
        yield { type: "progress", current: 0, total: 1, cancellable: true };
        await targetGate.promise;
        return;
      }
      yield { type: "result", output: { text: "cancel recorded" } };
    };
    runtimeAdapter.cancel = vi.fn(async (_session, callId) => {
      if (callId === "run-target") targetGate.resolve();
    });
    const installed = plugin();
    installed.manifest.capabilities.push({
      id: "cancel",
      name: "Cancel",
      description: "Cancel one run",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      execution: "request",
      control: { action: "cancel", runIdInput: "runId", scopeInput: "scope", taskIdInput: "taskId" }
    });
    installed.manifest.capabilities[0]!.inputSchema = {
      type: "object",
      required: ["text", "taskId"],
      properties: { text: { type: "string" }, taskId: { type: "string" } },
      additionalProperties: false
    };
    const host = createPluginRuntimeHost(new PluginAdapterRegistry([runtimeAdapter]));
    await host.activate(installed, {});
    const target = host.invoke({
      callId: "run-target", pluginId: installed.id, capabilityId: "echo", conversationId: "conversation-1", input: { taskId: "task-1", text: "slow" }
    })[Symbol.asyncIterator]();
    expect((await target.next()).value).toMatchObject({ type: "progress", cancellable: true });

    expect(await collect(host.invoke({
      callId: "run-cancel-wrong-task", pluginId: installed.id, capabilityId: "cancel", conversationId: "conversation-1",
      input: { taskId: "task-2", scope: "run", runId: "run-target" }
    }))).toEqual([{ type: "result", output: { text: "cancel recorded" } }]);
    expect(runtimeAdapter.cancel).not.toHaveBeenCalled();

    expect(await collect(host.invoke({
      callId: "run-cancel", pluginId: installed.id, capabilityId: "cancel", conversationId: "conversation-1",
      input: { taskId: "task-1", scope: "run", runId: "run-target" }
    }))).toEqual([{ type: "result", output: { text: "cancel recorded" } }]);
    expect(runtimeAdapter.cancel).toHaveBeenCalledWith(expect.any(Object), "run-target");
    expect((await target.next()).value).toMatchObject({ type: "error", code: "plugin_cancelled", retryable: false });
  });
});
