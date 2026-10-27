// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../../../api/http.js";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import { memoryPanelCacheKey, writeMemoryPanelCache } from "../memory-panel-cache.js";
import { MEMORY_PANEL_RETRY_DELAYS_MS } from "../memory-panel-error.js";
import { OverviewSubPage, OverviewSubPageView } from "../overview-sub-page.js";
import { classifyMemoryPanelError } from "../memory-panel-error.js";
import { createMemoryRuntimeClientStub, panelOverviewFixture } from "./fixtures.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const networkError = () => new ApiRequestError("memory layer network error", 503, "memory_layer_unavailable", "req-503");

describe("OverviewSubPage recovery", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(window, "sessionStorage", { configurable: true, value: createMemoryStorage() });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Object.defineProperty(window, "memmy", { configurable: true, value: undefined });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function render(client: Parameters<typeof OverviewSubPage>[0]["client"]) {
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <OverviewSubPage client={client} onNavigate={vi.fn()} />
        </I18nProvider>
      );
    });
  }

  async function advance(milliseconds: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
  }

  it("recovers automatically when the memory service becomes reachable again", async () => {
    const getPanelOverview = vi.fn()
      .mockRejectedValueOnce(networkError())
      .mockResolvedValue(panelOverviewFixture);
    await render(createMemoryRuntimeClientStub({ getPanelOverview }));

    expect(container.textContent).toContain("记忆服务暂时无法连接");
    expect(container.textContent).toContain("正在自动重试");
    expect(container.textContent).not.toContain("正在加载记忆概览");

    await advance(MEMORY_PANEL_RETRY_DELAYS_MS[0]);

    expect(getPanelOverview).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("记忆数量");
    expect(container.textContent).not.toContain("记忆服务暂时无法连接");
  });

  it("keeps retrying with backoff until the service is back", async () => {
    const getPanelOverview = vi.fn()
      .mockRejectedValueOnce(networkError())
      .mockRejectedValueOnce(networkError())
      .mockResolvedValue(panelOverviewFixture);
    await render(createMemoryRuntimeClientStub({ getPanelOverview }));

    await advance(MEMORY_PANEL_RETRY_DELAYS_MS[0]);
    expect(getPanelOverview).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("记忆服务暂时无法连接");

    await advance(MEMORY_PANEL_RETRY_DELAYS_MS[1]);
    expect(getPanelOverview).toHaveBeenCalledTimes(3);
    expect(container.textContent).toContain("记忆数量");
  });

  it("stops automatic retries after the schedule and offers manual recovery", async () => {
    const getPanelOverview = vi.fn().mockRejectedValue(networkError());
    await render(createMemoryRuntimeClientStub({ getPanelOverview }));

    for (const delay of MEMORY_PANEL_RETRY_DELAYS_MS) {
      await advance(delay);
    }

    expect(getPanelOverview).toHaveBeenCalledTimes(MEMORY_PANEL_RETRY_DELAYS_MS.length + 1);
    // Exhausted retries must not keep claiming a retry is in progress.
    expect(container.textContent).not.toContain("正在自动重试");
    expect(buttonByText("立即重试")).not.toBeNull();

    const callsBefore = getPanelOverview.mock.calls.length;
    getPanelOverview.mockResolvedValue(panelOverviewFixture);
    await act(async () => { buttonByText("立即重试")!.click(); });

    expect(getPanelOverview.mock.calls.length).toBe(callsBefore + 1);
    expect(container.textContent).toContain("记忆数量");
  });

  it("keeps the cached snapshot instead of replacing it with the error", async () => {
    writeMemoryPanelCache(memoryPanelCacheKey("overview"), panelOverviewFixture);
    const getPanelOverview = vi.fn().mockRejectedValue(networkError());
    await render(createMemoryRuntimeClientStub({ getPanelOverview }));

    expect(container.textContent).toContain("记忆数量");
    expect(container.textContent).toContain("记忆服务暂时无法连接");
    expect(container.textContent).toContain("上次成功读取的数据");
  });

  it("does not retry when the client is missing", async () => {
    await render(null);

    expect(container.textContent).toContain("记忆运行时客户端尚未就绪");
    expect(container.textContent).not.toContain("立即重试");
    expect(container.textContent).not.toContain("正在自动重试");
  });

  it("restarts the memory service from the error notice and reloads", async () => {
    const restartMemoryService = vi.fn(async () => ({ ok: true, baseUrl: "http://127.0.0.1:18960" }));
    Object.defineProperty(window, "memmy", { configurable: true, value: { restartMemoryService } });
    const getPanelOverview = vi.fn()
      .mockRejectedValueOnce(networkError())
      .mockResolvedValue(panelOverviewFixture);
    await render(createMemoryRuntimeClientStub({ getPanelOverview }));

    await act(async () => { buttonByText("重启服务")!.click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    expect(restartMemoryService).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("记忆服务已重新启动");
    expect(container.textContent).toContain("记忆数量");
  });

  it("reports a failed restart without losing the explanation", async () => {
    const restartMemoryService = vi.fn(async () => { throw new Error("Memory is still starting"); });
    Object.defineProperty(window, "memmy", { configurable: true, value: { restartMemoryService } });
    await render(createMemoryRuntimeClientStub({ getPanelOverview: vi.fn().mockRejectedValue(networkError()) }));

    await act(async () => { buttonByText("重启服务")!.click(); });
    await act(async () => { await Promise.resolve(); });

    expect(container.textContent).toContain("记忆服务重启失败");
    expect(container.textContent).toContain("Memory is still starting");
    expect(container.textContent).toContain("记忆服务暂时无法连接");
  });

  function buttonByText(label: string): HTMLButtonElement | null {
    return Array.from(container.querySelectorAll("button"))
      .find((item) => item.textContent?.includes(label)) ?? null;
  }
});

describe("OverviewSubPageView error rendering", () => {
  it("renders the raw memory-layer text only as a diagnostic", () => {
    const html = renderToStringish();
    expect(html).toContain("记忆服务暂时无法连接");
    expect(html).toContain("详细信息：memory layer network error");
    expect(html).toContain("请求 ID：req-503");
  });

  function renderToStringish(): string {
    const element = (
      <I18nProvider language="zh-CN">
        <OverviewSubPageView
          state={{ status: "error", message: "memory layer network error" }}
          onNavigate={vi.fn()}
          errorInfo={classifyMemoryPanelError(networkError())}
          onRetry={vi.fn()}
        />
      </I18nProvider>
    );
    const host = document.createElement("div");
    const viewRoot = createRoot(host);
    act(() => { viewRoot.render(element); });
    const html = host.innerHTML;
    act(() => { viewRoot.unmount(); });
    return html;
  }
});

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value)
  };
}
