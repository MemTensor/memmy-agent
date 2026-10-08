import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, FolderOpen, LoaderCircle, RotateCw, Save } from "lucide-react";
import type {
  MemmyAgentClient,
  WorkspaceEnvironmentScope,
  WorkspaceEnvironmentState,
} from "../api/memmy-agent-client.js";
import { useTranslation } from "../i18n/use-translation.js";
import { AgentMessageContent, type AgentArtifactClient } from "./agent-message-content.js";
import { ThreadFileIcon } from "./agent-thread-file-icon.js";
import {
  joinThreadPath,
  relativeThreadPath,
  threadFileExtension,
  threadPreviewKind,
  type ThreadPanelTab,
} from "./agent-thread-panel-model.js";
import { canEditWorkspacePreview } from "./editable-code-editor-options.js";
import { EditableCodePreview, type PreviewEditorControls } from "./editable-code-preview.js";
import { isLineOrientedDiff, WorkspaceDiffView, workspaceDiffStats, workspaceFileLineCount, WorkspaceSourceView } from "./workspace-diff-view.js";

export const THREAD_TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
export const THREAD_CSV_PREVIEW_MAX_ROWS = 500;

type ThreadPreviewState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "unsupported" }
  | { status: "too-large" }
  | { status: "unavailable" }
  | { status: "ready"; kind: "pdf" | "html"; objectUrl: string }
  | { status: "ready"; kind: "image" | "video"; url: string }
  | { status: "ready"; kind: "markdown" | "code" | "text" | "csv"; text: string }
  | { status: "ready"; kind: "diff"; diff: string; fileText: string | null }
  | { status: "ready"; kind: "source"; text: string; lineKind: "addition" | "context"; notice: boolean };

type LoadResult = { state: ThreadPreviewState; path: string | null; objectUrl?: string };

export type ThreadPreviewContext = {
  artifactClient: AgentArtifactClient | null;
  onPreviewFile?: (file: { name: string; path?: string; url?: string }) => boolean;
  agentClient: Pick<MemmyAgentClient, "readWorkspaceEnvironmentDiff"> | null;
  sessionScope: WorkspaceEnvironmentScope | null;
  environment: WorkspaceEnvironmentState | null;
  workspaceRoot: string | null;
  fetchFn?: typeof fetch;
};

export function ThreadTabPreview(props: { tab: ThreadPanelTab; context: ThreadPreviewContext }) {
  const { t } = useTranslation();
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<LoadResult>({ state: { status: "loading" }, path: null });
  const { tab, context } = props;

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | undefined;
    setResult({ state: { status: "loading" }, path: null });
    const load = tab.type === "change" ? loadChangePreview(tab, context) : loadFilePreview(tab, context);
    load
      .then((next) => {
        if (cancelled) {
          if (next.objectUrl) URL.revokeObjectURL(next.objectUrl);
          return;
        }
        objectUrl = next.objectUrl;
        setResult(next);
      })
      .catch(() => {
        if (!cancelled) setResult({ state: { status: "error" }, path: null });
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // The tab identity and reload attempt define a load; context objects are read at load time.
  }, [tab.id, attempt]);

  const filePath = result.path ?? (tab.type === "change" ? tab.absolutePath ?? tab.path : tab.path ?? null);
  const fileActions = Boolean(context.artifactClient && filePath);
  const changeStats = tab.type === "change" ? previewChangeStats(tab, result.state) : null;
  const draftsRef = useRef(new Map<string, string>());
  const [editorControls, setEditorControls] = useState<PreviewEditorControls | null>(null);
  const onEditorState = useCallback((state: PreviewEditorControls | null) => {
    setEditorControls(state);
  }, []);
  const onDraft = useCallback((path: string, text: string) => {
    draftsRef.current.set(path, text);
  }, []);
  const onDraftClear = useCallback((path: string) => {
    draftsRef.current.delete(path);
  }, []);
  const saveShortcut = /mac/iu.test(window.memmy?.platform ?? navigator.platform) ? "⌘S" : "Ctrl+S";

  return (
    <div className="thread-preview">
      <div className="thread-preview__header">
        <div className="thread-preview__heading">
          {editorControls?.dirty ? <span className="thread-preview__dirty" title={t("home.threadPanel.preview.dirty")} /> : null}
          <span className="thread-preview__title" title={filePath ?? tab.name}>{tab.name}</span>
        </div>
        <div className="thread-preview__actions">
          {editorControls && (editorControls.dirty || editorControls.saving) ? (
            <button
              type="button"
              className="thread-preview__action"
              aria-label={t("home.threadPanel.preview.save")}
              title={`${t("home.threadPanel.preview.save")} (${saveShortcut})`}
              disabled={editorControls.saving}
              onClick={() => editorControls.save()}
            >
              <Save size={16} aria-hidden="true" />
            </button>
          ) : null}
          {changeStats && (changeStats.added > 0 || changeStats.deleted > 0) ? (
            <span className="thread-preview__stats">
              {changeStats.added > 0 ? <span className="thread-preview__stat-added">+{changeStats.added}</span> : null}
              {changeStats.deleted > 0 ? <span className="thread-preview__stat-removed">-{changeStats.deleted}</span> : null}
            </span>
          ) : null}
          {fileActions ? (
            <>
              <button
                type="button"
                className="thread-preview__action"
                aria-label={t("home.threadPanel.preview.open")}
                title={t("home.threadPanel.preview.open")}
                onClick={() => void context.artifactClient?.openArtifact(filePath!).catch(() => undefined)}
              >
                <ExternalLink size={16} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="thread-preview__action"
                aria-label={t("appFrame.project.reveal")}
                title={t("appFrame.project.reveal")}
                onClick={() => void context.artifactClient?.revealArtifact(filePath!).catch(() => undefined)}
              >
                <FolderOpen size={16} aria-hidden="true" />
              </button>
            </>
          ) : null}
        </div>
      </div>
      <div className="thread-preview__body">
        <ThreadPreviewBody
          name={tab.name}
          path={filePath ?? tab.name}
          state={result.state}
          artifactClient={context.artifactClient}
          onPreviewFile={context.onPreviewFile}
          onRetry={() => setAttempt((value) => value + 1)}
          onOpen={fileActions ? () => void context.artifactClient?.openArtifact(filePath!).catch(() => undefined) : undefined}
          workspaceRoot={context.workspaceRoot}
          draft={filePath ? draftsRef.current.get(filePath) : undefined}
          onDraft={onDraft}
          onDraftClear={onDraftClear}
          onEditorState={onEditorState}
        />
      </div>
    </div>
  );
}

function ThreadPreviewBody(props: {
  name: string;
  path: string;
  state: ThreadPreviewState;
  artifactClient: AgentArtifactClient | null;
  onPreviewFile?: (file: { name: string; path?: string; url?: string }) => boolean;
  onRetry: () => void;
  onOpen?: () => void;
  workspaceRoot: string | null;
  draft?: string;
  onDraft: (path: string, text: string) => void;
  onDraftClear: (path: string) => void;
  onEditorState: (state: PreviewEditorControls | null) => void;
}) {
  const { t } = useTranslation();
  const { state } = props;
  if (state.status === "loading") {
    return (
      <div className="thread-preview__placeholder" role="status">
        <LoaderCircle size={18} className="thread-panel-spin" aria-hidden="true" />
        <span>{t("home.threadPanel.preview.loading")}</span>
      </div>
    );
  }
  if (state.status !== "ready") {
    const message = state.status === "error"
      ? t("home.threadPanel.preview.failed")
      : state.status === "too-large"
        ? t("home.threadPanel.preview.tooLarge")
        : state.status === "unavailable"
          ? t("home.threadPanel.preview.unavailable")
          : t("home.threadPanel.preview.unsupported");
    return (
      <div className="thread-preview__placeholder">
        <span className="thread-preview__placeholder-icon"><ThreadFileIcon name={props.name} /></span>
        <span className="thread-preview__placeholder-name">{props.name}</span>
        <span className="thread-preview__placeholder-message">{message}</span>
        {state.status === "error" ? (
          <button type="button" className="thread-preview__retry" onClick={props.onRetry}>
            <RotateCw size={14} aria-hidden="true" />
            <span>{t("home.threadPanel.preview.retry")}</span>
          </button>
        ) : (state.status === "unsupported" || state.status === "too-large") && props.onOpen ? (
          <button type="button" className="thread-preview__retry" onClick={props.onOpen}>
            <ExternalLink size={14} aria-hidden="true" />
            <span>{t("home.threadPanel.preview.open")}</span>
          </button>
        ) : null}
      </div>
    );
  }
  switch (state.kind) {
    case "pdf":
      return <iframe className="thread-preview__frame" src={state.objectUrl} title={props.name} />;
    case "html":
      return (
        <iframe
          className="thread-preview__frame thread-preview__frame--html"
          src={state.objectUrl}
          title={props.name}
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
        />
      );
    case "image":
      return (
        <div className="thread-preview__media">
          <img src={state.url} alt={props.name} />
        </div>
      );
    case "video":
      return (
        <div className="thread-preview__media">
          <video src={state.url} controls />
        </div>
      );
    case "markdown":
      return (
        <div className="thread-preview__document">
          <AgentMessageContent content={state.text} artifactClient={props.artifactClient} onPreviewFile={props.onPreviewFile} />
        </div>
      );
    case "csv":
      return <ThreadCsvTable text={state.text} delimiter={threadFileExtension(props.name) === "tsv" ? "\t" : ","} />;
    case "diff":
      return (
        <div className="thread-preview__code">
          <WorkspaceDiffView diff={state.diff} path={props.path} fileText={state.fileText} ariaLabel={t("home.threadPanel.diff.label", { path: props.path })} />
        </div>
      );
    case "source":
      return (
        <div className="thread-preview__code">
          {state.notice ? <p className="thread-preview__notice">{t("home.threadPanel.diff.noBaseline")}</p> : null}
          <WorkspaceSourceView text={state.text} path={props.path} kind={state.lineKind} ariaLabel={props.name} />
        </div>
      );
    case "code":
    case "text":
      if (canEditWorkspacePreview(props.path, props.workspaceRoot)) {
        return (
          <EditableCodePreview
            key={props.path}
            path={props.path}
            workspaceRoot={props.workspaceRoot ?? ""}
            diskText={state.text}
            initialText={props.draft ?? state.text}
            ariaLabel={props.name}
            onDraft={props.onDraft}
            onDraftClear={props.onDraftClear}
            onEditorState={props.onEditorState}
          />
        );
      }
      return (
        <div className="thread-preview__code">
          <WorkspaceSourceView text={state.text} path={props.path} ariaLabel={props.name} />
        </div>
      );
  }
}

function ThreadCsvTable(props: { text: string; delimiter: string }) {
  const { t } = useTranslation();
  const rows = useMemo(() => parseDelimitedRows(props.text, props.delimiter, THREAD_CSV_PREVIEW_MAX_ROWS + 1), [props.delimiter, props.text]);
  const [header = [], ...body] = rows.slice(0, THREAD_CSV_PREVIEW_MAX_ROWS);
  const columnCount = Math.max(header.length, ...body.map((row) => row.length));
  return (
    <div className="thread-preview__table-wrap">
      <table className="thread-preview__table">
        <thead>
          <tr>{Array.from({ length: columnCount }, (_, index) => <th key={index}>{header[index] ?? ""}</th>)}</tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex}>{Array.from({ length: columnCount }, (_, index) => <td key={index}>{row[index] ?? ""}</td>)}</tr>
          ))}
        </tbody>
      </table>
      {rows.length > THREAD_CSV_PREVIEW_MAX_ROWS ? (
        <p className="thread-preview__notice">{t("home.threadPanel.csv.truncated", { count: THREAD_CSV_PREVIEW_MAX_ROWS })}</p>
      ) : null}
    </div>
  );
}

export function parseDelimitedRows(text: string, delimiter: string, limit: number): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length && rows.length < limit; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === "\"" && text[index + 1] === "\"") {
        cell += "\"";
        index += 1;
      } else if (char === "\"") {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === "\"" && cell === "") {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if ((cell || row.length) && rows.length < limit) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

async function loadFilePreview(
  tab: { name: string; path?: string; url?: string },
  context: ThreadPreviewContext,
): Promise<LoadResult> {
  const kind = threadPreviewKind(tab.name);
  let path = tab.path ?? null;
  let mediaUrl = tab.url ?? null;
  if (tab.path && context.artifactClient) {
    const resolved = await context.artifactClient.resolveArtifact(tab.path);
    path = resolved.path;
    mediaUrl = resolved.media_url ?? mediaUrl;
  }
  if (kind === "unsupported") return { state: { status: "unsupported" }, path };
  if (!mediaUrl) return { state: { status: "unavailable" }, path };
  if (kind === "image" || kind === "video") return { state: { status: "ready", kind, url: mediaUrl }, path };

  const blob = await fetchBlob(mediaUrl, context.fetchFn);
  if (kind === "pdf") {
    const objectUrl = URL.createObjectURL(new Blob([blob], { type: "application/pdf" }));
    return { state: { status: "ready", kind: "pdf", objectUrl }, path, objectUrl };
  }
  if (blob.size > THREAD_TEXT_PREVIEW_MAX_BYTES) return { state: { status: "too-large" }, path };
  const text = await blob.text();
  if (kind === "html") {
    const objectUrl = URL.createObjectURL(new Blob([text], { type: "text/html;charset=utf-8" }));
    return { state: { status: "ready", kind: "html", objectUrl }, path, objectUrl };
  }
  return { state: { status: "ready", kind, text }, path };
}

async function loadChangePreview(
  tab: Extract<ThreadPanelTab, { type: "change" }>,
  context: ThreadPreviewContext,
): Promise<LoadResult> {
  const snapshot = context.environment?.snapshot ?? null;
  const base = snapshot?.cwd || context.workspaceRoot || "";
  const absolute = tab.absolutePath ?? joinThreadPath(base, tab.path);
  const repositoryRoot = snapshot?.status === "ready" ? snapshot.repository?.root ?? null : null;
  const relative = repositoryRoot ? relativeThreadPath(repositoryRoot, absolute) : null;
  let untracked = false;

  if (context.agentClient && context.sessionScope && relative) {
    try {
      const diff = await context.agentClient.readWorkspaceEnvironmentDiff(context.sessionScope, relative);
      if (shouldShowLineDiff(tab.name, diff.diff)) {
        const fileText = await readWorkspaceText(absolute, context);
        return { state: { status: "ready", kind: "diff", diff: diff.diff, fileText }, path: absolute };
      }
      untracked = diff.unavailable_reason === "untracked_diff_unavailable";
    } catch {
      untracked = false;
    }
  }

  const previewKind = threadPreviewKind(tab.name);
  if (previewKind !== "code" && previewKind !== "text" && previewKind !== "markdown" && previewKind !== "html" && previewKind !== "csv") {
    return loadFilePreview({ name: tab.name, path: absolute }, context);
  }
  if (!context.artifactClient) return { state: { status: "unavailable" }, path: absolute };
  const resolved = await context.artifactClient.resolveArtifact(absolute);
  if (!resolved.media_url) return { state: { status: "unavailable" }, path: resolved.path };
  const blob = await fetchBlob(resolved.media_url, context.fetchFn);
  if (blob.size > THREAD_TEXT_PREVIEW_MAX_BYTES) return { state: { status: "too-large" }, path: resolved.path };
  return {
    state: { status: "ready", kind: "source", text: await blob.text(), lineKind: untracked ? "addition" : "context", notice: !untracked },
    path: resolved.path,
  };
}

export function shouldShowLineDiff(name: string, diff: string): boolean {
  const kind = threadPreviewKind(name);
  return (kind === "code" || kind === "text" || kind === "markdown" || kind === "html" || kind === "csv") && isLineOrientedDiff(diff);
}

function previewChangeStats(
  tab: Extract<ThreadPanelTab, { type: "change" }>,
  state: ThreadPreviewState,
): { added: number; deleted: number } {
  if (state.status === "ready" && state.kind === "diff") return workspaceDiffStats(state.diff);
  if (state.status === "ready" && state.kind === "source" && state.lineKind === "addition") {
    return { added: workspaceFileLineCount(state.text), deleted: 0 };
  }
  return { added: tab.added, deleted: tab.deleted };
}

async function readWorkspaceText(absolute: string, context: ThreadPreviewContext): Promise<string | null> {
  if (!context.artifactClient) return null;
  try {
    const resolved = await context.artifactClient.resolveArtifact(absolute);
    if (!resolved.media_url) return null;
    const blob = await fetchBlob(resolved.media_url, context.fetchFn);
    if (blob.size > THREAD_TEXT_PREVIEW_MAX_BYTES) return null;
    return blob.text();
  } catch {
    return null;
  }
}

async function fetchBlob(url: string, fetchFn: typeof fetch = fetch): Promise<Blob> {
  const response = await fetchFn(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`preview request failed: ${response.status}`);
  return response.blob();
}
