import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  ComputerHistoryEntry,
  ComputerHistorySnapshot,
  MemmyAgentClient
} from "../../api/memmy-agent-client.js";
import { useTranslation } from "../../i18n/use-translation.js";
import { MemoryMarkdown } from "./memory-markdown.js";
import { AppIcon } from "./app-icon.js";

export interface ComputerHistorySubPageProps {
  client: MemmyAgentClient | null;
}

interface HistoryDay {
  key: string;
  label: string;
  entries: ComputerHistoryEntry[];
}

const DAY_MS = 86_400_000;

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
  const closed: Array<[number, number]> = [];
  for (const entry of histories) {
    if (entry.summaryWindow !== "6h") continue;
    const start = new Date(entry.createdAt).getTime();
    if (Number.isNaN(start) || now < start + SIX_HOUR_MS) continue;
    closed.push([start, start + SIX_HOUR_MS]);
  }
  return histories.filter((entry) => {
    if (entry.summaryWindow === "6h") {
      const start = new Date(entry.createdAt).getTime();
      return Number.isNaN(start) || now >= start + SIX_HOUR_MS;
    }
    const at = new Date(entry.createdAt).getTime();
    if (Number.isNaN(at)) return true;
    return !closed.some(([from, to]) => at >= from && at < to);
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
  const [collapsedDays, setCollapsedDays] = useState<Set<string>>(() => new Set());
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [clearMenuOpen, setClearMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clearMenuRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    if (!props.client) return;
    try {
      setSnapshot(await props.client.getComputerHistory());
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [props.client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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

  const runAction = useCallback(async (operation: (client: MemmyAgentClient) => Promise<ComputerHistorySnapshot>) => {
    if (!props.client) return;
    setBusy(true);
    setError(null);
    try {
      setSnapshot(await operation(props.client));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
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

  // No batch endpoint exists, so clearing is the individual deletes done for
  // the user rather than a new destructive route added on their behalf.
  const clearHistories = useCallback(async (scope: "today" | "all") => {
    const client = props.client;
    if (!client) return;
    const today = startOfDay(new Date());
    const doomed = (snapshot?.histories ?? []).filter((entry) => scope === "all"
      || startOfDay(new Date(entry.createdAt)) === today);
    if (!doomed.length) return;
    setClearMenuOpen(false);
    setBusy(true);
    setError(null);
    try {
      let latest: ComputerHistorySnapshot | null = null;
      for (const entry of doomed) latest = await client.deleteComputerHistory(entry.id);
      if (latest) setSnapshot(latest);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }, [props.client, snapshot?.histories]);

  const toggleDay = useCallback((key: string) => {
    setCollapsedDays((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  return (
    <section className="ch">
      <header className="ch__head">
        <h1>
          Computer History
          <span
            className="ch__info"
            title={t("computerHistory.info")}
            aria-hidden
          >
            i
          </span>
        </h1>
        <div className="ch__head-actions">
          {/* Codex records all day and so has no switch. Memmy only records
              when asked, which is the whole privacy story, so the control
              belongs where the eye already goes for actions. */}
          {paused ? (
            <button
              type="button"
              className="ch__button"
              disabled={busy || !props.client}
              onClick={() => void runAction((client) => client.resumeComputerHistoryObservation())}
            >
              {t("computerHistory.resume")}
            </button>
          ) : null}
          <button
            type="button"
            className={recording || paused ? "ch__button ch__button--recording" : "ch__button"}
            disabled={busy || !props.client}
            aria-pressed={recording || paused}
            onClick={() => recording || paused
              ? void runAction((client) => client.stopComputerHistoryObservation())
              : void runAction((client) => client.startComputerHistoryObservation())}
          >
            {recording ? <span className="ch__recording-dot" /> : null}
            {recording
              ? t("computerHistory.recording")
              : paused ? t("computerHistory.pausedStop") : t("computerHistory.startRecording")}
          </button>
          <div className="ch__menu" ref={clearMenuRef}>
            <button
              type="button"
              className="ch__button"
              disabled={busy || !snapshot?.histories.length}
              aria-expanded={clearMenuOpen}
              onClick={() => setClearMenuOpen((open) => !open)}
            >
              {t("computerHistory.clear")} <span className="ch__caret" aria-hidden>⌄</span>
            </button>
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
          <button type="button" className="ch__button ch__button--ask" disabled title={t("computerHistory.askSoon")}>
            <span className="ch__ask-glyph" aria-hidden>◌</span>
            {t("computerHistory.ask")}
          </button>
        </div>
      </header>

      {error ? <div className="ch__error">{error}</div> : null}

      <div className="ch__feed">
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
                <span className={collapsed ? "ch__caret ch__caret--collapsed" : "ch__caret"} aria-hidden>⌄</span>
              </button>
              {collapsed ? null : day.entries.map((entry, index) => {
                const next = day.entries[index + 1];
                const continuous = next ? isContinuous(entry, next) : true;
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
                            className={entry.pinned ? "ch-entry__action ch-entry__action--on" : "ch-entry__action"}
                            disabled={busy || !props.client}
                            title={entry.pinned ? t("computerHistory.unpin") : t("computerHistory.pin")}
                            aria-pressed={entry.pinned}
                            aria-label={t(entry.pinned ? "computerHistory.unpinLabel" : "computerHistory.pinLabel", { title: entry.title })}
                            onClick={() => void runAction((client) => client.pinComputerHistory(entry.id, !entry.pinned))}
                          >
                            {entry.pinned ? "★" : "☆"}
                          </button>
                          <button
                            type="button"
                            className={pendingDeleteId === entry.id
                              ? "ch-entry__action ch-entry__action--confirm"
                              : "ch-entry__action"}
                            disabled={busy}
                            title={t(pendingDeleteId === entry.id ? "computerHistory.deleteAgain" : "computerHistory.delete")}
                            aria-label={t(pendingDeleteId === entry.id ? "computerHistory.confirmDeleteLabel" : "computerHistory.deleteLabel", { title: entry.title })}
                            onClick={() => void deleteHistory(entry.id)}
                          >
                            {pendingDeleteId === entry.id ? t("computerHistory.confirm") : "🗑"}
                          </button>
                        </div>
                      </div>
                      {entry.description ? (
                        <p className="ch-entry__summary"><Prose text={entry.description} /></p>
                      ) : null}
                      {entry.applications?.length ? (
                        <ul className="ch-entry__apps">
                          {entry.applications.map((bundleId) => (
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
