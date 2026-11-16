import { describe, expect, it, vi } from "vitest";
import { AgentSourceScanProgressPayloadSchema, type MemoryAgentSourceScanState } from "@memmy/local-api-contracts";
import type { AgentSourceScanClient } from "../../adapters/outbound/memory-client/types.js";
import { createAgentSourceScanBridge } from "../agent-source-scan-bridge.js";
import { createProgressBus } from "../progress-bus.js";
import { MemoryLayerError, MemoryLayerNetworkError } from "../../adapters/outbound/memory-client/errors.js";

const empty = (): MemoryAgentSourceScanState => ({ running: false, jobId: null, sourceId: null, mode: null, progress: null, startedAt: null, completedAt: null, error: null });
it("preserves Memory job identity, progress and failures in existing desktop events", async () => {
  let state = empty();
  const client = { status: vi.fn(async () => state), start: vi.fn(async () => {
    state = { ...state, running: true, jobId: "memory-1", sourceId: "all", progress: { sourceId: "all", phase: "scan", current: 0, total: 0 } };
    return { jobId: "memory-1" };
  }), cancel: vi.fn(async () => ({ ok: true })) } as unknown as AgentSourceScanClient;
  const bus = createProgressBus();
  const completed = vi.fn();
  bus.on("agent_source.scan_completed", completed);
  const bridge = createAgentSourceScanBridge(client, bus, 60_000);
  try {
    expect(await bridge.start({ sourceId: "all" })).toEqual({ jobId: "memory-1" });
    expect(await bridge.status()).toMatchObject({ active: true, progress: { jobId: "memory-1" } });
    state = { ...state, running: false, completedAt: new Date().toISOString(), error: "source unavailable" };
    expect(await bridge.status()).toMatchObject({ completion: { succeeded: false } });
    await bridge.status();
    expect(completed).toHaveBeenCalledTimes(1);
    expect(completed.mock.calls[0]?.[0].results[0].errors[0].reason).toBe("source unavailable");
  } finally { await bridge.dispose(); }
  expect(client.cancel).not.toHaveBeenCalled();
});
describe("transport failure", () => {
  it.each([
    new MemoryLayerError("memory_scan_upgrade_required", 503, "Update Memory"),
    new MemoryLayerNetworkError(new Error("connection refused"))
  ])("keeps status readable while refusing scans, then recovers when Memory returns", async (error) => {
    let unavailable = true;
    const bus = createProgressBus();
    const completed = vi.fn(); bus.on("agent_source.scan_completed", completed);
    const start = vi.fn(async () => ({ jobId: "new-job" }));
    const client = { status: async () => { if (unavailable) throw error; return empty(); }, start } as unknown as AgentSourceScanClient;
    const bridge = createAgentSourceScanBridge(client, bus, 60_000);
    try {
      expect(await bridge.status()).toMatchObject({ active: false, progress: null, unavailable: { code: expect.any(String) } });
      await expect(bridge.start({ sourceId: "all" })).rejects.toBe(error);
      expect(start).not.toHaveBeenCalled();
      expect(completed).not.toHaveBeenCalled();
      unavailable = false;
      expect(await bridge.status()).toEqual({ active: false, progress: null });
      expect(await bridge.start({ sourceId: "all" })).toEqual({ jobId: "new-job" });
    } finally { await bridge.dispose(); }
  });
  it("does not fall back or report successful completion", async () => {
    const bus = createProgressBus();
    const completed = vi.fn(); bus.on("agent_source.scan_completed", completed);
    const bridge = createAgentSourceScanBridge({ status: async () => { throw new Error("offline"); } } as unknown as AgentSourceScanClient, bus, 60_000);
    try { await expect(bridge.status()).rejects.toThrow("offline"); expect(completed).not.toHaveBeenCalled(); }
    finally { await bridge.dispose(); }
  });
});

it("maps every raw scan phase at the desktop boundary", async () => {
  let state = { ...empty(), running: true, jobId: "job", sourceId: "all" };
  const bus = createProgressBus();
  const progress = vi.fn(); bus.on("agent_source.scan_progress", progress);
  const bridge = createAgentSourceScanBridge({ status: async () => state } as AgentSourceScanClient, bus, 60_000);
  try {
    for (const phase of ["discover", "read", "redact", "emit", "prepare"] as const) {
      state = { ...state, progress: { sourceId: "all", phase, current: 1, total: 2 } };
      expect((await bridge.status()).progress?.phase).toBe("scan");
    }
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ phase: "scan" }));
  } finally { await bridge.dispose(); }
});

it("reports complete error counts and emits each retry once for SSE and polling", async () => {
  let state: MemoryAgentSourceScanState = { ...empty(), jobId: "same-job", attemptId: "first", sourceId: "all", completedAt: new Date().toISOString(),
    results: [{ sourceId: "fixture", emittedMessages: 1000, discoveredConversations: 500, skipped: 0, errors: [], errorCount: 1, detailsTruncated: true }] };
  const bus = createProgressBus(); const completed = vi.fn(); bus.on("agent_source.scan_completed", completed);
  const bridge = createAgentSourceScanBridge({ status: async () => state } as AgentSourceScanClient, bus, 60_000);
  try {
    expect((await bridge.status()).completion?.succeeded).toBe(false);
    await bridge.status();
    expect(completed).toHaveBeenCalledTimes(1);
    expect(completed.mock.calls[0]![0].succeeded).toBe(false);
    state = { ...state, attemptId: "second", results: [{ ...state.results![0]!, errorCount: 0 }] };
    expect((await bridge.status()).completion?.succeeded).toBe(true);
    await bridge.status();
    expect(completed).toHaveBeenCalledTimes(2);
    expect(completed.mock.calls[1]![0]).toMatchObject({ jobId: "same-job", attemptId: "second", succeeded: true });
  } finally { await bridge.dispose(); }
});

it.each(["pause", "cancel"] as const)("uses the %s snapshot while a pre-control poll is outstanding", async (kind) => {
  let release!: (state: MemoryAgentSourceScanState) => void;
  const old: MemoryAgentSourceScanState = { ...empty(), running: true, jobId: "job", attemptId: "a", sourceId: "all", status: "running", version: { generation: 1, sequence: 1 }, progress: { sourceId: "all", phase: "scan", current: 1, total: 2 } };
  const next: MemoryAgentSourceScanState = { ...old, running: false, status: kind === "pause" ? "paused" : "cancelled", version: { generation: 1, sequence: 2 }, progress: kind === "pause" ? { ...old.progress!, phase: "stopped" } : null };
  const control = vi.fn(async () => ({ ok: true as const, outcome: "applied" as const, snapshot: next }));
  const client = { status: () => new Promise<MemoryAgentSourceScanState>(resolve => { release = resolve; }), [kind]: control } as unknown as AgentSourceScanClient;
  const bus = createProgressBus(); const published = vi.fn(); bus.on("agent_source.scan_progress", published);
  const bridge = createAgentSourceScanBridge(client, bus, 60_000);
  const poll = bridge.status();
  try {
    const expectedExecution = { jobId: "job", attemptId: "a" };
    const response = await bridge[kind]({ expectedExecution });
    expect(control).toHaveBeenCalledWith({ expectedExecution });
    expect(response.snapshot.status).toBe(next.status);
    release(old);
    expect((await poll).version).toEqual(next.version);
    expect(published.mock.calls.every(([value]) => value.version.sequence === 2)).toBe(true);
  } finally { release(old); await bridge.dispose(); }
});

it("does not bypass execution/version preconditions when a matching source is running", async () => {
  const start = vi.fn(async () => { throw new Error("conflict"); });
  const bridge = createAgentSourceScanBridge({ status: async () => ({ ...empty(), running: true, sourceId: "all", jobId: "new" }), start } as unknown as AgentSourceScanClient, createProgressBus(), 60_000);
  try {
    await expect(bridge.start({ sourceId: "all", expectedExecution: { jobId: "old", attemptId: "a" } })).rejects.toThrow("conflict");
    expect(start).toHaveBeenCalledOnce();
  } finally { await bridge.dispose(); }
});

it("prioritizes completion over residual paused progress at the same version", async () => {
  const state: MemoryAgentSourceScanState = { ...empty(), jobId: "job", attemptId: "a", sourceId: "all", status: "completed", version: { generation: 1, sequence: 5 }, completedAt: "2026-10-21T00:00:00Z", progress: { sourceId: "all", phase: "stopped", current: 1, total: 1 } };
  const bus = createProgressBus(), progress = vi.fn(), completed = vi.fn(); bus.on("agent_source.scan_progress", progress); bus.on("agent_source.scan_completed", completed);
  const bridge = createAgentSourceScanBridge({ status: async () => state } as AgentSourceScanClient, bus, 60_000);
  try {
    expect((await bridge.status()).progress).toBeNull(); expect(progress).not.toHaveBeenCalled(); expect(completed).toHaveBeenCalledOnce();
  } finally { await bridge.dispose(); }
});


it("starts a fresh status read after restart instead of reusing an outstanding old read", async () => {
  let release!: (state: MemoryAgentSourceScanState) => void;
  const old = { ...empty(), status: "idle" as const, version: { generation: 1, sequence: 0 } };
  const current = { ...old, version: { generation: 2, sequence: 0 } };
  const status = vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve; })).mockResolvedValue(current);
  const bridge = createAgentSourceScanBridge({ status } as unknown as AgentSourceScanClient, createProgressBus(), 60_000);
  const pending = bridge.status();
  try {
    const fresh = bridge.status();
    expect(status).toHaveBeenCalledTimes(2);
    expect((await fresh).version).toEqual(current.version);
    release(old);
    expect((await pending).version).toEqual(current.version);
  } finally { release(old); await pending; await bridge.dispose(); }
});


it.each(["full", "incremental", "initial_subset"] as const)("forwards the confirmed %s mode through status and events", async mode => {
  const state: MemoryAgentSourceScanState = { ...empty(), jobId: "job", attemptId: "a", sourceId: "all", mode, status: "paused", version: { generation: 2, sequence: 0 }, progress: { sourceId: "all", phase: "stopped", current: 0, total: 0 } };
  const bus = createProgressBus(), progress = vi.fn(); bus.on("agent_source.scan_progress", progress);
  const bridge = createAgentSourceScanBridge({ status: async () => state } as AgentSourceScanClient, bus, 60_000);
  try {
    expect(AgentSourceScanProgressPayloadSchema.parse((await bridge.status()).progress).mode).toBe(mode);
    expect(AgentSourceScanProgressPayloadSchema.parse(progress.mock.calls[0]![0]).mode).toBe(mode);
  } finally { await bridge.dispose(); }
});


it("keeps the all-source task scope separate from its current source progress", async () => {
  const state: MemoryAgentSourceScanState = { ...empty(), jobId: "job", attemptId: "a", sourceId: "all", mode: "full", status: "paused", version: { generation: 2, sequence: 0 }, progress: { sourceId: "pi", phase: "stopped", current: 3, total: 10 } };
  const bus = createProgressBus(), progress = vi.fn(); bus.on("agent_source.scan_progress", progress);
  const bridge = createAgentSourceScanBridge({ status: async () => state } as AgentSourceScanClient, bus, 60_000);
  try {
    expect(AgentSourceScanProgressPayloadSchema.parse((await bridge.status()).progress)).toMatchObject({ sourceId: "pi", requestedSourceId: "all", mode: "full" });
    expect(AgentSourceScanProgressPayloadSchema.parse(progress.mock.calls[0]![0])).toMatchObject({ sourceId: "pi", requestedSourceId: "all", mode: "full" });
  } finally { await bridge.dispose(); }
});
