// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppStateProvider } from "../../../state/app-state.js";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import { MemoriesSubPage } from "../memories-sub-page.js";
import { createMemoryRuntimeClientStub, memoryDetailFixture, panelItemsOutput } from "./fixtures.js";
import type { GetMemoryOutput, MemoryProcessingRecord } from "@memmy/local-api-contracts";
import { clearMemoryPanelCache } from "../memory-panel-cache.js";
import { PanelVisibilityContext } from "../panel-visibility.js";

function detail(state: MemoryProcessingRecord["state"]): GetMemoryOutput {
  const processed = state === "ready";
  return {
    ...memoryDetailFixture,
    item: {
      ...memoryDetailFixture.item,
      id: "observation_polling",
      kind: "observed_activity",
      title: processed ? "后续采购上下文" : "原始历史",
      generatedTitle: processed ? "后续采购上下文" : undefined,
      summary: processed ? "采购仍有审批事项需要跟进。" : "# 原始历史",
      body: processed ? "## 后续上下文\n\n采购审批还需跟进。" : "# 原始历史\n\n未整理的操作回顾。",
      processing: {
        memoryId: "observation_polling", state, stage: processed ? null : "summary",
        attemptCount: 1, manualRetryCount: 0, retryAction: "retry", updatedAt: "2026-10-09T04:22:00Z",
        ...(state === "failed" ? { errorMessage: "模型暂时不可用", autoRetryScheduled: false } : {}),
      },
      metadata: { source: "computer_history", properties: { internal_info: {
        memory_kind: "observed_activity",
        observation_memory: { schema_version: 1, status: processed ? "processed" : "pending" },
        external_evidence: { source: "computer_history", source_content: "# 原始历史\n\n未整理的操作回顾。" },
      } } },
    },
  };
}

describe("open observation processing", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.useFakeTimers();
    clearMemoryPanelCache();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    clearMemoryPanelCache();
  });

  it("stops retry follow-up reads when its page becomes hidden while the retry is in flight", async () => {
    const failed = detail("failed");
    let finishRetry!: () => void;
    const pending = new Promise<void>(resolve => { finishRetry = resolve; });
    const getMemory = vi.fn(async () => failed);
    const getMemoryProcessingStatus = vi.fn(async () => ({items:[failed.item.processing!],serverTime:"2026-10-28T00:00:00Z"}));
    const retryMemoryProcessing = vi.fn(async () => { await pending; return {processing:failed.item.processing!} as never; });
    const client = createMemoryRuntimeClientStub({ getMemory, getMemoryProcessingStatus, retryMemoryProcessing,
      listPanelItems: vi.fn(async () => panelItemsOutput([failed.item])) });
    const request = {id:failed.item.id,requestId:1};
    const render = async (visible: boolean) => act(async () => root.render(
      <AppStateProvider><I18nProvider language="zh-CN"><PanelVisibilityContext.Provider value={visible}>
        <MemoriesSubPage client={client} openRequest={request}/>
      </PanelVisibilityContext.Provider></I18nProvider></AppStateProvider>
    ));
    await render(true);
    await act(async () => container.querySelector<HTMLButtonElement>(".memory-processing-action--primary")!.click());
    expect(retryMemoryProcessing).toHaveBeenCalledTimes(1);
    await render(false); getMemory.mockClear(); getMemoryProcessingStatus.mockClear();
    await act(async () => finishRetry());
    expect(getMemoryProcessingStatus).not.toHaveBeenCalled();
    expect(getMemory).not.toHaveBeenCalled();
    await render(true);
    expect(container.textContent).not.toContain("正在重试");
  });

  it("updates an open pending drawer when processing finishes and stops polling", async () => {
    const pending = detail("summary_pending");
    const ready = detail("ready");
    const getMemory = vi.fn().mockResolvedValueOnce(pending).mockResolvedValue(ready);
    const client = createMemoryRuntimeClientStub({
      getMemory,
      listPanelItems: vi.fn(async () => panelItemsOutput([pending.item])),
    });
    await act(async () => root.render(<AppStateProvider><I18nProvider language="zh-CN"><MemoriesSubPage client={client} openRequest={{ id: pending.item.id, requestId: 1 }} /></I18nProvider></AppStateProvider>));
    expect(container.querySelector(".memory-drawer")?.textContent).toContain("正在整理为记忆");
    expect(container.querySelector(".memory-drawer__title")?.textContent).toBe("原始历史");
    expect(container.querySelector("details")?.hasAttribute("open")).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(container.querySelector(".memory-drawer")?.textContent).toContain("采购仍有审批事项需要跟进。");
    expect(container.querySelector(".memory-drawer__title")?.textContent).toBe("后续采购上下文");
    await act(async () => vi.advanceTimersByTimeAsync(4_000));
    expect(getMemory).toHaveBeenCalledTimes(2);
  });

  it("shows actionable processing failure while keeping raw source collapsed", async () => {
    const failed = detail("failed");
    const getMemory = vi.fn(async () => failed);
    const client = createMemoryRuntimeClientStub({ getMemory, listPanelItems: vi.fn(async () => panelItemsOutput([failed.item])) });
    await act(async () => root.render(<AppStateProvider><I18nProvider language="zh-CN"><MemoriesSubPage client={client} openRequest={{ id: failed.item.id, requestId: 1 }} /></I18nProvider></AppStateProvider>));
    const drawer = container.querySelector(".memory-drawer")!;
    expect(drawer.textContent).toContain("这段历史摘要尚未整理为记忆");
    expect(drawer.querySelector(".memory-processing-action--primary")?.textContent).toContain("重试");
    expect(drawer.querySelector("details")?.hasAttribute("open")).toBe(false);
    expect(drawer.textContent).not.toContain("可供后续参考的上下文");
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(getMemory).toHaveBeenCalledTimes(1);
  });

  it("opens the underlying memories used by a consolidated History memory", async () => {
    const aggregate = detail("ready");
    aggregate.item.sourceMemoryIds = ["observation_parent"];
    const source = detail("ready");
    source.item = { ...source.item, id: "observation_parent", summary: "这是一段对应的来源记忆。", sourceMemoryIds: [] };
    const getMemory = vi.fn(async (id: string) => id === aggregate.item.id ? aggregate : source);
    const client = createMemoryRuntimeClientStub({ getMemory, listPanelItems: vi.fn(async () => panelItemsOutput([aggregate.item])) });
    await act(async () => root.render(<AppStateProvider><I18nProvider language="zh-CN"><MemoriesSubPage client={client} openRequest={{ id: aggregate.item.id, requestId: 1 }} /></I18nProvider></AppStateProvider>));
    await act(async () => container.querySelector<HTMLButtonElement>(".memory-policy-id--link")?.click());
    expect(getMemory).toHaveBeenLastCalledWith("observation_parent", expect.any(AbortSignal));
    expect(container.querySelector(".memory-drawer")?.textContent).toContain("这是一段对应的来源记忆。");
  });

  it("refreshes a failed open drawer after an external retry without reloading the list", async () => {
    let latest = detail("failed");
    const getMemory = vi.fn(async () => latest);
    const listPanelItems = vi.fn(async () => panelItemsOutput([latest.item]));
    const client = createMemoryRuntimeClientStub({ getMemory, listPanelItems,
      getMemoryProcessingStatus: vi.fn(async () => ({ items: [latest.item.processing!], serverTime: latest.item.updatedAt })) });
    await act(async () => root.render(<AppStateProvider><I18nProvider language="zh-CN"><MemoriesSubPage client={client} openRequest={{ id: latest.item.id, requestId: 1 }} /></I18nProvider></AppStateProvider>));
    await act(async () => vi.advanceTimersByTimeAsync(180));
    expect(container.querySelector(".memory-drawer")?.textContent).toContain("这段历史摘要尚未整理为记忆");
    const oldVersion = latest.item.version;
    latest = detail("ready");
    latest.item.version = oldVersion + 1;
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(container.querySelector(".memory-drawer")?.textContent).toContain("采购仍有审批事项需要跟进。");
    expect(getMemory).toHaveBeenCalledTimes(2);
    expect(listPanelItems).toHaveBeenCalledTimes(1);
  });

  it("keeps a queued History window pending when an older service flags it for automatic retry", async () => {
    const queued = detail("summary_pending");
    queued.item.processing = { ...queued.item.processing!, attemptCount: 0, autoRetryScheduled: true };
    const client = createMemoryRuntimeClientStub({ getMemory: vi.fn(async () => queued), listPanelItems: vi.fn(async () => panelItemsOutput([queued.item])) });
    await act(async () => root.render(<AppStateProvider><I18nProvider language="zh-CN"><MemoriesSubPage client={client} openRequest={{ id: queued.item.id, requestId: 1 }} /></I18nProvider></AppStateProvider>));
    const drawer = container.querySelector(".memory-drawer")!;
    expect(drawer.textContent).toContain("正在整理为记忆");
    expect(drawer.textContent).not.toContain("记忆处理失败");
    expect(drawer.querySelector('[role="alert"]')).toBeNull();
  });

  it("guides an unconfigured pending model to settings without claiming a retry is running", async () => {
    const pending = detail("summary_pending");
    pending.item.processing = { ...pending.item.processing!, retryAction: "open_settings", errorCode: "summary_model_unconfigured", errorMessage: "等待配置摘要模型" };
    const onOpenSettings = vi.fn();
    const client = createMemoryRuntimeClientStub({ getMemory: vi.fn(async () => pending), listPanelItems: vi.fn(async () => panelItemsOutput([pending.item])) });
    await act(async () => root.render(<AppStateProvider><I18nProvider language="zh-CN"><MemoriesSubPage client={client} onOpenSettings={onOpenSettings} openRequest={{ id: pending.item.id, requestId: 1 }} /></I18nProvider></AppStateProvider>));
    const drawer = container.querySelector(".memory-drawer")!;
    expect(drawer.textContent).toContain("等待配置记忆模型");
    expect(drawer.textContent).not.toContain("正在重试");
    expect(drawer.querySelector(".memory-spin")).toBeNull();
    const settings = [...drawer.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("检查模型设置"));
    await act(async () => settings?.click());
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});
