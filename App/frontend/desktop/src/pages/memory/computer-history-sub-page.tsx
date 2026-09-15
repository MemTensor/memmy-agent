import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileText } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronDown, Info } from "lucide-react";
import { Button } from "../../components/button.js";
import { Tooltip } from "../../components/tooltip.js";
import type {
  ComputerHistoryEntry,
  ComputerHistorySnapshot,
  MemmyAgentClient
} from "../../api/memmy-agent-client.js";
import { useTranslation } from "../../i18n/use-translation.js";
import { MemoryMarkdown } from "./memory-markdown.js";
import { AppIcon } from "./app-icon.js";
import { ScrollText, Trash2 } from "./memory-prototype-icons.js";
import { ComputerHistoryRecordingConfirmation } from "./computer-history-recording-confirmation.js";

export interface ComputerHistorySubPageProps {
  client: MemmyAgentClient | null;
}

interface HistoryDay {
  key: string;
  label: string;
  entries: ComputerHistoryEntry[];
}

const DAY_MS = 86_400_000;

// These macOS system helpers use the generic app icon and add no useful
// application identity to the timeline. Keep their recorded history intact.
const HIDDEN_SYSTEM_APPLICATIONS = new Set([
  "com.apple.loginwindow",
  "com.apple.UserNotificationCenter",
  "com.apple.accessibility.universalAccessAuthWarn",
]);

function startOfDay(value: Date): number {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
}

type Translate = ReturnType<typeof useTranslation>["t"];

function dayLabel(at: Date, t: Translate): string {
  const today = startOfDay(new Date());
  const day = startOfDay(at);
  if (day === today) return t("computerHistory.today");
  if (day === today - DAY_MS) return t("computerHistory.yesterday");
  return at.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

/**
 * When an entry happened, at the resolution that entry deserves.
 *
 * A ten-minute segment is a moment, so it keeps the clock. A six-hour rollup
 * covers a stretch no clock time honestly describes, so it reads as the part of
 * the day it spans — which is also what makes older history legible: by then
 * the rollups are all that is shown. Rollup windows start at 00, 06, 12 and 18
 * on the local clock, so each part of the day names exactly one of them.
 */
function whenLabel(entry: ComputerHistoryEntry, t: Translate): string {
  const at = new Date(entry.createdAt);
  if (Number.isNaN(at.getTime())) return "";
  if (entry.summaryWindow !== "6h") {
    return at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  const hour = at.getHours();
  if (hour < 6) return t("computerHistory.night");
  if (hour < 12) return t("computerHistory.morning");
  return hour < 18 ? t("computerHistory.afternoon") : t("computerHistory.evening");
}

const SIX_HOUR_MS = 6 * 60 * 60_000;

/**
 * Hides every summary that a closed six-hour rollup already accounts for.
 *
 * A rollup and the segments beneath it describe the same stretch, so showing
 * both says the same hours twice and puts a six-hour account in the middle of
 * the ten-minute ones it covers. The rollup only earns that place once its
 * window has ended: while the window is current it is still being rewritten,
 * and the segments are the finer, truer account of what just happened. A
 * window whose rollup never ran keeps its segments rather than losing them.
 */
function withoutCoveredSegments(histories: ComputerHistoryEntry[]): ComputerHistoryEntry[] {
  const now = Date.now();
  const coveredIds = new Set<string>();
  for (const entry of histories) {
    if (entry.sourceType !== "rollup" || entry.summaryWindow !== "6h") continue;
    const start = new Date(entry.createdAt).getTime();
    if (Number.isNaN(start) || now < start + SIX_HOUR_MS) continue;
    for (const id of entry.coveredHistoryIds) coveredIds.add(id);
  }
  return histories.filter((entry) => {
    if (entry.sourceType === "rollup" && entry.summaryWindow === "6h") {
      const start = new Date(entry.createdAt).getTime();
      return Number.isNaN(start) || now >= start + SIX_HOUR_MS;
    }
    // Sharing a timestamp does not mean an imported or late-written entry
    // contributed to this rollup. Only its explicit source IDs can prove that.
    // Kept recordings must retain their own controls so they can be unpinned.
    return entry.pinned || entry.sourceType !== "captured" || entry.summaryWindow !== "10min" || !coveredIds.has(entry.id);
  });
}

/** Groups the visible feed by the day each entry happened on, newest first. */
function groupByDay(histories: ComputerHistoryEntry[], t: Translate): HistoryDay[] {
  const days = new Map<number, { at: Date; entries: ComputerHistoryEntry[] }>();
  for (const entry of withoutCoveredSegments(histories)) {
    const at = new Date(entry.createdAt);
    if (Number.isNaN(at.getTime())) continue;
    const key = startOfDay(at);
    const day = days.get(key) ?? { at, entries: [] };
    day.entries.push(entry);
    days.set(key, day);
  }
  return [...days.entries()]
    .sort(([left], [right]) => right - left)
    .map(([, day]) => ({
      key: String(startOfDay(day.at)),
      label: dayLabel(day.at, t),
      entries: [...day.entries].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    }));
}

/**
 * The gap between two entries, as the rail should draw it.
 *
 * Consecutive windows are a continuous stretch of attention; a gap means the
 * machine was not being watched, and drawing that as one unbroken line would
 * claim a continuity the recording does not have.
 */
function isContinuous(newer: ComputerHistoryEntry, older: ComputerHistoryEntry): boolean {
  const from = new Date(older.createdAt).getTime();
  const to = new Date(newer.createdAt).getTime();
  if (Number.isNaN(from) || Number.isNaN(to)) return true;
  const window = newer.summaryWindow === "6h" ? 6 * 60 * 60_000 : 10 * 60_000;
  return to - from <= window * 1.5;
}

/** The description, which carries inline code the model wrote into it. */
function Prose(props: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[[remarkGfm, { singleTilde: false }]]}
      skipHtml
      components={{
        p: ({ children }) => <>{children}</>,
        a: ({ children }) => <>{children}</>,
        code: ({ children }) => <code className="ch-entry__code">{children}</code>
      }}
    >
      {props.text}
    </ReactMarkdown>
  );
}

export function ComputerHistorySubPage(props: ComputerHistorySubPageProps) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<ComputerHistorySnapshot | null>(null);
  const [pendingRecordingAction, setPendingRecordingAction] = useState<"start" | "resume" | null>(null);
  const [collapsedDays, setCollapsedDays] = useState<Set<string>>(() => new Set());
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [clearMenuOpen, setClearMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const clearMenuRef = useRef<HTMLDivElement | null>(null);
  const requestVersion = useRef(0);
  const appliedVersion = useRef(0);
  const actionPending = useRef(false);

  const refresh = useCallback(async () => {
    if (!props.client || actionPending.current) return;
    const version = ++requestVersion.current;
    try {
      const next = await props.client.getComputerHistory();
      // A newer request being in flight does not make this response stale.
      // Reject only responses older than an applied result or a mutation.
      if (version < appliedVersion.current) return;
      appliedVersion.current = version;
      setSnapshot(next);
      setRefreshError(null);
    } catch (cause) {
      if (version < appliedVersion.current) return;
      appliedVersion.current = version;
      setRefreshError(errorMessage(cause));
    }
  }, [props.client]);

  useEffect(() => {
    actionPending.current = false;
    setBusy(false);
    void refresh();
    return () => { appliedVersion.current = ++requestVersion.current; };
  }, [refresh]);

  useEffect(() => {
    setPendingRecordingAction(null);
  }, [props.client]);

  useEffect(() => {
    const state = snapshot?.observation.state;
    const intervalMs = state === "running" || state === "stopping" ? 1500 : 5000;
    const timer = window.setInterval(() => void refresh(), intervalMs);
    return () => window.clearInterval(timer);
  }, [refresh, snapshot?.observation.state]);

  useEffect(() => {
    if (!clearMenuOpen) return;
    const dismiss = (event: MouseEvent) => {
      if (!clearMenuRef.current?.contains(event.target as Node)) setClearMenuOpen(false);
    };
    document.addEventListener("mousedown", dismiss);
    return () => document.removeEventListener("mousedown", dismiss);
  }, [clearMenuOpen]);

  const days = useMemo(() => groupByDay(snapshot?.histories ?? [], t), [snapshot?.histories, t]);
  const observationState = snapshot?.observation.state ?? "stopped";
  const recording = observationState === "running" || observationState === "stopping";
  const paused = observationState === "paused";
  const observationError = snapshot?.observation.error;
  const recordingError = observationError
    ? t("computerHistory.recordingFailed", { error: observationError })
    : observationState === "failed" ? t("computerHistory.recordingFailedUnknown") : null;
  const narrationError = snapshot?.observation.narrationError;
  // The window the recorder is still writing into, paused or not.
  const openEntryId = snapshot?.observation.segmentId ? `${snapshot.observation.segmentId}-10min-summary` : null;

  const runAction = useCallback(async (operation: (client: MemmyAgentClient) => Promise<ComputerHistorySnapshot>) => {
    if (!props.client || actionPending.current) return;
    // Invalidate polls issued before the mutation, and do not start a poll
    // until its response has supplied the new authoritative snapshot.
    actionPending.current = true;
    const version = ++requestVersion.current;
    appliedVersion.current = version;
    setBusy(true);
    setError(null);
    try {
      const next = await operation(props.client);
      if (version !== requestVersion.current) return;
      setSnapshot(next);
      setRefreshError(null);
    } catch (cause) {
      if (version !== requestVersion.current) return;
      setError(errorMessage(cause));
    } finally {
      if (version === requestVersion.current) {
        actionPending.current = false;
        setBusy(false);
      }
    }
  }, [props.client]);

  const deleteHistory = useCallback(async (historyId: string) => {
    if (!props.client) return;
    if (pendingDeleteId !== historyId) {
      setPendingDeleteId(historyId);
      return;
    }
    await runAction((client) => client.deleteComputerHistory(historyId));
    setPendingDeleteId(null);
  }, [pendingDeleteId, props.client, runAction]);

  // The service also knows about pending summaries absent from this snapshot.
  const clearHistories = useCallback(async (scope: "today" | "all") => {
    setClearMenuOpen(false);
    await runAction((client) => client.clearComputerHistories(scope));
    setPendingDeleteId(null);
  }, [runAction]);

  const toggleDay = useCallback((key: string) => {
    setCollapsedDays((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const openMarkdown = useCallback(async (entry: ComputerHistoryEntry) => {
    setError(null);
    try {
      const open = window.memmy?.openComputerHistoryMarkdown;
      if (typeof open !== "function") throw new Error(t("computerHistory.openMarkdownUnavailable"));
      await open(entry.filePath);
    } catch (cause) {
      setError(t("computerHistory.openMarkdownFailed", { error: errorMessage(cause) }));
    }
  }, [t]);

  return (
    <section className="memory-panel ch">
      <header className="memory-panel__header">
        <div className="memory-panel__header-main">
          <h3 className="memory-panel__title">
            <ScrollText size={18} className="text-text-ink/60" />
            {t("memory.nav.computerHistory")}
          </h3>
          <p id="computer-history-record-description" className="memory-panel__subtitle">{t("computerHistory.recordDescription")}</p>
        </div>
      </header>

      <div className="ch__recording-setting flex items-center justify-between bg-background-paper rounded-card-lg border-content-panel">
        <div className="flex-1 pr-4">
          <div id="computer-history-record-label" className="text-sm text-text-ink/70">{t("computerHistory.record")}</div>
        </div>
        <div className="ch__head-actions">
          {paused ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy || !props.client}
              onClick={() => setPendingRecordingAction("resume")}
            >
              {t("computerHistory.resume")}
            </Button>
          ) : null}
          <button
            type="button"
            role="switch"
            aria-checked={recording || paused}
            aria-labelledby="computer-history-record-label"
            aria-describedby="computer-history-record-description"
            disabled={busy || !props.client || !snapshot || observationState === "stopping"}
            className={`ch__recording-switch relative inline-flex shrink-0 h-5 w-9 items-center rounded-full border-0 p-0 cursor-pointer transition-colors ${
              recording || paused ? "bg-action-sky" : "bg-border-stone"
            }`}
            onClick={() => recording || paused
              ? void runAction((client) => client.stopComputerHistoryObservation())
              : setPendingRecordingAction("start")}
          >
            <span className={`inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${recording || paused ? "translate-x-[18px]" : "translate-x-0.5"}`} />
          </button>
        </div>
      </div>

      <div className="ch__head">
        <h4 className="ch__history-title text-sm font-semibold text-text-ink">
          {t("computerHistory.history")}
          <Tooltip content={t("computerHistory.info")} openOnClick variant="description">
            <button type="button" className="ch__info" aria-label={t("memory.learnMore")}><Info size={16} strokeWidth={1.7} aria-hidden="true" /></button>
          </Tooltip>
        </h4>
        <div className="ch__head-actions ch__history-actions">
          {recording || paused ? (
            <span
              className={`memory-pill ch__recording-status${paused ? "" : " memory-pill--processing"}`}
              role="status"
            >
              <span className="ch__recording-status-dot" aria-hidden="true" />
              {t(paused ? "computerHistory.paused" : "computerHistory.recording")}
            </span>
          ) : null}
          <div className="ch__menu" ref={clearMenuRef}>
            <Button
              type="button"
              size="sm"
              className="ch__clear-button"
              disabled={busy || !props.client}
              aria-expanded={clearMenuOpen}
              aria-haspopup="menu"
              onClick={() => setClearMenuOpen((open) => !open)}
            >
              <Trash2 size={14} />
              {t("computerHistory.clear")}
              <ChevronDown size={12} />
            </Button>
            {clearMenuOpen ? (
              <div className="ch__menu-sheet" role="menu">
                <button type="button" role="menuitem" onClick={() => void clearHistories("today")}>
                  {t("computerHistory.clearToday")}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="ch__menu-item--danger"
                  onClick={() => void clearHistories("all")}
                >
                  {t("computerHistory.clearAll")}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {error ? <div className="ch__error" role="alert">{error}</div> : null}
      {refreshError ? <div className="ch__error" role="alert">{refreshError}</div> : null}
      {recordingError ? <div className="ch__error" role="alert">{recordingError}</div> : null}
      {narrationError ? (
        <div className="ch__error" role="alert">{t("computerHistory.narrationFailed", { error: narrationError })}</div>
      ) : null}

      <div className="ch__feed bg-background-paper rounded-card-lg border-content-panel">
        {days.length ? days.map((day) => {
          const collapsed = collapsedDays.has(day.key);
          return (
            <section key={day.key} className="ch__day">
              <button
                type="button"
                className="ch__day-head"
                aria-expanded={!collapsed}
                onClick={() => toggleDay(day.key)}
              >
                {day.label}
                <ChevronDown
                  size={16}
                  className={collapsed ? "ch__caret ch__caret--collapsed" : "ch__caret"}
                  aria-hidden="true"
                />
              </button>
              {collapsed ? null : day.entries.map((entry, index) => {
                const next = day.entries[index + 1];
                const continuous = next ? isContinuous(entry, next) : true;
                const visibleApplications = (entry.applications ?? []).filter(
                  (bundleId) => !HIDDEN_SYSTEM_APPLICATIONS.has(bundleId),
                );
                return (
                  <article key={entry.id} className="ch-entry">
                    <div className="ch-entry__when">{whenLabel(entry, t)}</div>
                    <div className={continuous ? "ch-entry__rail" : "ch-entry__rail ch-entry__rail--gap"}>
                      <span className="ch-entry__dot" />
                    </div>
                    <div className="ch-entry__body">
                      <div className="ch-entry__title-row">
                        <h3>{entry.title}</h3>
                        <div className="ch-entry__row-actions">
                          <button
                            type="button"
                            className="ch-entry__action"
                            title={t("computerHistory.openMarkdown")}
                            aria-label={t("computerHistory.openMarkdownLabel", { title: entry.title })}
                            onClick={() => void openMarkdown(entry)}
                          >
                            <FileText size={14} aria-hidden />
                          </button>
                          {/* A six-hour summary has no raw events of its own to keep. */}
                          {entry.summaryWindow === "6h" ? null : (
                          <button
                            type="button"
                            className={entry.pinned ? "ch-entry__action ch-entry__action--on" : "ch-entry__action"}
                            disabled={busy || !props.client}
                            title={entry.pinned ? t("computerHistory.unpin") : t("computerHistory.pin")}
                            aria-pressed={entry.pinned}
                            aria-label={t(entry.pinned ? "computerHistory.unpinLabel" : "computerHistory.pinLabel", { title: entry.title })}
                            onClick={() => void runAction((client) => client.pinComputerHistory(entry.id, !entry.pinned))}
                          >
                            {entry.pinned ? "★" : "☆"}
                          </button>
                          )}
                          <button
                            type="button"
                            className={pendingDeleteId === entry.id
                              ? "ch-entry__action ch-entry__action--delete ch-entry__action--confirm"
                              : "ch-entry__action ch-entry__action--delete"}
                            disabled={busy || !props.client || entry.id === openEntryId}
                            title={t(entry.id === openEntryId
                              ? "computerHistory.deleteRecording"
                              : pendingDeleteId === entry.id ? "computerHistory.deleteAgain" : "computerHistory.delete")}
                            aria-label={t(pendingDeleteId === entry.id ? "computerHistory.confirmDeleteLabel" : "computerHistory.deleteLabel", { title: entry.title })}
                            onClick={() => void deleteHistory(entry.id)}
                          >
                            {pendingDeleteId === entry.id ? t("computerHistory.confirm") : <Trash2 size={14} />}
                          </button>
                        </div>
                      </div>
                      {entry.description ? (
                        <p className="ch-entry__summary"><Prose text={entry.description} /></p>
                      ) : null}
                      {visibleApplications.length ? (
                        <ul className="ch-entry__apps">
                          {visibleApplications.map((bundleId) => (
                            <li key={bundleId}>
                              <AppIcon bundleId={bundleId} client={props.client} />
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </section>
          );
        }) : (
          <p className="ch__empty">
            {t(recording ? "computerHistory.emptyRecording" : "computerHistory.empty")}
          </p>
        )}
      </div>

      <WorkflowSection snapshot={snapshot} />
      <ComputerHistoryRecordingConfirmation
        open={pendingRecordingAction !== null}
        onCancel={() => setPendingRecordingAction(null)}
        onConfirm={() => {
          const action = pendingRecordingAction;
          setPendingRecordingAction(null);
          if (action) void runAction((client) => action === "resume"
            ? client.resumeComputerHistoryObservation()
            : client.startComputerHistoryObservation());
        }}
      />
    </section>
  );
}

/**
 * Workflows have no counterpart in the Codex feed, but they are a Memmy
 * capability rather than a styling choice, so they keep a home below it.
 */
function WorkflowSection(props: { snapshot: ComputerHistorySnapshot | null }) {
  const { t } = useTranslation();
  const workflows = props.snapshot?.workflows ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = workflows.find((item) => item.id === selectedId) ?? workflows[0] ?? null;
  if (!workflows.length) return null;
  return (
    <section className="ch__workflows">
      <div className="ch__workflows-head">
        <h2>{t("computerHistory.workflow")}</h2>
        <select value={selected?.id ?? ""} onChange={(event) => setSelectedId(event.target.value)}>
          {workflows.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>
      </div>
      {selected ? <MemoryMarkdown text={selected.markdown} /> : null}
    </section>
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
