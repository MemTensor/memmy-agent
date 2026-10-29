import editorWorker from "monaco-editor/editor/editor.worker.js?worker";
import { editableCodeEditorOptions, monacoLanguageId } from "./editable-code-editor-options.js";

export type EditableCodeEditorCallbacks = {
  onChange: (value: string) => void;
  onSave: () => void;
};

let themeReady = false;

function ensureMonacoEnvironment(): void {
  const scope = globalThis as typeof globalThis & {
    MonacoEnvironment?: { getWorker: (workerId: string, label: string) => Worker };
  };
  scope.MonacoEnvironment = {
    getWorker() {
      return new editorWorker();
    },
  };
}

function ensureEditorTheme(monaco: typeof import("monaco-editor")): void {
  if (themeReady) return;
  monaco.editor.defineTheme("memmy-editor", {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#ffffff",
      "editor.foreground": "#111d1c",
      "editorCursor.foreground": "#111d1c",
      "editorLineNumber.foreground": "#8aa39c",
      "editorLineNumber.activeForeground": "#111d1c",
      "editor.lineHighlightBackground": "#f3f8f7",
      "editor.selectionBackground": "#d7efe8",
      "editor.inactiveSelectionBackground": "#e7f5f1",
      "editorGutter.background": "#ffffff",
      "minimap.background": "#ffffff",
      "editorWidget.background": "#ffffff",
      "editorWidget.border": "#cce0db",
      focusBorder: "#5cbfae",
    },
  });
  themeReady = true;
}

export async function mountEditableCodeEditor(
  host: HTMLElement,
  input: { text: string; path: string; callbacks: EditableCodeEditorCallbacks },
): Promise<{ dispose: () => void }> {
  ensureMonacoEnvironment();
  const monaco = await import("monaco-editor");
  ensureEditorTheme(monaco);
  const fontFamily = getComputedStyle(host).getPropertyValue("--font-mono").trim()
    || "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
  const editor = monaco.editor.create(host, {
    ...editableCodeEditorOptions(fontFamily),
    value: input.text,
    language: monacoLanguageId(input.path),
    theme: "memmy-editor",
    ariaLabel: input.path,
  });
  const change = editor.onDidChangeModelContent(() => {
    input.callbacks.onChange(editor.getValue());
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    input.callbacks.onSave();
  });
  return {
    dispose() {
      change.dispose();
      editor.dispose();
    },
  };
}
