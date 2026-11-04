/**
 * 成员协助：执行方那条任务页上的协助部分。
 *
 * 页面本身是项目下的一条本机任务：顶部一条授权条说明这次由谁执行、授权到什么程度，可以随时停止或结束授权；
 * 正文先列出对方要做什么，再按顺序展示执行的每一步；结果发出后给出「已发给谁」，需要她确认时给一张卡片。
 *
 * 过程统一在 Memmy 里看：Claude Code、Codex、Cursor 在后台跑的会话不会出现在它们自己的界面里。
 */
import { useEffect, useRef, useState } from "react";
import { AlertCircle, Check, History, Lock, Send, X } from "lucide-react";
import type { AssistExecution, AssistRequest, AssistScope, CollabClient } from "../api/collab-client.js";
import { useTranslation } from "../i18n/use-translation.js";
import { agentSourceLogoUrl } from "./agent-source-logos.js";
import styles from "./collab-assist-task.module.css";

export function CollabAssistTask(props: {
  request: AssistRequest;
  /** 本机这次执行的进度；还没开始或已结束后不再有。 */
  execution?: AssistExecution;
  collab: CollabClient | null;
  /** 执行方这个 Agent 自己的历史记录里也能看到这条会话：过程说明里补一句。 */
  agentKeepsHistory?: boolean;
  onChanged: (request: AssistRequest) => void;
  /** 结束授权之后：看板与设置里的授权行也要跟着变。 */
  onRevoked?: () => void;
}) {
  const { t } = useTranslation();
  const { request, execution, collab } = props;
  const [busy, setBusy] = useState<"stop" | "revoke" | "allow" | "deny" | "always" | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  const steps = execution?.steps?.length ? execution.steps : request.steps;
  // 只按请求自己的状态判断「还在执行」：执行记录可能比请求多留一会儿，不能让它继续转圈。
  const running = request.status === "running";
  const scope = request.scope;

  // 新的一步到了就滚到底：执行过程是边跑边看的。
  useEffect(() => {
    const node = threadRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [steps.length, request.status]);

  async function act(kind: "stop" | "revoke" | "allow" | "deny" | "always") {
    if (!collab || busy) return;
    setBusy(kind);
    setError(null);
    try {
      if (kind === "stop") {
        props.onChanged(await collab.stopAssist(request.id));
      } else if (kind === "revoke") {
        await collab.revokeAssistGrant(request.projectId, request.requester.userId);
        props.onRevoked?.();
      } else if (kind === "deny") {
        props.onChanged(await collab.decideAssist(request.id, { action: "reject" }));
      } else {
        props.onChanged(await collab.decideAssist(request.id, {
          action: "allow",
          agent: request.agent ?? undefined,
          scope: (kind === "always" ? "always" : "once") as AssistScope
        }));
      }
    } catch {
      setError(t("collab.assist.failed"));
    } finally {
      setBusy(null);
    }
  }

  async function sendNote() {
    if (!collab || !note.trim()) return;
    const text = note.trim();
    setNote("");
    await collab.noteAssist(request.id, text).catch(() => setError(t("collab.assist.failed")));
  }

  const requester = request.requester.name;
  const agentName = agentNameOf(request.agent, t("collab.assist.executorFallback"));
  const finished = ["done", "failed", "stopped", "rejected", "cancelled", "expired"].includes(request.status);

  return (
    <div className={styles.page}>
      <GrantBar
        request={request}
        scope={scope}
        agentName={agentName}
        busy={busy}
        onStop={() => void act("stop")}
        onRevoke={() => void act("revoke")}
      />

      <div className={styles.thread} ref={threadRef}>
        <div className={styles.column}>
          <RequestMessage request={request} />

          {request.status === "confirm" ? (
            <div className={styles.askCard}>
              <div className={styles.askHead}>
                <AlertCircle size={15} aria-hidden="true" />
                {t("collab.assist.askTitle", { name: requester, attempt: String(request.attempt) })}
              </div>
              <div className={styles.askBody}>
                {t("collab.assist.askBody", { agent: agentName })}
              </div>
              <div className={styles.askActions}>
                <button type="button" className={styles.askButton} disabled={busy !== null} onClick={() => void act("deny")}>
                  {t("collab.assist.askDeny")}
                </button>
                <button type="button" className={styles.askButton} disabled={busy !== null} onClick={() => void act("allow")}>
                  {t("collab.assist.askAllowOnce")}
                </button>
                <button type="button" className={`${styles.askButton} ${styles.askButtonPrimary}`} disabled={busy !== null} onClick={() => void act("always")}>
                  {t("collab.assist.askAlways")}
                </button>
              </div>
            </div>
          ) : (
            <div className={styles.block}>
              <div className={styles.processHead}>
                <AgentLogo agent={request.agent} name={agentName} />
                <strong>{agentName}</strong>
                <span>{t("collab.assist.processHead", { agent: agentName })}</span>
              </div>
              <div className={styles.steps}>
                {steps.length ? steps.map((step, index) => {
                  const waiting = running && index === steps.length - 1;
                  return (
                    <div className={styles.step} key={`${index}-${step.text}`}>
                      <span className={`${styles.stepIcon} ${waiting ? styles.stepIconWaiting : ""}`}>
                        {waiting ? <span className={styles.spin} /> : <Check size={13} aria-hidden="true" />}
                      </span>
                      <span>
                        {step.text}
                        {!waiting && step.output ? <div className={styles.stepOutput}>{step.output}</div> : null}
                      </span>
                    </div>
                  );
                }) : (
                  <div className={styles.step}>
                    <span className={`${styles.stepIcon} ${styles.stepIconWaiting}`}><span className={styles.spin} /></span>
                    <span>{t("collab.assist.starting", { agent: agentName })}</span>
                  </div>
                )}
              </div>

              {request.status === "rejected" ? (
                <div className={styles.steps}>
                  <div className={styles.step}>
                    <span className={`${styles.stepIcon} ${styles.stepIconBlocked}`}><X size={13} aria-hidden="true" /></span>
                    <span>{t("collab.assist.notAllowed", { name: requester })}</span>
                  </div>
                </div>
              ) : null}

              {request.status === "failed" || request.status === "stopped" ? (
                <div className={styles.steps}>
                  <div className={styles.step}>
                    <span className={`${styles.stepIcon} ${styles.stepIconBlocked}`}><AlertCircle size={13} aria-hidden="true" /></span>
                    <span>{request.failure ?? t("collab.assist.failed")}</span>
                  </div>
                </div>
              ) : null}

              {finished && request.status === "done" ? (
                <>
                  {request.reply ? <p>{request.reply}</p> : null}
                  <div className={styles.sent}>
                    <Send size={13} aria-hidden="true" />
                    {t("collab.assist.sent", { name: requester })}
                    {request.files.length ? ` · ${t("collab.assist.sentFiles", { count: String(request.files.length) })}` : ""}
                  </div>
                  {props.agentKeepsHistory ? (
                    <div className={styles.sent}>
                      <History size={13} aria-hidden="true" />
                      {t("collab.assist.agentHistory", { agent: agentName })}
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          )}

          {error ? <p className={styles.muted} role="alert">{error}</p> : null}
        </div>
      </div>

      <div className={styles.composer}>
        <div className={styles.composerBox}>
          <textarea
            className={styles.composerInput}
            rows={1}
            value={note}
            placeholder={t("collab.assist.composerPlaceholder", { name: requester })}
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void sendNote();
              }
            }}
          />
          <div className={styles.composerBar}>
            <span className={styles.grow} />
            <button
              type="button"
              className={`${styles.send} ${note.trim() ? styles.sendActive : ""}`}
              aria-label={t("collab.assist.send")}
              onClick={() => void sendNote()}
            >
              <Send size={14} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 授权条：由谁执行、授权到什么程度，以及停止与结束授权。 */
function GrantBar(props: {
  request: AssistRequest;
  scope: AssistScope | null;
  agentName: string;
  busy: string | null;
  onStop: () => void;
  onRevoke: () => void;
}) {
  const { t } = useTranslation();
  const { request, scope, agentName } = props;
  const requester = request.requester.name;

  // 结束授权之后只剩一句说明：之后的请求会重新问她。
  if (request.status === "cancelled" || (scope === null && request.status !== "running" && request.status !== "confirm")) {
    return (
      <div className={`${styles.grantbar} ${styles.grantbarOff}`}>
        <Lock size={13} aria-hidden="true" />
        <span>{t("collab.assist.grantEnded", { name: requester })}</span>
      </div>
    );
  }

  return (
    <div className={styles.grantbar}>
      <span className={styles.grantText}>
        <AgentLogo agent={request.agent} name={agentName} />
        <span>
          {scope === "always"
            ? t("collab.assist.grantAlways", { agent: agentName, name: requester })
            : t("collab.assist.grantOnce", { agent: agentName })}
        </span>
      </span>
      <button type="button" className={styles.grantButton} disabled={props.busy !== null} onClick={props.onStop}>
        {t("collab.assist.stop")}
      </button>
      {scope === "always" ? (
        <button
          type="button"
          className={`${styles.grantButton} ${styles.grantButtonDanger}`}
          disabled={props.busy !== null}
          onClick={props.onRevoke}
        >
          {t("collab.assist.endGrant")}
        </button>
      ) : null}
    </div>
  );
}

/** 请求消息：谁在请求、第几次、要做的事。 */
function RequestMessage(props: { request: AssistRequest }) {
  const { t } = useTranslation();
  const { request } = props;
  const requester = request.requester.name;
  return (
    <div className={styles.request}>
      <div className={styles.requestHead}>
        <span className={styles.avatar} style={{ background: memberColor(request.requester.userId) }}>
          {Array.from(requester)[0] ?? ""}
        </span>
        <span>
          <strong>{t("collab.assist.requestFrom", { name: requester, via: request.via })}</strong>
          {request.attempt > 1 ? `（${t("collab.assist.attempt", { attempt: String(request.attempt) })}）` : ""}
        </span>
        <span className={styles.grow} />
        <span>{formatTime(request.createdAt)}</span>
      </div>
      <div className={styles.requestBody}>
        {request.attempt > 1
          ? t("collab.assist.requestContinue", { name: requester, issue: request.reason })
          : t("collab.assist.requestFirst", { name: requester, issue: request.reason })}
        <ol>
          {request.items.map((item) => <li key={item}>{item}</li>)}
        </ol>
      </div>
    </div>
  );
}

function AgentLogo(props: { agent: string | null; name: string }) {
  const url = props.agent ? agentSourceLogoUrl(props.agent) : null;
  return (
    <span className={styles.agentLogo}>
      {url ? <img src={url} alt="" /> : <span className={styles.agentMark}>{Array.from(props.name)[0] ?? "A"}</span>}
    </span>
  );
}

/** 执行方标识换成名字：界面只显示名字，标识留给接口。 */
export function agentNameOf(sourceId: string | null, fallback: string): string {
  const names: Record<string, string> = {
    memmy: "Memmy",
    claude_code: "Claude Code",
    codex: "Codex",
    cursor: "Cursor",
    opencode: "OpenCode",
    openclaw: "OpenClaw",
    hermes: "Hermes",
    workbuddy: "WorkBuddy",
    qwenwork: "QwenWork",
    deepseek_harness: "DeepSeek Harness",
    pi: "Pi"
  };
  return sourceId ? names[sourceId] ?? sourceId : fallback;
}

/** 成员头像的底色：按 id 取一个稳定的颜色，同一个人在自己这边与成员那边看到的一样。 */
function memberColor(userId: string): string {
  const palette = ["#3aa893", "#e08a5a", "#7a8ee0", "#c98ac0", "#58a6c9", "#c9a227"];
  let sum = 0;
  for (const char of userId) sum += char.charCodeAt(0);
  return palette[sum % palette.length]!;
}

function formatTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
}