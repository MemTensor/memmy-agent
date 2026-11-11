// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../../../api/http.js";
import { PanelVisibilityContext } from "../panel-visibility.js";
import { PoliciesSubPage } from "../policies-sub-page.js";
import { clearMemoryPanelCache } from "../memory-panel-cache.js";
import { createMemoryRuntimeClientStub, panelItemsFixture, memoryDetailFixture } from "./fixtures.js";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import { AppStateProvider } from "../../../state/app-state.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => { vi.useRealTimers(); clearMemoryPanelCache(); });
describe("page checks preserve the existing experience page", () => {
  it.each([new Error("memory layer timeout"), new ApiRequestError("service unavailable", 503)])("keeps the title, search, refresh and safe contents visible after %s", async error => {
    vi.useFakeTimers();
    const container = document.createElement("div"), root = createRoot(container);
    const checkPanelView = vi.fn().mockResolvedValueOnce({updated: false}).mockRejectedValueOnce(error).mockResolvedValue({updated: false});
    const client = createMemoryRuntimeClientStub({checkPanelView, listPanelItems: async () => panelItemsFixture});
    const render = async (visible: boolean) => act(async () => root.render(<AppStateProvider><I18nProvider language="zh-CN"><PanelVisibilityContext.Provider value={visible}>
      <PoliciesSubPage client={client} onOpenMemoryReference={() => {}} />
    </PanelVisibilityContext.Provider></I18nProvider></AppStateProvider>));
    try {
      await render(true); await act(async () => vi.advanceTimersByTimeAsync(0));
      const content = container.querySelector(".memory-list")!.textContent;
      await render(false); await render(true); await act(async () => vi.advanceTimersByTimeAsync(0));
      expect(checkPanelView).toHaveBeenCalledTimes(2);
      for (const selector of [".memory-panel__title", "input[type=search]", ".memory-refresh-button", ".memory-list"]) {
        expect(container.querySelector(selector)).not.toBeNull();
        expect(container.querySelector(selector)?.closest("[hidden]")).toBeNull();
      }
      expect(container.querySelector(".memory-list")!.textContent).toBe(content);
      expect(container.textContent).not.toContain(error.message);
      expect(container.textContent).not.toContain("重试");
      await act(async () => vi.advanceTimersByTimeAsync(120_000));
      expect(checkPanelView).toHaveBeenCalledTimes(3);
    } finally { await act(async () => root.unmount()); }
  });

  it("clears revoked contents and drawer while retaining the page controls, then recovers automatically", async () => {
    vi.useFakeTimers();
    const container = document.createElement("div"), root = createRoot(container);
    const checkPanelView = vi.fn().mockResolvedValueOnce({updated: false}).mockRejectedValueOnce(new ApiRequestError("access revoked", 403)).mockResolvedValue({updated: false});
    const listPanelItems = vi.fn(async () => panelItemsFixture);
    const client = createMemoryRuntimeClientStub({checkPanelView, listPanelItems, getMemory: async () => memoryDetailFixture});
    try {
      await act(async () => root.render(<AppStateProvider><I18nProvider language="zh-CN"><PoliciesSubPage client={client} openRequest={{id:memoryDetailFixture.item.id, requestId:1}} onOpenMemoryReference={() => {}} /></I18nProvider></AppStateProvider>));
      await act(async () => vi.advanceTimersByTimeAsync(0));
      expect(container.querySelector(".memory-drawer")).not.toBeNull();
      await act(async () => vi.advanceTimersByTimeAsync(60_000));
      expect(container.querySelector(".memory-list")).toBeNull();
      expect(container.querySelector(".memory-drawer")).toBeNull();
      expect(container.querySelector("input[type=search]")).not.toBeNull();
      expect(container.querySelector(".memory-refresh-button")).not.toBeNull();
      expect(container.textContent).not.toContain("access revoked");
      listPanelItems.mockResolvedValue({...panelItemsFixture, items: []});
      await act(async () => vi.advanceTimersByTimeAsync(120_000));
      expect(container.textContent).toContain("暂无经验");
      expect(container.querySelector(".memory-drawer")).toBeNull();
    } finally { await act(async () => root.unmount()); }
  });
});
