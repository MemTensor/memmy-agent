import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "../i18n/use-translation.js";
import type { EditableCodeEditorCallbacks } from "./editable-code-editor.js";

export type PreviewEditorControls = {
  dirty: boolean;
  saving: boolean;
  save: () => void;
};

type EditableCodePreviewProps = {
  path: string;
  workspaceRoot: string;
  diskText: string;
  initialText: string;
  ariaLabel: string;
  onDraft: (path: string, text: string) => void;
  onDraftClear: (path: string) => void;
  onEditorState: (state: PreviewEditorControls | null) => void;
};

export function EditableCodePreview(props: EditableCodePreviewProps) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement>(null);
  const initialTextRef = useRef(props.initialText);
  const callbacksRef = useRef<EditableCodeEditorCallbacks>({
    onChange: () => undefined,
    onSave: () => undefined,
  });
  const [value, setValue] = useState(props.initialText);
  const [savedText, setSavedText] = useState(props.diskText);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plainEditor, setPlainEditor] = useState(import.meta.env.MODE === "test");
  const valueRef = useRef(props.initialText);
  const savedRef = useRef(props.diskText);
  const savingRef = useRef(false);
  const dirty = value !== savedText;
  const { onDraft, onDraftClear, onEditorState, path, workspaceRoot } = props;

  const save = useCallback(async () => {
    const current = valueRef.current;
    if (savingRef.current || current === savedRef.current) return;
    const writeWorkspaceFile = window.memmy?.writeWorkspaceFile;
    if (!writeWorkspaceFile) {
      setError(t("home.threadPanel.preview.saveFailed"));
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await writeWorkspaceFile(workspaceRoot, path, current);
      savedRef.current = current;
      setSavedText(current);
      onDraftClear(path);
    } catch {
      setError(t("home.threadPanel.preview.saveFailed"));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [onDraftClear, path, t, workspaceRoot]);

  callbacksRef.current.onChange = (next) => {
    valueRef.current = next;
    setValue(next);
    onDraft(path, next);
  };
  callbacksRef.current.onSave = () => {
    void save();
  };

  const reportSave = useCallback(() => {
    void save();
  }, [save]);

  useEffect(() => {
    onEditorState({ dirty, saving, save: reportSave });
  }, [dirty, onEditorState, reportSave, saving]);

  useEffect(() => () => onEditorState(null), [onEditorState]);

  useEffect(() => {
    if (plainEditor) return undefined;
    const host = hostRef.current;
    if (!host) return undefined;
    let disposed = false;
    let editor: { dispose: () => void } | null = null;
    void import("./editable-code-editor.js")
      .then((mod) => mod.mountEditableCodeEditor(host, {
        text: initialTextRef.current,
        path,
        callbacks: callbacksRef.current,
      }))
      .then((mounted) => {
        if (disposed) {
          mounted.dispose();
          return;
        }
        editor = mounted;
      })
      .catch(() => {
        if (!disposed) setPlainEditor(true);
      });
    return () => {
      disposed = true;
      editor?.dispose();
    };
  }, [path, plainEditor]);

  return (
    <div className="editable-code-preview" role="region" aria-label={props.ariaLabel} data-editable="true">
      {error ? <p className="thread-preview__notice">{error}</p> : null}
      {plainEditor ? (
        <textarea
          className="editable-code-preview__plain"
          aria-label={props.ariaLabel}
          value={value}
          spellCheck={false}
          onChange={(event) => callbacksRef.current.onChange(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
              event.preventDefault();
              callbacksRef.current.onSave();
            }
          }}
        />
      ) : (
        <div ref={hostRef} className="editable-code-preview__host" />
      )}
    </div>
  );
}
