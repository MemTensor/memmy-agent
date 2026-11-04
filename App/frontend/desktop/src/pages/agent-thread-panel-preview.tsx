import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, ExternalLink, FolderOpen, LoaderCircle, RotateCw, Save } from "lucide-react";
import type {
  MemmyAgentClient,
  WorkspaceEnvironmentScope,
  WorkspaceEnvironmentState,
} from "../api/memmy-agent-client.js";
import { useTranslation } from "../i18n/use-translation.js";
import { AgentMessageContent, saveAttachmentFile, type AgentArtifactClient } from "./agent-message-content.js";
import { ThreadFileIcon } from "./agent-thread-file-icon.js";
import {
  joinThreadPath,
  normalizeThreadPath,
  relativeThreadPath,
  threadFileExtension,
  threadPreviewKind,
  type ThreadPanelTab,
} from "./agent-thread-panel-model.js";
import { canEditWorkspacePreview } from "./editable-code-editor-options.js";
import { EditableCodePreview, type PreviewEditorControls } from "./editable-code-preview.js";
import { isLineOrientedDiff, WorkspaceDiffView, workspaceDiffStats, workspaceFileLineCount, WorkspaceSourceView } from "./workspace-diff-view.js";

import type { FilePreviewResource } from "./file-preview/file-preview-types.js";
import { FilePreview } from "./file-preview/file-preview.js";

export const THREAD_TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
export const THREAD_PDF_PREVIEW_MAX_BYTES = 20 * 1024 * 1024;
export const THREAD_OFFICE_PREVIEW_MAX_BYTES = 25 * 1024 * 1024;
export const THREAD_CSV_PREVIEW_MAX_ROWS = 500;
export const THREAD_LIVE_EDIT_RETRY_DELAYS_MS = [250, 1_000, 2_000, 4_000] as const;

type ThreadPreviewState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "unsupported" }
  | { status: "too-large" }
  | { status: "unavailable" }
  | { status: "ready"; kind: "document"; resource: FilePreviewResource }
  | { status: "ready"; kind: "paged-text"; text: string; start: number; end: number; total: number; url: string }
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

export function ThreadTabPreview(props: { tab: Extract<ThreadPanelTab, { type: "file" | "change" }>; context: ThreadPreviewContext; revision?: string }) {
  const { t } = useTranslation();
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<LoadResult>({ state: { status: "loading" }, path: null });
  const [loadedVersion, setLoadedVersion] = useState(0);
  const [downloadState, setDownloadState] = useState<"idle" | "saving" | "saved">("idle");
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const { tab, context } = props;
  const currentTabId = useRef(tab.id);
  currentTabId.current = tab.id;
  const environmentRevision = tab.type === "change" ? context.environment?.snapshot.revision ?? "" : "";

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | undefined;
    const abortController = new AbortController();
    setResult((current) => current.state.status === "ready" && current.state.kind !== "pdf" && current.state.kind !== "html"
      ? current
      : { state: { status: "loading" }, path: null });
    setDownloadState("idle");
    setDownloadError(null);
    const load = loadPreviewDuringLiveEdit(
      () => tab.type === "change" ? loadChangePreview(tab, context, abortController.signal) : loadFilePreview(tab, context, abortController.signal),
      abortController.signal,
    );
    load
      .then((next) => {
        if (cancelled) {
          if (next.objectUrl) URL.revokeObjectURL(next.objectUrl);
          return;
        }
        objectUrl = next.objectUrl;
        setResult(next);
        setLoadedVersion((value) => value + 1);
      })
      .catch(() => {
        if (!cancelled) setResult({ state: { status: "error" }, path: null });
      });
    return () => {
      cancelled = true;
      abortController.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // Change previews reload when Git status arrives. File edits keep their own draft.
  }, [tab, attempt, environmentRevision, props.revision]);

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
  const canDownload = tab.type === "file" && Boolean(tab.url || tab.path);

  const download = async () => {
    if (tab.type !== "file" || downloadState === "saving") return;
    const requestedTabId = tab.id;
    setDownloadState("saving");
    setDownloadError(null);
    let url = tab.url;
    let name = tab.name;
    if (tab.path && context.artifactClient) {
      try {
        const resolved = await context.artifactClient.resolveArtifact(normalizeThreadPath(tab.path));
        url = resolved.media_url ?? url;
        name = resolved.name ?? name;
      } catch {
        // A still-valid URL can outlive a local temporary path.
      }
    }
    if (currentTabId.current !== requestedTabId) return;
    if (!url) {
      setDownloadState("idle");
      setDownloadError(t("home.threadPanel.preview.downloadFailed"));
      return;
    }
    const saved = await saveAttachmentFile(url, name);
    if (currentTabId.current !== requestedTabId) return;
    if (saved.status === "saved") {
      setDownloadState("saved");
    } else if (saved.status === "failed") {
      setDownloadState("idle");
      setDownloadError(saved.error || t("home.threadPanel.preview.downloadFailed"));
    } else {
      setDownloadState("idle");
    }
  };

  return (
    <div className="thread-preview">
      <div className="thread-preview__header">
        <div className="thread-preview__heading">
          {editorControls?.dirty ? <span className="thread-preview__dirty" title={t("home.threadPanel.preview.dirty")} /> : null}
          <span className="thread-preview__title" title={filePath ?? tab.name}>{tab.name}</span>
        </div>
        <div className="thread-preview__actions">
          {canDownload ? (
            <button
              type="button"
              className="thread-preview__action"
              aria-label={t("home.threadPanel.preview.download")}
              title={t("home.threadPanel.preview.download")}
              disabled={downloadState === "saving"}
              onClick={() => void download()}
            >
              <Download size={16} aria-hidden="true" />
            </button>
          ) : null}
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
      {downloadError ? <p role="alert" className="thread-preview__notice">{downloadError}</p> : null}
      {downloadState !== "idle" ? <p role="status" className="thread-preview__notice">{t(
        downloadState === "saving" ? "home.threadPanel.preview.savingDownload" : "home.threadPanel.preview.downloadSaved",
      )}</p> : null}
      <div className="thread-preview__body">
        <ThreadPreviewBody
          fetchFn={context.fetchFn}
          name={tab.name}
          path={filePath ?? tab.name}
          state={result.state}
          loadedVersion={loadedVersion}
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

/**
 * Editors commonly save by replacing the destination atomically, leaving a
 * short interval where resolve/fetch cannot see the file. WorkBuddy uses the
 * same shape of protection: debounce the first read and retry with a small
 * backoff instead of turning that transient window into a moved/deleted error.
 */
export async function loadPreviewDuringLiveEdit<T>(
  load: () => Promise<T>,
  signal?: AbortSignal,
  delays: readonly number[] = THREAD_LIVE_EDIT_RETRY_DELAYS_MS,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    if (signal?.aborted) throw new DOMException("Preview load aborted", "AbortError");
    if (attempt > 0) await waitForPreviewRetry(delays[attempt - 1]!, signal);
    try {
      return await load();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function waitForPreviewRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, delayMs);
    signal?.addEventListener("abort", () => {
      window.clearTimeout(timer);
      reject(new DOMException("Preview load aborted", "AbortError"));
    }, { once: true });
  });
}

function ThreadPreviewBody(props: {
  fetchFn?: typeof fetch;
  name: string;
  path: string;
  state: ThreadPreviewState;
  loadedVersion: number;
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
    case "document":
      return <FilePreview resource={state.resource} />;
    case "paged-text":
      return <PagedTextPreview key={props.path} initial={state} name={props.name} fetchFn={props.fetchFn} />;
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
            key={`${props.path}:${props.loadedVersion}`}
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

const TEXT_PAGE_BYTES = 256 * 1024;
type TextPage = { status: "ready"; kind: "paged-text"; text: string; start: number; end: number; total: number; url: string };

async function readTextPage(url: string, offset: number, fetchFn: typeof fetch = fetch, signal?: AbortSignal): Promise<TextPage | Response> {
  const response = await fetchFn(url, { cache: "no-store", headers: { Range: `bytes=${offset}-${offset + TEXT_PAGE_BYTES + 2}` }, signal });
  // A readable empty file cannot satisfy a byte range. Only the initial
  // request with an explicit zero total should enter the normal empty preview.
  if (offset === 0 && response.status === 416 && response.headers.get("content-range")?.trim() === "bytes */0") {
    return { status: "ready", kind: "paged-text", text: "", start: 0, end: 0, total: 0, url };
  }
  if (!response.ok) throw new Error(`preview request failed: ${response.status}`);
  if (response.status !== 206) return response;
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
  if (!range) throw new Error("Missing text range metadata");
  const blob = await readPreviewResponse(response, TEXT_PAGE_BYTES + 3, signal);
  if (!blob) throw new Error("Text range exceeded the requested preview size");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let first = 0;
  while (first < Math.min(3, bytes.length) && (bytes[first]! & 0xc0) === 0x80) first++;
  let end = Math.min(bytes.length, first + TEXT_PAGE_BYTES);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text: string | undefined;
  for (let trim = 0; trim <= 3 && end >= first; trim++, end--) {
    try { text = decoder.decode(bytes.subarray(first, end)); break; } catch { /* retry a complete UTF-8 boundary */ }
  }
  if (text === undefined) throw new Error("Invalid UTF-8 preview");
  return { status: "ready", kind: "paged-text", text, start: Number(range[1]) + first,
    end: Number(range[1]) + end, total: Number(range[3]), url };
}

function PagedTextPreview(props: { initial: TextPage; name: string; fetchFn?: typeof fetch }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(props.initial);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const textRef = useRef<HTMLPreElement>(null);
  const showTail = useRef(false);
  const requestRef = useRef<AbortController | null>(null);
  useEffect(() => () => requestRef.current?.abort(), []);
  useEffect(() => {
    if (textRef.current) textRef.current.scrollTop = showTail.current ? textRef.current.scrollHeight : 0;
  }, [page]);
  const load = async (offset: number) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true); setFailed(false);
    try {
      const next = await readTextPage(page.url, offset, props.fetchFn, controller.signal);
      if (next instanceof Response) throw new Error("Range preview unavailable");
      showTail.current = offset > 0 && next.end >= next.total;
      setPage(next);
    } catch { if (!controller.signal.aborted) setFailed(true); }
    finally {
      if (requestRef.current === controller) requestRef.current = null;
      if (!controller.signal.aborted) setLoading(false);
    }
  };
  return <div className="thread-preview__paged">
    <div className="thread-preview__text-pager" role="group" aria-label={t("home.threadPanel.preview.pages")}>
      <button type="button" disabled={loading || page.start === 0} onClick={() => void load(0)}>{t("home.threadPanel.preview.firstPage")}</button>
      <button type="button" disabled={loading || page.start === 0} onClick={() => void load(Math.max(0, page.start - TEXT_PAGE_BYTES))}>{t("home.threadPanel.preview.previousPage")}</button>
      <span>{page.start}–{page.end} / {page.total} B</span>
      <button type="button" disabled={loading || page.end >= page.total} onClick={() => void load(page.end)}>{t("home.threadPanel.preview.nextPage")}</button>
      <button type="button" disabled={loading || page.end >= page.total} onClick={() => void load(Math.max(0, page.total - TEXT_PAGE_BYTES))}>{t("home.threadPanel.preview.lastPage")}</button>
    </div>
    {failed ? <p role="alert">{t("home.threadPanel.preview.unavailable")}</p> : null}
    {loading ? <p role="status">{t("home.threadPanel.preview.loading")}</p> : null}
    <pre ref={textRef} className="thread-preview__text-page" aria-label={props.name}>{page.text}</pre>
  </div>;
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
  signal: AbortSignal,
): Promise<LoadResult> {
  const kind = threadPreviewKind(tab.name);
  let path = tab.path ?? null;
  let mediaUrl = tab.url ?? null;
  if (tab.path && context.artifactClient) {
    const resolved = await context.artifactClient.resolveArtifact(normalizeThreadPath(tab.path));
    path = resolved.path;
    mediaUrl = resolved.media_url ?? mediaUrl;
  }
  if ((kind === "document" || kind === "pdf") && mediaUrl) {
    const url = mediaUrl;
    const limit = kind === "pdf" ? THREAD_PDF_PREVIEW_MAX_BYTES : THREAD_OFFICE_PREVIEW_MAX_BYTES;
    const blob = await fetchPreviewBlob(url, limit, signal, context.fetchFn);
    if (!blob) return { state: { status: "too-large" }, path };
    const resource: FilePreviewResource = {
      id: path ?? url,
      name: tab.name,
      path: path ?? undefined,
      load: async () => blob,
      open: path && context.artifactClient ? () => context.artifactClient!.openArtifact(path!) : undefined,
      reveal: path && context.artifactClient ? () => context.artifactClient!.revealArtifact(path!) : undefined,
    };
    return { state: { status: "ready", kind: "document", resource }, path };
  }
  if (kind === "document") return { state: { status: "unavailable" }, path };
  if (kind === "unsupported") return { state: { status: "unsupported" }, path };
  if (!mediaUrl) return { state: { status: "unavailable" }, path };
  if (kind === "image" || kind === "video") return { state: { status: "ready", kind, url: mediaUrl }, path };

  // Large raw text stays bounded in both network reads and rendering. Smaller
  // files retain the existing full-file preview/editor behavior.
  if (["code", "text", "markdown", "csv"].includes(kind)) {
    const first = await readTextPage(mediaUrl, 0, context.fetchFn, signal);
    if (!(first instanceof Response)) {
      if (first.total > THREAD_TEXT_PREVIEW_MAX_BYTES) return { state: first, path };
      if (first.end >= first.total) return { state: { status: "ready", kind: kind as "code" | "text" | "markdown" | "csv", text: first.text }, path };
    } else {
      const blob = await readPreviewResponse(first, THREAD_TEXT_PREVIEW_MAX_BYTES, signal);
      if (!blob) return { state: { status: "too-large" }, path };
      return { state: { status: "ready", kind: kind as "code" | "text" | "markdown" | "csv", text: await blob.text() }, path };
    }
  }
  const limit = kind === "pdf" ? THREAD_PDF_PREVIEW_MAX_BYTES : THREAD_TEXT_PREVIEW_MAX_BYTES;
  const blob = await fetchPreviewBlob(mediaUrl, limit, signal, context.fetchFn);
  if (!blob) return { state: { status: "too-large" }, path };
  if (kind === "pdf") {
    const objectUrl = URL.createObjectURL(new Blob([blob], { type: "application/pdf" }));
    return { state: { status: "ready", kind: "pdf", objectUrl }, path, objectUrl };
  }
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
  signal: AbortSignal,
): Promise<LoadResult> {
  const snapshot = context.environment?.snapshot ?? null;
  const base = snapshot?.cwd || context.workspaceRoot || "";
  const absolute = normalizeThreadPath(tab.absolutePath ?? joinThreadPath(base, tab.path));
  const repositoryRoot = snapshot?.status === "ready" ? snapshot.repository?.root ?? null : null;
  const relative = repositoryRoot ? relativeThreadPath(repositoryRoot, absolute) : null;
  let untracked = false;

  if (context.agentClient && context.sessionScope && relative) {
    try {
      const diff = await context.agentClient.readWorkspaceEnvironmentDiff(context.sessionScope, relative);
      if (shouldShowLineDiff(tab.name, diff.diff)) {
        const fileText = await readWorkspaceText(absolute, context, signal);
        return { state: { status: "ready", kind: "diff", diff: diff.diff, fileText }, path: absolute };
      }
      untracked = diff.unavailable_reason === "untracked_diff_unavailable";
    } catch {
      untracked = false;
    }
  }

  const previewKind = threadPreviewKind(tab.name);
  if (previewKind !== "code" && previewKind !== "text" && previewKind !== "markdown" && previewKind !== "html" && previewKind !== "csv") {
    return loadFilePreview({ name: tab.name, path: absolute }, context, signal);
  }
  if (!context.artifactClient) return { state: { status: "unavailable" }, path: absolute };
  const resolved = await context.artifactClient.resolveArtifact(absolute);
  if (!resolved.media_url) return { state: { status: "unavailable" }, path: resolved.path };
  const blob = await fetchPreviewBlob(resolved.media_url, THREAD_TEXT_PREVIEW_MAX_BYTES, signal, context.fetchFn);
  if (!blob) return { state: { status: "too-large" }, path: resolved.path };
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

async function readWorkspaceText(absolute: string, context: ThreadPreviewContext, signal: AbortSignal): Promise<string | null> {
  if (!context.artifactClient) return null;
  try {
    const resolved = await context.artifactClient.resolveArtifact(absolute);
    if (!resolved.media_url) return null;
    const blob = await fetchPreviewBlob(resolved.media_url, THREAD_TEXT_PREVIEW_MAX_BYTES, signal, context.fetchFn);
    if (!blob) return null;
    return blob.text();
  } catch {
    return null;
  }
}

async function fetchPreviewBlob(url: string, limit: number, signal: AbortSignal, fetchFn: typeof fetch = fetch): Promise<Blob | null> {
  const response = await fetchFn(url, { cache: "no-store", signal });
  if (!response.ok) throw new Error(`preview request failed: ${response.status}`);
  return readPreviewResponse(response, limit, signal);
}

/** Reads at most limit bytes, even when Content-Length is absent or incorrect. */
export async function readPreviewResponse(response: Response, limit: number, signal?: AbortSignal): Promise<Blob | null> {
  signal?.throwIfAborted();
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return new Blob();
  const reader = response.body.getReader();
  const chunks: ArrayBuffer[] = [];
  let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) return null;
      const copy = new Uint8Array(value.byteLength);
      copy.set(value);
      chunks.push(copy.buffer);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  signal?.throwIfAborted();
  return new Blob(chunks);
}
