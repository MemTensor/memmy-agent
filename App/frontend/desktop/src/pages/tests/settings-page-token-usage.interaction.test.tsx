// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { appActions } from "../../state/app-actions.js";
import { appReducer, createInitialAppState } from "../../state/app-reducer.js";
import { SettingsPageView } from "../settings-page.js";
import { mockBootstrap } from "./fixtures/bootstrap.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("SettingsPage platform scene quota details", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: createMemoryStorage()
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it("shows the aggregate on settings and all three scene totals in usage details", () => {
    const bootstrap = {
      ...mockBootstrap,
      app: {
        ...mockBootstrap.app,
        userMode: "account" as const,
        language: "zh-CN" as const
      },
      tokenUsage: {
        ...mockBootstrap.tokenUsage,
        totalTokens: 30_000_000,
        usedTokens: 23_000_000,
        remainingTokens: 7_000_000,
        sceneUsages: [
          {
            scene: "agent_chat" as const,
            totalTokens: 5_000_000,
            usedTokens: 6_000_000,
            remainingTokens: -1_000_000
          },
          {
            scene: "memory_summary" as const,
            totalTokens: 20_000_000,
            usedTokens: 15_000_000,
            remainingTokens: 5_000_000
          },
          {
            scene: "memory_evolution" as const,
            totalTokens: 5_000_000,
            usedTokens: 2_000_000,
            remainingTokens: 3_000_000
          }
        ]
      }
    };
    const state = appReducer(
      createInitialAppState(),
      appActions.bootstrapLoaded(bootstrap, "/settings")
    );

    act(() => {
      root.render(
        <I18nProvider language="zh-CN">
          <SettingsPageView
            state={state}
            dispatch={vi.fn()}
            update={{
              appVersion: "1.0.4",
              phase: "idle",
              preparedUpdatePath: null,
              downloadProgress: null,
              feedback: null,
              requestPrimaryAction: vi.fn(async () => undefined)
            }}
          />
        </I18nProvider>
      );
    });

    expect(container.textContent).toContain("赠送大模型额度已用 23.0M Token");
    expect(container.textContent).toContain("共 30.0M Token");

    const detailsButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("查看用量详情"));
    expect(detailsButton).toBeDefined();
    act(() => detailsButton?.click());

    expect(container.textContent).toContain("平台场景额度");
    expect(container.textContent).toContain("Agent 任务");
    expect(container.textContent).toContain("已用 6.0M / 共 5.0M Token");
    expect(container.textContent).toContain("剩余 -1.0M Token");
    expect(container.textContent).toContain("记忆摘要");
    expect(container.textContent).toContain("已用 15.0M / 共 20.0M Token");
    expect(container.textContent).toContain("记忆进化");
    expect(container.textContent).toContain("已用 2.0M / 共 5.0M Token");

    const sceneHeading = [...container.querySelectorAll("h2")]
      .find((heading) => heading.textContent === "平台场景额度");
    const sceneGrid = sceneHeading?.parentElement?.nextElementSibling;
    expect(sceneGrid).toBeInstanceOf(HTMLElement);
    expect(sceneGrid?.className).toContain("sceneGrid");
  });
});

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value)
  };
}
