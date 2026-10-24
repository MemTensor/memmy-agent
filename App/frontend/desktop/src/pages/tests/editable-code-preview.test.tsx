// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { canEditWorkspacePreview, editableCodeEditorOptions, monacoLanguageId } from "../editable-code-editor-options.js";
import { EditableCodePreview } from "../editable-code-preview.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("editable workspace preview", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(window, "memmy");
  });

  it("matches Cursor's editable editor defaults", () => {
    const options = editableCodeEditorOptions("ui-monospace, monospace");
    expect(options.readOnly).toBe(false);
    expect(options.domReadOnly).toBe(false);
    expect(options.scrollBeyondLastLine).toBe(true);
    expect(options.wordWrap).toBe("off");
    expect(options.minimap.enabled).toBe(false);
    expect(options.stickyScroll.enabled).toBe(false);
    expect(options.fontSize).toBe(14);
    expect(monacoLanguageId("/repo/pg.py")).toBe("python");
    expect(canEditWorkspacePreview("/repo/pg.py", null)).toBe(false);
  });

  it("saves edited text with the workspace bridge and clears the dirty state", async () => {
    const writeWorkspaceFile = vi.fn(async () => undefined);
    Object.defineProperty(window, "memmy", {
      configurable: true,
      value: { platform: "darwin", writeWorkspaceFile },
    });
    const states: Array<{ dirty: boolean; saving: boolean } | null> = [];

    act(() => {
      root.render(
        <I18nProvider language="zh-CN">
          <EditableCodePreview
            path="/repo/pg.py"
            workspaceRoot="/repo"
            diskText="print('old')\n"
            initialText="print('old')\n"
            ariaLabel="pg.py"
            onDraft={() => undefined}
            onDraftClear={() => undefined}
            onEditorState={(state) => states.push(state ? { dirty: state.dirty, saving: state.saving } : null)}
          />
        </I18nProvider>,
      );
    });

    const field = container.querySelector("textarea");
    expect(field).not.toBeNull();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(field, "print('new')\n");
      field?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(states.at(-1)?.dirty).toBe(true);

    await act(async () => {
      field?.dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true }));
    });

    expect(writeWorkspaceFile).toHaveBeenCalledWith("/repo", "/repo/pg.py", "print('new')\n");
    expect(states.at(-1)?.dirty).toBe(false);
  });
});
