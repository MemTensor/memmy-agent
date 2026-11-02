// @vitest-environment happy-dom

import { webcrypto } from "node:crypto";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as runtimeBridge from "../../app/agent-runtime-bridge.js";
import { AgentRuntimeBridge } from "../../app/agent-runtime-bridge.js";
import { AppProviders } from "../../app/providers.js";
import { agentActions } from "../../state/app-actions.js";
import { useAppState } from "../../state/app-state.js";
import { HomePage } from "../home-page.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("HomePage attachment drops", () => {
  let container: HTMLDivElement;
  let root: Root;
  let app: ReturnType<typeof useAppState>;

  function StateProbe() {
    app = useAppState();
    return null;
  }

  beforeEach(() => {
    vi.stubGlobal("crypto", webcrypto);
    vi.stubGlobal("memmy", undefined);
    Object.defineProperty(window, "memmy", {
      configurable: true,
      value: { getPathForFile: (file: File) => `/Users/memmy/研究资料/${file.name}` }
    });
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
          <StateProbe />
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

  it.each([
    ["new chat", false],
    ["existing conversation", true]
  ] as const)("accepts, deduplicates, and removes a folder alongside a file in the %s composer", async (_label, existingConversation) => {
    renderHomePage(existingConversation);
    const folder = new File([], "Papers.pdf");
    const read = vi.spyOn(folder, "arrayBuffer");
    await dropFolders([folder], [attachmentFile("report.pdf", "%PDF-report")]);

    expect(folderCards()).toHaveLength(1);
    expect(folderCards()[0]?.title).toBe("/Users/memmy/研究资料/Papers.pdf");
    expect(attachmentCards()).toHaveLength(2);
    expect(read).not.toHaveBeenCalled();
    expect(alert()).toBeNull();

    await dropFolders([folder]);
    expect(folderCards()).toHaveLength(1);
    act(() => folderCards()[0]!.querySelector<HTMLButtonElement>("button")!.click());
    expect(folderCards()).toHaveLength(0);
    expect(attachmentCards()).toHaveLength(1);
  });

  it.each([
    ["new chat", false],
    ["existing conversation", true]
  ] as const)("sends multiple folder references with their full paths from the %s composer", async (_label, existingConversation) => {
    const submitMessage = vi.fn(async () => ({ status: "accepted" as const }));
    const newChat = mockConnection(submitMessage);
    renderHomePage(existingConversation);
    connect();
    await dropFolders([new File([], "Empty folder"), new File([], '研究 "资料"')]);
    await dropFolders([new File([], "Empty folder")]);

    await sendComposer();

    expect(submitMessage).toHaveBeenCalledWith(expect.objectContaining({
      chatId: existingConversation ? "attachment-drop-test" : "folder-drop-created",
      content: ["/Users/memmy/研究资料/Empty folder", '/Users/memmy/研究资料/研究 "资料"'].map((path) => JSON.stringify(path)).join("\n\n"),
      media: []
    }), 1);
    expect(newChat).toHaveBeenCalledTimes(existingConversation ? 0 : 1);
    expect(folderCards()).toHaveLength(0);
  });

  it("restores folder references after a rejected send without losing newly added folders", async () => {
    let rejectSend!: (error: Error) => void;
    const submitMessage = vi.fn(() => new Promise<never>((_resolve, reject) => { rejectSend = reject; }));
    mockConnection(submitMessage);
    renderHomePage(true);
    connect();
    await dropFolders([new File([], "First")]);
    await sendComposer();
    expect(folderCards()).toHaveLength(0);

    await dropFolders([new File([], "Next")]);
    await act(async () => { rejectSend(new Error("Rejected")); });

    expect(Array.from(folderCards(), (card) => card.title)).toEqual([
      "/Users/memmy/研究资料/First", "/Users/memmy/研究资料/Next"
    ]);
  });

  it("keeps folder references in their original chat when opening a new chat", async () => {
    renderHomePage(true);
    await dropFolders([new File([], "Papers")]);
    act(() => app.dispatch(agentActions.newChatRequested()));
    expect(folderCards()).toHaveLength(0);
    expect(app.state.agent.composerContextReferencesByScope["attachment-drop-test"]).toMatchObject([
      { kind: "path", id: "/Users/memmy/研究资料/Papers", label: "Papers/" }
    ]);
  });

  it("reports an unreadable folder path instead of treating it as an attachment", async () => {
    window.memmy!.getPathForFile = () => "";
    renderHomePage();
    await dropFolders([new File([], "Papers")]);
    expect(folderCards()).toHaveLength(0);
    expect(attachmentCards()).toHaveLength(0);
    expect(alert()?.textContent).toBe("文件读取失败，请重新选择。");
  });

  it.each([
    ["new chat", false],
    ["existing conversation", true]
  ] as const)("mixes files and folders in one strip in addition order in %s", async (_label, existingConversation) => {
    renderHomePage(existingConversation);
    const first = attachmentFile("first.pdf", "%PDF-first");
    const folder = new File([], "Folder");
    const last = attachmentFile("last.pdf", "%PDF-last");
    const entries = [{ file: first }, { file: folder, folder: true }, { file: last }, { file: new File([], "Another"), folder: true }];
    const expected = ["first.pdf", "/Users/memmy/研究资料/Folder", "last.pdf", "/Users/memmy/研究资料/Another"];
    await dropEntries(entries);
    expect(document.querySelectorAll(".composer-media-preview-strip")).toHaveLength(1);
    expect(cardOrder()).toEqual(expected);

    await dropEntries([{ file: folder, folder: true }, { file: first }]);
    expect(cardOrder()).toEqual(expected);

    const originalChatId = app.state.agent.currentChatId;
    act(() => app.dispatch(agentActions.newChatCreated("other-chat")));
    expect(cardOrder()).toEqual([]);
    act(() => app.dispatch(originalChatId
      ? agentActions.newChatCreated(originalChatId)
      : agentActions.blankDraftReopened()));
    expect(cardOrder()).toEqual(expected);

    act(() => folderCards()[0]!.querySelector<HTMLButtonElement>("button")!.click());
    expect(cardOrder()).toEqual(["first.pdf", "last.pdf", "/Users/memmy/研究资料/Another"]);
  });

  it.each([
    ["new chat", false],
    ["existing conversation", true]
  ] as const)("preserves arrival order across asynchronous file validation in %s", async (_label, existingConversation) => {
    const submitMessage = vi.fn(async () => ({ status: "accepted" as const }));
    mockConnection(submitMessage);
    renderHomePage(existingConversation);
    connect();
    const slow = attachmentFile("slow.pdf", "%PDF-slow");
    const bytes = await slow.arrayBuffer();
    let finishRead!: (value: ArrayBuffer) => void;
    vi.spyOn(slow, "arrayBuffer").mockReturnValue(new Promise<ArrayBuffer>((resolve) => { finishRead = resolve; }));
    act(() => dispatchDropEntries([{ file: slow }]));

    await dropEntries([
      { file: new File([], "Folder"), folder: true },
      { file: attachmentFile("fast.pdf", "%PDF-fast") }
    ]);
    expect(cardOrder()).toEqual(["/Users/memmy/研究资料/Folder", "fast.pdf"]);
    const focus = vi.spyOn(document.querySelector<HTMLTextAreaElement>(".agent-composer-shell textarea")!, "focus");
    try {
      await act(async () => {
        finishRead(bytes);
        await vi.waitFor(() => expect(focus).toHaveBeenCalledOnce());
      });
    } finally {
      focus.mockRestore();
    }
    expect(cardOrder()).toEqual(["slow.pdf", "/Users/memmy/研究资料/Folder", "fast.pdf"]);
    reusePendingMedia();
    await sendComposer();
    expect(submitMessage).toHaveBeenCalledWith(expect.objectContaining({
      media: [expect.objectContaining({ name: "slow.pdf" }), expect.objectContaining({ name: "fast.pdf" })]
    }), 1);
  });

  it.each([
    ["new chat", false],
    ["existing conversation", true]
  ] as const)("shares addition order with file selection and pasting in %s", async (_label, existingConversation) => {
    renderHomePage(existingConversation);
    await dropFolders([new File([], "First")]);
    const digest = vi.spyOn(crypto.subtle, "digest");
    const picker = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(picker, "files", { configurable: true, value: [attachmentFile("selected.pdf", "%PDF-selected")] });
    await act(async () => {
      picker.dispatchEvent(new Event("change", { bubbles: true }));
      await vi.waitFor(() => expect(digest).toHaveBeenCalledOnce());
      await digest.mock.results[0]!.value;
    });
    expect(cardOrder()).toEqual(["/Users/memmy/研究资料/First", "selected.pdf"]);
    await dropFolders([new File([], "Next")]);
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { files: [attachmentFile("pasted.pdf", "%PDF-pasted")] } });
    await act(async () => {
      document.querySelector(".agent-composer-shell textarea")!.dispatchEvent(paste);
      await vi.waitFor(() => expect(digest).toHaveBeenCalledTimes(2));
      await digest.mock.results[1]!.value;
    });
    expect(cardOrder()).toEqual([
      "/Users/memmy/研究资料/First", "selected.pdf", "/Users/memmy/研究资料/Next", "pasted.pdf"
    ]);
    expect(paste.defaultPrevented).toBe(true);
  });

  it("restores mixed addition order after a rejected send and retains newly added references", async () => {
    let rejectSend!: (error: Error) => void;
    mockConnection(vi.fn(() => new Promise<never>((_resolve, reject) => { rejectSend = reject; })));
    renderHomePage(true);
    connect();
    await dropEntries([
      { file: attachmentFile("first.pdf", "%PDF-first") },
      { file: new File([], "Folder"), folder: true },
      { file: attachmentFile("last.pdf", "%PDF-last") }
    ]);
    reusePendingMedia();
    await sendComposer();
    expect(cardOrder()).toEqual([]);
    await dropFolders([new File([], "New")]);
    await act(async () => { rejectSend(new Error("Rejected")); });
    expect(cardOrder()).toEqual([
      "first.pdf", "/Users/memmy/研究资料/Folder", "last.pdf", "/Users/memmy/研究资料/New"
    ]);
  });

  function mockConnection(submitMessage: ReturnType<typeof vi.fn>) {
    const newChat = vi.fn(async () => ({ chatId: "folder-drop-created", modelPreset: "test-model" }));
    vi.spyOn(runtimeBridge, "useAgentRuntimeBridge").mockReturnValue({
      connection: {
        getReadyGeneration: () => 1,
        newChat,
        submitMessage,
        onStatusResult: () => () => undefined,
        onHistoryDagResult: () => () => undefined
      },
      ensureChatSubscription: vi.fn(),
      taskStateCoordinator: { refreshTaskState: vi.fn() }
    } as unknown as ReturnType<typeof runtimeBridge.useAgentRuntimeBridge>);
    return newChat;
  }

  function reusePendingMedia() {
    // Reuse stored media to exercise submission without starting a real upload.
    const scopeKey = app.state.agent.currentChatId ?? `draft-${app.state.agent.newChatRequestId}`;
    act(() => app.dispatch(agentActions.composerPendingAttachmentsUpdated(scopeKey,
      app.state.agent.composerPendingAttachmentsByScope[scopeKey]!.map((item) => ({
        ...item, reusedMedia: { path: `/stored/${item.fileName}`, url: `/media/${item.fileName}`, kind: item.kind, name: item.fileName }
      }))
    )));
  }

  function connect() {
    const blank = app.state.agent.currentChatId === null;
    act(() => {
      app.dispatch({ type: "agent/wsEvent", event: { event: "ready", chat_id: "default", connection_generation: 1 } });
      app.dispatch(agentActions.recoveryFinished(1));
      if (blank) app.dispatch(agentActions.newChatRequested());
    });
  }

  async function sendComposer() {
    const button = document.querySelector<HTMLButtonElement>('.agent-composer-shell button[aria-label="发送"]')!;
    expect(button.disabled).toBe(false);
    await act(async () => { button.click(); });
  }
});

function folderCards(): NodeListOf<HTMLElement> {
  return document.querySelectorAll<HTMLElement>(".composer-context-reference");
}

async function dropFolders(folders: File[], files: File[] = []) {
  await dropEntries([
    ...folders.map((file) => ({ file, folder: true })),
    ...files.map((file) => ({ file }))
  ]);
}

interface DropEntry {
  file: File;
  folder?: boolean;
}

function dispatchDropEntries(entries: DropEntry[]) {
  const composer = document.querySelector<HTMLElement>(".agent-composer-shell")!;
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: {
    types: ["Files"],
    files: entries.map((entry) => entry.file),
    items: entries.map((entry) => ({ kind: "file", getAsFile: () => entry.file, webkitGetAsEntry: () => ({ isDirectory: Boolean(entry.folder) }) }))
  } });
  composer.querySelector("textarea")!.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
}

async function dropEntries(entries: DropEntry[]) {
  const input = document.querySelector<HTMLTextAreaElement>(".agent-composer-shell textarea")!;
  const focus = vi.spyOn(input, "focus");
  try {
    await act(async () => {
      dispatchDropEntries(entries);
      await vi.waitFor(() => expect(focus).toHaveBeenCalledOnce());
    });
  } finally {
    focus.mockRestore();
  }
}

function cardOrder(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".composer-media-preview-strip .agent-attachment-card"), (card) => card.title);
}

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
