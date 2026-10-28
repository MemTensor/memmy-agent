// @vitest-environment happy-dom
import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PanelVisibilityContext } from "../panel-visibility.js";
import { usePanelViewStatus } from "../panel-view-status.js";
import { usePanelStats } from "../use-panel-stats.js";
import { createMemoryRuntimeClientStub } from "./fixtures.js";
import { memoryDetailFixture, panelItemsFixture } from "./fixtures.js";
import { PoliciesSubPage } from "../policies-sub-page.js";
import { AppStateProvider } from "../../../state/app-state.js";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import { clearMemoryPanelCache } from "../memory-panel-cache.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it.each(["inactive page", "background window"])("defers invalidated list and statistics reads for an %s", async (mode) => {
  vi.useFakeTimers();
  const foreground = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const container = document.createElement("div");
  const root = createRoot(container);
  const checkPanelView = vi.fn(async () => ({ updated: false }));
  const reload = vi.fn(async () => "fresh list");
  const getPanelStats = vi.fn(async () => ({ status: "ready", data: { analysis: { count: 42 } } }));
  const client = createMemoryRuntimeClientStub({ checkPanelView, getPanelStats } as never);
  function Fixture() {
    const [content, setContent] = useState("");
    const view = usePanelViewStatus(client, "L2", () => setContent(""), async () => setContent(await reload()));
    const stats = usePanelStats(client, "analysis", async () => ({ count: 0 }));
    useEffect(() => setContent("private list"), []);
    return <div>{content} {view.expired ? "expired" : "checked"} {JSON.stringify(stats.state)}</div>;
  }
  const render = async (visible: boolean) => act(async () => root.render(
    <PanelVisibilityContext.Provider value={visible}><Fixture /></PanelVisibilityContext.Provider>
  ));
  try {
    await render(true);
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(container.textContent).toContain("private list");
    expect(container.textContent).toContain('"count":42');
    if (mode === "inactive page") await render(false);
    else await act(async () => { foreground.mockReturnValue(true); document.dispatchEvent(new Event("visibilitychange")); });
    checkPanelView.mockClear(); getPanelStats.mockClear(); reload.mockClear();
    await act(async () => window.dispatchEvent(new Event("memmy-panel-invalidated")));
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(container.textContent).not.toContain("private list");
    expect(container.textContent).not.toContain('"count":42');
    expect(container.textContent).toContain("expired");
    expect(checkPanelView).not.toHaveBeenCalled();
    expect(getPanelStats).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    if (mode === "inactive page") await render(true);
    else await act(async () => { foreground.mockReturnValue(false); document.dispatchEvent(new Event("visibilitychange")); });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(checkPanelView).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(getPanelStats).toHaveBeenCalled();
    expect(container.textContent).toContain("fresh list");
    expect(container.textContent).toContain('"count":42');
  } finally { await act(async () => root.unmount()); }
});

it.each(["inactive page", "background window"])("does not let a completed delete reload an %s", async (mode) => {
  clearMemoryPanelCache();
  const foreground = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const container = document.createElement("div"), root = createRoot(container);
  let finishDelete!: () => void;
  const pending = new Promise<void>(resolve => { finishDelete = resolve; });
  const listPanelItems = vi.fn(async () => panelItemsFixture);
  const client = createMemoryRuntimeClientStub({ listPanelItems, getMemory: vi.fn(async () => memoryDetailFixture),
    deleteMemory: vi.fn(async () => { await pending; window.dispatchEvent(new Event("memmy-panel-invalidated")); return {} as never; }),
    checkPanelView: vi.fn(async () => ({ updated: false })) } as never);
  const request = { id: memoryDetailFixture.item.id, requestId: 1 };
  const render = async (visible: boolean) => act(async () => root.render(
    <AppStateProvider><I18nProvider language="zh-CN"><PanelVisibilityContext.Provider value={visible}>
      <PoliciesSubPage client={client} openRequest={request} onOpenMemoryReference={() => {}} />
    </PanelVisibilityContext.Provider></I18nProvider></AppStateProvider>
  ));
  const click = async (label: string) => act(async () => {
    const button = [...container.querySelectorAll("button")].find(x => x.textContent === label);
    expect(button).toBeDefined(); button!.click();
  });
  try {
    await render(true);
    await click("删除"); await click("确认删除");
    expect(client.deleteMemory).toHaveBeenCalledTimes(1);
    if (mode === "inactive page") await render(false);
    else await act(async () => { foreground.mockReturnValue(true); document.dispatchEvent(new Event("visibilitychange")); });
    listPanelItems.mockClear();
    await act(async () => finishDelete());
    expect(listPanelItems).not.toHaveBeenCalled();
    expect(container.querySelector(".memory-drawer")).toBeNull();
    if (mode === "inactive page") await render(true);
    else await act(async () => { foreground.mockReturnValue(false); document.dispatchEvent(new Event("visibilitychange")); });
    expect(listPanelItems).toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); clearMemoryPanelCache(); }
});

it("reloads the current filter when a delete finishes after its drawer was closed", async () => {
  vi.useFakeTimers(); clearMemoryPanelCache();
  const container = document.createElement("div"), root = createRoot(container);
  let finishDelete!: () => void;
  const pending = new Promise<void>(resolve => { finishDelete = resolve; });
  const listPanelItems = vi.fn(async (_input: { q?: string }) => panelItemsFixture);
  const client = createMemoryRuntimeClientStub({ listPanelItems, getMemory: vi.fn(async () => memoryDetailFixture),
    deleteMemory: vi.fn(async () => { await pending; window.dispatchEvent(new Event("memmy-panel-invalidated")); return {} as never; }) });
  try {
    await act(async () => root.render(<AppStateProvider><I18nProvider language="zh-CN">
      <PoliciesSubPage client={client} openRequest={{id:memoryDetailFixture.item.id,requestId:1}} onOpenMemoryReference={()=>{}} />
    </I18nProvider></AppStateProvider>));
    const click = async (label: string) => act(async () => [...container.querySelectorAll("button")].find(x=>x.textContent===label)!.click());
    await click("删除"); await click("确认删除");
    await act(async () => container.querySelector<HTMLButtonElement>(".memory-drawer-backdrop__close")!.click());
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"latest-filter");
      input.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await act(async () => vi.advanceTimersByTimeAsync(180));
    expect(listPanelItems.mock.calls.at(-1)?.[0]).toMatchObject({q:"latest-filter"});
    listPanelItems.mockClear();
    await act(async () => finishDelete());
    expect(listPanelItems).toHaveBeenCalled();
    for(const call of listPanelItems.mock.calls) expect(call[0]).toMatchObject({q:"latest-filter"});
  } finally { await act(async()=>root.unmount()); clearMemoryPanelCache(); }
});
