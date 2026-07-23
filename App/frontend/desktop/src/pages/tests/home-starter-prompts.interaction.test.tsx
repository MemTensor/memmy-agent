// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentRuntimeBridge } from "../../app/agent-runtime-bridge.js";
import { AppProviders } from "../../app/providers.js";
import { HomePage } from "../home-page.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("HomePage starter prompts", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(window, "localStorage", { configurable: true, value: createMemoryStorage() });
    Object.defineProperty(window, "sessionStorage", { configurable: true, value: createMemoryStorage() });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it("prefills and focuses the composer without sending the starter task", () => {
    act(() => {
      root.render(
        <AppProviders>
          <AgentRuntimeBridge>
            <HomePage />
          </AgentRuntimeBridge>
        </AppProviders>
      );
    });

    const starter = getButton("回顾最近任务");
    const textarea = getComposer();

    expect(document.querySelectorAll(".home-starter-prompt")).toHaveLength(4);
    act(() => starter.click());

    expect(textarea.value).toBe("整理我最近的 Agent 任务，列出当前进展、遗留问题和下一步。");
    expect(document.activeElement).toBe(textarea);
    expect(document.querySelector(".home-starter-prompts")).toBeNull();
    expect(document.querySelector(".agent-conversation-panel")).toBeNull();
    expect(document.querySelector(".agent-chat-bubble--user")).toBeNull();
  });
});

function getButton(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>(".home-starter-prompt"))
    .find((candidate) => candidate.textContent?.includes(text));
  if (!button) {
    throw new Error(`Missing starter prompt: ${text}`);
  }
  return button;
}

function getComposer(): HTMLTextAreaElement {
  const textarea = document.querySelector<HTMLTextAreaElement>(".home-empty-composer textarea");
  if (!textarea) {
    throw new Error("Missing home composer");
  }
  return textarea;
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
