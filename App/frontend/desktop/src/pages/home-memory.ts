import type { SearchInput, SearchOutput } from "@memmy/local-api-contracts";
import { ApiRequestError } from "../api/http.js";
import { formatMessage, type MessageKey, type MessageValues, zhCNMessages } from "../i18n/messages.js";

type HomeMemoryTranslate = (key: MessageKey, values?: MessageValues) => string;

const defaultTranslate: HomeMemoryTranslate = (key, values) => formatMessage(zhCNMessages[key], values);

export function createMemorySearchInput(query: string): SearchInput {
  return {
    query
  };
}

export function summarizeMemoryRecall(recall: SearchOutput | null, t: HomeMemoryTranslate = defaultTranslate): string {
  if (!recall) {
    return t("home.memoryUnavailable");
  }

  const sections = "debug" in recall ? recall.debug.sections : [];
  if (sections.length > 0) {
    return t("home.memoryHit", { count: sections.length, snippet: sections[0]!.content });
  }
  const markdown = recall.injectedContext.trim();
  if (!markdown) {
    return t("home.memoryEmpty");
  }
  return t("home.memoryHit", { count: 1, snippet: markdown });
}

export interface MemoryRecallErrorSummary {
  code: string | null;
  message: string;
  requestId: string | null;
}

export function toMemoryRecallErrorSummary(error: unknown): MemoryRecallErrorSummary {
  if (error instanceof ApiRequestError) {
    return {
      code: error.code,
      message: error.message,
      requestId: error.requestId
    };
  }

  if (error instanceof Error) {
    return {
      code: null,
      message: error.message,
      requestId: null
    };
  }

  return {
    code: null,
    message: String(error),
    requestId: null
  };
}

export function summarizeMemoryRecallError(error: unknown, t: HomeMemoryTranslate = defaultTranslate): string {
  const summary = toMemoryRecallErrorSummary(error);
  const code = summary.code ?? "";
  const requestId = summary.requestId ?? "";

  return t("home.memoryError", { code, message: summary.message, requestId });
}
