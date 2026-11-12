// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import type { TaskExperienceProcessing } from "../../../api/memory-runtime-client.js";
import { PanelVisibilityContext } from "../panel-visibility.js";
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
  async function render(client: ReturnType<typeof createMemoryRuntimeClientStub>, id = "e", visible = true) {
    await act(async () => root.render(<I18nProvider language="zh-CN"><PanelVisibilityContext value={visible}><TaskExperienceProcessingCard client={client} episodeId={id} /></PanelVisibilityContext></I18nProvider>));
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
  it("does not read or poll while the memory panel is hidden", async () => {
    const read = vi.fn(async () => failed);
    const retry = vi.fn(async () => queued);
    const client = createMemoryRuntimeClientStub({ taskExperienceProcessing: read, retryTaskExperienceProcessing: retry });
    await render(client, "e", false);
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(read).not.toHaveBeenCalled();
    expect(container.querySelector("button")).toBeNull();
    expect(retry).not.toHaveBeenCalled();
    await render(client, "e", true);
    expect(read).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("还有 7 条记录");
  });
  it("aborts a hidden read and ignores its late result when the same task resumes", async () => {
    const old = deferred<TaskExperienceProcessing>();
    const read = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue({ ...failed, state: "complete", pendingCount: 0, canRetry: false });
    const client = createMemoryRuntimeClientStub({ taskExperienceProcessing: read });
    await render(client);
    const signal = read.mock.calls[0]![1] as AbortSignal | undefined;
    await render(client, "e", false);
    expect(signal?.aborted).toBe(true);
    await render(client);
    await act(async () => old.resolve(failed));
    expect(container.textContent).toContain("当前没有待处理");
    expect(container.textContent).not.toContain("7 条");
  });
  it("leaves an accepted retry running when hidden and resumes by GET without another POST", async () => {
    const response = deferred<typeof queued>();
    const read = vi.fn().mockResolvedValueOnce(failed).mockResolvedValue({ ...failed, state: "complete", pendingCount: 0, canRetry: false });
    const retry = vi.fn(() => response.promise);
    const client = createMemoryRuntimeClientStub({ taskExperienceProcessing: read, retryTaskExperienceProcessing: retry });
    await render(client);
    await act(async () => container.querySelector("button")!.click());
    await render(client, "e", false);
    await act(async () => response.resolve(queued));
    await render(client);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("当前没有待处理");
    expect(container.textContent).not.toContain("已排队");
  });

  it("suspends document background reads and refreshes when the document returns", async () => {
    const original = Object.getOwnPropertyDescriptor(document, "hidden");
    const read = vi.fn(async () => failed);
    const client = createMemoryRuntimeClientStub({taskExperienceProcessing:read});
    try {
      await render(client);
      await act(async () => { Object.defineProperty(document, "hidden", {configurable:true,value:true}); document.dispatchEvent(new Event("visibilitychange")); });
      await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
      expect(read).toHaveBeenCalledTimes(1);
      expect(container.querySelector("button")).toBeNull();
      await act(async () => { Object.defineProperty(document, "hidden", {configurable:true,value:false}); document.dispatchEvent(new Event("visibilitychange")); });
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      if (original) Object.defineProperty(document, "hidden", original);
      else delete (document as {hidden?:boolean}).hidden;
      await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    }
  });
  it("does not apply a previous task's accepted POST to the newly selected task", async () => {
    const old = deferred<typeof queued>();
    const retry = vi.fn(() => old.promise);
    const client = createMemoryRuntimeClientStub({
      taskExperienceProcessing: vi.fn(async id => id === "e" ? failed : {...failed, episodeId:id, state:"complete", pendingCount:0, canRetry:false}),
      retryTaskExperienceProcessing:retry
    });
    await render(client);
    await act(async () => container.querySelector("button")!.click());
    await render(client, "new");
    await act(async () => old.resolve(queued));
    expect(container.textContent).toContain("当前没有待处理");
    expect(retry).toHaveBeenCalledTimes(1);
    expect(container.querySelector("button")).toBeNull();
  });

});
