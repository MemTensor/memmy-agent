// @vitest-environment happy-dom

import { webcrypto } from "node:crypto";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRuntimeBridge } from "../../app/agent-runtime-bridge.js";
import { AppProviders } from "../../app/providers.js";
import { agentActions } from "../../state/app-actions.js";
import { useAppState } from "../../state/app-state.js";
import { HomePage } from "../home-page.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("HomePage attachment drops", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("crypto", webcrypto);
    Object.defineProperty(window, "localStorage", { configurable: true, value: createMemoryStorage() });
    Object.defineProperty(window, "sessionStorage", { configurable: true, value: createMemoryStorage() });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  function renderHomePage(existingConversation = false) {
    act(() => root.render(
      <AppProviders>
        <AgentRuntimeBridge>
          {existingConversation ? <ConversationSeeder /> : null}
          <HomePage />
        </AgentRuntimeBridge>
      </AppProviders>
    ));
  }

  it.each([
    ["new chat", false],
    ["existing conversation", true]
  ] as const)("silently ignores an already attached file in the %s composer", async (_label, existingConversation) => {
    renderHomePage(existingConversation);

    await dropFiles([attachmentFile("report.pdf", "%PDF-report")]);
    expect(attachmentCards()).toHaveLength(1);
    expect(alert()).toBeNull();

    await dropFiles([attachmentFile("report.pdf", "%PDF-report")]);

    expect(attachmentCards()).toHaveLength(1);
    expect(alert()).toBeNull();
  });

  it("keeps renamed identical content distinct and silently ignores its repeat drop", async () => {
    renderHomePage();

    await dropFiles([attachmentFile("report.pdf", "%PDF-report")]);
    await dropFiles([attachmentFile("renamed-report.pdf", "%PDF-report")]);
    expect(attachmentCards()).toHaveLength(2);
    expect(alert()).toBeNull();

    await dropFiles([attachmentFile("renamed-report.pdf", "%PDF-report")]);

    expect(attachmentCards()).toHaveLength(2);
    expect(alert()).toBeNull();
  });

  it("adds only the new file from a mixed duplicate and new drop without an alert", async () => {
    renderHomePage();
    await dropFiles([attachmentFile("report.pdf", "%PDF-report")]);

    await dropFiles([
      attachmentFile("report.pdf", "%PDF-report"),
      attachmentFile("notes.pdf", "%PDF-notes")
    ]);

    expect(attachmentCards()).toHaveLength(2);
    expect(alert()).toBeNull();
  });

  it("still reports unsupported files when the drop also contains an existing attachment", async () => {
    renderHomePage();
    await dropFiles([attachmentFile("report.pdf", "%PDF-report")]);

    await dropFiles([
      attachmentFile("report.pdf", "%PDF-report"),
      attachmentFile("archive.zip", "archive", "application/zip")
    ]);

    expect(attachmentCards()).toHaveLength(1);
    expect(alert()?.textContent).toBeTruthy();
  });

  it("still reports unreadable files when the drop also contains an existing attachment", async () => {
    renderHomePage();
    await dropFiles([attachmentFile("report.pdf", "%PDF-report")]);
    const unreadable = attachmentFile("unreadable.pdf", "%PDF-unreadable");
    vi.spyOn(unreadable, "arrayBuffer").mockRejectedValue(new Error("read failed"));

    await dropFiles([
      attachmentFile("report.pdf", "%PDF-report"),
      unreadable
    ]);

    expect(attachmentCards()).toHaveLength(1);
    expect(alert()?.textContent).toBe("文件读取失败，请重新选择。");
  });
});

async function dropFiles(files: File[]) {
  const composer = document.querySelector<HTMLElement>(".agent-composer-shell");
  const input = composer?.querySelector<HTMLTextAreaElement>("textarea");
  if (!composer || !input) {
    throw new Error("Missing attachment drop composer");
  }
  const focus = vi.spyOn(input, "focus");
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { files, types: ["Files"] } });

  try {
    await act(async () => {
      composer.dispatchEvent(event);
      // The drop handler focuses the composer after validation and staging finish.
      await vi.waitFor(() => expect(focus).toHaveBeenCalledOnce());
    });
    expect(event.defaultPrevented).toBe(true);
  } finally {
    focus.mockRestore();
  }
}

function attachmentFile(name: string, content: string, type = "application/pdf"): File {
  return new File([content], name, { type, lastModified: 100 });
}

function attachmentCards(): NodeListOf<HTMLElement> {
  return document.querySelectorAll<HTMLElement>('[data-testid="agent-attachment-card-file"]');
}

function alert(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.agent-operation-error-slot [role="alert"]');
}

function ConversationSeeder() {
  const { dispatch } = useAppState();

  useEffect(() => {
    const requestId = "attachment-drop-test-request";
    dispatch(agentActions.historyLoading("websocket:attachment-drop-test", "attachment-drop-test", requestId));
    dispatch(agentActions.historyLoaded({
      schemaVersion: 1,
      sessionKey: "websocket:attachment-drop-test",
      last_turn_closed: true,
      messages: [
        { role: "user", content: "Existing question" },
        { role: "assistant", content: "Existing answer" }
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
