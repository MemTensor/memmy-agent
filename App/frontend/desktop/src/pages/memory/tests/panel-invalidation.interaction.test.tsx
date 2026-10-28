// @vitest-environment happy-dom
import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PanelVisibilityContext } from "../panel-visibility.js";
import { usePanelViewStatus } from "../panel-view-status.js";
import { usePanelStats } from "../use-panel-stats.js";
import { createMemoryRuntimeClientStub } from "./fixtures.js";

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
