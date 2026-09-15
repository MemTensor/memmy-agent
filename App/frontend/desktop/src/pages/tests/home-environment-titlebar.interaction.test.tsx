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
const appFrameSource = readFileSync(resolve(process.cwd(), "src/pages/app-frame.tsx"), "utf8");

describe("HomePage environment titlebar", () => {
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
  ])("keeps $name environment controls reachable while the sidebar is toggled", ({ platform, fullscreen }) => {
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

    const assertToolbarSpacing = () => {
      const toolbar = container.querySelector<HTMLElement>(".app-frame-content-topbar");
      expect(toolbar).not.toBeNull();
      const content = toolbar!.nextElementSibling as HTMLElement;
      expect(window.getComputedStyle(toolbar!).minHeight).toBe("46px");
      expect(toolbar!.style.top).toBe("");
      if (platform === "win32" && !fullscreen) {
        expect(styles).toMatch(/body\.memmy-platform-windows:not\(\.memmy-window-fullscreen\) \.app-frame-main--windows-titlebar-safe\s*{[^}]*--app-frame-topbar-offset:\s*var\(--codex-toolbar-height\);/s);
        expect(styles).toMatch(/\.app-frame-main--windows-titlebar-safe \.app-frame-content-topbar\s*{[^}]*top:\s*var\(--app-frame-topbar-offset, 0px\);/s);
        expect(appFrameSource).toContain('paddingTop: "calc(var(--codex-toolbar-height) + var(--app-frame-topbar-offset, 0px))"');
      } else {
        expect(appFrameSource).toContain('paddingTop: "calc(var(--codex-toolbar-height) + var(--app-frame-topbar-offset, 0px))"');
      }
      const environmentButton = container.querySelector<HTMLButtonElement>("[data-agent-environment-toggle]");
      expect(environmentButton).not.toBeNull();
      expect(environmentButton!.disabled).toBe(false);
      expect(window.getComputedStyle(environmentButton!).pointerEvents).toBe("auto");
      expect(window.getComputedStyle(environmentButton!).getPropertyValue("-webkit-app-region")).toBe("no-drag");
      return environmentButton!;
    };

    const environmentButton = assertToolbarSpacing();
    expect(container.querySelector(".agent-environment-panel")).toBeNull();
    act(() => environmentButton.click());
    expect(environmentButton.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".agent-environment-panel")).not.toBeNull();

    const hideSidebarButton = container.querySelector<HTMLButtonElement>(".sidebar-toolbar-button");
    expect(hideSidebarButton).not.toBeNull();
    act(() => hideSidebarButton!.click());
    expect(container.querySelector(".app-frame-sidebar")?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".agent-environment-panel")).not.toBeNull();
    assertToolbarSpacing();

    const showSidebarButton = container.querySelector<HTMLButtonElement>(".sidebar-restore-button");
    expect(showSidebarButton).not.toBeNull();
    act(() => showSidebarButton!.click());
    expect(container.querySelector(".app-frame-sidebar")?.getAttribute("aria-hidden")).toBeNull();
    expect(container.querySelector(".sidebar-restore-button")).toBeNull();
    expect(container.querySelector(".agent-environment-panel")).not.toBeNull();
    act(() => assertToolbarSpacing().click());
    expect(container.querySelector(".agent-environment-panel")).toBeNull();
  });
});

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
