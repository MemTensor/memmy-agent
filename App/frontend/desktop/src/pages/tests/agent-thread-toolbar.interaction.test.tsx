// @vitest-environment happy-dom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import type { AgentChatMessage } from "../../state/agent-chat-slice.js";
import { THREAD_SEARCH_DEBOUNCE_MS } from "../agent-thread-search.js";
import { AgentThreadToolbar } from "../agent-thread-toolbar.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const messages: AgentChatMessage[] = [
  { id: "u1", role: "user", content: "Write the deploy script" },
  { id: "a1", role: "assistant", content: "Deploy finished." },
  { id: "u2", role: "user", content: "Run deploy\nagain" },
];

function Harness(props: { panelOpen: boolean; onOpenPanel: () => void; onJump: (id: string) => void; onNavigate: () => void }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  return (
    <>
      <AgentThreadToolbar
        title="Deploy task"
        messages={messages}
        panelOpen={props.panelOpen}
        onOpenPanel={props.onOpenPanel}
        onJumpToMessage={props.onJump}
        onSearchNavigate={props.onNavigate}
        getSearchRoot={() => rootRef.current}
      />
      <div ref={rootRef}>
        {messages.map((message) => (
          <div key={message.id} data-agent-message-id={message.id}>
            <div data-agent-search-root="">{message.content}</div>
            <button type="button">Copy deploy</button>
          </div>
        ))}
      </div>
    </>
  );
}

describe("AgentThreadToolbar", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  function render(overrides: Partial<Parameters<typeof Harness>[0]> = {}) {
    const props = { panelOpen: false, onOpenPanel: vi.fn(), onJump: vi.fn(), onNavigate: vi.fn(), ...overrides };
    act(() => {
      root.render(
        <I18nProvider language="zh-CN">
          <Harness {...props} />
        </I18nProvider>,
      );
    });
    return props;
  }

  it("searches the conversation with ⌘F, Enter and Shift+Enter, then closes with Escape", () => {
    const props = render();

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true }));
    });
    expect(document.querySelector(".thread-toolbar__actions")?.getAttribute("data-window-drag-exclusion")).toBe("thread-toolbar-actions");
    const input = document.querySelector<HTMLInputElement>(".thread-search__input")!;
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);

    typeInto(input, "deploy");
    act(() => vi.advanceTimersByTime(THREAD_SEARCH_DEBOUNCE_MS));
    expect(counter()).toBe("1/3");
    expect(props.onNavigate).toHaveBeenCalledTimes(1);

    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(counter()).toBe("2/3");
    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true })));
    expect(counter()).toBe("1/3");
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="上一个（Shift+Enter）"]')!.click());
    expect(counter()).toBe("3/3");

    typeInto(input, "missing");
    act(() => vi.advanceTimersByTime(THREAD_SEARCH_DEBOUNCE_MS));
    expect(counter()).toBe("0/0");

    act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector(".thread-search")).toBeNull();
    expect(document.querySelector('[aria-label="对话内搜索（⌘F / Ctrl+F）"]')).not.toBeNull();
  });

  it("jumps to a prompt from the history popover", () => {
    const props = render();

    act(() => document.querySelector<HTMLButtonElement>('[aria-label="历史提问"]')!.click());
    expect(document.querySelector(".thread-prompt-list__header")?.textContent).toBe("历史提问（2）");
    const items = [...document.querySelectorAll<HTMLButtonElement>(".thread-prompt-list__item")];
    expect(items.map((item) => item.textContent)).toEqual(["Write the deploy script", "Run deploy again"]);

    act(() => items[1]!.click());
    expect(props.onJump).toHaveBeenCalledWith("u2");
    expect(document.querySelector(".thread-prompt-list")).toBeNull();

    act(() => document.querySelector<HTMLButtonElement>('[aria-label="历史提问"]')!.click());
    expect(document.querySelector(".thread-prompt-list__item--active")?.textContent).toBe("Run deploy again");
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(document.querySelector(".thread-prompt-list")).toBeNull();
  });

  it("shows the side panel toggle only while the panel is closed", () => {
    const props = render();
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="展开右栏"]')!.click());
    expect(props.onOpenPanel).toHaveBeenCalledTimes(1);

    render({ panelOpen: true });
    expect(document.querySelector('[aria-label="展开右栏"]')).toBeNull();
  });
});

function counter(): string | null {
  return document.querySelector(".thread-search__counter")?.textContent ?? null;
}

function typeInto(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
