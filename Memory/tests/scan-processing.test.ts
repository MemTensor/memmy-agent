import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForImportProcessing } from "../src/agent-source/scan-processing.js";
import type { MemoryService } from "../src/service/memory-service.js";
import type { MemoryAgentSourceScanStore } from "../src/agent-source/scan-store.js";

afterEach(() => vi.restoreAllMocks());
function setup(ids = ["one", "two", "three"]) {
  let now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const service = {
    enqueuePendingImportSummaries: vi.fn(),
    runWorkerOnce: vi.fn(async () => ({})),
    memoryProcessingStatus: vi.fn((pending: string[]) => ({ items: pending.map(memoryId => ({ memoryId, state: "ready", errorMessage: undefined as string | undefined })) }))
  };
  const store = { *importMemoryPages() { if (ids.length) yield ids; }, importMemoryCount: () => ids.length };
  const progress = vi.fn();
  const controller = new AbortController();
  return { service, progress, controller, advance(minutes: number) { now += minutes * 60_000; },
    run: (pause = async () => undefined) => waitForImportProcessing(service as unknown as MemoryService,
      store as unknown as MemoryAgentSourceScanStore, "fixture", controller.signal, pause, progress, () => undefined) };
}

describe("scan processing progress timeout", () => {
  it("allows a 63-minute batch while one memory completes every 21 minutes", async () => {
    const f = setup();
    f.service.runWorkerOnce.mockImplementation(async () => { f.advance(21); return {}; });
    f.service.memoryProcessingStatus.mockImplementation(ids => ({ items: ids.map((memoryId, i) => ({ memoryId, state: i ? "summarizing" : "ready", errorMessage: undefined })) }));
    expect(await f.run()).toEqual([]);
    expect(f.service.runWorkerOnce).toHaveBeenCalledTimes(3);
    expect(f.progress.mock.calls.map(([progress]) => progress.current)).toEqual([1, 2, 3]);
  });

  it("still times out after 40 minutes without progress", async () => {
    const f = setup();
    f.service.runWorkerOnce.mockImplementation(async () => { f.advance(40); return {}; });
    f.service.memoryProcessingStatus.mockImplementation(ids => ({ items: ids.map(memoryId => ({ memoryId, state: "embedding", errorMessage: undefined })) }));
    await expect(f.run()).rejects.toThrow("Timed out");
  });

  it("accepts a completed cohort before evaluating its timeout", async () => {
    const f = setup(["one"]);
    f.service.runWorkerOnce.mockImplementation(async () => { f.advance(41); return {}; });
    expect(await f.run()).toEqual([]);
  });

  it("excludes a pause that begins while a worker is running", async () => {
    const f = setup(["one"]); let calls = 0; let waits = 0;
    f.service.runWorkerOnce.mockImplementation(async () => { calls++; f.advance(20); return {}; });
    f.service.memoryProcessingStatus.mockImplementation(ids => ({ items: ids.map(memoryId => ({ memoryId, state: calls === 1 ? "summarizing" : "ready", errorMessage: undefined })) }));
    expect(await f.run(async () => { if (++waits === 2) f.advance(60); })).toEqual([]);
    expect(calls).toBe(2);
  });

  it("does not start a worker for an empty import", async () => {
    const f = setup([]);
    expect(await f.run()).toEqual([]);
    expect(f.service.runWorkerOnce).not.toHaveBeenCalled();
  });

  it("returns terminal processing failures instead of counting them as success", async () => {
    const f = setup(["one"]);
    f.service.memoryProcessingStatus.mockReturnValue({ items: [{ memoryId: "one", state: "failed", errorMessage: "embedding failed" }] });
    expect(await f.run()).toEqual(["embedding failed"]);
  });

  it("surfaces worker errors", async () => {
    const f = setup();
    f.service.runWorkerOnce.mockRejectedValue(new Error("worker failed"));
    await expect(f.run()).rejects.toThrow("worker failed");
  });

  it("honors cancellation while paused", async () => {
    const f = setup();
    await expect(f.run(async () => { f.controller.abort(); })).rejects.toThrow();
    expect(f.service.runWorkerOnce).not.toHaveBeenCalled();
  });
});
