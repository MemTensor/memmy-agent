// @vitest-environment happy-dom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceEnvironmentState } from "../../api/memmy-agent-client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import type { AgentChatMessage } from "../../state/agent-chat-slice.js";
import {
  AgentThreadPanel,
  THREAD_PANEL_FULLSCREEN_BODY_CLASS,
  THREAD_PANEL_WIDTH_STORAGE_KEY,
  useAgentThreadPanel,
} from "../agent-thread-panel.js";
import type { ThreadPreviewContext } from "../agent-thread-panel-preview.js";
import { requestBrowserNewTab, takePendingBrowserNewTab } from "../browser-panel.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LAYOUT_WIDTH = 1248;

function Harness(props: { messages: AgentChatMessage[]; context: ThreadPreviewContext; workspaceRoot?: string | null }) {
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const panel = useAgentThreadPanel({ scopeKey: "chat-1", containerRef: layoutRef, enabled: true });
  return (
    <div ref={layoutRef} data-testid="layout">
      <button type="button" data-testid="open-panel" onClick={panel.open}>open</button>
      <output data-testid="offset">{panel.offset}</output>
      {panel.visible ? (
        <AgentThreadPanel
          controller={panel}
          messages={props.messages}
          workspaceRoot={props.workspaceRoot ?? null}
          previewContext={props.context}
        />
      ) : null}
    </div>
  );
}

function artifactClient() {
  return {
    resolveArtifact: vi.fn(async (path: string) => ({
      ok: true as const,
      path,
      name: path.split("/").at(-1) ?? path,
      kind: "file" as const,
      media_url: `http://127.0.0.1:18980/media/${encodeURIComponent(path)}`,
    })),
    revealArtifact: vi.fn(async () => undefined),
    openArtifact: vi.fn(async () => undefined),
  };
}

function textFetch(files: Record<string, string>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const path = decodeURIComponent(String(input).split("/media/")[1] ?? "");
    const body = files[path];
    return body == null ? new Response("missing", { status: 404 }) : new Response(new Blob([body]));
  }) as unknown as typeof fetch;
}

const readyEnvironment = {
  snapshot: { status: "ready", cwd: "/repo", repository: { root: "/repo" } },
  files: [],
  branches: [],
} as unknown as WorkspaceEnvironmentState;

describe("AgentThreadPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
        clear: () => values.clear(),
        key: () => null,
        length: 0,
      },
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const width = this.dataset.testid === "layout" ? LAYOUT_WIDTH : 32;
      return { width, height: 32, top: 0, left: 0, right: width, bottom: 32, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    takePendingBrowserNewTab();
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "memmy");
    document.body.replaceChildren();
    document.body.className = "";
  });

  function render(props: { messages: AgentChatMessage[]; context: ThreadPreviewContext; workspaceRoot?: string | null }) {
    act(() => {
      root.render(
        <I18nProvider language="zh-CN">
          <Harness {...props} />
        </I18nProvider>,
      );
    });
    act(() => byTestId("open-panel").click());
  }

  it('keeps user tabs mounted while switching and opens an Agent page in a separate tab', () => {
    render({ messages: [], context: emptyContext() });
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="浏览器"]')!.click());
    const first = document.querySelector('webview');
    expect(first).not.toBeNull();
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="新建标签页"]')!.click());
    expect(document.querySelectorAll('webview')).toHaveLength(2);
    expect(document.querySelector('webview')).toBe(first);
    expect(document.querySelector('.memmy-browser-tabs')).toBeNull();
    act(() => requestBrowserNewTab('https://example.com/'));
    expect(document.querySelectorAll('webview')).toHaveLength(3);
    expect(document.querySelectorAll('.thread-tabs [data-browser-tab]')[2]?.getAttribute('aria-selected')).toBe('true');
    expect(document.querySelectorAll('webview')[2]?.getAttribute('src')).toBe('https://example.com/');
    act(() => document.querySelectorAll<HTMLButtonElement>('.thread-tabs [data-browser-tab]')[0]!.click());
    expect(document.querySelector('webview')).toBe(first);
    expect(document.querySelectorAll('.thread-tabs [data-browser-tab]')[0]?.getAttribute('aria-selected')).toBe('true');
  });

  it('keeps a browser tab beside the file tab in the same strip', async () => {
    render({
      messages: [
        { id: "a1", role: "assistant", content: "Wrote [notes](/work/notes.md).", media: [{ kind: "file", path: "/work/report.pdf", name: "report.pdf" }] },
      ],
      context: { ...emptyContext(), artifactClient: artifactClient(), fetchFn: textFetch({ "/work/notes.md": "# Release notes\n\nAll good." }) },
    });
    await act(async () => clickText(".thread-overview-item", "notes.md"));
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="浏览器"]')!.click());
    const strip = document.querySelector('.thread-tabs');
    expect(strip?.querySelector('.memmy-browser-tabs')).toBeNull();
    expect([...strip!.querySelectorAll('.thread-tab__title')].map((item) => item.textContent)).toEqual(['notes.md', '浏览器 1']);
    expect(strip?.querySelector('[data-browser-tab]')?.getAttribute('aria-selected')).toBe('true');
    expect(strip?.querySelector('[data-thread-tab-id^="file:"]')?.getAttribute('aria-selected')).toBe('false');
    act(() => strip?.querySelector<HTMLElement>('[data-thread-tab-id^="file:"]')?.click());
    await flush();
    expect(document.querySelector('.thread-preview__document')?.textContent).toContain('Release notes');
    expect(strip?.querySelector('[data-browser-tab]')?.getAttribute('aria-selected')).toBe('false');
    expect(strip?.querySelector('[data-thread-tab-id^="file:"]')?.getAttribute('aria-selected')).toBe('true');
  });

  it('opens a new Agent tab even when the browser panel mounts after the open event', () => {
    requestBrowserNewTab('https://example.com/');
    render({ messages: [], context: emptyContext() });
    expect(document.querySelectorAll('webview')).toHaveLength(2);
    expect(document.querySelectorAll('webview')[1]?.getAttribute('src')).toBe('https://example.com/');
  });

  it('copies the live tab reference and removes the webview when the Agent closes it', async () => {
    let closeTab: ((tabId: number) => void) | undefined;
    const copyMention = vi.fn(async () => undefined);
    Object.assign(window, { memmy: {
      selectEmbeddedBrowserTab: vi.fn(),
      copyEmbeddedBrowserTabMention: copyMention,
      onEmbeddedBrowserClose: (callback: (tabId: number) => void) => {
        closeTab = callback;
        return () => { closeTab = undefined; };
      },
    } });
    render({ messages: [], context: emptyContext() });
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="浏览器"]')!.click());
    const view = document.querySelector('webview') as HTMLElement & Record<string, any>;
    Object.assign(view, { getWebContentsId: () => 27, getURL: () => 'https://example.com/',
      getTitle: () => 'Example', canGoBack: () => false, canGoForward: () => false });
    await act(async () => view.dispatchEvent(new Event('dom-ready')));
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="复制标签页引用"]')!.click());
    expect(copyMention).toHaveBeenCalledWith(27);
    act(() => closeTab?.(27));
    expect(document.querySelector('webview')).not.toBe(view);
  });

  it("opens an artifact in a tab, widens to half the workspace and keeps the list behind the hover overview", async () => {
    const client = artifactClient();
    render({
      messages: [
        { id: "a1", role: "assistant", content: "Wrote [notes](/work/notes.md).", media: [{ kind: "file", path: "/work/report.pdf", name: "report.pdf" }] },
      ],
      context: { ...emptyContext(), artifactClient: client, fetchFn: textFetch({ "/work/notes.md": "# Release notes\n\nAll good." }) },
    });

    expect(document.querySelector(".thread-panel__header")?.getAttribute("data-window-drag-exclusion")).toBe("thread-panel-header");
    expect(offset()).toBe(360);
    expect(itemTitles()).toEqual(["report.pdf", "notes.md"]);

    await act(async () => clickText(".thread-overview-item", "notes.md"));
    await flush();

    expect(tabTitles()).toEqual(["notes.md"]);
    expect(offset()).toBe(LAYOUT_WIDTH / 2);
    expect(document.querySelector(".thread-panel__list")).toBeNull();
    expect(document.querySelector(".thread-preview__document")?.textContent).toContain("Release notes");
    expect(client.resolveArtifact).toHaveBeenCalledWith("/work/notes.md");

    act(() => {
      document.querySelector(".thread-panel__overview-trigger")!.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    });
    expect(document.querySelector(".thread-popover")).not.toBeNull();
    expect([...document.querySelectorAll(".thread-popover .thread-overview-item")].map((item) => item.textContent)).toEqual(["report.pdf", "notes.md"]);

    act(() => document.querySelector<HTMLButtonElement>('.thread-popover [aria-label="固定侧栏"]')!.click());
    expect(document.querySelector(".thread-popover")).toBeNull();
    expect(document.querySelector(".thread-panel__list")).not.toBeNull();
    expect(document.querySelector('.thread-panel__list [aria-label="取消固定"]')).not.toBeNull();
    expect(document.querySelector(".thread-panel__overview-button--inactive")).not.toBeNull();

    act(() => document.querySelector<HTMLButtonElement>(".thread-tab__close")!.click());
    expect(document.querySelector(".thread-panel--closing")).not.toBeNull();
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 170)));
    expect(document.querySelector(".thread-panel")).toBeNull();
    expect(offset()).toBe(0);
  });

  it("switches to changes and opens the git diff for a changed file", async () => {
    const readWorkspaceEnvironmentDiff = vi.fn(async () => ({
      path: "src/a.ts",
      diff: "@@ -1 +1,2 @@\n-const a = 1;\n+const a = 2;\n+export { a };",
      truncated: false,
      unavailable_reason: null,
    }));
    render({
      messages: [
        { id: "a1", role: "assistant", content: "Done", fileEdits: [{ call_id: "1", tool: "edit", path: "src/a.ts", added: 16, deleted: 1, status: "done" }] },
      ],
      context: {
        ...emptyContext(),
        artifactClient: artifactClient(),
        agentClient: { readWorkspaceEnvironmentDiff },
        sessionScope: { kind: "session", key: "session-1" },
        environment: readyEnvironment,
        workspaceRoot: "/repo",
        fetchFn: textFetch({ "/repo/src/a.ts": "const a = 2;\nexport { a };\nuntouched();\n" }),
      },
    });

    act(() => document.querySelector<HTMLButtonElement>(".thread-view-pill")!.click());
    act(() => clickText(".thread-view-menu__item", "变更"));

    expect(document.querySelector(".thread-view-menu")).toBeNull();
    expect(document.querySelector(".thread-changes__header")?.textContent).toBe("文件变更+16-1");

    await act(async () => clickText(".thread-changes__button", "a.ts"));
    await flush();

    expect(readWorkspaceEnvironmentDiff).toHaveBeenCalledWith({ kind: "session", key: "session-1" }, "src/a.ts");
    expect(document.querySelectorAll(".thread-preview .workspace-diff-view__line--addition")).toHaveLength(2);
    expect(document.querySelectorAll(".thread-preview .workspace-diff-view__line--deletion")).toHaveLength(1);
    expect(document.querySelector(".thread-preview__stat-added")?.textContent).toBe("+2");
    expect(document.querySelector(".thread-preview__stat-removed")?.textContent).toBe("-1");
    expect(document.querySelector(".workspace-diff-view__fold")?.textContent).toBe("1 行未修改");
    expect(document.querySelector(".thread-preview")?.textContent).not.toContain("untouched");
    act(() => document.querySelector<HTMLButtonElement>(".workspace-diff-view__fold")!.click());
    expect(document.querySelector(".thread-preview")?.textContent).toContain("untouched");
  });

  it("keeps image changes on the file preview instead of a line diff", async () => {
    render({
      messages: [
        { id: "a1", role: "assistant", content: "Done", fileEdits: [{ call_id: "1", tool: "write", path: "cover.png", absolute_path: "/repo/cover.png", added: 1, status: "done" }] },
      ],
      context: {
        ...emptyContext(),
        artifactClient: artifactClient(),
        agentClient: {
          readWorkspaceEnvironmentDiff: async () => ({
            path: "cover.png",
            diff: "@@ -1 +1 @@\n-old\n+new\n",
            truncated: false,
            unavailable_reason: null,
          }),
        },
        sessionScope: { kind: "session", key: "session-1" },
        environment: readyEnvironment,
        workspaceRoot: "/repo",
      },
    });

    act(() => document.querySelector<HTMLButtonElement>(".thread-view-pill")!.click());
    act(() => clickText(".thread-view-menu__item", "变更"));
    await act(async () => clickText(".thread-changes__button", "cover.png"));
    await flush();

    expect(document.querySelector(".thread-preview img")).not.toBeNull();
    expect(document.querySelector(".workspace-diff-view__fold")).toBeNull();
    expect(document.querySelector(".workspace-diff-view__line--addition")).toBeNull();
  });

  it("shows untracked files as fully added when git has no baseline", async () => {
    render({
      messages: [
        { id: "a1", role: "assistant", content: "Done", fileEdits: [{ call_id: "1", tool: "write", path: "new.ts", absolute_path: "/repo/new.ts", added: 2, status: "done" }] },
      ],
      context: {
        ...emptyContext(),
        artifactClient: artifactClient(),
        agentClient: {
          readWorkspaceEnvironmentDiff: async () => ({ path: "new.ts", diff: "", truncated: false, unavailable_reason: "untracked_diff_unavailable" }),
        },
        sessionScope: { kind: "session", key: "session-1" },
        environment: readyEnvironment,
        fetchFn: textFetch({ "/repo/new.ts": "export const created = true;\nexport default created;\n" }),
      },
    });

    act(() => document.querySelector<HTMLButtonElement>(".thread-view-pill")!.click());
    act(() => clickText(".thread-view-menu__item", "变更"));
    await act(async () => clickText(".thread-changes__button", "new.ts"));
    await flush();

    expect(document.querySelectorAll(".thread-preview .workspace-diff-view__line--addition")).toHaveLength(2);
    expect(document.querySelector(".thread-preview__notice")).toBeNull();
  });

  it("browses the workspace tree lazily through the desktop bridge", async () => {
    const readWorkspaceDirectory = vi.fn(async (rootPath: string, relativePath = "") => ({
      rootPath,
      relativePath,
      truncated: false,
      entries: relativePath === ""
        ? [
          { name: "src", path: "/repo/src", relativePath: "src", kind: "directory" as const },
          { name: "README.md", path: "/repo/README.md", relativePath: "README.md", kind: "file" as const },
        ]
        : [{ name: "index.ts", path: "/repo/src/index.ts", relativePath: "src/index.ts", kind: "file" as const }],
    }));
    Object.defineProperty(window, "memmy", { configurable: true, value: { readWorkspaceDirectory } });
    render({
      messages: [{ id: "a1", role: "assistant", content: "Done" }],
      workspaceRoot: "/repo",
      context: { ...emptyContext(), artifactClient: artifactClient(), fetchFn: textFetch({ "/repo/src/index.ts": "export {};\n" }) },
    });

    act(() => document.querySelector<HTMLButtonElement>(".thread-view-pill")!.click());
    act(() => clickText(".thread-view-menu__item", "工作空间文件"));
    await flush();

    expect(treeNames()).toEqual(["src", "README.md"]);
    await act(async () => clickText(".thread-tree__node", "src"));
    await flush();

    expect(readWorkspaceDirectory).toHaveBeenLastCalledWith("/repo", "src");
    expect(treeNames()).toEqual(["src", "index.ts", "README.md"]);
    await act(async () => clickText(".thread-tree__node", "index.ts"));
    await flush();

    expect(tabTitles()).toEqual(["index.ts"]);
    expect(document.querySelector(".thread-preview .workspace-diff-view")?.textContent).toContain("export {};");
  });

  it("remembers the resized width and leaves full screen with Escape", () => {
    render({ messages: [{ id: "a1", role: "assistant", content: "Done" }], context: emptyContext() });

    const sash = document.querySelector<HTMLElement>(".thread-panel__sash")!;
    act(() => sash.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(offset()).toBe(376);
    expect(JSON.parse(window.localStorage.getItem(THREAD_PANEL_WIDTH_STORAGE_KEY) ?? "{}")).toMatchObject({ sidebar: 376 });

    act(() => document.querySelector<HTMLButtonElement>('[aria-label="进入全屏"]')!.click());
    expect(document.querySelector(".thread-panel--fullscreen")).not.toBeNull();
    expect(document.body.classList.contains(THREAD_PANEL_FULLSCREEN_BODY_CLASS)).toBe(true);
    expect(document.querySelector('[aria-label="收起右栏"]')).toBeNull();

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(document.querySelector(".thread-panel--fullscreen")).toBeNull();
    expect(document.body.classList.contains(THREAD_PANEL_FULLSCREEN_BODY_CLASS)).toBe(false);
  });
});

function emptyContext(): ThreadPreviewContext {
  return { artifactClient: null, agentClient: null, sessionScope: null, environment: null, workspaceRoot: null };
}

async function flush() {
  for (let index = 0; index < 6; index += 1) {
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
  }
}

function byTestId(id: string): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
}

function offset(): number {
  return Number(byTestId("offset").textContent);
}

function itemTitles(): string[] {
  return [...document.querySelectorAll(".thread-panel__list .thread-overview-item")].map((item) => item.textContent ?? "");
}

function tabTitles(): string[] {
  return [...document.querySelectorAll(".thread-tab__title")].map((item) => item.textContent ?? "");
}

function treeNames(): string[] {
  return [...document.querySelectorAll(".thread-tree__name")].map((item) => item.textContent ?? "");
}

function clickText(selector: string, text: string) {
  const target = [...document.querySelectorAll<HTMLElement>(selector)].find((element) => element.textContent?.includes(text));
  if (!target) throw new Error(`No ${selector} containing ${text}`);
  target.click();
}
