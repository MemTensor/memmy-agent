import { useEffect, useId, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileCode2,
  FolderGit2,
  GitBranch,
  RefreshCw,
  X,
} from "lucide-react";
import type {
  MemmyAgentClient,
  WorkspaceEnvironmentDiff,
  WorkspaceEnvironmentFile,
  WorkspaceEnvironmentState,
} from "../api/memmy-agent-client.js";
import { useTranslation } from "../i18n/use-translation.js";
import { WorkspaceDiffView } from "./workspace-diff-view.js";

type AgentEnvironmentPanelProps = {
  client: MemmyAgentClient | null;
  scope: "session" | "project";
  scopeKey: string;
  environment: WorkspaceEnvironmentState | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
  onClose: () => void;
};

function shortSha(value: string): string {
  return value ? value.slice(0, 7) : "—";
}

function countLabel(value: number | null, prefix: "+" | "-"): string {
  return value == null ? "?" : `${prefix}${value.toLocaleString()}`;
}

export function AgentEnvironmentPanel({
  client,
  scope,
  scopeKey,
  environment,
  loading,
  error,
  onRefresh,
  onClose,
}: AgentEnvironmentPanelProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const panelRef = useRef<HTMLElement | null>(null);
  const [diff, setDiff] = useState<WorkspaceEnvironmentDiff | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [filesOpen, setFilesOpen] = useState(true);
  const diffRequestIdRef = useRef(0);
  const snapshot = environment?.snapshot ?? null;
  const files = environment?.files ?? [];

  useEffect(() => {
    diffRequestIdRef.current += 1;
    setDiff(null);
    setSelectedPath(null);
    return () => {
      diffRequestIdRef.current += 1;
    };
  }, [scope, scopeKey, snapshot?.revision]);

  useEffect(() => {
    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    function closeOnOutsidePointer(event: globalThis.PointerEvent) {
      const target = event.target instanceof Node ? event.target : null;
      const toggle = target instanceof Element
        ? target.closest("[data-agent-environment-toggle]")
        : null;
      if (
        !panelRef.current?.contains(target)
        && !toggle
      ) {
        onClose();
      }
    }
    window.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
    };
  }, [onClose]);

  async function selectFile(file: WorkspaceEnvironmentFile) {
    if (!client) return;
    if (selectedPath === file.path) {
      diffRequestIdRef.current += 1;
      setSelectedPath(null);
      setDiff(null);
      return;
    }
    const requestId = ++diffRequestIdRef.current;
    setSelectedPath(file.path);
    setDiff(null);
    try {
      const next = await client.readWorkspaceEnvironmentDiff({ kind: scope, key: scopeKey }, file.path);
      if (requestId === diffRequestIdRef.current) setDiff(next);
    } catch (cause) {
      if (requestId === diffRequestIdRef.current) {
        setDiff({
          path: file.path,
          diff: "",
          truncated: false,
          unavailable_reason: cause instanceof Error ? cause.message : "diff_unavailable",
        });
      }
    }
  }

  async function refresh() {
    diffRequestIdRef.current += 1;
    setDiff(null);
    setSelectedPath(null);
    await onRefresh();
  }

  const statusLabel = snapshot?.status === "not_git"
    ? t("home.environment.notGit")
    : snapshot?.status === "workspace_unavailable"
      ? t("home.environment.workspaceUnavailable")
      : snapshot?.status === "error"
        ? t("home.environment.readFailed")
        : null;

  return (
    <aside
      ref={panelRef}
      className="agent-environment-panel"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
    >
      <header className="agent-environment-panel__header">
        <h2 id={titleId}>{t("home.environment.title")}</h2>
        <div className="agent-environment-panel__actions">
          <button type="button" onClick={() => void refresh()} aria-label={t("home.environment.refresh")} title={t("home.environment.refreshShort")} disabled={loading}>
            <RefreshCw size={15} aria-hidden="true" className={loading ? "agent-environment-panel__spin" : undefined} />
          </button>
          <button type="button" onClick={onClose} aria-label={t("home.environment.close")} title={t("home.environment.closeShort")}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </header>

      {error ? <p className="agent-environment-panel__notice agent-environment-panel__notice--error" role="status">{error}</p> : null}
      {statusLabel ? <p className="agent-environment-panel__notice" role="status">{statusLabel}</p> : null}

      {snapshot?.status === "ready" && snapshot.repository ? (
        <div className="agent-environment-panel__body">
          <section className="agent-environment-section">
            <div className="agent-environment-row">
              <FolderGit2 size={16} aria-hidden="true" />
              <div className="agent-environment-row__content">
                <span>{t("home.environment.local")}</span>
                <small title={snapshot.cwd}>{snapshot.cwd}</small>
              </div>
            </div>
            <div className="agent-environment-row">
              <GitBranch size={16} aria-hidden="true" />
              <div className="agent-environment-row__content">
                <span>{snapshot.repository.branch ?? t("home.environment.detachedHead")}</span>
                <small>{shortSha(snapshot.repository.head_sha)}{snapshot.repository.upstream ? ` · ${snapshot.repository.upstream}` : ""}</small>
              </div>
              {(snapshot.repository.ahead || snapshot.repository.behind) ? (
                <span className="agent-environment-row__meta">↑{snapshot.repository.ahead} ↓{snapshot.repository.behind}</span>
              ) : null}
            </div>
          </section>

          <section className="agent-environment-section">
            <button type="button" className="agent-environment-section__toggle" onClick={() => setFilesOpen((value) => !value)} aria-expanded={filesOpen}>
              {filesOpen ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
              <span>{t("home.environment.changes")}</span>
              <span className="agent-environment-section__count">{snapshot.changes?.file_count ?? 0}</span>
              <span className="agent-environment-section__lines agent-environment-section__lines--add">{countLabel(snapshot.changes?.additions ?? null, "+")}</span>
              <span className="agent-environment-section__lines agent-environment-section__lines--delete">{countLabel(snapshot.changes?.deletions ?? null, "-")}</span>
            </button>
            {filesOpen ? (
              <div className="agent-environment-files">
                {files.length ? files.map((file) => (
                  <div key={file.path}>
                    <button type="button" className={`agent-environment-file${selectedPath === file.path ? " agent-environment-file--selected" : ""}`} onClick={() => void selectFile(file)} aria-expanded={selectedPath === file.path}>
                      <FileCode2 size={14} aria-hidden="true" />
                      <span className="agent-environment-file__path" title={file.path}>{file.path}</span>
                      <span className={`agent-environment-file__attribution agent-environment-file__attribution--${file.attribution}`}>
                        {file.attribution === "goal"
                          ? t("home.environment.attribution.goal")
                          : file.attribution === "preexisting"
                            ? t("home.environment.attribution.preexisting")
                            : file.attribution === "uncertain"
                              ? t("home.environment.attribution.uncertain")
                              : "—"}
                      </span>
                    </button>
                    {selectedPath === file.path ? (
                      <div className="agent-environment-diff" aria-busy={!diff}>
                        {!diff ? (
                          <p role="status">{t("home.environment.diff.loading")}</p>
                        ) : diff.diff ? (
                          <WorkspaceDiffView
                            diff={diff.diff}
                            path={diff.path}
                            ariaLabel={t("home.environment.diff.label", { path: diff.path })}
                          />
                        ) : (
                          <p>{diff.unavailable_reason === "untracked_diff_unavailable" ? t("home.environment.diff.untrackedUnavailable") : t("home.environment.diff.empty")}</p>
                        )}
                        {diff?.truncated ? <small>{t("home.environment.diff.truncated")}</small> : null}
                      </div>
                    ) : null}
                  </div>
                )) : <p className="agent-environment-panel__empty">{t("home.environment.clean")}</p>}
              </div>
            ) : null}
          </section>

          {snapshot.goal ? (
            <section className="agent-environment-section agent-environment-goal">
              <div className="agent-environment-section__heading">
                <span>{t("home.environment.goal.title")}</span>
                {snapshot.goal.completion_audit === "risk" ? (
                  <AlertTriangle size={15} aria-label={t("home.environment.goal.risk")} />
                ) : snapshot.goal.completion_audit === "satisfied" ? (
                  <CheckCircle2 size={15} aria-label={t("home.environment.goal.satisfied")} />
                ) : null}
              </div>
              <dl>
                <div><dt>{t("home.environment.goal.baseline")}</dt><dd>{snapshot.goal.base_branch ?? "—"} · {snapshot.goal.base_head ? shortSha(snapshot.goal.base_head) : "—"}</dd></div>
                <div><dt>{t("home.environment.goal.files")}</dt><dd>{snapshot.goal.goal_files}</dd></div>
                <div><dt>{t("home.environment.goal.preexisting")}</dt><dd>{snapshot.goal.preexisting_files}</dd></div>
                <div><dt>{t("home.environment.goal.uncertain")}</dt><dd>{snapshot.goal.uncertain_files}</dd></div>
                <div><dt>{t("home.environment.goal.verification")}</dt><dd>{snapshot.goal.verification === "not_run" ? t("home.environment.goal.notRun") : snapshot.goal.verification}</dd></div>
              </dl>
            </section>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}
