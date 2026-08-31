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
    sessionKey: string,
    relativePath: string
  ) => Promise<WorkspaceFilesListing>>>;
  let loadPreview: ReturnType<typeof vi.fn<(path: string) => Promise<{
    title: string;
    sections: Array<{ heading: string; body: string }>;
  } | null>>>;

  beforeEach(async () => {
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    onAddToChat = vi.fn();
    loadDirectory = vi.fn(async (_sessionKey, relativePath) => listing(relativePath));
    loadPreview = vi.fn(async (path) => ({
      title: path.split("/").pop()!,
      sections: [{ heading: "真实文件预览", body: path }]
    }));
    await renderPreview();
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it("loads the active real root and preserves the literature file-tree shell", () => {
    expect(loadDirectory).toHaveBeenCalledWith(SESSION_KEY, "");
    expect(loadDirectory).toHaveBeenCalledWith(SESSION_KEY, "downloads");
    expect(loadDirectory).toHaveBeenCalledWith(SESSION_KEY, "outputs");
    expect(loadDirectory).not.toHaveBeenCalledWith(SESSION_KEY, "notes");
    expect(folderButtons().map((button) => button.textContent)).toEqual(["downloads", "outputs", "notes"]);
    expect(fileButtonLabels()).toEqual([
      "研究资料.pdf",
      "证据.pdf",
      "综述.tex"
    ]);
    expect(activeTab()?.textContent).toContain("研究资料.pdf");
    expect(container.querySelector(".workspace-artifact-preview-document")?.textContent).toContain("真实文件预览");
    expect(container.querySelector(".workspace-artifact-preview-crumb")?.textContent).toContain("memmy-agent");
    expect(container.querySelectorAll('[role="separator"]')).toHaveLength(2);
  });

  it("collapses folders and toggles the whole file tree without losing the open tab", () => {
    act(() => folderButtons()[0]!.click());
    expect(fileButtonLabels()).not.toContain("研究资料.pdf");

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

    expect(loadDirectory).toHaveBeenCalledWith(SESSION_KEY, "notes");
    expect(fileButtonLabels()).toContain("README.md");
  });

  it("opens real files in closable tabs and falls back to the previous tab", async () => {
    const evidence = fileButtons().find((button) => button.textContent?.trim() === "证据.pdf")!;
    await act(async () => {
      evidence.click();
      await Promise.resolve();
    });

    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(activeTab()?.textContent).toContain("证据.pdf");
    expect(loadPreview).toHaveBeenLastCalledWith("downloads/证据.pdf");

    await act(async () => {
      activeTab()!.querySelector<HTMLButtonElement>(".workspace-artifact-file-tab__close")!.click();
      await Promise.resolve();
    });
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
    expect(activeTab()?.textContent).toContain("研究资料.pdf");
  });

  it("adds the session-relative file path to chat from the context menu", () => {
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

  it("writes the session-relative path reference when a file is dragged", () => {
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
    const replacement = vi.fn(async (_sessionKey: string, relativePath: string) => listing(relativePath));
    loadDirectory = replacement;
    await renderPreview();

    expect(replacement).not.toHaveBeenCalled();
    expect(fileButtonLabels()).toContain("研究资料.pdf");
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

  async function renderPreview(refreshKey = 0) {
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <WorkspaceArtifactPanel
            sessionKey={SESSION_KEY}
            rootLabel="memmy-agent"
            loadDirectory={loadDirectory}
            loadPreview={loadPreview}
            onAddToChat={onAddToChat}
            refreshKey={refreshKey}
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
