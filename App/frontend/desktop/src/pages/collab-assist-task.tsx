/**
 * 成员协助在 Memmy 任务页上的部分。
 *
 * 执行方：协助由 Memmy 执行时，协助本身就是项目里的一条 Memmy 任务。输入框上方一个可呼吸的小 chip 说明是谁的请求，
 * 以及这一次的进展——停下时说清是谁停的、没跑完时给出原因、其余只写状态；执行中可以在 chip 里停止、限时授权可以结束。
 * 授权到什么程度（仅这一次，或「1 小时内直接执行（到 08:45）」）收在悬停提示里，
 * 同一次排查的后续请求需要她确认时，确认卡片出现在任务底部，
 * 确认后就在这条任务里继续；结果发出后，底部一行说明「结果已发给谁」，可展开查看发出去的内容。
 *
 * 发起方：在 Memmy 的任务里请成员协助后，这条任务底部出现请求卡片，状态随进展更新；
 * 结果送回任务后，卡片让位给消息流里的结果卡片。
 */
import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Send } from "lucide-react";
import type { AssistTaskView, CollabClient } from "../api/collab-client.js";
import { useTranslation } from "../i18n/use-translation.js";
import { AgentMessageContent } from "./agent-message-content.js";
import { CollabAssistRequestCard } from "./collab-assist-card.js";
import { ConfirmCard, type ConfirmDecision } from "./collab-assist-detail.js";
import {
  AssistAgentLogo,
  assistAgentName,
  assistStatusKey,
  assistStopText,
  grantSummary,
  pickAssistAgent,
  useAssistAgentChoice
} from "./collab-assist-view.js";
import styles from "./collab-assist-task.module.css";

/** 任务页读协助的间隔：与收件箱一致。 */
export const ASSIST_TASK_POLL_MS = 5_000;

const EMPTY_VIEW: AssistTaskView = { executing: null, requested: [] };

/** 内容没变就保留原对象：任务页的其他部分不必跟着轮询重画。 */
function sameView(left: AssistTaskView, right: AssistTaskView): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * 读一条 Memmy 任务上的协助。只在协作可用时读；不是协助、也没有发出过请求的任务拿到的是空视图，
 * 页面上什么都不多出来。
 */
export function useAssistTask(collab: CollabClient | null, chatId: string | null, enabled: boolean) {
  const [view, setView] = useState<AssistTaskView>(EMPTY_VIEW);
  const refresh = useCallback(async () => {
    if (!collab || !chatId || !enabled) return;
    try {
      const next = await collab.assistTask(chatId);
      setView((current) => (sameView(current, next) ? current : next));
    } catch {
      // 本机接口短暂不可用：保留上一份，下一轮再读。
    }
  }, [collab, chatId, enabled]);

  useEffect(() => {
    setView(EMPTY_VIEW);
    if (!collab || !chatId || !enabled) return;
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, ASSIST_TASK_POLL_MS);
    return () => clearInterval(timer);
  }, [collab, chatId, enabled, refresh]);

  return { view, refresh };
}

/**
 * 输入框上方的协助 chip：写是谁的哪个 Agent 发来的请求，这一次的状态也写在同一行里，不另起一行。
 * 状态只用两种样子表达——进行中薄荷绿并轻轻呼吸，停下或结束后变红、不再动；
 * 授权方式、第几次这些细节收进悬停提示，不摊在 chip 上。
 */
export function CollabAssistTaskChip(props: { view: AssistTaskView; collab: CollabClient | null; onChanged: () => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const thread = props.view.executing?.thread;
  if (!thread) return null;
  const latest = thread.requests[0];
  const runningRequest = latest?.status === "running" ? latest : null;
  const running = runningRequest !== null;
  const grantLive = thread.scope === "timed" && Boolean(thread.grant?.active);
  const label = t("collab.assist.requestFrom", { name: thread.requester.name, via: thread.via });
  // 这一次的结果直接写进 chip：停下时说清是谁停的，没跑完时给出原因，其余只写状态本身。
  const outcome = latest && !running
    ? latest.status === "stopped"
      ? assistStopText(latest, t)
      : latest.status === "failed"
        ? t("collab.assist.conv.notFinished", { reason: latest.failure ?? t("collab.assist.state.failed") })
        : t(assistStatusKey(latest))
    : "";
  // 停下那句话本身就带名字（「小饭团停止了这次执行」），不再重复一遍「小饭团的 Memmy 请求」。
  const chipText = !outcome || latest?.status === "stopped" ? outcome || label : `${label} · ${outcome}`;
  // 悬停时才看的细节：第几次、授权到什么程度、这一次的结局。
  const detail = [
    latest && thread.attempt > 1 ? t("collab.assist.attemptLabel", { attempt: String(thread.attempt) }) : "",
    thread.scope === "timed" && thread.grant
      ? grantSummary(thread.grant, t)
      : thread.scope && latest?.status !== "confirm" && latest?.status !== "pending" ? t("collab.assist.scopeOnce") : "",
    latest && latest.status !== "stopped" ? outcome : ""
  ].filter(Boolean).join(" · ");

  async function act(run: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    try {
      await run();
    } catch {
      // 失败时 chip 保持原样，下一轮读取会给出真实状态。
    } finally {
      setBusy(false);
      props.onChanged();
    }
  }

  const collab = props.collab;
  return (
    <div className={styles.chipRow}>
      <div
        className={`${styles.chip} ${running ? styles.chipRunning : styles.chipStopped}`}
        role="status"
        data-collab-assist-chip=""
        data-state={running ? "running" : "stopped"}
        title={detail ? `${label} · ${detail}` : label}
      >
        <span className={styles.pulse} aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className={styles.chipText}>{chipText}</span>
        {runningRequest && collab ? (
          <button type="button" className={styles.chipAction} disabled={busy} onClick={() => void act(() => collab.stopAssist(runningRequest.id))}>
            {t("collab.assist.stop")}
          </button>
        ) : null}
        {grantLive && collab ? (
          <button
            type="button"
            className={styles.chipAction}
            disabled={busy}
            onClick={() => void act(() => collab.revokeAssistGrant(thread.projectId, thread.requester.userId))}
          >
            {t("collab.assist.endGrant")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** 任务底部：执行方的确认卡片与「结果已发给谁」，发起方还没送回结果的请求卡片。 */
export function CollabAssistTaskDock(props: { view: AssistTaskView; collab: CollabClient | null; onChanged: () => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [sentOpen, setSentOpen] = useState(false);
  const { view, collab } = props;
  const executing = view.executing;
  const thread = executing?.thread ?? null;
  const latest = thread?.requests[0] ?? null;
  const confirm = executing?.confirm ?? null;
  // 发起方：结果还没送回这条任务的请求才在底部显示；送回之后由消息里的结果卡片承接。
  const waiting = view.requested.filter((request) => !request.delivered);
  // 确认时由谁执行：与授权弹窗同一份候选，上一次的 Agent 仍能运行就用它，否则用默认项。
  const choice = useAssistAgentChoice(collab, confirm?.projectId ?? null, confirm?.requester.userId ?? null, Boolean(confirm));
  const confirmAgent = pickAssistAgent(choice, confirm?.lastAgent ?? thread?.agent ?? null);
  if (!thread && !waiting.length) return null;

  async function decide(decision: ConfirmDecision) {
    if (!collab || !confirm || busy) return;
    setBusy(true);
    try {
      const agent = confirmAgent ?? "memmy";
      await collab.decideAssist(confirm.id, decision.action === "allow"
        ? { action: "allow", agent, scope: decision.scope, ...(decision.scope === "timed" ? { minutes: decision.minutes } : {}) }
        : { action: "reject" });
    } catch {
      // 请求可能已在别处处理：下一轮读取会更新。
    } finally {
      setBusy(false);
      props.onChanged();
    }
  }

  const agentName = choice?.agents.find((item) => item.sourceId === confirmAgent)?.name
    ?? assistAgentName(confirmAgent, t("collab.assist.executorFallback"));
  return (
    <div className={styles.dock} data-collab-assist-dock="">
      {thread && confirm ? (
        <ConfirmCard
          requesterName={thread.requester.name}
          attempt={confirm.attempt}
          agentName={agentName}
          busy={busy}
          onDecide={(decision) => void decide(decision)}
        />
      ) : null}
      {thread && latest && !confirm && latest.status === "done" ? (
        <div className={styles.sentBlock}>
          <button type="button" className={styles.sentToggle} aria-expanded={sentOpen} onClick={() => setSentOpen((open) => !open)}>
            <Send size={13} aria-hidden="true" />
            <span>{t("collab.assist.sent", { name: thread.requester.name })}</span>
            {latest.files.length ? <span>· {t("collab.assist.sentFiles", { count: String(latest.files.length) })}</span> : null}
            {sentOpen ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
          </button>
          {sentOpen ? (
            <div className={styles.sentBody}>
              {latest.resultItems.length ? (
                <dl className={styles.sentItems}>
                  {latest.resultItems.map((item) => (
                    <div key={item.key}>
                      <dt>{item.key}</dt>
                      <dd>{item.value}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              {/* 回复按 Markdown 渲染，与对话正文一致，不露出原样的符号。 */}
              {latest.reply ? <div className={styles.sentReply}><AgentMessageContent content={latest.reply} readOnlyFileReferences /></div> : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {waiting.map((request) => (
        <CollabAssistRequestCard key={request.id} request={request} collab={collab} onChanged={() => props.onChanged()} />
      ))}
    </div>
  );
}

/** 消息里的请求与结果卡片也要用到执行 Agent 的图标。 */
export { AssistAgentLogo };

/** 成员头像的底色：按 id 取一个稳定的颜色，同一个人在自己这边与成员那边看到的一样。 */
export function memberColor(userId: string): string {
  const palette = ["#3aa893", "#e08a5a", "#7a8ee0", "#c98ac0", "#58a6c9", "#c9a227"];
  let sum = 0;
  for (const char of userId) sum += char.charCodeAt(0);
  return palette[sum % palette.length]!;
}
