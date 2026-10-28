import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../viewer/src/api/client.js";
import { followEmbeddingMaintenance, type EmbeddingMaintenanceRunResult } from "../viewer/src/api/embedding-maintenance.js";
vi.mock("../viewer/src/api/client.js", () => ({ api: { get: vi.fn(), post: vi.fn() } }));
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });
const result = (updated: number, pending: number): EmbeddingMaintenanceRunResult => ({
  runId: "run-test", mode: "repair", accepted: true, enqueued: 55, processed: updated,
  updated, failed: 0, pending, retrying: 0, done: pending === 0,
  statsAfter: { totalSlots: 55, ready: updated, missing: pending, dimMismatch: 0, modelMismatch: 0,
    needsRepair: pending, dimension: 3, available: true }, serverTime: "2026-10-19"
});
describe("embedding maintenance Viewer polling", () => {
  it("polls real cumulative progress without posting or double-counting batches", async () => {
    vi.useFakeTimers();
    vi.mocked(api.get).mockResolvedValueOnce(result(20, 35)).mockResolvedValueOnce(result(55, 0));
    const progress = vi.fn();
    const following = followEmbeddingMaintenance(result(0, 55), progress, new AbortController().signal);
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ updated: 0, done: false }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ updated: 20, done: false }));
    await vi.advanceTimersByTimeAsync(1000); await following;
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ updated: 55, done: true }));
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(api.post).not.toHaveBeenCalled();
  });
  it("stops polling when the page unmounts", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const following = followEmbeddingMaintenance(result(0, 55), vi.fn(), controller.signal);
    controller.abort(); await following;
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.get).not.toHaveBeenCalled();
  });
});
