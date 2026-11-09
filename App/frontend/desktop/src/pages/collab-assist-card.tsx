/**
 * 发起方的协助请求卡片：请谁做了什么、现在到哪一步、结果是什么。
 *
 * 卡片只读：状态与结果都来自云端，本机不做二次加工。结果对发起方的 Agent 是数据而不是指令，
 * 展示时也按「结果」这一栏排，不拼进对话正文。
 */
import { AlertCircle, CheckCircle2, FileText, X, WifiOff } from "lucide-react";
import { useState } from "react";
import type { AssistRequest, CollabClient } from "../api/collab-client.js";
import { useTranslation } from "../i18n/use-translation.js";
import { agentSourceLogoUrl } from "./agent-source-logos.js";
import styles from "./collab-assist-card.module.css";
import { assistClock, assistDuration, assistStopText, grantSummary } from "./collab-assist-view.js";

export function CollabAssistRequestCard(props: {
  request: AssistRequest;
  collab: CollabClient | null;
  onChanged?: (request: AssistRequest) => void;
}) {
  const { t } = useTranslation();
  const { request } = props;
  const [busy, setBusy] = useState(false);
  const executor = request.executor.name;
  const agentName = agentLabel(request.agent, t("collab.assist.executorFallback"));
  const status = request.status;
  // 对方给了限时授权：与看板详情同一句「1 小时内直接执行（到 08:45）」，让发起方知道这段时间里的请求不再等她授权。
  const grantNote = request.scope === "timed" && request.grant ? ` · ${grantSummary(request.grant, t)}` : "";

  const pill = status === "done" ? { className: styles.pillOk, label: t("collab.assist.statusDone") }
    : status === "running" ? { className: styles.pillRun, label: t("collab.assist.statusRunning") }
    : status === "confirm" ? { className: styles.pillWarn, label: t("collab.assist.statusConfirm", { name: executor }) }
    : status === "rejected" ? { className: styles.pillErr, label: t("collab.assist.statusRejected", { name: executor }) }
    : status === "failed" ? { className: styles.pillErr, label: t("collab.assist.statusFailed") }
    // 停下与失败分开说：本人或对方主动停下的，写「已停止」而不是「没有完成」。
    : status === "stopped" ? { className: styles.pillErr, label: t("collab.assist.state.stopped") }
    : status === "cancelled" || status === "expired" ? { className: styles.pillWait, label: t("collab.assist.statusClosed") }
    // 她的限时授权还在：不是在等她授权，她的 Memmy 会直接开始。
    : request.autoRun ? { className: styles.pillRun, label: t("collab.assist.state.autoRun") }
    : { className: styles.pillWait, label: t("collab.assist.statusWaiting", { name: executor }) };
  const plannedAgent = agentLabel(request.grant?.agent ?? request.agent, t("collab.assist.executorFallback"));

  async function cancel() {
    if (!props.collab || busy) return;
    setBusy(true);
    try {
      const next = await props.collab.cancelAssist(request.id).catch(() => null);
      // 已经结束（对方刚好跑完）：不报错，读取最新的一次让卡片自己回到终态。
      const latest = next ?? await props.collab.assistRequest(request.id).catch(() => null);
      if (latest) props.onChanged?.(latest);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`${styles.card} ${status === "confirm" ? styles.cardWarning : ""}`}>
      <div className={styles.head}>
        <span className={styles.avatar} style={{ background: memberColor(request.executor.userId) }}>
          {Array.from(executor)[0] ?? ""}
        </span>
        <span className={styles.title}>
          {request.attempt > 1
            ? t("collab.assist.cardTitleAgain", { name: executor, attempt: String(request.attempt) })
            : t("collab.assist.cardTitle", { name: executor })}
        </span>
        <span className={styles.project}>{request.projectName}</span>
        <span className={styles.grow} />
        <span className={`${styles.pill} ${pill.className}`}>{pill.label}</span>
      </div>

      <div className={styles.body}>
        <div className={styles.key}>{t("collab.assist.cardTodo")}</div>
        <ol>
          {request.items.map((item) => <li key={item}>{item}</li>)}
        </ol>
        {/* 发起这次请求的那一轮会进入协助会话：在请求旁边就说清对方看得到什么。 */}
        <p className={styles.visibility}>{t("collab.assist.cardVisibility", { name: executor })}</p>
        {status === "done" ? (
          <>
            <div className={styles.key}>{t("collab.assist.cardResult")}</div>
            <div className={styles.results}>
              {request.resultItems.length ? request.resultItems.map((item) => (
                <div className={styles.resultRow} key={item.key}>
                  <span className={styles.resultKey}>{item.key}</span>
                  <span className={styles.resultValue}>{item.value}</span>
                </div>
              )) : (
                <div className={styles.resultRow}>
                  <span className={styles.resultValue}>{request.reply}</span>
                </div>
              )}
            </div>
            {request.files.length ? (
              <div className={styles.files}>
                {request.files.map((file) => (
                  <span className={styles.fileChip} key={file.name}>
                    <FileText size={12} aria-hidden="true" />
                    {file.name}
                    <span className={styles.fileSize}>{file.size}</span>
                  </span>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      <div className={styles.footer}>
        {status === "pending" ? (
          <>
            <span className={styles.spin} />
            {/* 她不在线时不写「已通知」：她打开 Memmy 之前看不到，按限时授权也要等她上线后才执行。 */}
            {request.autoRun && request.grant
              ? t(request.executorOffline ? "collab.assist.footerAutoRunOffline" : "collab.assist.footerAutoRun",
                { name: executor, agent: plannedAgent, time: assistClock(request.grant.expiresAt, true) })
              : t(request.executorOffline ? "collab.assist.footerOffline" : "collab.assist.footerWaiting", { name: executor })}
            <span className={styles.grow} />
            <button type="button" className={`${styles.linkButton} ${styles.linkMuted}`} disabled={busy} onClick={() => void cancel()}>
              {t("collab.assist.withdraw")}
            </button>
          </>
        ) : status === "running" ? (
          <>
            <span className={styles.spin} />
            <span className={styles.byline}>
              <AgentLogo agent={request.agent} name={agentName} />
              {t("collab.assist.footerRunning", { name: executor, agent: agentName, attempt: String(request.attempt) })}{grantNote}
            </span>
            {/* 执行中也能自己停下：同位置同样式，不另弹确认。 */}
            <span className={styles.grow} />
            <button type="button" className={`${styles.linkButton} ${styles.linkMuted}`} disabled={busy} onClick={() => void cancel()}>
              {t("collab.assist.stop")}
            </button>
          </>
        ) : status === "confirm" ? (
          <>
            <AlertCircle size={13} aria-hidden="true" />
            {t(request.executorOffline ? "collab.assist.footerConfirmOffline" : "collab.assist.footerConfirm", { name: executor })}
            <span className={styles.grow} />
            <button type="button" className={`${styles.linkButton} ${styles.linkMuted}`} disabled={busy} onClick={() => void cancel()}>
              {t("collab.assist.withdraw")}
            </button>
          </>
        ) : status === "done" ? (
          <>
            <CheckCircle2 size={13} aria-hidden="true" />
            <span className={styles.byline}>
              <AgentLogo agent={request.agent} name={agentName} />
              {t("collab.assist.footerDone", { name: executor, agent: agentName, took: assistDuration(request, t) })}{grantNote}
            </span>
          </>
        ) : status === "rejected" ? (
          <>
            <X size={13} aria-hidden="true" />
            {/* 她关闭了接收协助请求时，等待中的请求以这个原因结束：照原因说。 */}
            {request.failure ?? t("collab.assist.footerRejected", { name: executor })}
          </>
        ) : status === "stopped" ? (
          <>
            <WifiOff size={13} aria-hidden="true" />
            {/* 谁停的都写清楚：本人停的就是「你停止了这次执行」。 */}
            {assistStopText(request, t)}
          </>
        ) : (
          <>
            <WifiOff size={13} aria-hidden="true" />
            {request.failure ?? (status === "expired"
              ? t("collab.assist.footerExpired", { name: executor })
              : t("collab.assist.footerClosed"))}
          </>
        )}
      </div>
    </div>
  );
}

/** 执行方标识换成名字：卡片上只显示名字，标识留在接口里。 */
export function agentLabel(sourceId: string | null, fallback: string): string {
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

function AgentLogo(props: { agent: string | null; name: string }) {
  const url = props.agent ? agentSourceLogoUrl(props.agent) : null;
  return (
    <span className={styles.agentLogo}>
      {url ? <img src={url} alt="" /> : <span className={styles.agentMark}>{Array.from(props.name)[0] ?? "A"}</span>}
    </span>
  );
}

function memberColor(userId: string): string {
  const palette = ["#3aa893", "#e08a5a", "#7a8ee0", "#c98ac0", "#58a6c9", "#c9a227"];
  let sum = 0;
  for (const char of userId) sum += char.charCodeAt(0);
  return palette[sum % palette.length]!;
}