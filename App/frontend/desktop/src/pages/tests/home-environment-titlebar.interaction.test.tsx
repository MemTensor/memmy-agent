// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "postcss";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRuntimeBridge } from "../../app/agent-runtime-bridge.js";
import { AppProviders } from "../../app/providers.js";
import { UpdateCoordinatorProvider } from "../../app/update-coordinator.js";
import { agentActions } from "../../state/app-actions.js";
import { useAppState } from "../../state/app-state.js";
import { rememberPublishedMemoryBudget } from "../../components/memory-token-budget-banner.js";
import { applyWindowFullScreenClass, applyWindowPlatformClass } from "../../utils/window-fullscreen.js";
import { THREAD_PANEL_FULLSCREEN_BODY_CLASS } from "../agent-thread-panel.js";
import { HomePage } from "../home-page.js";
import { MemoryPageView } from "../memory-page.js";
import { ComputerHistorySubPage } from "../memory/computer-history-sub-page.js";
import { SettingsPage } from "../settings-page.js";
import { ToolsPage } from "../tools-page.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tokens = readFileSync(resolve(process.cwd(), "src/theme/tokens.css"), "utf8");
const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8")
  .replace(/^@import[^;]*;\s*/gm, "");
const toolsPageSource = readFileSync(resolve(process.cwd(), "src/pages/tools-page.tsx"), "utf8");
// happy-dom does not apply cascade layers. Preserve the actual generated
// utilities and their import order while exposing their rules to its CSS engine.
const utilities = parse(readFileSync(resolve(process.cwd(), "src/prototype-utilities.css"), "utf8"));
utilities.walkAtRules("import", (rule) => rule.remove());
utilities.walkAtRules("layer", (rule) => {
  if (rule.nodes) rule.replaceWith(rule.nodes);
  else rule.remove();
});
// The fixture uses the app's default horizontal writing mode. happy-dom also
// omits the logical-to-physical padding mapping performed by the browser.
utilities.walkDecls("padding-block", (declaration) => {
  declaration.cloneBefore({ prop: "padding-top" });
  declaration.cloneBefore({ prop: "padding-bottom" });
  declaration.remove();
});
const initialWindowSize = { width: window.innerWidth, height: window.innerHeight };

describe("Windows chrome spacing and the HomePage thread side panel", () => {
  let container: HTMLDivElement;
  let root: Root;
  let stylesheet: HTMLStyleElement;

  beforeEach(() => {
    vi.useFakeTimers();
    rememberPublishedMemoryBudget(null);
    Reflect.deleteProperty(window, "memmy");
    Object.defineProperty(window, "localStorage", { configurable: true, value: createMemoryStorage() });
    Object.defineProperty(window, "sessionStorage", { configurable: true, value: createMemoryStorage() });
    stylesheet = document.createElement("style");
    stylesheet.textContent = `${utilities.toString()}\n${tokens}\n${styles}`;
    document.head.append(stylesheet);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    stylesheet.remove();
    document.body.replaceChildren();
    applyWindowPlatformClass(null);
    applyWindowFullScreenClass(false);
    rememberPublishedMemoryBudget(null);
    Reflect.deleteProperty(window, "memmy");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: initialWindowSize.width });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: initialWindowSize.height });
  });

  it.each([
    { name: "Windows", platform: "win32", fullscreen: false },
    { name: "Mac", platform: "darwin", fullscreen: false },
    { name: "Windows fullscreen", platform: "win32", fullscreen: true }
  ])("keeps $name side panel controls reachable while the sidebar is toggled", ({ platform, fullscreen }) => {
    applyWindowPlatformClass(platform);
    applyWindowFullScreenClass(fullscreen);
    act(() => {
      root.render(
        <AppProviders>
          <AgentRuntimeBridge>
            <CompletedConversationSeeder />
            <HomePage />
          </AgentRuntimeBridge>
        </AppProviders>
      );
    });
    const assertReachable = (button: HTMLButtonElement | null, insidePassThroughTopbar = false) => {
      expect(button).not.toBeNull();
      expect(button!.disabled).toBe(false);
      const pointerEvents = window.getComputedStyle(button!).pointerEvents;
      if (insidePassThroughTopbar) expect(pointerEvents).toBe("auto");
      else expect(pointerEvents).not.toBe("none");
      expect(window.getComputedStyle(button!).getPropertyValue("-webkit-app-region")).toBe("no-drag");
      return button!;
    };
    const assertToolbarSpacing = () => {
      const toolbar = container.querySelector<HTMLElement>(".app-frame-content-topbar");
      expect(toolbar).not.toBeNull();
      expect(window.getComputedStyle(toolbar!).minHeight).toBe("46px");
      expect(toolbar!.style.top).toBe("");
      expect(window.getComputedStyle(toolbar!).top).toBe("0px");
      const conversation = container.querySelector<HTMLElement>(".agent-conversation-panel");
      expect(conversation).not.toBeNull();
      expect(window.getComputedStyle(conversation!).paddingTop).toBe("calc(46px + 0px)");
      if (platform === "win32") {
        expect(container.querySelector(".windows-titlebar")?.nextElementSibling?.className).toBe("sidebar-shell__body");
        expect(window.getComputedStyle(container.querySelector<HTMLElement>(".app-frame-main")!).getPropertyValue("--app-frame-topbar-offset")).toBe("0px");
      }
      expect(container.querySelector("[data-agent-environment-toggle]")).toBeNull();
    };
    const openPanelButton = () => container.querySelector<HTMLButtonElement>('.thread-toolbar__button[aria-label="展开右栏"]');
    const collapsePanelButton = () => container.querySelector<HTMLButtonElement>('.thread-panel__icon-button[aria-label="收起右栏"]');

    assertToolbarSpacing();
    expect(container.querySelector(".thread-panel")).toBeNull();
    act(() => assertReachable(openPanelButton(), true).click());
    expect(container.querySelector(".thread-panel")).not.toBeNull();
    expect(window.getComputedStyle(container.querySelector<HTMLElement>(".thread-panel")!).top).toBe("0px");
    expect(openPanelButton()).toBeNull();

    const hideSidebarButton = container.querySelector<HTMLButtonElement>(".sidebar-toolbar-button");
    expect(hideSidebarButton).not.toBeNull();
    act(() => hideSidebarButton!.click());
    expect(container.querySelector(".app-frame-sidebar")?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".thread-panel")).not.toBeNull();
    assertToolbarSpacing();
    assertReachable(collapsePanelButton());

    const showSidebarButton = container.querySelector<HTMLButtonElement>(
      platform === "win32" ? ".windows-titlebar__sidebar" : ".sidebar-restore-button"
    );
    expect(showSidebarButton).not.toBeNull();
    if (platform === "win32") {
      expect(showSidebarButton!.getAttribute("aria-label")).toBe("显示侧边栏");
    }
    act(() => showSidebarButton!.click());
    expect(container.querySelector(".app-frame-sidebar")?.getAttribute("aria-hidden")).toBeNull();
    expect(container.querySelector(".sidebar-restore-button")).toBeNull();
    expect(container.querySelector(".thread-panel")).not.toBeNull();

    act(() => assertReachable(collapsePanelButton()).click());
    expect(container.querySelector(".thread-panel--closing")).not.toBeNull();
    expect(openPanelButton()).not.toBeNull();
    act(() => vi.advanceTimersByTime(150));
    expect(container.querySelector(".thread-panel")?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector<HTMLElement>(".thread-panel")?.style.display).toBe("none");
    assertToolbarSpacing();
  });

  it("keeps the project name out of the empty new-task title bar", () => {
    act(() => {
      root.render(
        <AppProviders>
          <AgentRuntimeBridge>
            <ProjectDraftSeeder />
            <HomePage />
          </AgentRuntimeBridge>
        </AppProviders>
      );
    });

    expect(container.querySelector(".app-frame-project-title")?.textContent).toBe("报告");
    expect(container.querySelector(".home-empty-screen")).not.toBeNull();
    expect(container.querySelector(".app-frame-content-topbar .agent-conversation-title")).toBeNull();
  });

  it.each([
    { name: "Windows", platform: "win32", fullscreen: false },
    { name: "Mac", platform: "darwin", fullscreen: false },
    { name: "Windows fullscreen", platform: "win32", fullscreen: true }
  ])("keeps $name empty-home spacing while the sidebar is toggled", ({ platform, fullscreen }) => {
    applyWindowPlatformClass(platform);
    applyWindowFullScreenClass(fullscreen);
    act(() => root.render(
      <AppProviders>
        <AgentRuntimeBridge>
          <HomePage />
        </AgentRuntimeBridge>
      </AppProviders>
    ));

    const toolbar = container.querySelector<HTMLElement>(".app-frame-content-topbar")!;
    expect(window.getComputedStyle(toolbar).top).toBe("0px");
    expect(container.querySelectorAll(".windows-titlebar")).toHaveLength(platform === "win32" ? 1 : 0);
    const toggle = container.querySelector<HTMLButtonElement>(".sidebar-toolbar-button")!;
    act(() => toggle.click());
    expect(container.querySelector(".app-frame-sidebar")?.getAttribute("aria-hidden")).toBe("true");
    expect(window.getComputedStyle(toolbar).top).toBe("0px");
    expect(container.querySelector(".home-empty-screen")?.closest(".app-frame-content-body--sidebar-hidden")).not.toBeNull();
  });

  it.each([
    { name: "Windows", platform: "win32", fullscreen: false },
    { name: "Mac", platform: "darwin", fullscreen: false },
    { name: "Windows fullscreen", platform: "win32", fullscreen: true }
  ])("keeps $name memory-header spacing while the sidebar is toggled", ({ platform, fullscreen }) => {
    applyWindowPlatformClass(platform);
    applyWindowFullScreenClass(fullscreen);
    rememberPublishedMemoryBudget({
      dailyLimitM: 10,
      totalLimitM: 500,
      dailyUsed: 0,
      lifetimeUsed: 0,
      paused: true,
      trigger: "daily",
      nextLocalMidnightAt: "2026-10-10T16:00:00.000Z"
    });
    act(() => root.render(
      <AppProviders>
        <MemoryPageView activePage="overview" onActivePageChange={() => undefined} childByPage={{
          overview: <section className="memory-panel"><header className="memory-panel__header">概览</header></section>,
          "computer-history": null,
          memories: null,
          "user-memories": null,
          tasks: null,
          policies: null,
          "world-model": null,
          skills: null,
          analytics: null,
          logs: null,
          sources: null
        }} />
      </AppProviders>
    ));

    const header = container.querySelector<HTMLElement>(".memory-panel__header")!;
    const toolbar = container.querySelector<HTMLElement>(".app-frame-content-topbar")!;
    const capsule = container.querySelector<HTMLElement>(".memory-token-budget-capsule")!;
    expect(capsule).not.toBeNull();
    expect(capsule.closest(".app-frame-content-topbar")).toBe(toolbar);
    if (platform === "win32") {
      let positioningAncestor = toolbar.parentElement;
      while (positioningAncestor && !["relative", "absolute", "fixed", "sticky"].includes(window.getComputedStyle(positioningAncestor).position)) {
        positioningAncestor = positioningAncestor.parentElement;
      }
      expect(positioningAncestor).toBe(container.querySelector(".memory-page-main"));
      expect(positioningAncestor!.closest(".sidebar-shell__body")?.previousElementSibling?.className).toBe("windows-titlebar");
    }
    expect(parseFloat(window.getComputedStyle(header).paddingTop || "0")).toBe(0);
    expect(container.querySelectorAll(".windows-titlebar")).toHaveLength(platform === "win32" ? 1 : 0);
    act(() => container.querySelector<HTMLButtonElement>(".sidebar-toolbar-button")!.click());
    expect(container.querySelector(".memory-page-sidebar")?.getAttribute("aria-hidden")).toBe("true");
    expect(parseFloat(window.getComputedStyle(header).paddingTop || "0")).toBe(0);
    expect(header.closest(".memory-page-main--sidebar-hidden")).not.toBeNull();
  });

  it.each(
    ["win32", "darwin"].flatMap((platform) =>
      [1280, 640].flatMap((width) =>
        [false, true].flatMap((paused) =>
          ["computer-history", "settings", "tools"].map((page) => ({ platform, width, paused, page }))
        )
      )
    )
  )("keeps actual $page menu spacing on $platform at $width px, paused=$paused", async ({ platform, width, paused, page }) => {
    applyWindowPlatformClass(platform);
    window.memmy = { platform, osRelease: "10.0.22631", getLogLevel: vi.fn().mockResolvedValue("info") } as unknown as Window["memmy"];
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 1000 });
    if (paused) publishPausedBudget();
    await act(async () => root.render(
      <AppProviders>
        {page === "computer-history" ? (
          <MemoryPageView activePage="computer-history" onActivePageChange={() => undefined} childByPage={{
            overview: null,
            "computer-history": <ComputerHistorySubPage client={null} />,
            memories: null,
            "user-memories": null,
            tasks: null,
            policies: null,
            "world-model": null,
            skills: null,
            analytics: null,
            logs: null,
            sources: null
          }} />
        ) : page === "settings" ? <UpdateCoordinatorProvider><SettingsPage /></UpdateCoordinatorProvider> : <ToolsPage />}
      </AppProviders>
    ));

    const pageContent = container.querySelector<HTMLElement>(".app-frame-page-content")!;
    const toolbar = container.querySelector<HTMLElement>(".app-frame-content-topbar")!;
    expect(pageContent).not.toBeNull();
    expect(window.getComputedStyle(toolbar).top).toBe("0px");
    expect(container.querySelector(".memory-token-budget-capsule") != null).toBe(paused);
    if (page === "computer-history") {
      expect(container.querySelector(".ch .memory-panel__title")?.textContent).toBe("电脑历史记录");
      // Its viewport-dependent clamp is unsupported by happy-dom, so also
      // verify that only the Windows shell explicitly removes that real rule.
      expect(styles).toMatch(/\.sidebar-shell--windows-titlebar \.ch\s*\{\s*padding-top:\s*0;\s*\}/);
      expect(styles).toMatch(/(?:^|\n)\.ch\s*\{[^}]*padding-top:\s*clamp\(28px, 5vh, 76px\);/);
      if (platform === "win32") expect(readTopPadding(container.querySelector<HTMLElement>(".ch")!)).toBe(0);
    }

    const assertMenuSpacing = (sidebarHidden: boolean) => {
      const expected = platform === "win32"
        ? paused ? 56 : 24
        : page === "settings" ? 56 : sidebarHidden ? 46 : 24;
      if (platform === "darwin" && page === "tools") {
        // Happy DOM discards variable-based calc styles. Check the rendered
        // page and its explicit lifted-tab inset instead of a false 0px.
        expect(pageContent.classList.contains("tools-page-content")).toBe(true);
        expect(toolsPageSource).toContain("topBarInsetOffsetPx={-8}");
      } else {
        expect(readTopPadding(pageContent)).toBe(expected);
      }
      if (platform === "win32" && paused) {
        // Reserve the entire 46px content toolbar plus 10px before real menu
        // content, including when a narrow capsule title wraps to two lines.
        expect(readTopPadding(pageContent)).toBeGreaterThan(parseFloat(window.getComputedStyle(toolbar).minHeight));
      }
    };
    assertMenuSpacing(false);
    act(() => container.querySelector<HTMLButtonElement>(".sidebar-toolbar-button")!.click());
    const sidebar = container.querySelector(page === "computer-history" ? ".memory-page-sidebar" : ".app-frame-sidebar")!;
    expect(sidebar.getAttribute("aria-hidden")).toBe("true");
    assertMenuSpacing(true);
    act(() => container.querySelector<HTMLButtonElement>(platform === "win32" ? ".windows-titlebar__sidebar" : ".sidebar-restore-button")!.click());
    expect(sidebar.getAttribute("aria-hidden")).toBeNull();
    assertMenuSpacing(false);
  });

  it.each([
    { name: "Mac", platform: "darwin" },
    { name: "Windows", platform: "win32" }
  ])("keeps $name browser settings and the exit button usable in panel fullscreen", ({ platform }) => {
    applyWindowPlatformClass(platform);
    act(() => {
      root.render(
        <AppProviders>
          <AgentRuntimeBridge>
            <CompletedConversationSeeder />
            <HomePage />
          </AgentRuntimeBridge>
        </AppProviders>
      );
    });
    const clickButton = (selector: string) => {
      const button = container.querySelector<HTMLButtonElement>(selector);
      expect(button).not.toBeNull();
      expect(button!.disabled).toBe(false);
      act(() => button!.click());
    };
    const chatTopbar = container.querySelector<HTMLElement>(".app-frame-content-topbar.thread-topbar")!;
    expect(window.getComputedStyle(chatTopbar).display).not.toBe("none");
    clickButton('.thread-toolbar__button[aria-label="展开右栏"]');
    clickButton('.thread-panel__icon-button[aria-label="浏览器"]');
    const webview = container.querySelector("webview");
    expect(webview).not.toBeNull();
    clickButton('.memmy-browser-toolbar button[aria-label="浏览器设置"]');
    const browserSettings = container.querySelector(".memmy-browser-settings");
    expect(browserSettings).not.toBeNull();

    clickButton('.thread-panel__icon-button[aria-label="进入全屏"]');
    expect(container.querySelector(".thread-panel--fullscreen")).not.toBeNull();
    expect(window.getComputedStyle(container.querySelector<HTMLElement>(".thread-panel--fullscreen")!).top).toBe(
      platform === "win32" ? "46px" : "0px"
    );
    expect(document.body.classList.contains(THREAD_PANEL_FULLSCREEN_BODY_CLASS)).toBe(true);
    expect(window.getComputedStyle(chatTopbar).display).toBe("none");
    const exitButton = container.querySelector<HTMLButtonElement>('.thread-panel__icon-button[aria-label="退出全屏"]')!;
    expect(window.getComputedStyle(exitButton).getPropertyValue("-webkit-app-region")).toBe("no-drag");
    clickButton('.thread-panel__icon-button[aria-label="退出全屏"]');

    expect(container.querySelector(".thread-panel--fullscreen")).toBeNull();
    // happy-dom retains cached ancestor selector matches after body class removal.
    // The fullscreen class is the sole condition that hides this mounted toolbar.
    expect(document.body.classList.contains(THREAD_PANEL_FULLSCREEN_BODY_CLASS)).toBe(false);
    expect(container.querySelector(".app-frame-content-topbar.thread-topbar")).toBe(chatTopbar);
    expect(container.querySelector(".memmy-browser-settings")).toBe(browserSettings);
    expect(container.querySelector("webview")).toBe(webview);
  });
});

function publishPausedBudget() {
  rememberPublishedMemoryBudget({
    dailyLimitM: 10,
    totalLimitM: 500,
    dailyUsed: 0,
    lifetimeUsed: 0,
    paused: true,
    trigger: "daily",
    nextLocalMidnightAt: "2026-10-10T16:00:00.000Z"
  });
}

function readTopPadding(element: HTMLElement): number {
  const value = window.getComputedStyle(element).paddingTop || "0px";
  const pixels = value.match(/^([\d.]+)px$/);
  if (pixels) return Number(pixels[1]);
  const sum = value.match(/^calc\(([\d.]+)px\s*\+\s*([\d.]+)px\)$/);
  if (sum) return Number(sum[1]) + Number(sum[2]);
  const spacing = value.match(/^calc\(([\d.]+)(px|rem)\s*\*\s*([\d.]+)\)$/);
  if (spacing) {
    const rootFontSize = parseFloat(window.getComputedStyle(document.documentElement).fontSize || "16px");
    return Number(spacing[1]) * Number(spacing[3]) * (spacing[2] === "rem" ? rootFontSize : 1);
  }
  throw new Error(`Unsupported computed menu padding: ${value}`);
}

function ProjectDraftSeeder() {
  const { dispatch } = useAppState();

  useEffect(() => {
    const project = {
      id: "project-report",
      name: "报告",
      rootPath: "/workspace/报告",
      pinned: false,
      createdAt: "2026-09-26T00:00:00.000Z"
    };
    dispatch(agentActions.sessionSnapshotApplied({
      projectRegistryState: "ready",
      projects: [project],
      sessions: []
    }));
    dispatch(agentActions.draftTargetUpdated("draft-0", { kind: "project", projectId: project.id }));
  }, [dispatch]);

  return null;
}

function CompletedConversationSeeder() {
  const { dispatch } = useAppState();

  useEffect(() => {
    const requestId = "environment-titlebar-request";
    dispatch(agentActions.historyLoading("websocket:environment-titlebar", "environment-titlebar", requestId));
    dispatch(agentActions.historyLoaded({
      schemaVersion: 1,
      sessionKey: "websocket:environment-titlebar",
      last_turn_closed: true,
      messages: [
        { role: "user", content: "Show the environment" },
        { role: "assistant", content: "The conversation is ready." }
      ]
    }, requestId));
  }, [dispatch]);

  return null;
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value)
  };
}
