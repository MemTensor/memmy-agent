import type { MemoryListItem } from "@memmy/local-api-contracts";
import { displayMemoryId } from "./memory-id.js";

type MemoryDisplayItem = Pick<MemoryListItem, "id" | "title" | "summary" | "memoryLayer"> & {
  body?: string;
};
type MemorySourceItem = Pick<MemoryListItem, "tags"> & {
  metadata?: Record<string, unknown>;
};

const PLACEHOLDER_TITLES = new Set([
  "user",
  "assistant",
  "system",
  "tool",
  "developer",
  "\u6458\u8981\u6392\u961F\u4E2D",
  "\u6458\u8981\u6574\u7406\u4E2D",
  "\u5EFA\u7ACB\u7D22\u5F15\u4E2D",
  "\u7D22\u5F15\u5EFA\u7ACB\u4E2D",
  "\u7D22\u5F15\u5DF2\u5EFA\u7ACB",
  "\u53CD\u601D\u751F\u6210\u4E2D"
]);

export function cleanMemoryText(value?: string | null): string {
  return stripMarkdownHeading(stripSummaryPrefix(value ?? "")).trim();
}

export function memoryDisplaySource(item?: MemorySourceItem | null): string {
  const explicitSource = stringValue(item?.metadata?.source)?.trim();
  return normalizedAgentSource(explicitSource)
    ?? explicitSource
    ?? firstAgentSourceTag(item?.tags ?? [])
    ?? "unknown";
}

export function drawerEyebrow(item?: Pick<MemoryListItem, "id"> | null): string {
  return item?.id ? displayMemoryId(item.id) : "memmy";
}

export function displayMemoryTitle(item: MemoryDisplayItem, ...candidates: Array<string | undefined | null>): string {
  for (const value of [readySummary(item.summary), ...candidates, firstUserQueryLine(item.body), firstReadableBodyLine(item.body), item.title]) {
    const cleaned = cleanMemoryText(value);
    if (cleaned && !isInternalTitle(cleaned)) return cleaned;
  }

  return displayMemoryId(item.id);
}

export function cleanMemoryBody(value?: string | null): string {
  return stripSummaryPrefix(value ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !isInternalMetricLine(line))
    .join("\n")
    .trim();
}

function stripSummaryPrefix(value: string): string {
  return value.replace(/^\s*Summary:\s*/i, "");
}

function stripMarkdownHeading(value: string): string {
  return value.replace(/^\s*#{1,6}\s+/, "");
}

function firstReadableBodyLine(value?: string | null): string | undefined {
  const body = cleanMemoryBody(value);
  return body
    .split("\n")
    .map((line) => cleanMemoryText(line))
    .find((line) => line && !isInternalTitle(line) && !isPlaceholderTitle(line));
}

function firstUserQueryLine(value?: string | null): string | undefined {
  const body = cleanMemoryBody(value);
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  let inUserSection = false;

  for (const line of lines) {
    const role = markdownRoleHeading(line);
    if (role) {
      inUserSection = role === "user";
      continue;
    }
    if (!inUserSection) {
      continue;
    }

    const cleaned = cleanMemoryText(line);
    if (cleaned && !isPlaceholderTitle(cleaned) && !isInternalTitle(cleaned)) {
      return cleaned;
    }
  }

  return undefined;
}

function readySummary(value?: string | null): string | undefined {
  const cleaned = cleanMemoryText(value);
  if (!cleaned) {
    return undefined;
  }
  const firstLine = cleaned.split("\n").map((line) => line.trim()).find(Boolean);
  return firstLine && !isPlaceholderTitle(firstLine) && !markdownRoleHeading(value ?? "")
    ? cleaned
    : undefined;
}

function isInternalTitle(value: string): boolean {
  return /^(trace|policy|world|world_model|skill)[:_]/i.test(value)
    || /^episode_[a-f0-9]{8,}$/i.test(value)
    || /^[a-z]+_[a-f0-9]{12,}$/i.test(value);
}

function isPlaceholderTitle(value: string): boolean {
  return PLACEHOLDER_TITLES.has(value.trim().toLowerCase());
}

function markdownRoleHeading(value: string): string | undefined {
  const match = value.trim().match(/^#{1,6}\s+(user|assistant|system|tool|developer)\b/i);
  return match?.[1]?.toLowerCase();
}

function isInternalMetricLine(value: string): boolean {
  return /^(Alpha|Value|Priority|RawTurn|TraceStep|Reflection|Signature|Vec Summary|Vec Action):\s*/i.test(value.trim());
}

function normalizedAgentSource(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "claude") return "claude-code";
  if (normalized === "open-code") return "opencode";
  return ["hermes", "openclaw", "codex", "cursor", "claude-code", "opencode", "workbuddy"].includes(normalized ?? "")
    ? normalized
    : undefined;
}

function firstAgentSourceTag(tags: readonly string[]): string | undefined {
  for (const tag of tags) {
    const source = normalizedAgentSource(tag);
    if (source) return source;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
