import type { AgentSourceView, ScanResult } from "@memmy/local-api-contracts";
import { ApiRequestError } from "../api/http.js";
import type { MessageKey } from "../i18n/messages.js";
import { agentSourceDisplayName } from "./agent-source-logos.js";

export type AgentSourceScanErrorTranslator = (
  key: MessageKey,
  values?: Record<string, string | number>
) => string;

export function formatScanCompletedError(
  results: readonly ScanResult[],
  sources: readonly AgentSourceView[],
  t: AgentSourceScanErrorTranslator
): string | null {
  const messages = results.flatMap((result) =>
    result.errors.map((error) => formatScanError(result.sourceId, error.reason, sources, t))
  );
  const uniqueMessages = [...new Set(messages)];
  return uniqueMessages.length > 0 ? uniqueMessages.join("; ") : null;
}

export function formatAgentSourceScanRequestError(
  error: unknown,
  source: AgentSourceView | undefined,
  t: AgentSourceScanErrorTranslator
): string {
  const reason = error instanceof Error ? error.message : String(error);
  const missingPath = extractMissingScanPath(reason);
  if (missingPath) {
    return t("memory.scanPathNotFound", { path: missingPath });
  }

  if (error instanceof ApiRequestError && error.code === "agent_source_unavailable") {
    return source?.dataPath
      ? t("memory.scanPathNotFound", { path: source.dataPath })
      : t("memory.scanSourcePathNotFound", { agent: source?.displayName ?? t("common.unknown") });
  }

  return source
    ? t("memory.scanSourceFailed", { agent: source.displayName })
    : t("memory.scanFailed");
}

function formatScanError(
  sourceId: string,
  reason: string,
  sources: readonly AgentSourceView[],
  t: AgentSourceScanErrorTranslator
): string {
  const missingPath = extractMissingScanPath(reason);
  if (missingPath) {
    return t("memory.scanPathNotFound", { path: missingPath });
  }

  const source = sources.find((candidate) => candidate.sourceId === sourceId);
  const agent = source?.displayName ?? agentSourceDisplayName(sourceId);
  if (isSourceUnavailableReason(reason)) {
    return source?.dataPath
      ? t("memory.scanPathNotFound", { path: source.dataPath })
      : t("memory.scanSourcePathNotFound", { agent });
  }

  return sourceId === "all"
    ? t("memory.scanFailed")
    : t("memory.scanSourceFailed", { agent });
}

function extractMissingScanPath(reason: string): string | null {
  if (!reason.includes("ENOENT")) {
    return null;
  }

  const operationMatch = reason.match(
    /\b(?:access|lstat|mkdir|open|opendir|readlink|realpath|scandir|stat)\s+(['"])(.*?)\1/u
  );
  if (operationMatch?.[2]?.trim()) {
    return operationMatch[2].trim();
  }

  const quotedPathMatch = reason.match(/\bENOENT\b[\s\S]*?(['"])(.*?)\1/u);
  return quotedPathMatch?.[2]?.trim() || null;
}

function isSourceUnavailableReason(reason: string): boolean {
  return /not installed or its directory is unavailable/iu.test(reason);
}
