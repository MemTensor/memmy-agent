import type { MemmyAgentModelError } from "../api/memmy-agent-client.js";
import { ERROR_NOTICE_KEYS } from "../i18n/error-notice-messages.js";
import type { MessageKey, MessageValues } from "../i18n/messages.js";
import type { AgentChatMessage, AgentRetryWaitStatus } from "../state/agent-chat-slice.js";

type Translate = (key: MessageKey, values?: MessageValues) => string;

const MODEL_ERROR_PREFIX = /^Error(?: calling LLM)?:/i;
const PERSISTED_MODEL_ERROR_PLACEHOLDER = "[Assistant reply unavailable due to model error.]";
const RETRY_GIVING_UP_PATTERN = /Model request failed after \d+ retries, giving up\./;
const RETRY_ATTEMPT_PATTERN = /Model request failed, retrying attempt (\d+) in (\d+)s\.\.\./;
const RETRY_WAIT_PATTERN = /Retry attempt (\d+): Model request still waiting to retry in (\d+)s\.\.\./;
const PERSISTENT_RETRY_STOPPED_PATTERN = /Persistent retry stopped after \d+ identical errors\./;
const LEGACY_QUOTA_CODE_PATTERN = /\b40309\b/;

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
  modelError?: MemmyAgentModelError | null;
}

export function formatAgentModelError(content: string, t: Translate, options?: AgentModelErrorFormatOptions): AgentModelErrorPresentation {
  const failedAt = [options?.modelError?.failedProvider, options?.modelError?.failedModel]
    .filter((value): value is string => Boolean(value))
    .join("/");
  const structuredDetail = options?.modelError?.detail ?? null;
  const failureDetail = failedAt
    ? (structuredDetail ? `${failedAt}: ${structuredDetail}` : failedAt)
    : structuredDetail;
  if (options?.modelError?.category === "image_input_unsupported") {
    return {
      title: t(ERROR_NOTICE_KEYS.agent.imageInputUnsupported),
      detail: options.modelError.detail ?? null
    };
  }
  if (options?.modelError?.category === "image_analysis_failed") {
    return {
      title: t(ERROR_NOTICE_KEYS.agent.imageAnalysisFailed),
      detail: failureDetail
    };
  }
  if (options?.modelError?.category === "quota_exhausted") {
    return {
      title: t(ERROR_NOTICE_KEYS.agent.quotaExhausted),
      detail: failureDetail
    };
  }
  const text = content.trim();
  if (text === PERSISTED_MODEL_ERROR_PLACEHOLDER) {
    return { title: t("agent.error.modelFailed"), detail: null };
  }

  const modelFailureDetail = options?.modelError?.category === "model_failed"
    ? options.modelError.detail
    : undefined;
  const classificationText = modelFailureDetail ?? text;
  const normalized = classificationText.replace(/^Error(?: calling LLM)?:\s*/i, "").trim();
  const haystack = `${classificationText}\n${normalized}`.toLowerCase();

  if (LEGACY_QUOTA_CODE_PATTERN.test(text)) {
    return { title: t(ERROR_NOTICE_KEYS.agent.quotaExhausted), detail: text };
  }
  if (/401|403|unauthorized|invalid.*api.*key|authentication|api key/.test(haystack)) {
    return {
      title: t(options?.modelError?.source === "account" ? "agent.error.loginExpired" : "agent.error.authFailed"),
      detail: modelFailureDetail ?? null
    };
  }
  if (/429|rate limit|too many requests/.test(haystack)) {
    return { title: t("agent.error.rateLimited"), detail: modelFailureDetail ?? null };
  }
  if (/503|502|504|upstream|connect error|connection refused|connection failure|econnrefused|delayed connect|transport failure|network|timeout|timed out/.test(haystack)) {
    return {
      title: t("agent.error.connectionFailed"),
      detail: modelFailureDetail ?? (text || null)
    };
  }

  return {
    title: t(ERROR_NOTICE_KEYS.agent.modelFailed),
    detail: modelFailureDetail ?? (text || null)
  };
}

export function shouldSuppressRetryWaitStatus(status: AgentRetryWaitStatus, messages: AgentChatMessage[]): boolean {
  const anchorIndex = status.anchorMessageId
    ? messages.findIndex((message) => message.id === status.anchorMessageId)
    : findLastUserIndex(messages);
  const start = anchorIndex >= 0 ? anchorIndex + 1 : 0;
  for (let index = start; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== "assistant" || message.kind === "trace") continue;
    if (message.modelError) {
      return true;
    }
    if (isRetryWaitGivingUp(status.text) && isAgentModelErrorContent(message.content)) return true;
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
