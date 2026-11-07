// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HistoryLaunchPromptHost } from "../history-launch-prompt-host.js";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  state: {
    startup: { status: "ready" },
    navigation: { currentPath: "/main", windowVisible: true },
    bootstrap: { app: { userMode: "account" }, onboarding: { completed: true } },
    account: { userId: "user-1" as string | null },
    modelConfig: { catalog: { modelAssignments: { byok: { agent: { candidates: [] as string[] } } } } },
  },
}));

vi.mock("../../state/app-state.js", () => ({ useAppState: () => ({ state: mocks.state, dispatch: mocks.dispatch }) }));
vi.mock("../../app/use-guidance-progress.js", () => ({ useGuidanceDone: () => true }));
vi.mock("../history-launch-prompt.js", () => ({
  HistoryLaunchPrompt: (props: { onDismiss(): void; onEnable(): void }) => (
    <div role="dialog"><button type="button" onClick={props.onDismiss}>Dismiss history</button><button type="button" onClick={props.onEnable}>Enable history</button></div>
  ),
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("HistoryLaunchPromptHost", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    window.sessionStorage.clear();
    Object.defineProperty(window, "memmy", { configurable: true, value: { platform: "darwin" } });
    mocks.dispatch.mockReset();
    mocks.state.navigation.currentPath = "/main";
    mocks.state.account.userId = "user-1";
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    Reflect.deleteProperty(window, "memmy");
    vi.useRealTimers();
  });

  it("does not open on the initial workspace page", async () => {
    await act(async () => root.render(<HistoryLaunchPromptHost />));
    await act(async () => { vi.advanceTimersByTime(1200); });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("does not open when the app itself starts on Memory", async () => {
    mocks.state.navigation.currentPath = "/memory";
    await act(async () => root.render(<HistoryLaunchPromptHost />));
    await act(async () => { vi.advanceTimersByTime(1200); });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("opens after a deliberate transition into Memory", async () => {
    await act(async () => root.render(<HistoryLaunchPromptHost />));
    mocks.state.navigation.currentPath = "/memory";
    await act(async () => root.render(<HistoryLaunchPromptHost />));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => { vi.advanceTimersByTime(899); });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  });
});
