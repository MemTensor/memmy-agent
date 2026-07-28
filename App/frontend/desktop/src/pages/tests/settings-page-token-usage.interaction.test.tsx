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

  it("shows Agent-task quota on settings and scene rows in usage details", () => {
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
            totalTokens: 19_000_000,
            usedTokens: 14_500_000,
            remainingTokens: 4_500_000
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
    const byokSummary = {
      inputTokens: 1_950_000,
      outputTokens: 550_000,
      totalTokens: 2_500_000,
      cachedInputTokens: 330_000,
      cacheCreationInputTokens: 0,
      updatedAt: "2026-07-28T08:00:00.000Z",
      byKind: [
        {
          kind: "agent_chat" as const,
          inputTokens: 850_000,
          outputTokens: 250_000,
          totalTokens: 1_100_000,
          cachedInputTokens: 180_000,
          cacheCreationInputTokens: 0
        },
        {
          kind: "memory_summary" as const,
          inputTokens: 420_000,
          outputTokens: 80_000,
          totalTokens: 500_000,
          cachedInputTokens: 60_000,
          cacheCreationInputTokens: 0
        },
        {
          kind: "memory_evolution" as const,
          inputTokens: 500_000,
          outputTokens: 220_000,
          totalTokens: 720_000,
          cachedInputTokens: 90_000,
          cacheCreationInputTokens: 0
        },
        {
          kind: "embedding" as const,
          inputTokens: 180_000,
          outputTokens: 0,
          totalTokens: 180_000,
          cachedInputTokens: 0,
          cacheCreationInputTokens: 0
        }
      ]
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
            byokTokenUsageClient={{
              getSummary: vi.fn(async () => byokSummary)
            } as never}
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

    expect(container.textContent).toContain("Agent 任务额度已用 6.0M Token");
    expect(container.textContent).toContain("共 5.0M Token");

    const detailsButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("查看用量详情"));
    expect(detailsButton).toBeDefined();
    act(() => detailsButton?.click());

    // Wait for BYOK summary load if SettingsPageView fetches on detail open.
    return Promise.resolve().then(async () => {
      await act(async () => {
        await Promise.resolve();
      });

      expect(container.textContent).toContain("平台赠送额度");
      expect(container.textContent).toContain("Agent 任务");
      expect(container.textContent).toContain("6M/5MToken");
      expect(container.textContent).toContain("记忆摘要");
      expect(container.textContent).toContain("14.5M/19MToken");
      expect(container.textContent).toContain("记忆进化");
      expect(container.textContent).toContain("2M/5MToken");
      expect(container.textContent).not.toContain("已用");

      const platformHeading = [...container.querySelectorAll("h2")]
        .find((heading) => heading.textContent === "平台赠送额度");
      // Sum of the three scene rows (6 + 14.5 + 2) / (5 + 19 + 5).
      const platformStats = platformHeading?.parentElement?.querySelector("p");
      expect(platformStats?.className).toContain("sectionNote");
      expect(platformStats?.textContent).toBe("22.5M / 29MToken");
      const platformQuotaList = platformHeading?.parentElement?.nextElementSibling;
      expect(platformQuotaList).toBeInstanceOf(HTMLElement);
      expect(platformQuotaList?.className).toContain("platformQuotaList");
      expect(platformQuotaList?.querySelectorAll("article")).toHaveLength(3);
      expect(platformQuotaList?.textContent).not.toContain("Embedding");

      const byokHeading = [...container.querySelectorAll("h2")]
        .find((heading) => heading.textContent === "自有 API Key 消耗");
      expect(byokHeading).toBeDefined();
    });
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
