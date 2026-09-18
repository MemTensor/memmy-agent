// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import type { WorkspaceFilesListing } from "../../api/memmy-agent-client.js";
import { readComposerReferenceDrag } from "../../lib/composer-file-reference.js";
import type { ComposerContextReference } from "../../state/agent-composer-state.js";
import {
  WorkspaceArtifactPanel,
  type WorkspaceArtifactEntry
} from "../workspace-artifact-panel.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION_KEY = "websocket:chat-real";
const ROOT_ENTRIES: WorkspaceArtifactEntry[] = [
  {
    path: "downloads",
    name: "downloads",
    kind: "directory",
    size: null,
    modifiedAt: null
  },
  {
    path: "outputs",
    name: "outputs",
    kind: "directory",
    size: null,
    modifiedAt: null
  },
  {
    path: "notes",
    name: "notes",
    kind: "directory",
    size: null,
    modifiedAt: null
  }
];

const ENTRIES_BY_DIRECTORY: Record<string, WorkspaceArtifactEntry[]> = {
  "": ROOT_ENTRIES,
  downloads: [
    {
      path: "downloads/研究资料.pdf",
      name: "研究资料.pdf",
      kind: "file",
      size: 24,
      modifiedAt: null
    },
    {
      path: "downloads/证据.pdf",
      name: "证据.pdf",
      kind: "file",
      size: 18,
      modifiedAt: null
    }
  ],
  outputs: [{
    path: "outputs/综述.tex",
    name: "综述.tex",
    kind: "file",
    size: 30,
    modifiedAt: null
  }],
  notes: [{
    path: "notes/README.md",
    name: "README.md",
    kind: "file",
    size: 12,
    modifiedAt: null
  }]
};

function listing(path: string, entries = ENTRIES_BY_DIRECTORY[path] ?? [], truncated = false): WorkspaceFilesListing {
  return {
    root: { kind: "project", label: "memmy-agent" },
    path,
    entries,
    truncated
  };
}

describe("WorkspaceArtifactPanel", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onAddToChat: ReturnType<typeof vi.fn<(reference: ComposerContextReference) => void>>;
  let loadDirectory: ReturnType<typeof vi.fn<(
    scope: { kind: "session"; key: string },
    relativePath: string
  ) => Promise<WorkspaceFilesListing>>>;
  let loadFile: ReturnType<typeof vi.fn<(path: string) => Promise<Blob>>>;

  beforeEach(async () => {
    if (typeof window.localStorage?.clear === "function") window.localStorage.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    onAddToChat = vi.fn();
    loadDirectory = vi.fn(async (_scope, relativePath) => listing(relativePath));
    loadFile = vi.fn(async (path) => new Blob([path], {
      type: path.endsWith(".pdf") ? "application/pdf" : "text/plain"
    }));
    await renderPreview();
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it("loads only the active real root until a folder is expanded", () => {
    expect(loadDirectory).toHaveBeenCalledWith({ kind: "session", key: SESSION_KEY }, "");
    expect(loadDirectory).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".workspace-artifact-file-root")).toBeNull();
    expect(folderButtons().map((button) => button.textContent)).toEqual(["downloads", "outputs", "notes"]);
    expect(fileButtonLabels()).toEqual([]);
    expect(activeTab()).toBeNull();
    expect(container.querySelectorAll('[role="separator"]')).toHaveLength(2);
    const preview = container.querySelector(".workspace-artifact-preview-main")!;
    const browser = container.querySelector<HTMLElement>(".workspace-artifact-file-browser")!;
    expect(browser.style.width).toBe("200px");
    expect(preview.compareDocumentPosition(browser) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    const toolbar = container.querySelector(".workspace-artifact-preview-toolbar")!;
    const toggle = toolbar.querySelector(".workspace-artifact-file-browser__toggle")!;
    const tabs = toolbar.querySelector(".workspace-artifact-file-tabs")!;
    expect(toggle.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("collapses folders and toggles the whole file tree without losing the open tab", async () => {
    await expandFolder("downloads");
    const research = fileButtons().find((button) => button.textContent?.trim() === "研究资料.pdf")!;
    act(() => research.click());
    act(() => folderButtons()[0]!.click());
    expect(activeTab()?.textContent).toContain("研究资料.pdf");

    const toggle = container.querySelector<HTMLButtonElement>(".workspace-artifact-file-browser__toggle")!;
    act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".workspace-artifact-file-list")).toBeNull();
    expect(activeTab()?.textContent).toContain("研究资料.pdf");

    act(() => toggle.click());
    act(() => folderButtons()[0]!.click());
    expect(fileButtonLabels()).toContain("研究资料.pdf");
  });

  it("loads an ordinary directory only when the user expands it", async () => {
    const notes = folderButtons().find((button) => button.textContent === "notes")!;
    expect(notes.getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      notes.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(loadDirectory).toHaveBeenCalledWith({ kind: "session", key: SESSION_KEY }, "notes");
    expect(fileButtonLabels()).toContain("README.md");
  });

  it("opens real files in closable tabs and falls back to the previous tab", async () => {
    await expandFolder("downloads");
    const research = fileButtons().find((button) => button.textContent?.trim() === "研究资料.pdf")!;
    act(() => research.click());
    const evidence = fileButtons().find((button) => button.textContent?.trim() === "证据.pdf")!;
    await act(async () => {
      evidence.click();
      await Promise.resolve();
    });

    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(activeTab()?.textContent).toContain("证据.pdf");
    expect(loadFile).toHaveBeenLastCalledWith("downloads/证据.pdf", expect.any(AbortSignal));

    await act(async () => {
      const close = activeTab()!.querySelector<HTMLButtonElement>(".workspace-artifact-file-tab__close")!;
      close.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
      close.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, cancelable: true })
      );
      await Promise.resolve();
    });
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
    expect(activeTab()?.textContent).toContain("研究资料.pdf");
  });

  it("preserves open tabs while the side preview is hidden or its listing refreshes", async () => {
    await expandFolder("downloads");
    const research = fileButtons().find((button) => button.textContent?.trim() === "研究资料.pdf")!;
    act(() => research.click());
    const evidence = fileButtons().find((button) => button.textContent?.trim() === "证据.pdf")!;
    act(() => evidence.click());

    await renderPreview(0, true);
    expect(container.querySelector('[role="tab"]')).toBeNull();

    await renderPreview(0, false);
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(activeTab()?.textContent).toContain("证据.pdf");

    await renderPreview(1, false);
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(activeTab()?.textContent).toContain("证据.pdf");
  });

  it("shows a compact path crumb above the preview and keeps the file toggle in the tab toolbar", async () => {
    await expandFolder("downloads");
    const research = fileButtons().find((button) => button.textContent?.trim() === "研究资料.pdf")!;
    act(() => research.click());

    const crumb = container.querySelector(".workspace-artifact-preview-crumb")!;
    expect(crumb.textContent).toContain("memmy-agent");
    expect(crumb.textContent).toContain("研究资料.pdf");
    expect(crumb.textContent).toContain("›");
    expect(container.querySelector(".workspace-artifact-breadcrumb-bar")).toBeNull();
    expect(container.querySelector(".workspace-artifact-preview-toolbar .workspace-artifact-file-browser__toggle")).not.toBeNull();
  });

  it("opens a workspace-relative path requested from outside the panel", async () => {
    await renderPreview(0, false, { path: "outputs/综述.tex", nonce: 1 });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(loadDirectory).toHaveBeenCalledWith({ kind: "session", key: SESSION_KEY }, "outputs");
    expect(activeTab()?.textContent).toContain("综述.tex");
    expect(container.querySelector(".workspace-artifact-preview-crumb")?.textContent).toContain("综述.tex");
  });

  it("adds the session-relative file path to chat from the context menu", async () => {
    await expandFolder("outputs");
    const latex = fileButtons().find((button) => button.textContent?.trim() === "综述.tex")!;
    act(() => latex.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 80,
      clientY: 100
    })));

    const addButton = container.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    act(() => addButton.click());

    expect(onAddToChat).toHaveBeenCalledWith({
      kind: "path",
      id: "outputs/综述.tex",
      label: "综述.tex"
    });
  });

  it("writes the session-relative path reference when a file is dragged", async () => {
    await expandFolder("downloads");
    const dataTransfer = new TestDataTransfer();
    const evidence = fileButtons().find((button) => button.textContent?.trim() === "证据.pdf")!;
    const event = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });

    act(() => evidence.dispatchEvent(event));

    expect(readComposerReferenceDrag(dataTransfer)).toEqual({
      kind: "path",
      id: "downloads/证据.pdf",
      label: "证据.pdf"
    });
  });

  it("shows the real-root empty state instead of synthesizing demo files", async () => {
    loadDirectory = vi.fn(async () => listing("", []));
    await renderPreview(1);

    expect(fileButtons()).toHaveLength(0);
    expect(container.textContent).toContain("暂无文件");
    expect(container.textContent).toContain("memmy-agent");
  });

  it("does not reload merely because an inline loader identity changes", async () => {
    const replacement = vi.fn(async (_scope: { kind: "session"; key: string }, relativePath: string) => listing(relativePath));
    loadDirectory = replacement;
    await renderPreview();

    expect(replacement).not.toHaveBeenCalled();
    expect(folderButtons()).toHaveLength(3);
  });

  it("ignores a nested directory response from an older refresh generation", async () => {
    let resolveNotes!: (value: WorkspaceFilesListing) => void;
    const pendingNotes = new Promise<WorkspaceFilesListing>((resolve) => {
      resolveNotes = resolve;
    });
    loadDirectory = vi.fn(async (_sessionKey, relativePath) => (
      relativePath === "notes" ? pendingNotes : listing(relativePath)
    ));
    await renderPreview(1);
    const notes = folderButtons().find((button) => button.textContent === "notes")!;
    act(() => notes.click());

    loadDirectory = vi.fn(async () => listing("", []));
    await renderPreview(2);
    await act(async () => {
      resolveNotes(listing("notes"));
      await Promise.resolve();
    });

    expect(fileButtonLabels()).toHaveLength(0);
    expect(container.textContent).not.toContain("README.md");
  });

  it("opens a staged media attachment as an external preview tab", async () => {
    const load = vi.fn(async () => new Blob(["%PDF-1.7"], { type: "application/pdf" }));
    await renderPreview(0, false, null, {
      id: "/tmp/media/review.pdf",
      name: "review.pdf",
      nonce: 7,
      load
    });

    expect(activeTab()?.textContent).toContain("review.pdf");
    expect(container.textContent).toContain("review.pdf");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(load).toHaveBeenCalled();
  });

  async function renderPreview(
    refreshKey = 0,
    hidden = false,
    focusFile: { path: string; nonce: number } | null = null,
    focusExternalFile: {
      id: string;
      name: string;
      nonce: number;
      load: (signal?: AbortSignal) => Promise<Blob>;
    } | null = null
  ) {
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <WorkspaceArtifactPanel
            scope={{ kind: "session", key: SESSION_KEY }}
            rootLabel="memmy-agent"
            loadDirectory={loadDirectory}
            loadFile={loadFile}
            onAddToChat={onAddToChat}
            refreshKey={refreshKey}
            hidden={hidden}
            focusFile={focusFile}
            focusExternalFile={focusExternalFile}
          />
        </I18nProvider>
      );
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function folderButtons(): HTMLButtonElement[] {
    return [...container.querySelectorAll<HTMLButtonElement>(".workspace-artifact-file-folder__toggle")];
  }

  function fileButtons(): HTMLButtonElement[] {
    return [...container.querySelectorAll<HTMLButtonElement>("button.workspace-artifact-file-item")];
  }

  function fileButtonLabels(): string[] {
    return fileButtons().map((button) => button.textContent?.trim() ?? "");
  }

  function activeTab(): HTMLDivElement | null {
    return container.querySelector<HTMLDivElement>(".workspace-artifact-file-tab--active");
  }

  async function expandFolder(name: string) {
    await act(async () => {
      folderButtons().find((button) => button.textContent === name)!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
  }
});

class TestDataTransfer {
  dropEffect: DataTransfer["dropEffect"] = "none";
  effectAllowed: DataTransfer["effectAllowed"] = "all";
  files = [] as unknown as FileList;
  items = [] as unknown as DataTransferItemList;
  types: readonly string[] = [];
  private readonly data = new Map<string, string>();

  clearData(format?: string): void {
    if (format) this.data.delete(format);
    else this.data.clear();
    this.types = [...this.data.keys()];
  }

  getData(format: string): string {
    return this.data.get(format) ?? "";
  }

  setData(format: string, value: string): void {
    this.data.set(format, value);
    this.types = [...this.data.keys()];
  }

  setDragImage(): void {}
}
