import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ComputerHistorySnapshot,
  MemmyAgentClient
} from "../../api/memmy-agent-client.js";
import { MemoryMarkdown } from "./memory-markdown.js";

export interface ComputerHistorySubPageProps {
  client: MemmyAgentClient | null;
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
    const intervalMs = snapshot?.capture.status === "recording" || snapshot?.capture.status === "stopping"
      ? 1500
      : 5000;
    const timer = window.setInterval(() => void refresh(), intervalMs);
    return () => window.clearInterval(timer);
  }, [refresh, snapshot?.capture.status]);

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
  const recording = snapshot?.capture.status === "recording" || snapshot?.capture.status === "stopping";

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
      const next = await props.client.stopComputerHistoryCapture();
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
        <div className={`computer-history-status computer-history-status--${recording ? "active" : "idle"}`}>
          <span />Computer History：{recording ? "记录中" : "已暂停"}
        </div>
      </header>

      {error ? <div className="computer-history-page__error">{error}</div> : null}

      <div className="computer-history-page__actions computer-history-page__actions--recording">
        <div>
          <strong>Computer History：{recording ? "开启" : "关闭"}</strong>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={recording}
          aria-label={`Computer History：${recording ? "关闭" : "开启"}`}
          className={recording ? "computer-history-toggle computer-history-toggle--on" : "computer-history-toggle"}
          disabled={busy || !props.client}
          onClick={() => recording
            ? void stopRecording()
            : void runAction((client) => client.startComputerHistoryCapture())}
        >
          {recording ? "关闭" : "开启"}
        </button>
      </div>

      <div className="computer-history-page__workspace">
        <aside className="computer-history-page__timeline">
          <div className="computer-history-page__section-title">
            <h2>Timeline</h2><button type="button" onClick={() => void refresh()}>刷新</button>
          </div>
          {snapshot?.histories.length ? snapshot.histories.map((item) => (
            <div
              key={item.id}
              className={item.id === selectedHistoryId ? "computer-history-card computer-history-card--active" : "computer-history-card"}
            >
              <button
                type="button"
                className="computer-history-card__select"
                onClick={() => {
                  setSelectedHistoryId(item.id);
                  setPendingDeleteId(null);
                  if (historyDocumentRef.current) historyDocumentRef.current.scrollTop = 0;
                }}
              >
                <strong>{item.title}</strong>
                <span>{formatTime(item.createdAt)}</span>
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
          )) : <p className="computer-history-page__empty">还没有 History。开启上方开关开始记录。</p>}
        </aside>

        <main ref={historyDocumentRef} className="computer-history-page__document">
          <div className="computer-history-page__section-title">
            <div>
              <h2>{selectedHistory ? "History Markdown" : "选择一条 History"}</h2>
            </div>
          </div>
          {selectedHistory ? <MemoryMarkdown text={selectedHistory.markdown} /> : null}
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
