// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { appActions } from "../../state/app-actions.js";
import { MemoryPage } from "../memory-page.js";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  track: vi.fn()
}));

vi.mock("../../app/providers.js", () => ({
  useApiClients: () => ({ clients: null, setClients: vi.fn() })
}));

vi.mock("../../state/app-state.js", () => ({
  useAppState: () => ({ state: null, dispatch: mocks.dispatch })
}));

vi.mock("../../analytics/use-analytics.js", () => ({
  useAnalytics: () => ({ track: mocks.track, ready: false })
}));

vi.mock("../memory/memories-sub-page.js", async () => {
  const { createElement } = await import("react");

  return {
    MemoriesSubPage: (props: { onOpenSettings?: () => void }) => createElement(
      "button",
      { type: "button", onClick: props.onOpenSettings },
      "Check model settings"
    )
  };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("MemoryPage model settings navigation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: new MapStorage()
    });
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      value: new MapStorage()
    });
    window.history.replaceState({ keep: true }, "", "/memory#about");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    window.history.replaceState(null, "", "/");
  });

  it("opens the model configuration tab instead of reusing a stale settings hash", () => {
    act(() => {
      root.render(
        <I18nProvider language="zh-CN">
          <MemoryPage initialSubPage="memories" />
        </I18nProvider>
      );
    });

    const button = [...container.querySelectorAll("button")]
      .find((candidate) => candidate.textContent === "Check model settings");
    expect(button).toBeDefined();

    act(() => button?.click());

    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(mocks.dispatch).toHaveBeenCalledWith(appActions.navigate("/settings"));
    expect(window.location.hash).toBe("#model-config");
    expect(window.history.state).toEqual({ keep: true });
  });
});

class MapStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}
