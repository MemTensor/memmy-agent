// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { AgentMessageContent } from "../agent-message-content.js";
import { MEMMY_BROWSER_OPEN_EVENT } from "../browser-panel.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("chat links and the built-in browser preference", () => {
  afterEach(() => { Reflect.deleteProperty(window, "memmy"); document.body.replaceChildren(); });

  it("routes a normal chat link into the right sidebar when selected", async () => {
    const values = new Map([["memmy.browser.preferences.v1", JSON.stringify({ webLinks: "memmy", localLinks: "memmy", showFullUrl: false })]]);
    Object.defineProperty(window, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null } });
    Object.defineProperty(window, "memmy", { configurable: true, value: {} });
    const events: string[] = [];
    const listener = (event: Event) => events.push((event as CustomEvent<{ url: string }>).detail.url);
    window.addEventListener(MEMMY_BROWSER_OPEN_EVENT, listener);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<I18nProvider language="zh-CN"><AgentMessageContent content="[Example](https://example.com/report)" /></I18nProvider>));
      const link = container.querySelector("a") as HTMLAnchorElement;
      await act(async () => link.click());
      expect(events).toEqual(["https://example.com/report"]);
    } finally {
      act(() => root.unmount());
      window.removeEventListener(MEMMY_BROWSER_OPEN_EVENT, listener);
    }
  });
});
