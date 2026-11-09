// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import type { TaskExperienceProcessing } from "../../../api/memory-runtime-client.js";
import { TaskExperienceProcessingCard } from "../task-experience-processing.js";
import { createMemoryRuntimeClientStub } from "./fixtures.js";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const failed: TaskExperienceProcessing = { episodeId: "e", state: "failed", pendingCount: 7, canRetry: true,
  errorCode: "invalid_model_output", serverTime: "2026-11-10T00:00:00Z" };
const queued = { ...failed, state: "queued" as const, canRetry: false, accepted: true };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
describe("task experience recovery", () => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => { vi.useFakeTimers(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
  afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); });
  async function render(client: ReturnType<typeof createMemoryRuntimeClientStub>, id = "e") {
    await act(async () => root.render(<I18nProvider language="zh-CN"><TaskExperienceProcessingCard client={client} episodeId={id} /></I18nProvider>));
  }
  it("shows the separate experience failure and coalesces rapid retry clicks", async () => {
    const gate = deferred<typeof queued>();
    const retry = vi.fn(() => gate.promise);
    await render(createMemoryRuntimeClientStub({ taskExperienceProcessing: vi.fn(async () => failed), retryTaskExperienceProcessing: retry }));
    expect(container.textContent).toContain("还有 7 条记录");
    expect(container.textContent).toContain("原始记录已保留");
    const button = container.querySelector("button")!;
    await act(async () => { button.click(); button.click(); });
    expect(retry).toHaveBeenCalledTimes(1); expect(button.disabled).toBe(true);
    await act(async () => gate.resolve(queued));
    expect(container.textContent).toContain("已排队"); expect(container.querySelector("button")).toBeNull();
  });
  it("does not replace the new retry state with a slower earlier poll", async () => {
    const oldPoll = deferred<TaskExperienceProcessing>();
    const read = vi.fn().mockResolvedValueOnce(failed).mockReturnValueOnce(oldPoll.promise);
    await render(createMemoryRuntimeClientStub({ taskExperienceProcessing: read, retryTaskExperienceProcessing: vi.fn(async () => queued) }));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    await act(async () => container.querySelector("button")!.click());
    await act(async () => oldPoll.resolve(failed));
    expect(container.textContent).toContain("已排队"); expect(container.querySelector("button")).toBeNull();
  });
  it("ignores a previous episode's late response", async () => {
    const old = deferred<TaskExperienceProcessing>();
    const client = createMemoryRuntimeClientStub({ taskExperienceProcessing: vi.fn(id => id === "old" ? old.promise : Promise.resolve({ ...failed, episodeId: id, state: "complete", pendingCount: 0, canRetry: false })) });
    await render(client, "old"); await render(client, "new");
    await act(async () => old.resolve(failed));
    expect(container.textContent).toContain("当前没有待处理"); expect(container.textContent).not.toContain("7 条");
  });
  it("keeps pending records and offers retry again after a request error", async () => {
    const retry = vi.fn().mockRejectedValueOnce(new Error("连接中断")).mockResolvedValueOnce(queued);
    await render(createMemoryRuntimeClientStub({ taskExperienceProcessing: vi.fn(async () => failed), retryTaskExperienceProcessing: retry }));
    await act(async () => container.querySelector("button")!.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("连接中断");
    expect(container.querySelector("button")!.disabled).toBe(false);
    await act(async () => container.querySelector("button")!.click());
    expect(retry).toHaveBeenCalledTimes(2); expect(container.textContent).toContain("已排队");
  });
});
