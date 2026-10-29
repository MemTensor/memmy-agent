import { describe, expect, it, vi } from "vitest";
import {
  PLUGIN_RUNTIME_EVENTS,
  createPluginRuntimeAnalytics,
  storedCountFromSourceTurnResponse,
  trackExternalHookCapture,
  trackStoredExternalMemoryAdd,
  trackStoredExternalSourceTurnCapture,
  type PluginRuntimeAnalytics,
} from "../src/server/plugin-runtime-analytics.js";

describe("stored source-turn capture analytics", () => {
  it("emits hook capture only after a new source turn is stored", async () => {
    const events: Array<{ name: string; params: Record<string, unknown> }> = [];
    const stored = {
      status: "stored",
      result: { l1MemoryIds: ["l1-a", "l1-b"], l1MemoryId: "l1-a" },
    };
    const result = await trackStoredExternalSourceTurnCapture(
      recorder(events),
      { source: "cursor", adapterId: "memmy-cursor-hook", turnId: "turn-1" },
      { toolCalls: [{ id: "call-1" }] },
      () => stored,
    );

    expect(result).toBe(stored);
    expect(events.map((event) => event.name)).toEqual([
      PLUGIN_RUNTIME_EVENTS.hookCaptureStarted,
      PLUGIN_RUNTIME_EVENTS.hookCaptureSucceeded,
    ]);
    expect(events[1]?.params).toMatchObject({
      source_id: "cursor",
      source_kind: "hook",
      adapter_id: "memmy-cursor-hook",
      hook_name: "turn_complete",
      success: 1,
      stored_count: 2,
      tool_call_count: 1,
    });
  });

  it("does not emit when the source turn already exists", async () => {
    const events: Array<{ name: string; params: Record<string, unknown> }> = [];
    const existing = {
      status: "existing",
      result: { l1MemoryIds: ["l1-a"], duplicate: true },
    };

    await trackStoredExternalSourceTurnCapture(
      recorder(events),
      { source: "opencode", adapterId: "memmy-opencode-plugin", turnId: "turn-1" },
      {},
      () => existing,
    );

    expect(storedCountFromSourceTurnResponse(existing)).toBe(0);
    expect(events).toEqual([]);
  });

  it("emits capture failure only when the write throws", async () => {
    const events: Array<{ name: string; params: Record<string, unknown> }> = [];

    await expect(trackStoredExternalSourceTurnCapture(
      recorder(events),
      { source: "deepseek_harness", adapterId: "memmy-deepseek-harness-plugin", turnId: "turn-1" },
      {},
      () => {
        throw new Error("capture failed");
      },
    )).rejects.toThrow("capture failed");

    expect(events.map((event) => event.name)).toEqual([
      PLUGIN_RUNTIME_EVENTS.hookCaptureStarted,
      PLUGIN_RUNTIME_EVENTS.hookCaptureFailed,
    ]);
    expect(events[1]?.params).toMatchObject({
      source_id: "deepseek_harness",
      source_kind: "native_plugin",
      success: 0,
      error_code: "capture failed",
    });
  });
});

describe("legacy turn complete capture analytics", () => {
  it("emits hook capture only after a new turn stores memories", async () => {
    const events: Array<{ name: string; params: Record<string, unknown> }> = [];
    const stored = { l1MemoryIds: ["l1-a"], l1MemoryId: "l1-a" };

    const result = await trackExternalHookCapture(
      recorder(events),
      { source: "cursor", adapterId: "memmy-cursor-hook", turnId: "turn-1" },
      { toolCalls: [{ id: "call-1" }] },
      () => stored,
    );

    expect(result).toBe(stored);
    expect(events.map((event) => event.name)).toEqual([
      PLUGIN_RUNTIME_EVENTS.hookCaptureStarted,
      PLUGIN_RUNTIME_EVENTS.hookCaptureSucceeded,
    ]);
    expect(events[1]?.params).toMatchObject({
      source_id: "cursor",
      success: 1,
      stored_count: 1,
      tool_call_count: 1,
    });
  });

  it("does not emit when the completed turn is a replay", async () => {
    const events: Array<{ name: string; params: Record<string, unknown> }> = [];

    await trackExternalHookCapture(
      recorder(events),
      { source: "cursor", adapterId: "memmy-cursor-hook", turnId: "turn-1" },
      {},
      () => ({ l1MemoryIds: ["l1-a"], l1MemoryId: "l1-a", duplicate: true }),
    );

    expect(events).toEqual([]);
  });

  it("emits capture failure only when the legacy complete throws", async () => {
    const events: Array<{ name: string; params: Record<string, unknown> }> = [];

    await expect(trackExternalHookCapture(
      recorder(events),
      { source: "codex", adapterId: "memmy-codex-hook", turnId: "turn-1" },
      {},
      () => {
        throw new Error("complete failed");
      },
    )).rejects.toThrow("complete failed");

    expect(events.map((event) => event.name)).toEqual([
      PLUGIN_RUNTIME_EVENTS.hookCaptureStarted,
      PLUGIN_RUNTIME_EVENTS.hookCaptureFailed,
    ]);
    expect(events[1]?.params).toMatchObject({
      success: 0,
      error_code: "complete failed",
    });
  });
});

describe("native plugin memory add analytics", () => {
  it("emits tool call analytics only after a new memory is stored", async () => {
    const events: Array<{ name: string; params: Record<string, unknown> }> = [];
    const stored = { id: "mem-1", status: "activated" };

    const result = await trackStoredExternalMemoryAdd(
      recorder(events),
      { source: "opencode", adapterId: "memmy-opencode-plugin", layer: "L1" },
      () => stored,
    );

    expect(result).toBe(stored);
    expect(events.map((event) => event.name)).toEqual([
      PLUGIN_RUNTIME_EVENTS.toolCallStarted,
      PLUGIN_RUNTIME_EVENTS.toolCallSucceeded,
    ]);
    expect(events[1]?.params).toMatchObject({
      source_id: "opencode",
      source_kind: "native_plugin",
      tool_name: "memmy_memory_add",
      layer: "L1",
      success: 1,
      stored_count: 1,
    });
  });

  it("does not emit when the added memory already exists or was deleted", async () => {
    const events: Array<{ name: string; params: Record<string, unknown> }> = [];

    await trackStoredExternalMemoryAdd(
      recorder(events),
      { source: "hermes", adapterId: "memmy-hermes-plugin" },
      () => ({ id: "mem-1", duplicate: true }),
    );
    await trackStoredExternalMemoryAdd(
      recorder(events),
      { source: "hermes", adapterId: "memmy-hermes-plugin" },
      () => ({ id: "skill-1", status: "deleted" }),
    );

    expect(events).toEqual([]);
  });

  it("emits tool call failure only when the add throws", async () => {
    const events: Array<{ name: string; params: Record<string, unknown> }> = [];

    await expect(trackStoredExternalMemoryAdd(
      recorder(events),
      { source: "openclaw", adapterId: "memmy-openclaw-plugin" },
      () => {
        throw new Error("add failed");
      },
    )).rejects.toThrow("add failed");

    expect(events.map((event) => event.name)).toEqual([
      PLUGIN_RUNTIME_EVENTS.toolCallStarted,
      PLUGIN_RUNTIME_EVENTS.toolCallFailed,
    ]);
    expect(events[1]?.params).toMatchObject({
      success: 0,
      error_code: "add failed",
    });
  });
});

describe("plugin runtime analytics source", () => {
  it("posts hook writes with the source ingest stores", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ code: 0 }), { status: 200 }));
    const analytics = createPluginRuntimeAnalytics({
      fetchImpl,
      baseUrl: "https://cloud.example.com",
      getClientId: () => "1234567890.1234567890",
    });

    await analytics.trackAwait(PLUGIN_RUNTIME_EVENTS.hookCaptureStarted, {
      source_id: "cursor",
      source_kind: "hook",
      status: "started",
    });

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as {
      events: Array<{ params: { source?: string } }>;
    };
    expect(body.events[0]?.params.source).toBe("memmy-agent");
  });
});

function recorder(events: Array<{ name: string; params: Record<string, unknown> }>): PluginRuntimeAnalytics {
  return {
    track(eventName, params = {}) {
      events.push({ name: eventName, params });
    },
    async trackAwait(eventName, params = {}) {
      events.push({ name: eventName, params });
    },
    async flush() {},
  };
}
