// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../../../api/http.js";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import { MEMORY_PANEL_RETRY_DELAYS_MS } from "../memory-panel-error.js";
import { AnalyticsSubPage, AnalyticsSubPageView } from "../analytics-sub-page.js";
import { classifyMemoryPanelError } from "../memory-panel-error.js";
import { createMemoryRuntimeClientStub, panelAnalysisFixture } from "./fixtures.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const networkError = () => new ApiRequestError("memory layer network error", 503, "memory_layer_unavailable", "req-503");

describe("AnalyticsSubPage recovery", () => {
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
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function render(client: Parameters<typeof AnalyticsSubPage>[0]["client"]) {
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <AnalyticsSubPage client={client} />
        </I18nProvider>
      );
    });
  }

  it("recovers automatically once the memory service is reachable", async () => {
    const getPanelAnalysis = vi.fn()
      .mockRejectedValueOnce(networkError())
      .mockResolvedValue(panelAnalysisFixture);
    await render(createMemoryRuntimeClientStub({ getPanelAnalysis }));

    expect(container.textContent).toContain("记忆服务暂时无法连接");

    await act(async () => { await vi.advanceTimersByTimeAsync(MEMORY_PANEL_RETRY_DELAYS_MS[0]); });

    expect(getPanelAnalysis).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("平均召回得分");
    expect(container.textContent).not.toContain("记忆服务暂时无法连接");
  });

  it("does not leave the panel stuck showing the raw memory-layer text", async () => {
    const getPanelAnalysis = vi.fn().mockRejectedValue(networkError());
    await render(createMemoryRuntimeClientStub({ getPanelAnalysis }));

    for (const delay of MEMORY_PANEL_RETRY_DELAYS_MS) {
      await act(async () => { await vi.advanceTimersByTimeAsync(delay); });
    }

    expect(container.textContent).not.toContain("正在自动重试");
    const retry = Array.from(container.querySelectorAll("button"))
      .find((item) => item.textContent?.includes("立即重试"));
    expect(retry).toBeDefined();
  });
});

describe("AnalyticsSubPageView error rendering", () => {
  it("renders an actionable headline with the raw text as diagnostics", () => {
    const host = document.createElement("div");
    const viewRoot = createRoot(host);
    act(() => {
      viewRoot.render(
        <I18nProvider language="zh-CN">
          <AnalyticsSubPageView
            state={{ status: "error", message: "memory layer network error" }}
            errorInfo={classifyMemoryPanelError(networkError())}
            onRetry={vi.fn()}
          />
        </I18nProvider>
      );
    });

    expect(host.textContent).toContain("记忆服务暂时无法连接");
    expect(host.textContent).toContain("详细信息：memory layer network error");
    act(() => { viewRoot.unmount(); });
  });
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
