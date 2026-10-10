// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { MemoryPage, type MemorySubPageId } from "../memory-page.js";
import { HISTORY_PERMISSION_SETUP_KEY } from "../memory/computer-history-permission-state.js";

const mocks = vi.hoisted(() => ({ historyPage: vi.fn(), dispatch: vi.fn(), track: vi.fn() }));
vi.mock("../../app/providers.js", () => ({ useApiClients: () => ({ clients: null }) }));
vi.mock("../../state/app-state.js", () => ({ useAppState: () => ({ state: null, dispatch: mocks.dispatch }) }));
vi.mock("../../analytics/use-analytics.js", () => ({ useAnalytics: () => ({ track: mocks.track, ready: false }) }));
vi.mock("../memory/overview-sub-page.js", () => ({ OverviewSubPage: () => "Overview content" }));
vi.mock("../memory/computer-history-sub-page.js", () => ({
  // If mounted, the real page starts polling and can resume permission setup.
  ComputerHistorySubPage: () => { mocks.historyPage(); return "History content"; },
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/memory");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete window.memmy;
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});
function platform(value: string | undefined): void {
  Object.defineProperty(window, "memmy", { configurable: true, value: value ? { platform: value } : undefined });
}
function render(initialSubPage?: MemorySubPageId): void {
  act(() => root.render(<I18nProvider language="en-US"><MemoryPage initialSubPage={initialSubPage}/></I18nProvider>));
}

describe("Computer History platform availability", () => {
  it.each(["win32", "linux", undefined])("hides History and refuses an explicit History page on %s", (hostPlatform) => {
    platform(hostPlatform);
    render("computer-history");
    expect(host.textContent).not.toContain("Computer History");
    expect(host.textContent).toContain("Overview content");
    expect(mocks.historyPage).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem("memmy.memorySubPage")).toBe("overview");
  });

  it.each(["saved page", "direct URL", "pending permission setup"])("ignores Windows %s without mounting permission/polling effects", (entry) => {
    platform("win32");
    if (entry === "saved page") window.sessionStorage.setItem("memmy.memorySubPage", "computer-history");
    if (entry === "direct URL") window.history.replaceState(null, "", "/memory?memoryPage=computer-history");
    if (entry === "pending permission setup") window.localStorage.setItem(HISTORY_PERMISSION_SETUP_KEY, "start");
    render();
    expect(host.textContent).not.toContain("Computer History");
    expect(host.textContent).toContain("Overview content");
    expect(mocks.historyPage).not.toHaveBeenCalled();
  });

  it("keeps the macOS entry and mounts History when selected", () => {
    platform("darwin");
    render();
    const entry = [...host.querySelectorAll("button")].find((button) => button.textContent === "Computer History");
    expect(entry).toBeDefined();
    expect(mocks.historyPage).not.toHaveBeenCalled();
    act(() => entry!.click());
    expect(host.textContent).toContain("History content");
    expect(mocks.historyPage).toHaveBeenCalled();
  });

  it("restores macOS pending permission onboarding", () => {
    platform("darwin");
    window.localStorage.setItem(HISTORY_PERMISSION_SETUP_KEY, "resume");
    render();
    expect(host.textContent).toContain("History content");
    expect(mocks.historyPage).toHaveBeenCalled();
  });
});
