/**
 * 成员协助在各处共用的小部件与说法：执行 Agent 的名字与图标、状态的界面用语、时间与用时。
 *
 * 看板条目、协助详情、任务页的协助条与卡片都用同一套说法，状态与请求卡片一致：
 * 等待授权、执行中、等待确认、已完成、未允许、已撤回、已过期、没有完成。
 */
import { useEffect, useState } from "react";
import type {
  AssistAgentChoice,
  AssistGrantInfo,
  AssistGrantMinutes,
  AssistRequest,
  AssistStatus,
  CollabClient
} from "../api/collab-client.js";
import type { MessageKey } from "../i18n/messages.js";
import { useTranslation } from "../i18n/use-translation.js";
import { agentSourceLogoUrl } from "./agent-source-logos.js";
import grantStyles from "./collab-assist-grant.module.css";

type Translate = (key: MessageKey, values?: Record<string, string>) => string;

/** 限时授权的四档时长（分钟）。不提供永久，也不设 10 分钟：单次执行最长 15 分钟，太短的授权等不到下一次请求。 */
export const ASSIST_GRANT_MINUTES: readonly AssistGrantMinutes[] = [30, 60, 120, 240];
/** 默认 1 小时。 */
export const DEFAULT_GRANT_MINUTES: AssistGrantMinutes = 60;

const GRANT_MINUTE_KEYS: Record<AssistGrantMinutes, MessageKey> = {
  30: "collab.assist.grantMinutes.30",
  60: "collab.assist.grantMinutes.60",
  120: "collab.assist.grantMinutes.120",
  240: "collab.assist.grantMinutes.240"
};

/**
 * 一段正文的人读规模：事项、附件都用它。小于 1KB 写字节数，否则保留一位小数。
 * 按 UTF-8 字节算：中文一个字三个字节，跟附件上传时算的是同一个口径。
 */
export function assistTextSize(text: string): string {
  const bytes = new TextEncoder().encode(text).length;
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** 一档时长的说法：30 分钟、1 小时……；不是四档之一时按分钟写。 */
export function grantDurationLabel(minutes: number | null, t: Translate): string {
  if (minutes && minutes in GRANT_MINUTE_KEYS) return t(GRANT_MINUTE_KEYS[minutes as AssistGrantMinutes]);
  return minutes ? t("collab.assist.duration.minutes", { minutes: String(minutes) }) : "";
}

/**
 * 限时授权的一句说明：「1 小时内直接执行（到 08:45）」；已经结束时写「限时授权已结束」。
 * 执行方任务页的协助条、看板右侧详情、发起方卡片共用这一句。
 */
export function grantSummary(grant: AssistGrantInfo, t: Translate, now: Date = new Date()): string {
  const ended = !grant.active || new Date(grant.expiresAt).getTime() <= now.getTime();
  if (ended) return t("collab.assist.grantTimedEnded");
  const time = assistClock(grant.expiresAt, true);
  return grant.minutes
    ? t("collab.assist.grantTimed", { duration: grantDurationLabel(grant.minutes, t), time })
    : t("collab.assist.grantTimedShort", { time });
}

/** 剩余时间：「还剩 42 分钟」「还剩 1 小时 12 分钟」。项目设置的授权列表用它。 */
export function grantRemaining(expiresAt: string | null, t: Translate, now: Date = new Date()): string {
  if (!expiresAt) return "";
  const left = Math.ceil((new Date(expiresAt).getTime() - now.getTime()) / 60_000);
  if (!Number.isFinite(left)) return "";
  if (left <= 0) return t("collab.assist.left.ending");
  if (left < 60) return t("collab.assist.left.minutes", { minutes: String(left) });
  const hours = Math.floor(left / 60);
  const minutes = left % 60;
  return minutes
    ? t("collab.assist.left.hoursMinutes", { hours: String(hours), minutes: String(minutes) })
    : t("collab.assist.left.hours", { hours: String(hours) });
}

/** 时长的分段选择：授权弹窗与任务内确认卡片共用。 */
export function GrantDurationPicker(props: {
  value: AssistGrantMinutes;
  onChange: (minutes: AssistGrantMinutes) => void;
  disabled?: boolean;
  label?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className={grantStyles.picker} role="radiogroup" aria-label={props.label ?? t("collab.assist.durationLabel")}>
      {ASSIST_GRANT_MINUTES.map((minutes) => (
        <button
          key={minutes}
          type="button"
          role="radio"
          aria-checked={props.value === minutes}
          disabled={props.disabled}
          className={`${grantStyles.option} ${props.value === minutes ? grantStyles.optionOn : ""}`}
          onClick={() => props.onChange(minutes)}
        >
          {t(GRANT_MINUTE_KEYS[minutes])}
        </button>
      ))}
    </div>
  );
}

/**
 * 读一次执行方候选（授权弹窗、任务内确认、项目设置的「换用」用同一份）。
 * `enabled` 为假时不读；读失败时给空候选，调用方退回已知的 Agent。
 */
export function useAssistAgentChoice(
  collab: CollabClient | null,
  projectId: string | null,
  requester: string | null,
  enabled: boolean
): AssistAgentChoice | null {
  const [choice, setChoice] = useState<AssistAgentChoice | null>(null);
  useEffect(() => {
    setChoice(null);
    if (!collab || !projectId || !enabled) return;
    let cancelled = false;
    void collab.assistAgents(projectId, requester ?? undefined)
      .then((next) => {
        if (!cancelled) setChoice(next);
      })
      .catch(() => {
        if (!cancelled) setChoice({ agents: [], defaultAgent: null });
      });
    return () => {
      cancelled = true;
    };
  }, [collab, projectId, requester, enabled]);
  return choice;
}

/** 在候选里取一个执行方：想用的那个能运行就用它，否则用候选的默认项，最后才退回想用的那个。 */
export function pickAssistAgent(choice: AssistAgentChoice | null, preferred: string | null): string | null {
  if (!choice) return preferred;
  if (preferred && choice.agents.some((agent) => agent.sourceId === preferred)) return preferred;
  return choice.defaultAgent ?? choice.agents[0]?.sourceId ?? preferred;
}

const AGENT_NAMES: Record<string, string> = {
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

/** 执行方标识换成名字：界面只显示名字，标识留给接口。 */
export function assistAgentName(sourceId: string | null | undefined, fallback: string): string {
  return sourceId ? AGENT_NAMES[sourceId] ?? sourceId : fallback;
}

/** 状态的界面用语：看板条目、详情与卡片共用。 */
export const ASSIST_STATUS_KEYS: Record<AssistStatus, MessageKey> = {
  pending: "collab.assist.state.pending",
  running: "collab.assist.state.running",
  confirm: "collab.assist.state.confirm",
  done: "collab.assist.state.done",
  rejected: "collab.assist.state.rejected",
  cancelled: "collab.assist.state.cancelled",
  expired: "collab.assist.state.expired",
  failed: "collab.assist.state.failed",
  stopped: "collab.assist.state.stopped"
};

/**
 * 一次请求或一次排查（取最近一次请求）的状态用语：还在等待、但执行方的限时授权仍然有效时，
 * 不写「等待授权」，写「按限时授权执行」——她的 Memmy 会直接开始。
 */
export function assistStatusKey(target: { status: AssistStatus; autoRun?: boolean; requests?: Array<{ autoRun?: boolean }> }): MessageKey {
  const autoRun = target.autoRun ?? target.requests?.[0]?.autoRun ?? false;
  if (target.status === "pending" && autoRun) return "collab.assist.state.autoRun";
  return ASSIST_STATUS_KEYS[target.status];
}

/**
 * 请求等了多久，用于执行方弹窗「18 小时前发起」。不到 10 分钟不写：刚发出的请求不需要说明。
 * 秒数由云端算，不受两端时钟与时区影响。
 */
export function assistWaitedText(
  seconds: number | null | undefined,
  t: (key: MessageKey, values?: Record<string, string>) => string
): string {
  if (typeof seconds !== "number" || seconds < 600) return "";
  if (seconds < 3600) return t("collab.assist.agoMinutes", { count: String(Math.floor(seconds / 60)) });
  return t("collab.assist.agoHours", { count: String(Math.floor(seconds / 3600)) });
}

/** 请求还没结束：等待授权、执行中、等待确认。 */
export function assistIsOpen(status: AssistStatus): boolean {
  return status === "pending" || status === "running" || status === "confirm";
}

/**
 * 谁停了这次执行，按看的人换成「你」：本人停的就是「你停止了这次执行」，对方停的写名字。
 * 旧后端不给 stoppedBy 时按执行方算（V1.0.19 之前只有执行方能停）。
 */
export function assistStopText(
  request: Pick<AssistRequest, "stoppedBy" | "status" | "mine" | "requester" | "executor">,
  t: (key: MessageKey, values?: Record<string, string>) => string
): string {
  const byRequester = request.status === "stopped" && request.stoppedBy === "requester";
  const stopperIsMe = byRequester ? request.mine : !request.mine;
  return stopperIsMe
    ? t("collab.assist.stoppedByMe")
    : t("collab.assist.stoppedBy", { name: byRequester ? request.requester.name : request.executor.name });
}

/** 用时：从对方授权到结果回传；没授权就从发出算起。说法交给调用方的 t()。 */
export function assistDuration(
  request: Pick<AssistRequest, "decidedAt" | "createdAt" | "finishedAt">,
  t: (key: MessageKey, values?: Record<string, string>) => string
): string {
  const from = request.decidedAt ?? request.createdAt;
  if (!from || !request.finishedAt) return "";
  const start = new Date(from).getTime();
  const end = new Date(request.finishedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "";
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return t("collab.assist.duration.seconds", { seconds: String(seconds) });
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest
    ? t("collab.assist.duration.minutesSeconds", { minutes: String(minutes), seconds: String(rest) })
    : t("collab.assist.duration.minutes", { minutes: String(minutes) });
}

export function assistClock(value: string | null, padHours = false): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const hours = padHours ? String(date.getHours()).padStart(2, "0") : String(date.getHours());
  return `${hours}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** 执行 Agent 的图标：有内置图标用图标，否则用名字首字。 */
export function AssistAgentLogo(props: { agent: string | null; name: string; className?: string; markClassName?: string }) {
  const url = props.agent ? agentSourceLogoUrl(props.agent) : null;
  return (
    <span className={props.className}>
      {url ? <img src={url} alt="" /> : <span className={props.markClassName}>{Array.from(props.name)[0] ?? "A"}</span>}
    </span>
  );
}
