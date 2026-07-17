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

export function formatAgentModelError(content: string, t: Translate, options?: AgentModelErrorFormatOptions): AgentModelErrorPresentation {
  const text = content.trim();
  if (text === PERSISTED_MODEL_ERROR_PLACEHOLDER) {
    return { title: t("agent.error.modelFailed"), detail: null };
  }

  const normalized = text.replace(/^Error(?: calling LLM)?:\s*/i, "").trim();
  const haystack = `${text}\n${normalized}`.toLowerCase();

  if (new RegExp(`quota|${"\u989d\u5ea6"}`).test(haystack)) {
    return { title: t("agent.error.quotaExceeded"), detail: null };
  }
  if (/401|403|unauthorized|invalid.*api.*key|authentication|api key/.test(haystack)) {
    return {
      title: t(options?.accountMode === true ? "agent.error.loginExpired" : "agent.error.authFailed"),
      detail: null
    };
  }
  if (/429|rate limit|too many requests/.test(haystack)) {
    return { title: t("agent.error.rateLimited"), detail: null };
  }
  if (/503|502|504|upstream|connect error|connection refused|connection failure|econnrefused|delayed connect|transport failure|network|timeout|timed out/.test(haystack)) {
    return {
      title: t("agent.error.connectionFailed"),
      detail: normalized || null
    };
  }

  return {
    title: t("agent.error.modelFailed"),
    detail: normalized || null
  };
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
