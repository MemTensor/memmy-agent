// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasComputerHistoryLaunchEnable } from "../../app/computer-history-launch-intent.js";
import { areOtherPromptsDeferredForHistoryLaunch, readHistoryLaunchPromptState, setHistoryLaunchPromptOpen } from "../../app/history-launch-prompt-state.js";
import {
  clearDeferredGuidanceStep,
  GUIDANCE_PROGRESS_STORAGE_KEY,
  readDeferredGuidanceStep,
  writeDeferredGuidanceStep,
  writeGuidanceCompleted,
} from "../../app/routes.js";
import { appActions } from "../../state/app-actions.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { HistoryLaunchPromptHost } from "../history-launch-prompt-host.js";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  state: {
    startup: { status: "ready" },
    navigation: { currentPath: "/main" },
    bootstrap: { app: { userMode: "account" }, onboarding: { completed: true } },
    account: { userId: "user-1" as string | null },
    modelConfig: { catalog: { modelAssignments: { byok: { agent: { candidates: [] as string[] } } } } },
  },
}));

vi.mock("../../state/app-state.js", () => ({ useAppState: () => ({ state: mocks.state, dispatch: mocks.dispatch }) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

function resetStorage(name: "localStorage" | "sessionStorage"): void {
  const current = window[name];
  if (typeof current?.clear === "function") {
    current.clear();
    return;
  }
  Object.defineProperty(window, name, { configurable: true, value: new MemoryStorage() });
}

describe("History launch prompt", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-07T12:00:00+08:00"));
    resetStorage("localStorage");
    resetStorage("sessionStorage");
    writeGuidanceCompleted(window.localStorage);
    Object.defineProperty(window, "memmy", { configurable: true, value: { platform: "darwin" } });
    mocks.dispatch.mockClear();
    mocks.state.navigation.currentPath = "/main";
    mocks.state.bootstrap.app.userMode = "account";
    mocks.state.bootstrap.onboarding.completed = true;
    mocks.state.account.userId = "user-1";
    mocks.state.modelConfig.catalog.modelAssignments.byok.agent.candidates = [];
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    setHistoryLaunchPromptOpen(false);
    document.body.replaceChildren();
    Reflect.deleteProperty(window, "memmy");
    vi.restoreAllMocks();
  });

  const renderPrompt = async () => act(async () => {
    root.render(<StrictMode><I18nProvider language="zh-CN"><HistoryLaunchPromptHost /></I18nProvider></StrictMode>);
  });

  it("shows the launch notice once to a ready user and keeps dismissal permanent", async () => {
    await renderPrompt();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("电脑历史记录");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("默认关闭");
    await act(async () => document.querySelector<HTMLButtonElement>('.history-launch-close')!.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(readHistoryLaunchPromptState(window.localStorage).dismissed).toBe(true);
    await act(async () => root.unmount());
    root = createRoot(container);
    await renderPrompt();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("hands the action to History without starting collection in the announcement", async () => {
    await renderPrompt();
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "去开启")!.click());
    expect(mocks.dispatch).toHaveBeenCalledWith(appActions.navigate("/memory"));
    expect(window.sessionStorage.getItem("memmy.memorySubPage")).toBe("computer-history");
    expect(hasComputerHistoryLaunchEnable(window.sessionStorage)).toBe(true);
    expect(areOtherPromptsDeferredForHistoryLaunch(window.sessionStorage)).toBe(true);
    expect(readHistoryLaunchPromptState(window.localStorage).actioned).toBe(true);
  });

  it("keeps showing on later releases for BYOK users until the China-time deadline", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-31T23:59:59+08:00"));
    mocks.state.bootstrap.app.userMode = "byok";
    mocks.state.account.userId = null;
    mocks.state.modelConfig.catalog.modelAssignments.byok.agent.candidates = ["local-agent"];
    await renderPrompt();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it("stops at 2026-11-01 00:00 China time", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-01T00:00:00+08:00"));
    await renderPrompt();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  describe.each([
    { name: "macOS", platform: "darwin", osRelease: "25.0.0" },
    { name: "Windows 11", platform: "win32", osRelease: "10.0.26100" },
  ])("first launch on $name", ({ platform, osRelease }) => {
    beforeEach(() => {
      Object.defineProperty(window, "memmy", { configurable: true, value: { platform, osRelease } });
    });

    it("waits for the product tour even when bootstrap already reports onboarding completed", async () => {
      writeDeferredGuidanceStep(window.sessionStorage, "product_tour");
      await renderPrompt();

      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(readHistoryLaunchPromptState(window.localStorage).shown).toBe(false);
    });

    it("offers the notice as soon as guidance finishes without an app rerender or account response", async () => {
      writeDeferredGuidanceStep(window.sessionStorage, "product_tour");
      await renderPrompt();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      mocks.dispatch.mockClear();

      // No root.render(), account update, or restart follows the actual guide completion.
      await act(async () => {
        writeGuidanceCompleted(window.localStorage);
        clearDeferredGuidanceStep(window.sessionStorage);
      });

      expect(document.querySelector('[role="dialog"]')?.textContent).toContain("电脑历史记录");
      expect(mocks.dispatch).not.toHaveBeenCalled();
    });

    it("keeps an unfinished tour pending after restart and offers the notice when it finishes", async () => {
      writeDeferredGuidanceStep(window.sessionStorage, "product_tour");
      await renderPrompt();
      expect(document.querySelector('[role="dialog"]')).toBeNull();

      await act(async () => root.unmount());
      window.sessionStorage.clear();
      root = createRoot(container);
      await renderPrompt();

      expect(readDeferredGuidanceStep(window.sessionStorage)).toBe("product_tour");
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(readHistoryLaunchPromptState(window.localStorage).shown).toBe(false);

      await act(async () => {
        writeGuidanceCompleted(window.localStorage);
        clearDeferredGuidanceStep(window.sessionStorage);
      });
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    });

    it("reacts to guidance completed by another window despite this window's old pending step", async () => {
      writeDeferredGuidanceStep(window.sessionStorage, "product_tour");
      await renderPrompt();
      expect(document.querySelector('[role="dialog"]')).toBeNull();

      await act(async () => {
        window.localStorage.setItem(GUIDANCE_PROGRESS_STORAGE_KEY, "completed");
        window.dispatchEvent(new StorageEvent("storage", {
          key: GUIDANCE_PROGRESS_STORAGE_KEY,
          oldValue: "product_tour",
          newValue: "completed",
          storageArea: window.localStorage,
        }));
      });

      expect(window.sessionStorage.getItem("memmy.deferredGuidanceStep")).toBe("product_tour");
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    });

    it("does not reopen a dismissed notice when guidance later finishes", async () => {
      await renderPrompt();
      await act(async () => document.querySelector<HTMLButtonElement>(".history-launch-close")!.click());
      expect(readHistoryLaunchPromptState(window.localStorage).dismissed).toBe(true);

      await act(async () => root.unmount());
      writeDeferredGuidanceStep(window.sessionStorage, "product_tour");
      root = createRoot(container);
      await renderPrompt();
      await act(async () => {
        writeGuidanceCompleted(window.localStorage);
        clearDeferredGuidanceStep(window.sessionStorage);
      });

      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(readHistoryLaunchPromptState(window.localStorage).dismissed).toBe(true);
    });
  });
});
