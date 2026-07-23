import type { MessageKey, MessageValues } from "../i18n/messages.js";
import type { AgentChatMessage, AgentRetryWaitStatus } from "../state/agent-chat-slice.js";

type Translate = (key: MessageKey, values?: MessageValues) => string;

const MODEL_ERROR_PREFIX = /^Error(?: calling LLM)?:/i;
const PERSISTED_MODEL_ERROR_PLACEHOLDER = "[Assistant reply unavailable due to model error.]";
const RETRY_GIVING_UP_PATTERN = /Model request failed after \d+ retries, giving up\./;
const RETRY_ATTEMPT_PATTERN = /Model request failed, retrying attempt (\d+) in (\d+)s\.\.\./;
const RETRY_WAIT_PATTERN = /Retry attempt (\d+): Model request still waiting to retry in (\d+)s\.\.\./;
const PERSISTENT_RETRY_STOPPED_PATTERN = /Persistent retry stopped after \d+ identical errors\./;

export function isAgentModelErrorContent(content: string): boolean {
  const text = content.trim();
  if (!text) {
    return false;
  }
  if (text === PERSISTED_MODEL_ERROR_PLACEHOLDER) {
    return true;
  }
  return MODEL_ERROR_PREFIX.test(text);
}

export function isRetryWaitGivingUp(text: string): boolean {
  return RETRY_GIVING_UP_PATTERN.test(text.trim());
}

export function formatRetryWaitStatus(text: string, t: Translate): string {
  const trimmed = text.trim();
  if (RETRY_GIVING_UP_PATTERN.test(trimmed)) {
    return t("agent.error.givingUp");
  }
  const retryAttempt = trimmed.match(RETRY_ATTEMPT_PATTERN);
  if (retryAttempt) {
    return t("agent.error.retrying", {
      attempt: Number(retryAttempt[1]),
      seconds: Number(retryAttempt[2])
    });
  }
  const retryWait = trimmed.match(RETRY_WAIT_PATTERN);
  if (retryWait) {
    return t("agent.error.retryWait", {
      attempt: Number(retryWait[1]),
      seconds: Number(retryWait[2])
    });
  }
  if (PERSISTENT_RETRY_STOPPED_PATTERN.test(trimmed)) {
    return t("agent.error.persistentStopped");
  }
  return trimmed;
}

export interface AgentModelErrorPresentation {
  title: string;
  detail: string | null;
}

export interface AgentModelErrorFormatOptions {
  /** Account mode (memmy_account): the credential is the projected login token, not a user-supplied API key. */
  accountMode?: boolean;
}

export type AgentApiErrorKind =
  | "user_token_quota_exhausted"
  | "upstream_billing_unavailable"
  | "upstream_rate_limited"
  | "auth_failed"
  | "rate_limited"
  | "connection_failed"
  | "model_failed";

const UPSTREAM_BILLING_ERROR_PATTERNS = [
  /UPSTREAM_BILLING_UNAVAILABLE/i,
  /\b(insufficient_balance|credit_balance_too_low|billing_hard_limit_reached|billing_not_active|payment_required)\b/i,
  /(?:剩余(?:额度|余额)|余额)[^\n]*[$＄￥¥]/i,
  /[$＄￥¥]\s*-?\d+(?:\.\d+)?/
];

/** Classifies model-service failures without conflating upstream billing with user Token quota. */
export function classifyAgentApiError(content: string): AgentApiErrorKind {
  const text = content.trim();
  const normalized = text.replace(/^Error(?: calling LLM)?:\s*/i, "").trim();
  const haystack = `${text}\n${normalized}`.toLowerCase();

  if (UPSTREAM_BILLING_ERROR_PATTERNS.some((pattern) => pattern.test(haystack))) {
    return "upstream_billing_unavailable";
  }
  if (/USER_TOKEN_QUOTA_EXHAUSTED|REQUEST_TOKEN_QUOTA_EXCEEDED/i.test(haystack)
    || /quota[\s_]*(exceeded|exhausted)|insufficient[\s_]*quota|out of quota/i.test(haystack)
    || /额度.*(用完|不足|超限)/.test(haystack)) {
    return "user_token_quota_exhausted";
  }
  if (/UPSTREAM_RATE_LIMITED/i.test(haystack)) {
    return "upstream_rate_limited";
  }
  if (/429|rate[\s_-]*limit|too many requests|请求过于频繁|速率限制|访问量过大/.test(haystack)) {
    return "rate_limited";
  }
  if (/401|403|unauthorized|invalid.*api.*key|authentication|api key/.test(haystack)) {
    return "auth_failed";
  }
  if (/503|502|504|upstream|connect error|connection refused|connection failure|econnrefused|delayed connect|transport failure|network|timeout|timed out/.test(haystack)) {
    return "connection_failed";
  }
  return "model_failed";
}

export function formatAgentModelError(content: string, t: Translate, options?: AgentModelErrorFormatOptions): AgentModelErrorPresentation {
  const text = content.trim();
  if (text === PERSISTED_MODEL_ERROR_PLACEHOLDER) {
    return { title: t("agent.error.modelFailed"), detail: null };
  }

  const normalized = text.replace(/^Error(?: calling LLM)?:\s*/i, "").trim();
  switch (classifyAgentApiError(content)) {
    case "user_token_quota_exhausted":
      return { title: t("agent.error.quotaExceeded"), detail: null };
    case "upstream_billing_unavailable":
      return { title: t("agent.error.upstreamBillingUnavailable"), detail: null };
    case "upstream_rate_limited":
      return { title: t("agent.error.upstreamRateLimited"), detail: null };
    case "rate_limited":
      return { title: t(options?.accountMode === true ? "agent.error.upstreamRateLimited" : "agent.error.rateLimited"), detail: null };
    case "auth_failed":
      return {
        title: t(options?.accountMode === true ? "agent.error.loginExpired" : "agent.error.authFailed"),
        detail: null
      };
    case "connection_failed":
      return {
        title: t("agent.error.connectionFailed"),
        detail: normalized || null
      };
    default:
      return {
        title: t("agent.error.modelFailed"),
        detail: normalized || null
      };
  }
}

export function shouldSuppressRetryWaitStatus(status: AgentRetryWaitStatus, messages: AgentChatMessage[]): boolean {
  if (!isRetryWaitGivingUp(status.text)) {
    return false;
  }

  const anchorIndex = status.anchorMessageId
    ? messages.findIndex((message) => message.id === status.anchorMessageId)
    : findLastUserIndex(messages);
  const start = anchorIndex >= 0 ? anchorIndex + 1 : 0;
  for (let index = start; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role === "assistant" && message.kind !== "trace" && isAgentModelErrorContent(message.content)) {
      return true;
    }
  }
  return false;
}

function findLastUserIndex(messages: AgentChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      return index;
    }
  }
  return -1;
}
