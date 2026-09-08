import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ComputerHistoryEntry,
  ComputerHistorySnapshot,
  MemmyAgentClient
} from "../../api/memmy-agent-client.js";
import { MemoryMarkdown } from "./memory-markdown.js";

export interface ComputerHistorySubPageProps {
  client: MemmyAgentClient | null;
}

type HistoryDay = {
  key: string;
  label: string;
  overview: ComputerHistoryEntry | null;
  entries: ComputerHistoryEntry[];
};

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\n[\s\S]*?\n---\n?/u, "").trimStart();
}

function dayKey(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "unknown" : at.toLocaleDateString();
}

function dayLabel(key: string): string {
  const today = new Date().toLocaleDateString();
  if (key === today) return "今天";
  const yesterday = new Date(Date.now() - 86_400_000).toLocaleDateString();
  return key === yesterday ? "昨天" : key;
}

// The six-hour rollup summarizes the day rather than a moment in it, so it
// heads the group instead of competing with the ten-minute entries below.
function groupByDay(histories: ComputerHistoryEntry[]): HistoryDay[] {
  const days = new Map<string, HistoryDay>();
  for (const entry of histories) {
    const key = dayKey(entry.createdAt);
    let day = days.get(key);
    if (!day) {
      day = { key, label: dayLabel(key), overview: null, entries: [] };
      days.set(key, day);
    }
    if (entry.summaryWindow === "6h" && !day.overview) day.overview = entry;
    else day.entries.push(entry);
  }
  return [...days.values()];
}

export function ComputerHistorySubPage(props: ComputerHistorySubPageProps) {
  const [snapshot, setSnapshot] = useState<ComputerHistorySnapshot | null>(null);
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const historyDocumentRef = useRef<HTMLElement | null>(null);

  const acceptSnapshot = useCallback((next: ComputerHistorySnapshot) => {
    setSnapshot(next);
    setSelectedHistoryId((current) => current && next.histories.some((item) => item.id === current)
      ? current
      : next.histories[0]?.id ?? null);
  }, []);

  const refresh = useCallback(async () => {
    if (!props.client) return;
    try {
      acceptSnapshot(await props.client.getComputerHistory());
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [acceptSnapshot, props.client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const state = snapshot?.observation.state;
    const intervalMs = state === "running" || state === "stopping" ? 1500 : 5000;
    const timer = window.setInterval(() => void refresh(), intervalMs);
    return () => window.clearInterval(timer);
  }, [refresh, snapshot?.observation.state]);

  const selectedHistory = useMemo(
    () => snapshot?.histories.find((item) => item.id === selectedHistoryId) ?? null,
    [selectedHistoryId, snapshot]
  );
  const selectedHistoryWorkflows = useMemo(
    () => snapshot?.workflows.filter((item) => item.sourceHistoryId === selectedHistoryId) ?? [],
    [selectedHistoryId, snapshot]
  );
  const selectedWorkflow = useMemo(
    () => selectedHistoryWorkflows.find((item) => item.id === selectedWorkflowId) ?? null,
    [selectedHistoryWorkflows, selectedWorkflowId]
  );
  const days = useMemo(() => groupByDay(snapshot?.histories ?? []), [snapshot?.histories]);
  const selectHistory = useCallback((historyId: string) => {
    setSelectedHistoryId(historyId);
    setPendingDeleteId(null);
    if (historyDocumentRef.current) historyDocumentRef.current.scrollTop = 0;
  }, []);
  const observationState = snapshot?.observation.state ?? "stopped";
  const recording = observationState === "running" || observationState === "stopping";
  const paused = observationState === "paused";
  // Paused keeps the current segment, so it reads as a third state rather than
  // a variant of off.
  const stateLabel = recording ? "记录中" : paused ? "已暂停" : "已停止";
  const stateModifier = recording ? "active" : paused ? "paused" : "idle";

  useEffect(() => {
    setSelectedWorkflowId((current) => current && selectedHistoryWorkflows.some((item) => item.id === current)
      ? current
      : selectedHistoryWorkflows[0]?.id ?? null);
  }, [selectedHistoryWorkflows]);

  useEffect(() => {
    if (historyDocumentRef.current) historyDocumentRef.current.scrollTop = 0;
  }, [selectedHistoryId]);

  const runAction = useCallback(async (operation: (client: MemmyAgentClient) => Promise<ComputerHistorySnapshot>) => {
    if (!props.client) return;
    setBusy(true);
    setError(null);
    try {
      acceptSnapshot(await operation(props.client));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }, [acceptSnapshot, props.client]);

  const stopRecording = useCallback(async () => {
    if (!props.client) return;
    setBusy(true);
    setError(null);
    try {
      const before = new Set(snapshot?.histories.map((item) => item.id) ?? []);
      const next = await props.client.stopComputerHistoryObservation();
      acceptSnapshot(next);
      const captured = next.histories.find((item) => !before.has(item.id) && item.sourceType === "captured")
        ?? next.histories.find((item) => item.sourceType === "captured");
      if (captured) setSelectedHistoryId(captured.id);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }, [acceptSnapshot, props.client, snapshot?.histories]);

  const deleteHistory = useCallback(async (historyId: string) => {
    if (!props.client) return;
    if (pendingDeleteId !== historyId) {
      setPendingDeleteId(historyId);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      acceptSnapshot(await props.client.deleteComputerHistory(historyId));
      setPendingDeleteId(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }, [acceptSnapshot, pendingDeleteId, props.client]);

  return (
    <section className="computer-history-page">
      <header className="computer-history-page__header">
        <div>
          <p className="computer-history-page__eyebrow">PERSONAL CONTEXT LAYER</p>
          <h1>Computer History</h1>
        </div>
        <div className={`computer-history-status computer-history-status--${stateModifier}`}>
          <span />Computer History：{stateLabel}
        </div>
      </header>

      {error ? <div className="computer-history-page__error">{error}</div> : null}

      <div className="computer-history-page__actions computer-history-page__actions--recording">
        <div>
          <strong>Computer History：{stateLabel}</strong>
          {paused ? <span className="computer-history-page__hint">当前片段已保留，恢复后继续写入。</span> : null}
        </div>
        <div className="computer-history-page__switches">
          {recording ? (
            <button
              type="button"
              className="computer-history-toggle"
              disabled={busy || !props.client}
              onClick={() => void runAction((client) => client.pauseComputerHistoryObservation())}
            >
              暂停
            </button>
          ) : null}
          {paused ? (
            <button
              type="button"
              className="computer-history-toggle"
              disabled={busy || !props.client}
              onClick={() => void runAction((client) => client.resumeComputerHistoryObservation())}
            >
              恢复
            </button>
          ) : null}
          <button
            type="button"
            role="switch"
            aria-checked={recording || paused}
            aria-label={`Computer History：${recording || paused ? "停止" : "开启"}`}
            className={recording || paused
              ? "computer-history-toggle computer-history-toggle--on"
              : "computer-history-toggle"}
            disabled={busy || !props.client}
            onClick={() => recording || paused
              ? void stopRecording()
              : void runAction((client) => client.startComputerHistoryObservation())}
          >
            {recording || paused ? "停止" : "开启"}
          </button>
        </div>
      </div>

      <div className="computer-history-page__workspace">
        <aside className="computer-history-page__timeline">
          <div className="computer-history-page__section-title">
            <h2>Timeline</h2><button type="button" onClick={() => void refresh()}>刷新</button>
          </div>
          {days.length ? days.map((day) => (
            <section key={day.key} className="computer-history-day">
              <h3 className="computer-history-day__label">{day.label}</h3>
              {day.overview ? (
                <button
                  type="button"
                  className={day.overview.id === selectedHistoryId
                    ? "computer-history-overview computer-history-overview--active"
                    : "computer-history-overview"}
                  onClick={() => selectHistory(day.overview!.id)}
                >
                  <span className="computer-history-overview__badge">这一天</span>
                  <strong>{day.overview.title}</strong>
                  {day.overview.description ? <p>{day.overview.description}</p> : null}
                </button>
              ) : null}
              {day.entries.map((item) => (
                <div
                  key={item.id}
                  className={item.id === selectedHistoryId ? "computer-history-card computer-history-card--active" : "computer-history-card"}
                >
                  <button
                    type="button"
                    className="computer-history-card__select"
                    onClick={() => selectHistory(item.id)}
                  >
                    <span className="computer-history-card__time">{formatTime(item.createdAt)}</span>
                    <strong>{item.title}</strong>
                    {item.description ? <p className="computer-history-card__summary">{item.description}</p> : null}
                  </button>
                  <button
                    type="button"
                    className={pendingDeleteId === item.id ? "computer-history-card__delete computer-history-card__delete--confirm" : "computer-history-card__delete"}
                    disabled={busy || recording}
                    onClick={() => void deleteHistory(item.id)}
                    aria-label={`${pendingDeleteId === item.id ? "确认删除" : "删除"} ${item.title}`}
                  >
                    {pendingDeleteId === item.id ? "确认删除" : "删除"}
                  </button>
                </div>
              ))}
            </section>
          )) : <p className="computer-history-page__empty">还没有 History。开启上方开关开始记录。</p>}
        </aside>

        <main ref={historyDocumentRef} className="computer-history-page__document">
          {selectedHistory ? (
            <>
              <header className="computer-history-detail__head">
                <span className="computer-history-detail__time">{formatTime(selectedHistory.createdAt)}</span>
                <h2>{selectedHistory.title}</h2>
                {selectedHistory.description ? <p>{selectedHistory.description}</p> : null}
                {selectedHistory.applications?.length ? (
                  <ul className="computer-history-detail__apps">
                    {selectedHistory.applications.map((app) => <li key={app}>{app}</li>)}
                  </ul>
                ) : null}
              </header>
              {/* The frontmatter is presentation metadata already shown above. */}
              <MemoryMarkdown text={stripFrontmatter(selectedHistory.markdown)} />
            </>
          ) : (
            <div className="computer-history-page__section-title">
              <div><h2>选择一条 History</h2></div>
            </div>
          )}
        </main>
      </div>

      <section className="computer-history-page__workflows">
        <div className="computer-history-page__section-title">
          <div>
            <h2>Workflow</h2>
            <p>Workflow 由聊天中的 Agent 根据选中的 History 生成；这里仅展示，具体执行统一在聊天框中触发。</p>
          </div>
        </div>
        {selectedHistoryWorkflows.length ? (
          <>
            <select value={selectedWorkflowId ?? ""} onChange={(event) => setSelectedWorkflowId(event.target.value)}>
              {selectedHistoryWorkflows.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
            </select>
            {selectedWorkflow ? <MemoryMarkdown text={selectedWorkflow.markdown} /> : null}
          </>
        ) : <p className="computer-history-page__empty">这条 History 还没有 Workflow。回到聊天框提出复现请求后，生成的 Workflow 会显示在这里。</p>}
      </section>
    </section>
  );
}

function formatTime(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
