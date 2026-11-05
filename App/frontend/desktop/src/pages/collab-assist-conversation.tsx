/**
 * 看板上打开的一次协助：按会话展示双方的完整上下文，位置与排版和读成员任务的只读面板一致。
 *
 * 每一次请求是一轮，按时间顺序依次是：发起方的请求、执行方的决定、执行方 Agent 收到的提示词（Memmy 执行时另有
 * 隐藏注入的格式要求）、执行过程（说明文字与每一步工具调用）、执行方的回复，以及发起方实际收到的内容与它的回复。
 * 发起人与执行人看到的是同一份内容；项目里的其他成员看不到。执行中每 3 秒重读一次。
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, ChevronRight, FileText, Loader2, Terminal, X } from "lucide-react";
import type { AssistRequest, AssistThread, AssistThreadDetail, AssistTranscriptItem, CollabClient } from "../api/collab-client.js";
import type { MessageKey } from "../i18n/messages.js";
import { useTranslation } from "../i18n/use-translation.js";
import { AgentMessageContent } from "./agent-message-content.js";
import { ConfirmCard } from "./collab-assist-detail.js";
import {
  AssistAgentLogo,
  assistAgentName,
  assistClock,
  grantDurationLabel,
  pickAssistAgent,
  useAssistAgentChoice
} from "./collab-assist-view.js";
import frame from "./collab-page.module.css";
import detailStyles from "./collab-assist-detail.module.css";
import styles from "./collab-assist-conversation.module.css";

type Translate = (key: MessageKey, values?: Record<string, string>) => string;

/** 执行中多久重读一次。 */
const LIVE_POLL_MS = 3_000;
/** 提示词与收到的内容默认显示的行数。 */
const PREVIEW_LINES = 6;

export function CollabAssistConversation(props: {
  /** 看板列表里的这一行：打开时先用它画出标题，详情读到后再补全会话。 */
  thread: AssistThread | null;
  collab: CollabClient | null;
  /** 发起的任务是否还在这台电脑上：只对还在的任务给出「打开发起的任务」。 */
  sourceTaskAvailable?: (chatId: string) => boolean;
  onOpenTask?: (chatId: string) => void;
  /** 撤回、停止或确认之后：看板重新读一次协助。 */
  onChanged?: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const panelRef = useRef<HTMLElement | null>(null);
  const { thread: summary, collab } = props;
  const open = summary !== null;
  const [detail, setDetail] = useState<AssistThreadDetail | null>(null);
  const [offset, setOffset] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const projectId = summary?.projectId ?? null;
  const threadId = summary?.threadId ?? null;
  // 列表里这一行有变化（新请求、状态变了）时也重读一次。
  const changeKey = summary ? `${summary.lastActiveAt ?? ""}|${summary.status}|${summary.attempt}` : "";

  const load = useCallback(async () => {
    if (!collab || !projectId || !threadId) return;
    try {
      const next = await collab.assistThread(projectId, threadId);
      setDetail(next);
      setLoadFailed(false);
      // 云端数据库的时间与本机时钟的差：会话里的时间都按本机时间显示（测试库的时区设置差了 8 小时）。
      const server = next.serverTime ? Date.parse(next.serverTime) : Number.NaN;
      setOffset(Number.isFinite(server) ? Date.now() - server : 0);
    } catch {
      setLoadFailed(true);
    }
  }, [collab, projectId, threadId]);

  useEffect(() => {
    setDetail(null);
    setError(null);
    setLoadFailed(false);
  }, [threadId]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load, changeKey]);

  const thread = detail?.thread ?? summary;
  const live = Boolean(thread?.requests.some((request) => request.status === "running" || request.status === "pending" || request.status === "confirm"));
  useEffect(() => {
    if (!open || !live) return;
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, LIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [open, live, load]);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") props.onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    panelRef.current?.focus();
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, props.onClose]);

  const latest = thread?.requests[0] ?? null;
  const confirming = Boolean(thread?.executor.mine && latest?.status === "confirm");
  const choice = useAssistAgentChoice(collab, thread?.projectId ?? null, thread?.requester.userId ?? null, confirming);
  const rounds = useMemo(() => [...(thread?.requests ?? [])].reverse(), [thread]);

  if (!thread || typeof document === "undefined") return null;

  const shift = (iso: string | null) => (iso ? new Date(Date.parse(iso) + offset).toISOString() : null);
  const agentName = assistAgentName(thread.agent, t("collab.assist.executorFallback"));
  const route = thread.agent
    ? t("collab.assist.detail.route", { requester: thread.requester.name, via: thread.via, executor: thread.executor.name, agent: agentName })
    : t("collab.assist.detail.routePending", { requester: thread.requester.name, via: thread.via, executor: thread.executor.name });
  const confirmAgent = pickAssistAgent(choice, thread.agent);
  const confirmAgentName = choice?.agents.find((item) => item.sourceId === confirmAgent)?.name
    ?? assistAgentName(confirmAgent, t("collab.assist.executorFallback"));
  const sourceTask = detail?.thread.sourceTask ?? (thread.mine ? thread.requests.find((request) => request.sourceTask)?.sourceTask ?? null : null);
  const canOpenSource = Boolean(sourceTask && props.onOpenTask && (props.sourceTaskAvailable?.(sourceTask) ?? true));
  const executorTask = thread.executor.mine ? thread.conversationId : null;

  async function act(run: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await run();
      props.onChanged?.();
      void load();
    } catch {
      setError(t("collab.assist.failed"));
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className={frame.readerLayer}>
      <button type="button" className={frame.readerScrim} aria-label={t("common.close")} tabIndex={-1} onClick={props.onClose} />
      <aside
        ref={panelRef}
        className={frame.readerPanel}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        data-collab-assist-conversation=""
        tabIndex={-1}
      >
        <header className={frame.readerHead}>
          <div className={frame.readerHeadText}>
            <h2 id={titleId} className={frame.readerTitle}>{t("collab.assist.detail.title", { title: thread.title })}</h2>
            <div className={frame.readerHeadMeta}>
              <span className={detailStyles.route}>
                {thread.agent ? (
                  <AssistAgentLogo agent={thread.agent} name={agentName} className={detailStyles.agentLogo} markClassName={detailStyles.agentMark} />
                ) : null}
                {route}
              </span>
            </div>
          </div>
          <div className={frame.readerActions}>
            <button type="button" className={frame.readerAction} aria-label={t("common.close")} title={t("common.close")} onClick={props.onClose}>
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className={frame.readerBody}>
          {!detail && !loadFailed ? <p className={styles.note}>{t("collab.assist.conv.loading")}</p> : null}
          {loadFailed && !detail ? <p className={styles.note}>{t("collab.assist.conv.loadFailed")}</p> : null}
          {rounds.map((request) => (
            <AssistRound
              key={request.id}
              request={request}
              thread={thread}
              showIndex={rounds.length > 1}
              withConversation={Boolean(detail)}
              shift={shift}
              t={t}
            />
          ))}
          {thread.executor.mine && latest?.status === "confirm" && collab ? (
            <ConfirmCard
              requesterName={thread.requester.name}
              attempt={latest.attempt}
              agentName={confirmAgentName}
              busy={busy || !confirmAgent}
              onDecide={(decision) => void act(() => collab.decideAssist(latest.id, decision.action === "allow"
                ? {
                  action: "allow",
                  ...(confirmAgent ? { agent: confirmAgent } : {}),
                  scope: decision.scope,
                  ...(decision.scope === "timed" ? { minutes: decision.minutes } : {})
                }
                : { action: "reject" }))}
            />
          ) : null}
          {error ? <p className={detailStyles.error} role="alert">{error}</p> : null}
        </div>

        <footer className={detailStyles.foot}>
          <span className={detailStyles.footNote}>{t("collab.assist.detail.visibility")}</span>
          <span className={detailStyles.grow} />
          {thread.mine && latest && (latest.status === "pending" || latest.status === "confirm") && collab ? (
            <button type="button" className={detailStyles.button} disabled={busy} onClick={() => void act(() => collab.cancelAssist(latest.id))}>
              {t("collab.assist.withdraw")}
            </button>
          ) : null}
          {thread.executor.mine && latest?.status === "running" && collab ? (
            <button type="button" className={detailStyles.button} disabled={busy} onClick={() => void act(() => collab.stopAssist(latest.id))}>
              {t("collab.assist.stop")}
            </button>
          ) : null}
          {executorTask && props.onOpenTask ? (
            <button type="button" className={`${detailStyles.button} ${detailStyles.buttonPrimary}`} onClick={() => props.onOpenTask?.(executorTask)}>
              {t("collab.assist.conv.openExecutorTask")}
            </button>
          ) : null}
          {canOpenSource && sourceTask ? (
            <button type="button" className={`${detailStyles.button} ${detailStyles.buttonPrimary}`} onClick={() => props.onOpenTask?.(sourceTask)}>
              {t("collab.assist.detail.openSource")}
            </button>
          ) : null}
        </footer>
      </aside>
    </div>,
    document.body
  );
}

/** 一次请求：请求、决定、提示词、过程、回复、发起方收到的内容。 */
function AssistRound(props: {
  request: AssistRequest;
  thread: AssistThread;
  showIndex: boolean;
  /** 详情已经读到：没有会话内容时按旧请求处理，只显示已有的部分。 */
  withConversation: boolean;
  shift: (iso: string | null) => string | null;
  t: Translate;
}) {
  const { request, thread, t } = props;
  const executor = thread.executor.name;
  const requester = thread.requester.name;
  const agent = assistAgentName(request.agent ?? request.grant?.agent ?? null, t("collab.assist.executorFallback"));
  const running = request.status === "running";
  const ran = request.status === "running" || request.status === "done" || request.status === "failed" || request.status === "stopped";
  const finished = request.status === "done" || request.status === "failed" || request.status === "stopped"
    || request.status === "rejected" || request.status === "cancelled" || request.status === "expired";
  // 新请求带完整过程；旧请求只有摘要步骤，按工具调用列出。
  const transcript: AssistTranscriptItem[] = request.transcript
    ?? request.steps.map((step) => ({ kind: "tool" as const, name: step.text, input: "", output: step.output ?? "", status: "done" as const }));

  return (
    <article className={frame.readerTurn} data-assist-round={request.attempt}>
      {props.showIndex ? (
        <span className={frame.readerTurnIndex}>{t("collab.assist.attemptLabel", { attempt: String(request.attempt) })}</span>
      ) : null}

      {/* 1. 发起方的请求 */}
      <div className={styles.requestSide} data-assist-part="request">
        <span className={styles.byline}>
          {[t("collab.assist.conv.requestBy", { requester, via: request.via }), assistClock(props.shift(request.createdAt))].filter(Boolean).join(" · ")}
        </span>
        <div className={styles.requestBubble}>
          <strong className={styles.requestTitle}>{request.title}</strong>
          {request.reason ? <p className={styles.requestReason}>{t("collab.assist.detail.reason", { reason: request.reason })}</p> : null}
          <ol className={styles.requestItems}>
            {request.items.map((item) => <li key={item}>{item}</li>)}
          </ol>
        </div>
      </div>

      {/* 2. 执行方的决定 */}
      <p className={styles.decision} data-assist-part="decision">{decisionText(request, thread, agent, props.shift, t)}</p>

      {/* 3. 执行方 Agent 收到的提示词 */}
      {request.prompt || request.promptContext ? (
        <section className={styles.section} data-assist-part="prompt">
          <span className={styles.sectionLabel}>{t("collab.assist.conv.prompt", { executor, agent })}</span>
          {request.prompt ? (
            <>
              {request.promptContext ? <span className={styles.subLabel}>{t("collab.assist.conv.promptMessage")}</span> : null}
              <FoldedText text={request.prompt} t={t} />
            </>
          ) : null}
          {request.promptContext ? (
            <>
              <span className={styles.subLabel}>{t("collab.assist.conv.promptContext")}</span>
              <FoldedText text={request.promptContext} t={t} />
            </>
          ) : null}
        </section>
      ) : null}

      {/* 4. 执行过程 */}
      {ran && (transcript.length || running) ? (
        <section className={styles.section} data-assist-part="process">
          <span className={styles.sectionLabel}>{t("collab.assist.conv.process")}</span>
          <div className={styles.process}>
            {transcript.map((item, index) => <TranscriptLine key={index} item={item} t={t} />)}
            {running ? (
              <p className={styles.runningLine}>
                <Loader2 size={13} aria-hidden="true" className={styles.spinIcon} />
                {t("collab.assist.conv.running")}
              </p>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* 5. 执行方的回复 */}
      {request.status === "done" ? (
        <div className={frame.readerAgent} data-assist-part="reply">
          <div className={frame.readerAgentHead}>
            <AssistAgentLogo agent={request.agent} name={agent} className={detailStyles.agentLogo} markClassName={detailStyles.agentMark} />
            <span>{t("collab.assist.conv.replyBy", { executor, agent })}</span>
            <span className={styles.byTime}>{assistClock(props.shift(request.finishedAt))}</span>
          </div>
          {request.reply ? <AgentMessageContent content={request.reply} readOnlyFileReferences /> : null}
          {request.resultItems.length ? (
            <dl className={styles.results}>
              {request.resultItems.map((item) => (
                <div key={`${item.key}-${item.value}`} className={styles.resultRow}>
                  <dt>{item.key}</dt>
                  <dd>{item.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {request.files.length ? (
            <div className={detailStyles.files}>
              {request.files.map((file) => (
                <span key={file.name} className={detailStyles.file}>
                  <FileText size={12} aria-hidden="true" />
                  {file.name}
                  <span className={detailStyles.fileSize}>{file.size}</span>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {(request.status === "failed" || request.status === "stopped") ? (
        <p className={detailStyles.failure} data-assist-part="failure">
          <AlertCircle size={13} aria-hidden="true" />
          {t("collab.assist.conv.notFinished", { reason: request.failure ?? t("collab.assist.state.failed") })}
        </p>
      ) : null}

      {/* 6. 发起方收到的内容 */}
      {finished && props.withConversation ? (
        request.delivery ? (
          <section className={styles.section} data-assist-part="delivery">
            <span className={styles.sectionLabel}>
              {[t("collab.assist.conv.delivery", { requester, via: request.via }), assistClock(props.shift(request.deliveredAt))].filter(Boolean).join(" · ")}
            </span>
            <FoldedText text={request.delivery} t={t} />
            {request.deliveryReply ? (
              <div className={`${frame.readerAgent} ${styles.deliveryReply}`}>
                <div className={frame.readerAgentHead}>
                  <span>{t("collab.assist.conv.deliveryReply", { requester, via: request.via })}</span>
                </div>
                <AgentMessageContent content={request.deliveryReply} readOnlyFileReferences />
              </div>
            ) : null}
          </section>
        ) : request.status !== "cancelled" ? (
          <p className={styles.note} data-assist-part="delivery">{t("collab.assist.conv.notDelivered", { requester })}</p>
        ) : null
      ) : null}
    </article>
  );
}

/** 执行方的决定：一行说明谁允许、由哪个 Agent、授权到什么程度，或者为什么没有执行。 */
function decisionText(
  request: AssistRequest,
  thread: AssistThread,
  agent: string,
  shift: (iso: string | null) => string | null,
  t: Translate
): string {
  const executor = thread.executor.name;
  switch (request.status) {
    case "pending":
      return request.autoRun
        ? t("collab.assist.conv.decision.autoPending", { executor, agent })
        : t("collab.assist.conv.decision.pending", { executor });
    case "confirm":
      return t("collab.assist.conv.decision.confirm", { executor });
    case "rejected":
      return request.failure ?? t("collab.assist.conv.decision.rejected", { executor });
    case "cancelled":
      return t("collab.assist.conv.decision.cancelled");
    case "expired":
      return t("collab.assist.conv.decision.expired");
    default:
      break;
  }
  if (request.scope === "timed") {
    if (request.decidedMinutes && request.decidedAt) {
      const until = shift(new Date(Date.parse(request.decidedAt) + request.decidedMinutes * 60_000).toISOString());
      return t("collab.assist.conv.decision.timed", {
        executor,
        agent,
        duration: grantDurationLabel(request.decidedMinutes, t),
        time: assistClock(until, true)
      });
    }
    return t("collab.assist.conv.decision.auto", { agent });
  }
  return t("collab.assist.conv.decision.once", { executor, agent });
}

/** 一段原文（提示词、收到的内容）：默认显示前几行，可展开全文。 */
function FoldedText(props: { text: string; t: Translate }) {
  const [open, setOpen] = useState(false);
  const lines = props.text.split("\n");
  const long = lines.length > PREVIEW_LINES || props.text.length > 600;
  const shown = open || !long ? props.text : `${lines.slice(0, PREVIEW_LINES).join("\n").slice(0, 600)}…`;
  return (
    <div className={styles.folded}>
      <pre className={styles.foldedText}>{shown}</pre>
      {long ? (
        <button type="button" className={styles.foldToggle} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {open ? props.t("collab.assist.collapse") : props.t("collab.assist.conv.showAll")}
        </button>
      ) : null}
    </div>
  );
}

/**
 * 执行过程里的一项：说明文字按 Markdown 显示；工具调用一行写做了什么，默认收起，展开后是命令或参数与完整输出，
 * 样式与对话页的工具步骤一致。
 */
function TranscriptLine(props: { item: AssistTranscriptItem; t: Translate }) {
  const { item, t } = props;
  if (item.kind === "omitted") {
    return <p className={styles.omitted}>{t("collab.assist.conv.omitted", { count: String(item.count) })}</p>;
  }
  if (item.kind === "text") {
    return (
      <div className={styles.processText}>
        <AgentMessageContent content={item.text} readOnlyFileReferences />
      </div>
    );
  }
  const failed = item.status === "failed";
  const summary = (
    <>
      {item.status === "running"
        ? <Loader2 size={13} aria-hidden="true" className={`agent-activity-timeline-item__icon ${styles.spinIcon}`} />
        : <Terminal size={13} aria-hidden="true" className="agent-activity-timeline-item__icon" />}
      <div className="agent-activity-timeline-item__body">
        <p className="agent-activity-timeline-item__line">
          <span className="agent-activity-timeline-item__verb">{failed ? `${item.name} · ${t("collab.assist.state.failed")}` : item.name}</span>
        </p>
      </div>
    </>
  );
  const className = "agent-activity-timeline-item agent-activity-timeline-item--tool";
  if (!item.input && !item.output) {
    return <div className={`${className} ${styles.toolRow}`} data-assist-tool="">{summary}</div>;
  }
  return (
    <details className={`${className} agent-activity-tool-details`} data-assist-tool="">
      <summary className="agent-activity-tool-details__summary">
        {summary}
        <ChevronRight size={12} aria-hidden="true" className="agent-activity-tool-details__chevron" />
      </summary>
      <div className="agent-activity-tool-card">
        {item.input ? (
          <div data-detail="arguments" className="agent-activity-tool-card__section">
            <pre className="agent-activity-tool-card__value">{item.input}</pre>
          </div>
        ) : null}
        {item.output ? (
          <div data-detail="result" className="agent-activity-tool-card__section">
            <pre className="agent-activity-tool-card__value">{item.output}</pre>
          </div>
        ) : null}
        {item.truncated ? <p className={styles.truncated}>{t("collab.assist.conv.truncated")}</p> : null}
      </div>
    </details>
  );
}
