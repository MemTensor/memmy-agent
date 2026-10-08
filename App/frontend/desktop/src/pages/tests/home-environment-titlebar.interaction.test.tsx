// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRuntimeBridge } from "../../app/agent-runtime-bridge.js";
import { AppProviders } from "../../app/providers.js";
import { agentActions } from "../../state/app-actions.js";
import { useAppState } from "../../state/app-state.js";
import { applyWindowFullScreenClass, applyWindowPlatformClass } from "../../utils/window-fullscreen.js";
import { HomePage } from "../home-page.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tokens = readFileSync(resolve(process.cwd(), "src/theme/tokens.css"), "utf8");
const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8")
  .replace(/^@import[^;]*;\s*/gm, "");

describe("HomePage thread side panel titlebar", () => {
  let container: HTMLDivElement;
  let root: Root;
  let stylesheet: HTMLStyleElement;

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(window, "localStorage", { configurable: true, value: createMemoryStorage() });
    Object.defineProperty(window, "sessionStorage", { configurable: true, value: createMemoryStorage() });
    stylesheet = document.createElement("style");
    stylesheet.textContent = `${tokens}\n${styles}`;
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
  });

  it.each([
    { name: "Windows", platform: "win32", fullscreen: false },
    { name: "Mac", platform: "darwin", fullscreen: false },
    { name: "Windows fullscreen", platform: "win32", fullscreen: true }
  ])("keeps $name side panel controls reachable while the sidebar is toggled", ({ platform, fullscreen }) => {
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
    applyWindowPlatformClass(platform);
    applyWindowFullScreenClass(fullscreen);

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
      if (platform === "win32" && !fullscreen) {
        expect(styles).toMatch(/body\.memmy-platform-windows:not\(\.memmy-window-fullscreen\) \.app-frame-main--windows-titlebar-safe\s*{[^}]*--app-frame-topbar-offset:\s*var\(--codex-toolbar-height\);/s);
        expect(styles).toMatch(/\.app-frame-main--windows-titlebar-safe \.app-frame-content-topbar\s*{[^}]*top:\s*var\(--app-frame-topbar-offset, 0px\);/s);
        expect(styles).toMatch(/\.thread-panel\s*{[^}]*top:\s*var\(--app-frame-topbar-offset, 0px\);/s);
      }
      expect(styles).toMatch(/\.agent-workspace-layout > \.agent-conversation-panel\s*{[^}]*padding-top:\s*calc\(var\(--codex-toolbar-height\) \+ var\(--app-frame-topbar-offset, 0px\)\);/s);
      expect(container.querySelector("[data-agent-environment-toggle]")).toBeNull();
    };
    const openPanelButton = () => container.querySelector<HTMLButtonElement>('.thread-toolbar__button[aria-label="展开右栏"]');
    const collapsePanelButton = () => container.querySelector<HTMLButtonElement>('.thread-panel__icon-button[aria-label="收起右栏"]');

    assertToolbarSpacing();
    expect(container.querySelector(".thread-panel")).toBeNull();
    act(() => assertReachable(openPanelButton(), true).click());
    expect(container.querySelector(".thread-panel")).not.toBeNull();
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
});

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
