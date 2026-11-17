/**
 * 成员协助在 Memmy 任务页上的部分。
 *
 * 执行方：协助由 Memmy 执行时，协助本身就是项目里的一条 Memmy 任务。面包屑下方一条协助条说明是谁的请求、
 * 授权到什么程度（仅这一次，或「1 小时内直接执行（到 08:45）」），右侧是「停止」与「结束授权」；
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
  ASSIST_STATUS_KEYS,
  AssistAgentLogo,
  assistAgentName,
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

/** 面包屑下方的协助条：谁的哪个 Agent 请求、授权到什么程度，以及停止与结束授权（限时授权仍有效时）。 */
export function CollabAssistTaskBar(props: { view: AssistTaskView; collab: CollabClient | null; onChanged: () => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const thread = props.view.executing?.thread;
  if (!thread) return null;
  const latest = thread.requests[0];
  const requester = thread.requester.name;
  const scope = thread.scope === "timed" && thread.grant
    ? grantSummary(thread.grant, t)
    : t("collab.assist.scopeOnce");
  const grantLive = thread.scope === "timed" && Boolean(thread.grant?.active);
  // 「张三的 Claude Code 请求 · 1 小时内直接执行（到 08:45）」；执行中以外再带上这一次的状态，结束后仍看得出结局。
  const parts = [
    t("collab.assist.requestFrom", { name: requester, via: thread.via }),
    thread.attempt > 1 ? t("collab.assist.attemptLabel", { attempt: String(thread.attempt) }) : "",
    // 等待确认或授权时这一次还没有授权方式，上一次的「仅这一次」不再适用。
    thread.scope && latest?.status !== "confirm" && latest?.status !== "pending" ? scope : "",
    // 停下的写明是谁停的：被发起方停下时，执行方在任务页里就知道不用再管了。
    latest && latest.status !== "running"
      ? latest.status === "stopped" ? assistStopText(latest, t) : t(ASSIST_STATUS_KEYS[latest.status])
      : ""
  ].filter(Boolean);

  async function act(run: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    try {
      await run();
    } catch {
      // 失败时协助条保持原样，下一轮读取会给出真实状态。
    } finally {
      setBusy(false);
      props.onChanged();
    }
  }

  const collab = props.collab;
  return (
    <div className={styles.grantbar} role="status" data-collab-assist-bar="">
      <span className={styles.grantText}>
        <span className={styles.avatar} style={{ background: memberColor(thread.requester.userId) }}>
          {Array.from(requester)[0] ?? ""}
        </span>
        <span>{parts.join(" · ")}</span>
      </span>
      {latest?.status === "running" && collab ? (
        <button type="button" className={styles.grantButton} disabled={busy} onClick={() => void act(() => collab.stopAssist(latest.id))}>
          {t("collab.assist.stop")}
        </button>
      ) : null}
      {grantLive && collab ? (
        <button
          type="button"
          className={`${styles.grantButton} ${styles.grantButtonDanger}`}
          disabled={busy}
          onClick={() => void act(() => collab.revokeAssistGrant(thread.projectId, thread.requester.userId))}
        >
          {t("collab.assist.endGrant")}
        </button>
      ) : null}
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
      {thread && latest && !confirm && (latest.status === "failed" || latest.status === "stopped") ? (
        <div className={styles.sent}>
          {latest.status === "stopped" ? assistStopText(latest, t) : latest.failure ?? t(ASSIST_STATUS_KEYS[latest.status])}
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
