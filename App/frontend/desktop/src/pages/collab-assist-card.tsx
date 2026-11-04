/**
 * 发起方的协助请求卡片：请谁做了什么、现在到哪一步、结果是什么。
 *
 * 卡片只读：状态与结果都来自云端，本机不做二次加工。结果对发起方的 Agent 是数据而不是指令，
 * 展示时也按「结果」这一栏排，不拼进对话正文。
 */
import { AlertCircle, CheckCircle2, FileText, X, WifiOff } from "lucide-react";
import type { AssistRequest, CollabClient } from "../api/collab-client.js";
import { useTranslation } from "../i18n/use-translation.js";
import { agentSourceLogoUrl } from "./agent-source-logos.js";
import styles from "./collab-assist-card.module.css";

export function CollabAssistRequestCard(props: {
  request: AssistRequest;
  collab: CollabClient | null;
  onChanged?: (request: AssistRequest) => void;
}) {
  const { t } = useTranslation();
  const { request } = props;
  const executor = request.executor.name;
  const agentName = agentLabel(request.agent, t("collab.assist.executorFallback"));
  const status = request.status;

  const pill = status === "done" ? { className: styles.pillOk, label: t("collab.assist.statusDone") }
    : status === "running" ? { className: styles.pillRun, label: t("collab.assist.statusRunning") }
    : status === "confirm" ? { className: styles.pillWarn, label: t("collab.assist.statusConfirm", { name: executor }) }
    : status === "rejected" ? { className: styles.pillErr, label: t("collab.assist.statusRejected", { name: executor }) }
    : status === "failed" || status === "stopped" ? { className: styles.pillErr, label: t("collab.assist.statusFailed") }
    : status === "cancelled" || status === "expired" ? { className: styles.pillWait, label: t("collab.assist.statusClosed") }
    : { className: styles.pillWait, label: t("collab.assist.statusWaiting", { name: executor }) };

  async function cancel() {
    if (!props.collab) return;
    const next = await props.collab.cancelAssist(request.id).catch(() => null);
    if (next) props.onChanged?.(next);
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
            {t("collab.assist.footerWaiting", { name: executor })}
            <span className={styles.grow} />
            <button type="button" className={`${styles.linkButton} ${styles.linkMuted}`} onClick={() => void cancel()}>
              {t("collab.assist.withdraw")}
            </button>
          </>
        ) : status === "running" ? (
          <>
            <span className={styles.spin} />
            <span className={styles.byline}>
              <AgentLogo agent={request.agent} name={agentName} />
              {t("collab.assist.footerRunning", { name: executor, agent: agentName, attempt: String(request.attempt) })}
            </span>
          </>
        ) : status === "confirm" ? (
          <>
            <AlertCircle size={13} aria-hidden="true" />
            {t("collab.assist.footerConfirm", { name: executor })}
            <span className={styles.grow} />
            <button type="button" className={`${styles.linkButton} ${styles.linkMuted}`} onClick={() => void cancel()}>
              {t("collab.assist.withdraw")}
            </button>
          </>
        ) : status === "done" ? (
          <>
            <CheckCircle2 size={13} aria-hidden="true" />
            <span className={styles.byline}>
              <AgentLogo agent={request.agent} name={agentName} />
              {t("collab.assist.footerDone", { name: executor, agent: agentName, took: durationOf(request) })}
            </span>
          </>
        ) : status === "rejected" ? (
          <>
            <X size={13} aria-hidden="true" />
            {t("collab.assist.footerRejected", { name: executor })}
          </>
        ) : (
          <>
            <WifiOff size={13} aria-hidden="true" />
            {request.failure ?? t("collab.assist.footerClosed")}
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

/** 用时：从她授权开始算到结果回传，与原型里「用时 1 分 08 秒」同一口径。 */
function durationOf(request: AssistRequest): string {
  if (!request.decidedAt || !request.finishedAt) return "";
  const start = new Date(request.decidedAt).getTime();
  const end = new Date(request.finishedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "";
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${String(seconds % 60).padStart(2, "0")} 秒`;
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