// @vitest-environment happy-dom
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import { EmbeddingMaintenancePanel } from "../viewer/src/views/SettingsView";
import { api } from "../viewer/src/api/client";
import { locale } from "../viewer/src/stores/i18n";

const container = document.createElement("div");
afterEach(() => { act(() => render(null, container)); vi.restoreAllMocks(); vi.useRealTimers(); });

it("refreshes away repaired historical failures while keeping other failed targets visible", async () => {
  vi.useFakeTimers();
  locale.value = "zh";
  const stats = {
    dimension: 3, available: true, totalSlots: 2, ready: 0, missing: 2, dimMismatch: 0, needsRepair: 2,
    retryQueue: { pending: 0, active: 0, stale: 0, failed: 2 }
  };
  vi.spyOn(api, "get").mockImplementation(async path => path.includes("/embeddings/rebuild") ? null : structuredClone(stats));
  act(() => render(h(EmbeddingMaintenancePanel, {}), container));
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(container.textContent).toContain("失败 2");
  stats.ready = 1; stats.missing = 1; stats.needsRepair = 1; stats.retryQueue.failed = 1;
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(container.textContent).toContain("可用 1/2");
  expect(container.textContent).toContain("失败 1");
  stats.ready = 2; stats.missing = 0; stats.needsRepair = 0; stats.retryQueue.failed = 0;
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(container.textContent).toContain("可用 2/2");
  expect(container.textContent).toContain("失败 0");
  const repair = [...container.querySelectorAll("button")].find(button => button.textContent?.startsWith("修复缺失"));
  expect(repair?.disabled).toBe(true);
});

it("allows repairing outdated content with no missing vectors and refreshes after completion", async () => {
  vi.useFakeTimers();
  locale.value = "zh";
  const stats = {
    dimension: 3, available: true, totalSlots: 1, ready: 0, missing: 0, dimMismatch: 1, needsRepair: 1,
    retryQueue: { pending: 0, active: 0, stale: 0, failed: 1 }
  };
  vi.spyOn(api, "get").mockImplementation(async path => path.includes("/embeddings/rebuild") ? null : structuredClone(stats));
  const completed = { runId: "run-content", mode: "repair", accepted: true, enqueued: 1,
    processed: 1, updated: 1, failed: 0, pending: 0, retrying: 0, done: true, statsAfter: stats, serverTime: "2026-10-27" };
  const post = vi.spyOn(api, "post").mockResolvedValue(completed);
  act(() => render(h(EmbeddingMaintenancePanel, {}), container));
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  const repair = [...container.querySelectorAll("button")].find(button => button.textContent?.startsWith("修复缺失"))!;
  expect(repair.disabled).toBe(false);
  await act(async () => { repair.click(); });
  expect(post).toHaveBeenCalledExactlyOnceWith("/api/v1/embeddings/rebuild", { mode: "repair" }, { signal: expect.any(AbortSignal) });
  stats.ready = 1; stats.dimMismatch = 0; stats.needsRepair = 0; stats.retryQueue.failed = 0;
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(repair.disabled).toBe(true);
  expect(container.textContent).toContain("失败 0");
});
