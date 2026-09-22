import type { MemoryListItem } from "@memmy/local-api-contracts";
import { displayMemoryId } from "./memory-id.js";

type MemoryDisplayItem = Pick<MemoryListItem, "id" | "title" | "summary" | "memoryLayer" | "sourceText" | "generatedTitle" | "experienceDraft"> & {
  kind?: MemoryListItem["kind"];
  body?: string;
  metadata?: Record<string, unknown>;
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
  if (item.kind === "span") {
    return spanGoal(item.metadata) ?? item.title;
  }

  if (item.kind === "work_memory") {
    const topic = cleanMemoryText(item.title);
    if (topic && !isInternalTitle(topic)) return topic;
  }

  if (item.kind === "policy" && isExperienceTitleDraft(item.title)) {
    return waitingPrimaryText(item);
  }

  const generatedTitle = independentGeneratedTitle(item);
  if (generatedTitle) return generatedTitle;

  const summary = readySummary(item.summary);
  if (item.kind === "trace" && summary) {
    return summary;
  }

  for (const value of [summary, ...candidates, firstUserQueryLine(item.body), firstReadableBodyLine(item.body), item.title]) {
    const cleaned = cleanMemoryText(value);
    if (cleaned && !isInternalTitle(cleaned) && !isExperienceTitleDraft(cleaned)) return cleaned;
  }

  return displayMemoryId(item.id);
}

export function isMemorySummaryWaiting(processing?: { state?: string } | null): boolean {
  return processing?.state === "summary_pending" || processing?.state === "summarizing";
}

export function isExperienceTitleDraft(value?: string | null): boolean {
  return Boolean(value && /^Policy:\s+/i.test(value.trim()));
}

export function isExperienceWaiting(item: MemoryDisplayItem): boolean {
  return item.kind === "policy" && (item.experienceDraft === true || isExperienceTitleDraft(item.title));
}

export function experienceDisplayTitle(item: MemoryDisplayItem): string | undefined {
  if (item.kind !== "policy" || item.experienceDraft) return undefined;
  const generated = independentGeneratedTitle(item);
  if (generated) return generated;
  const title = cleanMemoryText(item.title);
  if (!title || isInternalTitle(title) || isExperienceTitleDraft(title)) return undefined;
  return title;
}

export function waitingPrimaryText(item: MemoryDisplayItem): string {
  const source = cleanMemoryText(item.sourceText);
  if (usableWaitingText(source)) return source;
  if (item.kind === "policy") return displayMemoryId(item.id);
  return firstUserQueryLine(item.body)
    ?? firstReadableBodyLine(item.body)
    ?? displayMemoryId(item.id);
}

export function independentGeneratedTitle(item: MemoryDisplayItem): string | undefined {
  const title = cleanMemoryText(item.generatedTitle);
  if (!title || isInternalTitle(title) || isPlaceholderTitle(title) || isExperienceTitleDraft(title)) {
    return undefined;
  }
  return title;
}

export function showsGeneratedSummaryRow(item: MemoryDisplayItem, waiting: boolean): boolean {
  if (waiting || item.kind === "policy") return false;
  const summary = readySummary(item.summary);
  if (!summary) return false;
  const title = item.kind === "span" ? spanGoal(item.metadata) : independentGeneratedTitle(item);
  return Boolean(title && title !== summary);
}

function spanGoal(metadata?: Record<string, unknown>): string | undefined {
  const explicitGoal = stringValue(metadata?.spanGoal)?.trim();
  if (explicitGoal) return explicitGoal;

  const properties = recordValue(metadata?.properties);
  const internalInfo = recordValue(properties.internal_info);
  const span = recordValue(internalInfo.span);
  return stringValue(span.span_goal)?.trim() || undefined;
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
    const role = markdownRoleHeading(line) ?? plainRoleLabel(line);
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

function usableWaitingText(value: string): value is string {
  return Boolean(value && !isInternalTitle(value) && !isPlaceholderTitle(value) && !isExperienceTitleDraft(value));
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

function plainRoleLabel(value: string): string | undefined {
  const match = value.trim().match(/^(User|Assistant|Agent|System|Tool|Developer):$/i);
  if (!match) return undefined;
  const role = match[1]?.toLowerCase();
  return role === "agent" ? "assistant" : role;
}

function isInternalMetricLine(value: string): boolean {
  return /^(Alpha|Value|Priority|RawTurn|TraceStep|Reflection|Signature|Vec Summary|Vec Action):\s*/i.test(value.trim());
}

function normalizedAgentSource(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "claude") return "claude-code";
  if (normalized === "open-code") return "opencode";
  if (normalized === "deepseek_harness") return "deepseek-harness";
  return ["deepseek-harness", "hermes", "openclaw", "codex", "cursor", "claude-code", "opencode", "workbuddy", "pi", "qwenwork"].includes(normalized ?? "")
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

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
