// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRuntimeBridge } from "../../app/agent-runtime-bridge.js";
import { AppProviders } from "../../app/providers.js";
import { agentActions } from "../../state/app-actions.js";
import { useAppState } from "../../state/app-state.js";
import { HomePage } from "../home-page.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("HomePage conversation scrolling", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(window, "localStorage", { configurable: true, value: createMemoryStorage() });
    Object.defineProperty(window, "sessionStorage", { configurable: true, value: createMemoryStorage() });
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
    document.body.replaceChildren();
  });

  it("jumps to the latest message in a completed long conversation", () => {
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

    const scrollContainer = document.querySelector<HTMLDivElement>(".agent-conversation-scroll");
    expect(scrollContainer).not.toBeNull();
    if (!scrollContainer) {
      throw new Error("Missing agent conversation scroll container");
    }
    Object.defineProperties(scrollContainer, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1200 },
      scrollTop: { configurable: true, value: 800, writable: true }
    });

    act(() => vi.advanceTimersByTime(121));
    expect(findScrollToLatestButton()).toBeNull();

    act(() => {
      scrollContainer.scrollTop = 200;
      scrollContainer.dispatchEvent(new Event("scroll", { bubbles: true }));
    });

    const button = findScrollToLatestButton();
    expect(button).not.toBeNull();
    act(() => button?.click());

    expect(scrollContainer.scrollTop).toBe(scrollContainer.scrollHeight);
    expect(findScrollToLatestButton()).toBeNull();

    act(() => {
      vi.advanceTimersByTime(121);
      scrollContainer.dispatchEvent(new Event("wheel", { bubbles: true }));
      scrollContainer.scrollTop = 200;
      scrollContainer.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(findScrollToLatestButton()).not.toBeNull();

    act(() => {
      scrollContainer.scrollTop = 800;
      scrollContainer.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(findScrollToLatestButton()).toBeNull();
  });

  it("tracks the real composer overlay height without pulling an actively reading user down", () => {
    let overlayHeight = 180;
    let resizeCallback: ResizeObserverCallback | null = null;
    class TestResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {
      }
      observe(target: Element) {
        if (target.classList.contains("agent-conversation-composer")) {
          resizeCallback = this.callback;
        }
      }
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("agent-conversation-composer")) {
        return { x: 0, y: 0, top: 0, right: 0, bottom: overlayHeight, left: 0, width: 0, height: overlayHeight, toJSON: () => ({}) };
      }
      return { x: 0, y: 0, top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0, toJSON: () => ({}) };
    });

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

    const panel = document.querySelector<HTMLElement>(".agent-conversation-panel")!;
    const scrollContainer = document.querySelector<HTMLDivElement>(".agent-conversation-scroll")!;
    Object.defineProperties(scrollContainer, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1200 },
      scrollTop: { configurable: true, value: 200, writable: true }
    });
    expect(panel.style.getPropertyValue("--agent-composer-overlay-height")).toBe("180px");
    expect(resizeCallback).not.toBeNull();

    overlayHeight = 260;
    act(() => (resizeCallback as ResizeObserverCallback)([], {} as ResizeObserver));
    act(() => vi.advanceTimersByTime(20));
    expect(panel.style.getPropertyValue("--agent-composer-overlay-height")).toBe("260px");
    expect(scrollContainer.scrollTop).toBe(1200);

    act(() => {
      vi.advanceTimersByTime(121);
      scrollContainer.dispatchEvent(new Event("wheel", { bubbles: true }));
      scrollContainer.scrollTop = 200;
      scrollContainer.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    overlayHeight = 320;
    act(() => (resizeCallback as ResizeObserverCallback)([], {} as ResizeObserver));
    act(() => vi.advanceTimersByTime(20));

    expect(panel.style.getPropertyValue("--agent-composer-overlay-height")).toBe("320px");
    expect(scrollContainer.scrollTop).toBe(200);
    expect(findScrollToLatestButton()).not.toBeNull();
  });

});

function CompletedConversationSeeder() {
  const { dispatch } = useAppState();

  useEffect(() => {
    const requestId = "scroll-test-request";
    dispatch(agentActions.historyLoading("websocket:scroll-test", "scroll-test", requestId));
    dispatch(agentActions.historyLoaded({
      schemaVersion: 1,
      sessionKey: "websocket:scroll-test",
      last_turn_closed: true,
      messages: [
        { role: "user", content: "较早的消息" },
        { role: "assistant", content: "最近的消息" }
      ]
    }, requestId));
  }, [dispatch]);

  return null;
}

function findScrollToLatestButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('button[aria-label="回到最新"]');
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
