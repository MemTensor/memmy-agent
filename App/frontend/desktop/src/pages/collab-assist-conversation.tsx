/**
 * 看板上打开的一次协助：按会话展示双方的完整上下文，位置与排版和读成员任务的只读面板一致。
 *
 * 每一次请求是一轮，按时间顺序是一条链：发起方 Agent 里发起这次请求的对话（用户的话、思考、说明与工具调用）→
 * 请求 → 执行方的决定 → 执行方 Agent 收到的提示词（Memmy 执行时另有隐藏注入的格式要求）、执行过程与回复 →
 * 发起方收到的结果与之后的过程和回复。发起方那两段只有 Memmy 与 DeepSeek Harness 发起时有；旧请求与其他 Agent 发起时
 * 仍是「收到的内容 + 收到后的回复」。发起人与执行人看到的是同一份内容；项目里的其他成员看不到。执行中每 3 秒重读一次；
 * 请求结束后发起方那边还会陆续上传收到的内容与之后的过程，所以结束后 30 分钟内每 5 秒再读一次。
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, Brain, ChevronRight, FileText, Inbox, Loader2, Terminal, X } from "lucide-react";
import type { AssistRequest, AssistThread, AssistThreadDetail, AssistTranscriptItem, CollabClient } from "../api/collab-client.js";
import { ApiRequestError } from "../api/http.js";
import type { MessageKey } from "../i18n/messages.js";
import { useTranslation } from "../i18n/use-translation.js";
import { AgentMessageContent } from "./agent-message-content.js";
import { ConfirmCard } from "./collab-assist-detail.js";
import { agentSourceIdOf, AssistMessageCard, parseAssistEnvelope } from "./collab-assist-message.js";
import {
  AssistAgentLogo,
  assistAgentName,
  assistClock,
  assistIsOpen,
  assistStopText,
  grantDurationLabel,
  pickAssistAgent,
  useAssistAgentChoice
} from "./collab-assist-view.js";
import frame from "./collab-page.module.css";
import { ASSIST_PANEL_WIDTH_STORAGE_KEY, useReaderPanelWidth } from "./collab-reader-resize.js";
import detailStyles from "./collab-assist-detail.module.css";
import styles from "./collab-assist-conversation.module.css";

type Translate = (key: MessageKey, values?: Record<string, string>) => string;

/** 执行中多久重读一次。 */
const LIVE_POLL_MS = 3_000;
/** 请求结束后多久重读一次：与发起方 Memmy 追读本机记录的节奏一致。 */
const SYNC_POLL_MS = 5_000;
/**
 * 请求结束后还等发起方补传多久：与本机后端停止追读发起方记录、等待 Memmy 收到后回复的上限相同（30 分钟）。
 * 超过之后不会再有新内容，面板停止重读。
 */
const SYNC_WINDOW_MS = 30 * 60_000;
/** 提示词与收到的内容默认显示的行数。 */
const PREVIEW_LINES = 6;

/** 旧的引用位置：宽度常量已移到 collab-reader-resize。 */
export { ASSIST_PANEL_WIDTH_STORAGE_KEY };

export function CollabAssistConversation(props: {
  /** 看板列表里的这一行：打开时先用它画出标题，详情读到后再补全会话。 */
  thread: AssistThread | null;
  collab: CollabClient | null;
  /** 发起的任务是否还在这台电脑上：只对还在的任务给出「打开发起的任务」。 */
  sourceTaskAvailable?: (chatId: string) => boolean;
  onOpenTask?: (chatId: string) => void;
  /** 撤回、停止或确认之后：看板重新读一次协助。 */
  onChanged?: () => void;
  /**
   * 从本人的列表中移除之后：只对自己隐藏（hidden），或者对方也移除过、记录已删除（deleted）。看板据此关掉面板并提示。
   * 不给时不出现「删除」。删除只是从自己的列表中移除，另一方仍看得到。
   */
  onRemoved?: (removed: "hidden" | "deleted") => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const panelRef = useRef<HTMLElement | null>(null);
  const panelWidth = useReaderPanelWidth(ASSIST_PANEL_WIDTH_STORAGE_KEY, t("collab.assist.conv.resize"));
  const { thread: summary, collab } = props;
  const open = summary !== null;
  const [detail, setDetail] = useState<AssistThreadDetail | null>(null);
  const [offset, setOffset] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 点了「删除」，正在等确认：底部换成一句说明与「取消 / 删除」。 */
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  /** 判断「还在等发起方补传」用的时刻：只在打开时与某次请求的等待到期时更新，不随轮询重画。 */
  const [clock, setClock] = useState(() => Date.now());
  /** 上一次读到的内容：没变就不写，面板不跟着轮询重画。 */
  const loadedKey = useRef("");
  /**
   * 现在开着的是哪一次协助（关着时为 null）。读取是异步的：关掉面板或换到另一次协助时，还在路上的那次读取
   * 返回后不能再写进来，否则面板会在关闭后又显示出来，而且再也关不掉。
   */
  const activeThread = useRef<string | null>(null);

  const projectId = summary?.projectId ?? null;
  const threadId = summary?.threadId ?? null;
  activeThread.current = open ? threadId : null;
  // 列表里这一行有变化（新请求、状态变了）时也重读一次。
  const changeKey = summary ? `${summary.lastActiveAt ?? ""}|${summary.status}|${summary.attempt}` : "";

  const load = useCallback(async () => {
    if (!collab || !projectId || !threadId) return;
    try {
      const next = await collab.assistThread(projectId, threadId);
      if (activeThread.current !== threadId) return;
      const key = JSON.stringify(next.thread);
      if (key !== loadedKey.current) {
        loadedKey.current = key;
        setDetail(next);
      }
      setLoadFailed(false);
      // 云端数据库的时间与本机时钟的差：会话里的时间都按本机时间显示（测试库的时区设置差了 8 小时）。
      // 每次读到的差会有几十毫秒的抖动，差超过 1 秒才更新，面板不跟着重画。
      const server = next.serverTime ? Date.parse(next.serverTime) : Number.NaN;
      const nextOffset = Number.isFinite(server) ? Date.now() - server : 0;
      setOffset((current) => (Math.abs(current - nextOffset) > 1_000 ? nextOffset : current));
    } catch {
      if (activeThread.current === threadId) setLoadFailed(true);
    }
  }, [collab, projectId, threadId]);

  useEffect(() => {
    setDetail(null);
    setError(null);
    setLoadFailed(false);
    setConfirmingRemove(false);
    setClock(Date.now());
    loadedKey.current = "";
  }, [threadId]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load, changeKey]);

  // 重新打开时从当前时刻算起：面板关着的时候时刻不更新。
  useEffect(() => {
    if (open) setClock(Date.now());
  }, [open, changeKey]);

  // 关着时什么都不画；读到的内容只在属于现在开着的这次协助时才用。
  const current = open && detail && detail.thread.threadId === threadId ? detail : null;
  const thread = !open ? null : current?.thread ?? summary;
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

  /**
   * 请求结束之后，发起方那边还会陆续上传收到的内容、收到之后的过程与回复。这些上传不改变看板上的时间，
   * 列表那一行不会变，所以结束后的 30 分钟里面板自己接着读。按云端时间换算成本机时刻。
   */
  const syncDeadlines = useMemo(() => {
    const deadlines = new Map<string, number>();
    for (const request of thread?.requests ?? []) {
      if (assistIsOpen(request.status)) continue;
      const end = request.finishedAt ?? request.decidedAt ?? request.createdAt;
      const at = end ? Date.parse(end) : Number.NaN;
      if (Number.isFinite(at)) deadlines.set(request.id, at + offset + SYNC_WINDOW_MS);
    }
    return deadlines;
  }, [thread, offset]);
  const nextDeadline = useMemo(() => {
    const upcoming = [...syncDeadlines.values()].filter((deadline) => deadline > clock);
    return upcoming.length ? Math.min(...upcoming) : null;
  }, [syncDeadlines, clock]);
  const syncing = nextDeadline !== null;

  // 等到期时更新一次时刻：停止重读，并把「还在同步」换成「没有读到」。
  useEffect(() => {
    if (!open || nextDeadline === null) return;
    const timer = setTimeout(() => setClock(Date.now()), Math.max(0, nextDeadline - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [open, nextDeadline]);

  useEffect(() => {
    if (!open || live || !syncing) return;
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, SYNC_POLL_MS);
    return () => clearInterval(timer);
  }, [open, live, syncing, load]);

  if (!thread || typeof document === "undefined") return null;

  const shift = (iso: string | null) => (iso ? new Date(Date.parse(iso) + offset).toISOString() : null);
  const agentName = assistAgentName(thread.agent, t("collab.assist.executorFallback"));
  const route = thread.agent
    ? t("collab.assist.detail.route", { requester: thread.requester.name, via: thread.via, executor: thread.executor.name, agent: agentName })
    : t("collab.assist.detail.routePending", { requester: thread.requester.name, via: thread.via, executor: thread.executor.name });
  const confirmAgent = pickAssistAgent(choice, thread.agent);
  const confirmAgentName = choice?.agents.find((item) => item.sourceId === confirmAgent)?.name
    ?? assistAgentName(confirmAgent, t("collab.assist.executorFallback"));
  const sourceTask = current?.thread.sourceTask ?? (thread.mine ? thread.requests.find((request) => request.sourceTask)?.sourceTask ?? null : null);
  const canOpenSource = Boolean(sourceTask && props.onOpenTask && (props.sourceTaskAvailable?.(sourceTask) ?? true));
  const executorTask = thread.executor.mine ? thread.conversationId : null;

  async function remove() {
    if (busy || !collab || !thread) return;
    setBusy(true);
    setError(null);
    try {
      const result = await collab.hideAssistThread(thread.projectId, thread.threadId);
      setConfirmingRemove(false);
      props.onRemoved?.(result.removed);
    } catch {
      setError(t("collab.assist.failed"));
      setConfirmingRemove(false);
    } finally {
      setBusy(false);
    }
  }

  async function act(run: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch (error) {
      // 两人几乎同时停止、或对方刚好跑完时，后到的那一下拿到 409：不是故障，刷新面板就行。
      if (!(error instanceof ApiRequestError && error.status === 409)) setError(t("collab.assist.failed"));
    } finally {
      props.onChanged?.();
      void load();
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
        style={panelWidth.style}
      >
        {panelWidth.handle}
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
          {!current && !loadFailed ? <p className={styles.note}>{t("collab.assist.conv.loading")}</p> : null}
          {loadFailed && !current ? <p className={styles.note}>{t("collab.assist.conv.loadFailed")}</p> : null}
          {rounds.map((request) => (
            <AssistRound
              key={request.id}
              request={request}
              thread={thread}
              showIndex={rounds.length > 1}
              withConversation={Boolean(current)}
              syncing={(syncDeadlines.get(request.id) ?? 0) > clock}
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

        {confirmingRemove ? (
          <footer className={detailStyles.foot} data-assist-remove-confirm="">
            <span className={detailStyles.footNote}>
              {t("collab.assist.removeConfirm", { other: thread.mine ? thread.executor.name : thread.requester.name })}
            </span>
            <span className={detailStyles.grow} />
            <button type="button" className={detailStyles.button} disabled={busy} onClick={() => setConfirmingRemove(false)}>
              {t("collab.cancel")}
            </button>
            <button
              type="button"
              className={`${detailStyles.button} ${detailStyles.buttonPrimary}`}
              disabled={busy}
              onClick={() => void remove()}
            >
              {t("collab.assist.removeAction")}
            </button>
          </footer>
        ) : (
        <footer className={detailStyles.foot}>
          <span className={detailStyles.footNote}>{t("collab.assist.detail.visibility")}</span>
          <span className={detailStyles.grow} />
          {/* 结束了的协助可以从自己的列表中移除；还在进行的先撤回或停止。 */}
          {!live && collab && props.onRemoved ? (
            <button type="button" className={detailStyles.button} disabled={busy} onClick={() => setConfirmingRemove(true)}>
              {t("collab.assist.remove")}
            </button>
          ) : null}
          {thread.mine && latest && (latest.status === "pending" || latest.status === "confirm") && collab ? (
            <button type="button" className={detailStyles.button} disabled={busy} onClick={() => void act(() => collab.cancelAssist(latest.id))}>
              {t("collab.assist.withdraw")}
            </button>
          ) : null}
          {/* 发起人也能停下执行中的请求：同一位置、同一样式，只换文案。 */}
          {thread.mine && latest?.status === "running" && collab ? (
            <button type="button" className={detailStyles.button} disabled={busy} onClick={() => void act(() => collab.cancelAssist(latest.id))}>
              {t("collab.assist.stop")}
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
        )}
      </aside>
    </div>,
    document.body
  );
}

/** 一次请求：发起方的对话、请求、决定、提示词、过程、回复、发起方收到的结果与之后的过程。 */
function AssistRound(props: {
  request: AssistRequest;
  thread: AssistThread;
  showIndex: boolean;
  /** 详情已经读到：没有会话内容时按旧请求处理，只显示已有的部分。 */
  withConversation: boolean;
  /** 这次请求结束不到 30 分钟：发起方那边可能还在补传。 */
  syncing: boolean;
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
  // 发起方的记录（Memmy 与 DeepSeek Harness 发起时有）：有就按链展示，没有就是原来的「收到的内容」。
  const chain = props.withConversation && (request.origin != null || request.followup != null);
  const requesterSide = (
    <SideHead
      label={t("collab.assist.conv.side.requester", { requester, via: request.via })}
      agent={agentSourceIdOf(request.via)}
      name={request.via}
    />
  );

  return (
    <article className={frame.readerTurn} data-assist-round={request.attempt}>
      {props.showIndex ? (
        <span className={frame.readerTurnIndex}>{t("collab.assist.attemptLabel", { attempt: String(request.attempt) })}</span>
      ) : null}

      {/* 0. 发起方 Agent 里发起这次请求的对话 */}
      {chain ? (
        <section className={styles.side} data-assist-part="origin">
          {requesterSide}
          {request.origin?.length
            ? <ChainItems items={request.origin} t={t} />
            : <p className={styles.note}>{t("collab.assist.conv.originPending", { requester, via: request.via })}</p>}
        </section>
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

      {chain && (request.prompt || request.promptContext || ran) ? (
        <SideHead
          label={t("collab.assist.conv.side.executor", { executor, agent })}
          agent={request.agent ?? request.grant?.agent ?? null}
          name={agent}
        />
      ) : null}

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
          {request.status === "stopped"
            ? t("collab.assist.conv.notFinished", { reason: assistStopText(request, t) })
            : t("collab.assist.conv.notFinished", { reason: request.failure ?? t("collab.assist.state.failed") })}
        </p>
      ) : null}

      {/* 6. 发起方收到的结果：有发起方记录时是收到结果那一步起的过程与回复，否则是收到的内容与回复 */}
      {finished && chain && request.followup?.length ? (
        <section className={styles.side} data-assist-part="followup">
          {requesterSide}
          <ChainItems items={request.followup} t={t} />
        </section>
      ) : finished && props.withConversation ? (
        <>
          {request.delivery ? (
            <section className={styles.section} data-assist-part="delivery">
              <span className={styles.sectionLabel}>
                {[t("collab.assist.conv.delivery", { requester, via: request.via }), assistClock(props.shift(request.deliveredAt))].filter(Boolean).join(" · ")}
              </span>
              <DeliveredText text={request.delivery} t={t} />
              {request.deliveryReply ? (
                <div className={`${frame.readerAgent} ${styles.deliveryReply}`}>
                  <div className={frame.readerAgentHead}>
                    <span>{t("collab.assist.conv.deliveryReply", { requester, via: request.via })}</span>
                  </div>
                  <AgentMessageContent content={request.deliveryReply} readOnlyFileReferences />
                </div>
              ) : null}
            </section>
          ) : request.status !== "cancelled" && !chain ? (
            <p className={styles.note} data-assist-part="delivery">{t("collab.assist.conv.notDelivered", { requester })}</p>
          ) : null}
          {chain && request.status !== "cancelled" ? (
            <p className={styles.note} data-assist-part="followup-pending">
              {t(props.syncing ? "collab.assist.conv.followupPending" : "collab.assist.conv.followupMissing", { requester, via: request.via })}
            </p>
          ) : null}
        </>
      ) : null}
    </article>
  );
}

/** 链上一段的归属：哪一方、谁的哪个 Agent。 */
function SideHead(props: { label: string; agent: string | null; name: string }) {
  return (
    <div className={styles.sideHead}>
      <AssistAgentLogo agent={props.agent} name={props.name} className={detailStyles.agentLogo} markClassName={detailStyles.agentMark} />
      <span>{props.label}</span>
    </div>
  );
}

/**
 * 发起方记录的一段：用户说的话单独成气泡，其余（思考、说明、工具调用）与执行过程同一种排法；
 * 拿到结果的那一步突出显示为「收到的结果」。
 */
function ChainItems(props: { items: readonly AssistTranscriptItem[]; t: Translate }) {
  const { t } = props;
  const blocks: ReactElement[] = [];
  let group: AssistTranscriptItem[] = [];
  const flush = () => {
    if (!group.length) return;
    const items = group;
    group = [];
    blocks.push(
      <div key={`g${blocks.length}`} className={styles.process}>
        {items.map((item, index) => <TranscriptLine key={index} item={item} t={t} />)}
      </div>
    );
  };
  for (const item of props.items) {
    const delivery = (item.kind === "tool" || item.kind === "user") && item.delivery === true;
    if (item.kind !== "user" && !delivery) {
      group.push(item);
      continue;
    }
    flush();
    const key = `i${blocks.length}`;
    if (delivery) {
      blocks.push(<ReceivedResult key={key} item={item} t={t} />);
    } else if (item.kind === "user") {
      const envelope = parseAssistEnvelope(item.text);
      blocks.push(envelope ? (
        <div key={key} className={styles.received}><AssistMessageCard envelope={envelope} /></div>
      ) : (
        <div key={key} className={styles.userSide} data-assist-item="user">
          <div className={styles.userBubble}>
            <AgentMessageContent content={item.text} readOnlyFileReferences />
          </div>
        </div>
      ));
    }
  }
  flush();
  return <>{blocks}</>;
}

/** 发起方拿到结果的那一步：外部 Agent 是那次 wait / status 的输出，Memmy 是送进任务的结果消息（显示成结果卡片）。 */
function ReceivedResult(props: { item: AssistTranscriptItem; t: Translate }) {
  const { item, t } = props;
  const text = item.kind === "tool" ? item.output : item.kind === "user" ? item.text : "";
  return (
    <section className={styles.received} data-assist-item="received">
      <span className={styles.receivedLabel}>
        <Inbox size={13} aria-hidden="true" />
        {t("collab.assist.conv.received")}
      </span>
      {item.kind === "tool" && item.input ? <code className={styles.receivedCommand}>{item.input}</code> : null}
      <DeliveredText text={text} t={t} />
    </section>
  );
}

/** 发起方收到的内容：Memmy 的结果消息显示成结果卡片，不露出标签；命令行输出按原文显示。 */
function DeliveredText(props: { text: string; t: Translate }) {
  const envelope = parseAssistEnvelope(props.text);
  return envelope ? <AssistMessageCard envelope={envelope} /> : <FoldedText text={props.text} t={props.t} />;
}

/** 一段思考：默认收起，只显示第一行，展开看全文。 */
function ThinkingLine(props: { text: string; truncated?: boolean; t: Translate }) {
  const preview = props.text.trim().split("\n")[0] ?? "";
  return (
    <details className={styles.thinking} data-assist-item="thinking">
      <summary className={styles.thinkingSummary}>
        <Brain size={13} aria-hidden="true" />
        <span className={styles.thinkingLabel}>{props.t("collab.assist.conv.thinking")}</span>
        <span className={styles.thinkingPreview}>{preview}</span>
        <ChevronRight size={12} aria-hidden="true" className={styles.thinkingChevron} />
      </summary>
      <div className={styles.thinkingText}>{props.text}</div>
      {props.truncated ? <p className={styles.truncated}>{props.t("collab.assist.conv.truncated")}</p> : null}
    </details>
  );
}

/** 还在等她处理、而她此刻不在线：补一句她打开 Memmy 后才会看到。 */
function offlineSuffix(request: AssistRequest, executor: string, t: Translate): string {
  return request.executorOffline ? ` · ${t("collab.assist.conv.offline", { executor })}` : "";
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
      return (request.autoRun
        ? t("collab.assist.conv.decision.autoPending", { executor, agent })
        : t("collab.assist.conv.decision.pending", { executor })) + offlineSuffix(request, executor, t);
    case "confirm":
      return t("collab.assist.conv.decision.confirm", { executor }) + offlineSuffix(request, executor, t);
    case "stopped":
      // 谁停的按看的人写：本人停的就是「你停止了这次执行」。
      return assistStopText(request, t);
    case "rejected":
      return request.failure ?? t("collab.assist.conv.decision.rejected", { executor });
    case "cancelled":
      return t("collab.assist.conv.decision.cancelled");
    case "expired":
      return t("collab.assist.conv.decision.expired", { executor });
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
  if (item.kind === "thinking") return <ThinkingLine text={item.text} {...(item.truncated ? { truncated: true } : {})} t={t} />;
  if (item.kind === "text" || item.kind === "user") {
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
