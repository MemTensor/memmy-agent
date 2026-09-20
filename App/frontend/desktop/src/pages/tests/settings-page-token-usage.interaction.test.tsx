// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import type { ByokTokenUsageSummary, MemoryTokenBudgetDto, ModelConfigView, TokenUsageDto } from "@memmy/local-api-contracts";
import { appActions } from "../../state/app-actions.js";
import { appReducer, createInitialAppState } from "../../state/app-reducer.js";
import { commitMemoryByokLimitDraft, memoryBudgetUsageFill, MemoryTokenBudgetRow, SettingsPageView, UsageDetails } from "../settings-page.js";
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

  it("shows all three platform scene totals inline without a detail-page click", () => {
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
    const bootstrapped = appReducer(
      createInitialAppState(),
      appActions.bootstrapLoaded(bootstrap, "/settings")
    );
    const state = appReducer(bootstrapped, appActions.accountUpdated({
      nickname: "测试账户",
      email: "tester@example.com",
      phoneNumber: null,
      registeredAt: "2026-04-12T00:00:00.000Z"
    }));

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
              requestInlineAction: vi.fn(async () => undefined),
              requestPrimaryAction: vi.fn(async () => undefined)
            }}
          />
        </I18nProvider>
      );
    });

    expect(container.textContent).toContain("平台赠送额度");
    expect(container.textContent).toContain("Agent 任务");
    expect(container.textContent).toContain("6M/5MToken");
    expect(container.textContent).toContain("记忆摘要");
    expect(container.textContent).toContain("15M/20MToken");
    expect(container.textContent).toContain("记忆进化");
    expect(container.textContent).toContain("2M/5MToken");
    expect(container.textContent).toContain("申请更多");
    expect(container.textContent).not.toContain("查看用量详情");
    expect(container.textContent).not.toContain("Token 用量详情");
    const applyMoreButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "申请更多");
    expect(applyMoreButton?.className).toContain("bg-status-error rounded-btn");

    const sceneHeading = [...container.querySelectorAll("h2")]
      .find((heading) => heading.textContent === "平台赠送额度");
    const sceneGrid = sceneHeading?.parentElement?.nextElementSibling;
    expect(sceneGrid).toBeInstanceOf(HTMLElement);
    expect(sceneGrid?.className).toContain("platformQuotaList");
  });

  it("filters BYOK totals and purpose rows by model while keeping historical usage in all models", () => {
    const byokUsage: ByokTokenUsageSummary = {
      inputTokens: 38,
      outputTokens: 16,
      totalTokens: 54,
      cachedInputTokens: 8,
      cacheCreationInputTokens: 0,
      updatedAt: "2026-08-11T12:00:00.000Z",
      byKind: [
        byKind("agent_chat", 25, 10, 35, 5),
        byKind("memory_summary", 9, 3, 12, 2),
        byKind("memory_evolution", 4, 3, 7, 1)
      ],
      byProvider: [],
      byModel: [
        byModel("preset-openai", "openai", "shared-model", "agent", 20, 10, 30, 5),
        byModel("preset-openai", "openai", "shared-model", "memory_summary", 9, 3, 12, 2),
        byModel("preset-anthropic", "anthropic", "shared-model", "memory_evolution", 4, 3, 7, 1),
        byModel(null, null, null, null, 5, 0, 5, 0)
      ]
    };

    act(() => {
      root.render(
        <I18nProvider language="zh-CN">
          <UsageDetails
            showPlatform={false}
            platformUsage={emptyPlatformUsage()}
            byokUsage={byokUsage}
            byokUsageStatus="ready"
          />
        </I18nProvider>
      );
    });

    expect(container.textContent).toContain("本机累计54Token");
    expect(container.textContent).toContain("输入38Token输出16Token缓存命中8Token");
    expect([...container.querySelectorAll("div")].some((element) => element.textContent === "按模型")).toBe(false);
    expect(container.textContent).not.toContain("按用途");
    expect(container.querySelector('[data-testid="byok-model-usage-row"]')).toBeNull();

    act(() => {
      container.querySelector<HTMLButtonElement>('[role="combobox"]')?.click();
    });

    const options = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(options.map((option) => option.textContent)).toEqual([
      "全部模型",
      "openai · shared-model",
      "anthropic · shared-model"
    ]);

    act(() => {
      options[1]?.click();
    });

    expect(container.textContent).toContain("本机累计42Token");
    expect(container.textContent).toContain("输入29Token输出13Token缓存命中7Token");
    expect(findUsageRow(container, "Agent 任务").textContent).toContain("30Token");
    expect(findUsageRow(container, "记忆摘要").textContent).toContain("12Token");
    expect(findUsageRow(container, "记忆进化").textContent).toContain("0Token");
    expect(findUsageRow(container, "Embedding").textContent).toContain("0Token");
  });

  it("disambiguates identical provider, model, and API base by preset", () => {
    const byokUsage: ByokTokenUsageSummary = {
      inputTokens: 30,
      outputTokens: 0,
      totalTokens: 30,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      updatedAt: "2026-08-11T12:00:00.000Z",
      byKind: [byKind("agent_chat", 30, 0, 30, 0)],
      byProvider: [],
      byModel: [
        byModel("preset-primary", "openai", "shared-model", "agent", 10, 0, 10, 0),
        byModel("preset-relay", "openai", "shared-model", "agent", 20, 0, 20, 0)
      ]
    };

    act(() => {
      root.render(
        <I18nProvider language="zh-CN">
          <UsageDetails
            showPlatform={false}
            platformUsage={emptyPlatformUsage()}
            byokUsage={byokUsage}
            byokUsageStatus="ready"
            modelCatalog={duplicateModelCatalog()}
          />
        </I18nProvider>
      );
    });

    act(() => {
      container.querySelector<HTMLButtonElement>('[role="combobox"]')?.click();
    });

    const options = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(options.map((option) => option.textContent)).toEqual([
      "全部模型",
      "openai · shared-model · https://api.openai.com/v1 · preset-primary",
      "openai · shared-model · https://api.openai.com/v1 · preset-relay"
    ]);

    act(() => {
      options[2]?.click();
    });

    expect(container.querySelector('[role="combobox"]')?.textContent)
      .toContain("shared-model · https://api.openai.com/v1 · preset-relay");
    expect(container.textContent).toContain("本机累计20Token");
  });

  it("places the BYOK updated time beside the outer Token usage heading", async () => {
    const byokUsage: ByokTokenUsageSummary = {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      updatedAt: "2026-08-11T12:00:00.000Z",
      byKind: [],
      byProvider: [],
      byModel: []
    };

    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <SettingsPageView
            state={createInitialAppState()}
            dispatch={vi.fn()}
            activeTab="tokens"
            byokTokenUsageClient={{
              getSummary: vi.fn(async () => byokUsage),
              getMemoryBudget: vi.fn(async () => memoryBudgetFixture())
            }}
            update={{
              appVersion: "1.0.4",
              phase: "idle",
              preparedUpdatePath: null,
              downloadProgress: null,
              feedback: null,
              requestInlineAction: vi.fn(async () => undefined),
              requestPrimaryAction: vi.fn(async () => undefined)
            }}
          />
        </I18nProvider>
      );
      await Promise.resolve();
    });

    const tokenUsageHeading = [...container.querySelectorAll("#token-usage h2")]
      .find((heading) => heading.textContent === "Token 用量");
    const tokenUsageHeader = tokenUsageHeading?.parentElement?.parentElement;
    expect(tokenUsageHeader?.textContent).toContain("更新于");
    expect(tokenUsageHeader?.className).toContain("justify-between");
  });

  it("refreshes BYOK usage when entering the Token tab and when the focused Token tab regains focus", async () => {
    const getSummary = vi.fn(async () => ({
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      updatedAt: "2026-08-31T02:00:00.000Z",
      byKind: [],
      byProvider: [],
      byModel: []
    } satisfies ByokTokenUsageSummary));
    const byokTokenUsageClient = { getSummary, getMemoryBudget: vi.fn(async () => memoryBudgetFixture()) };
    const update = {
      appVersion: "1.0.4",
      phase: "idle" as const,
      preparedUpdatePath: null,
      downloadProgress: null,
      feedback: null,
      requestInlineAction: vi.fn(async () => undefined),
      requestPrimaryAction: vi.fn(async () => undefined)
    };
    const renderTab = async (activeTab: "account" | "tokens") => {
      await act(async () => {
        root.render(
          <I18nProvider language="zh-CN">
            <SettingsPageView
              state={createInitialAppState()}
              dispatch={vi.fn()}
              activeTab={activeTab}
              byokTokenUsageClient={byokTokenUsageClient}
              update={update}
            />
          </I18nProvider>
        );
        await Promise.resolve();
      });
    };

    await renderTab("account");
    expect(getSummary).not.toHaveBeenCalled();

    await renderTab("tokens");
    expect(getSummary).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(getSummary).toHaveBeenCalledTimes(2);

    await renderTab("account");
    window.dispatchEvent(new Event("focus"));
    expect(getSummary).toHaveBeenCalledTimes(2);
  });
});

function byModel(
  presetId: string | null,
  provider: string | null,
  model: string | null,
  capability: ByokTokenUsageSummary["byModel"][number]["capability"],
  inputTokens: number,
  outputTokens: number,
  totalTokens: number,
  cachedInputTokens: number
): ByokTokenUsageSummary["byModel"][number] {
  return {
    presetId,
    provider,
    model,
    capability,
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens,
    cacheCreationInputTokens: 0,
    eventCount: 1,
    updatedAt: "2026-08-11T12:00:00.000Z"
  };
}

function byKind(
  kind: ByokTokenUsageSummary["byKind"][number]["kind"],
  inputTokens: number,
  outputTokens: number,
  totalTokens: number,
  cachedInputTokens: number
): ByokTokenUsageSummary["byKind"][number] {
  return {
    kind,
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens,
    cacheCreationInputTokens: 0,
    eventCount: 1,
    updatedAt: "2026-08-11T12:00:00.000Z"
  };
}

function findUsageRow(container: HTMLElement, label: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>("article")]
    .find((candidate) => candidate.querySelector("h3")?.textContent === label);
  expect(row).not.toBeUndefined();
  return row!;
}

function duplicateModelCatalog(): ModelConfigView {
  return {
    providers: [{
      provider: "openai",
      endpoints: [
        { endpointId: "endpoint-primary", apiBase: "https://api.openai.com/v1" },
        { endpointId: "endpoint-relay", apiBase: "https://api.openai.com/v1" }
      ],
      models: [
        { presetId: "preset-primary", endpointId: "endpoint-primary" },
        { presetId: "preset-relay", endpointId: "endpoint-relay" }
      ]
    }]
  } as ModelConfigView;
}

describe("memory token budget limit inputs", () => {
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

  it("treats empty drafts as revert and only an explicit 0 as unlimited", () => {
    expect(commitMemoryByokLimitDraft("", 10)).toEqual({ draft: "10" });
    expect(commitMemoryByokLimitDraft("   ", 10)).toEqual({ draft: "10" });
    expect(commitMemoryByokLimitDraft("-1", 10)).toEqual({ draft: "10" });
    expect(commitMemoryByokLimitDraft("1.5", 10)).toEqual({ draft: "10" });
    expect(commitMemoryByokLimitDraft("100000", 10)).toEqual({ draft: "10" });
    expect(commitMemoryByokLimitDraft("0", 10)).toEqual({ draft: "0", value: 0 });
    expect(commitMemoryByokLimitDraft("12", 10)).toEqual({ draft: "12", value: 12 });
  });

  it("colors the usage fill green, yellow, then red by percent", () => {
    expect(memoryBudgetUsageFill(0, 10)).toEqual({ percent: 0, tone: "green" });
    expect(memoryBudgetUsageFill(6_000_000, 10)).toEqual({ percent: 60, tone: "green" });
    expect(memoryBudgetUsageFill(6_100_000, 10)).toEqual({ percent: 61, tone: "yellow" });
    expect(memoryBudgetUsageFill(8_000_000, 10)).toEqual({ percent: 80, tone: "yellow" });
    expect(memoryBudgetUsageFill(8_100_000, 10)).toEqual({ percent: 81, tone: "red" });
    expect(memoryBudgetUsageFill(12_000_000, 10)).toEqual({ percent: 100, tone: "red" });
    expect(memoryBudgetUsageFill(1_000_000, 0)).toBeNull();
  });

  it("does not persist an emptied input and does persist an explicit 0", async () => {
    const onCommit = vi.fn();
    function Harness() {
      const [draft, setDraft] = useState("10");
      return (
        <I18nProvider language="zh-CN">
          <MemoryTokenBudgetRow
            label="每日限额"
            note="已用"
            draft={draft}
            savedValue={10}
            onDraftChange={setDraft}
            onCommit={onCommit}
          />
        </I18nProvider>
      );
    }

    await act(async () => {
      root.render(<Harness />);
    });

    const input = container.querySelector<HTMLInputElement>('input[type="number"]');
    expect(input).toBeTruthy();

    typeAndBlur("");
    expect(onCommit).not.toHaveBeenCalled();

    typeAndBlur("-1");
    expect(onCommit).not.toHaveBeenCalled();

    typeAndBlur("1.5");
    expect(onCommit).not.toHaveBeenCalled();

    typeAndBlur("100000");
    expect(onCommit).not.toHaveBeenCalled();

    typeAndBlur("0");
    expect(onCommit).toHaveBeenCalledWith(0);

    typeAndBlur("12");
    expect(onCommit).toHaveBeenCalledWith(12);

    onCommit.mockClear();
    act(() => {
      input!.focus();
      setReactInputValue(input!, "20");
      input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(20);

    act(() => {
      input!.focus();
      input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(onCommit).toHaveBeenNthCalledWith(2, 20);
  });

  it("shows a save error and still retries the same limit", async () => {
    const updateSettings = vi.fn(async () => {
      throw new Error("disk full");
    });
    const getSummary = vi.fn(async () => ({
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      updatedAt: "2026-09-18T02:00:00.000Z",
      byKind: [],
      byProvider: [],
      byModel: []
    } satisfies ByokTokenUsageSummary));
    const getMemoryBudget = vi.fn(async () => memoryBudgetFixture());

    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <SettingsPageView
            state={createInitialAppState()}
            dispatch={vi.fn()}
            activeTab="tokens"
            configClient={{
              updateSettings,
              getModelConfig: vi.fn(async () => ({ providers: [] }))
            } as never}
            byokTokenUsageClient={{ getSummary, getMemoryBudget }}
            update={{
              appVersion: "1.0.4",
              phase: "idle",
              preparedUpdatePath: null,
              downloadProgress: null,
              feedback: null,
              requestInlineAction: vi.fn(async () => undefined),
              requestPrimaryAction: vi.fn(async () => undefined)
            }}
          />
        </I18nProvider>
      );
      await Promise.resolve();
    });

    const dailyInput = container.querySelectorAll<HTMLInputElement>('input[type="number"]')[0];
    expect(dailyInput).toBeTruthy();
    act(() => {
      dailyInput!.focus();
      setReactInputValue(dailyInput!, "20");
      dailyInput!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("disk full");

    act(() => {
      dailyInput!.focus();
      dailyInput!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(updateSettings).toHaveBeenCalledTimes(2);
    expect(updateSettings).toHaveBeenNthCalledWith(2, { memoryByokDailyLimitM: 20 });
  });

  it("refreshes the open Token tab budget without wiping an in-progress draft", async () => {
    const getSummary = vi.fn(async () => ({
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      updatedAt: "2026-09-18T02:00:00.000Z",
      byKind: [],
      byProvider: [],
      byModel: []
    } satisfies ByokTokenUsageSummary));
    const getMemoryBudget = vi.fn(async () => ({
      ...memoryBudgetFixture(),
      dailyUsed: 1_000_000,
      lifetimeUsed: 1_000_000
    }));

    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <SettingsPageView
            state={createInitialAppState()}
            dispatch={vi.fn()}
            activeTab="tokens"
            byokTokenUsageClient={{ getSummary, getMemoryBudget }}
            update={{
              appVersion: "1.0.4",
              phase: "idle",
              preparedUpdatePath: null,
              downloadProgress: null,
              feedback: null,
              requestInlineAction: vi.fn(async () => undefined),
              requestPrimaryAction: vi.fn(async () => undefined)
            }}
          />
        </I18nProvider>
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain("今日已用 1.0M");
    const dailyInput = container.querySelectorAll<HTMLInputElement>('input[type="number"]')[0];
    expect(dailyInput).toBeTruthy();
    act(() => {
      setReactInputValue(dailyInput!, "12");
    });

    act(() => {
      window.dispatchEvent(new CustomEvent("memmy:memory-token-budget-updated", {
        detail: {
          ...memoryBudgetFixture(),
          dailyUsed: 10_000_000,
          lifetimeUsed: 10_000_000,
          paused: true,
          trigger: "daily"
        }
      }));
    });

    expect(container.textContent).toContain("今日已用 10.0M");
    expect(dailyInput!.value).toBe("12");
  });

  it("renders a usage bar under the limit note and hides it when unlimited", async () => {
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <MemoryTokenBudgetRow
            label="总计限额"
            note="累计已用 8.1M / 限额 10M"
            draft="10"
            savedValue={10}
            usedTokens={8_100_000}
            limitM={10}
            onDraftChange={() => undefined}
            onCommit={() => undefined}
          />
        </I18nProvider>
      );
    });

    const bar = container.querySelector<HTMLElement>('[role="progressbar"]');
    expect(bar?.getAttribute("data-tone")).toBe("red");
    expect(bar?.getAttribute("aria-valuenow")).toBe("81");
    expect(bar?.querySelector("span")?.getAttribute("style")).toContain("width: 81%");

    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <MemoryTokenBudgetRow
            label="总计限额"
            note="不限制"
            draft="0"
            savedValue={0}
            usedTokens={8_100_000}
            limitM={0}
            onDraftChange={() => undefined}
            onCommit={() => undefined}
          />
        </I18nProvider>
      );
    });
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
  });
});

function setReactInputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function typeAndBlur(value: string): void {
  const input = document.querySelector<HTMLInputElement>('input[type="number"]');
  expect(input).toBeTruthy();
  act(() => {
    setReactInputValue(input!, value);
  });
  act(() => {
    input!.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

function memoryBudgetFixture(): MemoryTokenBudgetDto {
  return {
    dailyLimitM: 10,
    totalLimitM: 500,
    dailyUsed: 0,
    lifetimeUsed: 0,
    paused: false,
    trigger: null,
    nextLocalMidnightAt: "2026-09-19T16:00:00.000Z"
  };
}

function emptyPlatformUsage(): TokenUsageDto {
  return {
    planName: "free",
    totalTokens: 1,
    usedTokens: 1,
    remainingTokens: 0,
    expiresAt: null,
    lastSyncedAt: null,
    sceneUsages: [{
      scene: "agent_chat",
      totalTokens: 1,
      usedTokens: 1,
      remainingTokens: 0
    }]
  };
}

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
