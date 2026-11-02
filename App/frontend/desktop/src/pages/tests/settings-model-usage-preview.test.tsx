// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ByokTokenUsageSummarySchema, MemoryTokenBudgetDtoSchema } from "@memmy/local-api-contracts";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { AppStateProvider } from "../../state/app-state.js";
import { createInitialAppState } from "../../state/app-reducer.js";
import { modelUsagePreview } from "../../app/model-usage-preview.js";
import { SettingsPageView } from "../settings-page.js";
import { resolveSettingsTabFromHash } from "../settings-nav.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
const updateSettings = vi.fn();
const getSummary = vi.fn();
const getMemoryBudget = vi.fn();
beforeEach(async () => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/?credits-preview=1#model-usage");
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<I18nProvider language="zh-CN"><AppStateProvider><SettingsPageView
      state={createInitialAppState()} dispatch={vi.fn()} activeTab="model"
      configClient={{ updateSettings, getModelConfig: vi.fn(async () => ({ providers: [] })) } as never}
      byokTokenUsageClient={{ getSummary, getMemoryBudget }}
      update={{ appVersion: "1.0", phase: "idle", preparedUpdatePath: null, downloadProgress: null, feedback: null,
        requestInlineAction: vi.fn(async () => undefined), requestPrimaryAction: vi.fn(async () => undefined) }}
    /></AppStateProvider></I18nProvider>);
  });
});
afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

it("uses consistent mock model and purpose totals without loading the real usage service", () => {
  const { usage, budget } = modelUsagePreview();
  expect(ByokTokenUsageSummarySchema.safeParse(usage).success).toBe(true);
  expect(MemoryTokenBudgetDtoSchema.safeParse(budget).success).toBe(true);
  expect(usage.totalTokens).toBe(7_710_000);
  expect(usage.byKind.reduce((sum, row) => sum + row.totalTokens, 0)).toBe(usage.totalTokens);
  expect(usage.byModel.reduce((sum, row) => sum + row.totalTokens, 0)).toBe(usage.totalTokens);
  expect(budget.lifetimeUsed).toBe(4_560_000);
  expect(getSummary).not.toHaveBeenCalled();
  expect(getMemoryBudget).not.toHaveBeenCalled();
  expect(container.querySelector("#settings-panel-tokens #memory-token-budget")).toBeNull();
  expect(container.querySelector("#settings-panel-tokens")?.textContent).not.toContain("自有 API 模型用量");
});

it("switches tabs with the keyboard and filters BYOK usage by model", () => {
  const usageTab = container.querySelector<HTMLButtonElement>("#model-tab-usage")!;
  act(() => usageTab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
  expect(container.querySelector("#model-panel-usage")?.hasAttribute("hidden")).toBe(true);
  expect(container.querySelector("#model-panel-manage")?.hasAttribute("hidden")).toBe(false);
  act(() => usageTab.click());
  expect(window.location.hash).toBe("#model-usage");
  act(() => container.querySelector<HTMLButtonElement>("#model-panel-usage [role='combobox']")!.click());
  const model = [...document.querySelectorAll<HTMLButtonElement>("[role='option']")]
    .find(option => option.textContent?.includes("gpt-5.6-sol"))!;
  act(() => model.click());
  expect(container.querySelector("#model-panel-usage")?.textContent).toContain("本机累计2.1MToken");
  expect(resolveSettingsTabFromHash("#token-usage-memory-budget")).toBe("model");
});

it("changes only mock limits and preserves them when revisiting the usage tab", () => {
  const daily = container.querySelector<HTMLInputElement>("#memory-token-budget input[type='number']")!;
  act(() => {
    daily.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(daily, "1");
    daily.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => daily.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(updateSettings).not.toHaveBeenCalled();
  expect(modelUsagePreview().budget).toMatchObject({ dailyLimitM: 1, paused: true, trigger: "daily" });
  act(() => container.querySelector<HTMLButtonElement>("#model-tab-manage")!.click());
  act(() => container.querySelector<HTMLButtonElement>("#model-tab-usage")!.click());
  expect(container.querySelector<HTMLInputElement>("#memory-token-budget input[type='number']")?.value).toBe("1");
  expect(container.querySelector("[aria-label='已达到限额，暂停后台记忆处理。提高限额可恢复。']")).not.toBeNull();
});
