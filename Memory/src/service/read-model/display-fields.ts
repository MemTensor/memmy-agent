import type { MemoryRow } from "../../types.js";
import { asStringArray, isRecord } from "../../utils/json.js";
import { clip, semanticUserText } from "../../utils/text.js";

const PLACEHOLDER_LINE = /^(user|assistant|system|tool|developer|摘要排队中|摘要整理中|摘要总结中|建立索引中|索引建立中|索引已建立|反思生成中)$/i;
const INTERNAL_LINE = /^(RawTurn|TraceStep|Alpha|Value|Priority|Reflection|Signature|Vec Summary|Vec Action|Trigger|Procedure|Verification|Boundary|Support|Gain|Raw gain|Confidence|Evidence):/i;
const DRAFT_TITLE = /^Policy:\s+/i;

export function evidenceMemoryIds(memory: MemoryRow): string[] {
  const internal = memory.properties.internal_info;
  const policy = isRecord(internal.policy) ? internal.policy : {};
  return distinct([
    ...asStringArray(internal.source_memory_ids),
    ...asStringArray(internal.source_l1_memory_ids),
    ...asStringArray(internal.source_trace_ids),
    ...asStringArray(policy.source_trace_ids),
    ...asStringArray(memory.info.source_memory_ids)
  ]);
}

/** A title written by generation, not a list/detail fallback clipped from the summary. */
export function storedGeneratedTitle(memory: MemoryRow): string | undefined {
  const internal = memory.properties.internal_info;
  const infoTitle = text(memory.info.title);
  const internalTitle = text(internal.title);
  if (memory.memoryLayer === "L2") {
    const policy = isRecord(internal.policy) ? internal.policy : {};
    const title = text(policy.title) || internalTitle || infoTitle;
    return title && !DRAFT_TITLE.test(title) ? title : undefined;
  }
  if (memory.memoryLayer !== "L1") return undefined;
  if (internal.memory_kind === "span" || internal.memory_kind === "work_memory") return undefined;
  if (internal.memory_kind === "observed_activity") return infoTitle || internalTitle;
  const trace = isRecord(internal.trace) ? internal.trace : {};
  return text(trace.title);
}

/** Older History syncs stored the Markdown title as the entire summary. */
export function observedActivitySummary(memory: MemoryRow): string | undefined {
  if (memory.properties.internal_info.memory_kind !== "observed_activity") return undefined;
  const title = text(memory.info.title) || text(memory.properties.internal_info.title);
  const clean = (value: string) => value.replace(/^\s*#{1,6}\s+/, "").trim();
  for (const value of [text(memory.info.summary), text(memory.properties.internal_info.summary)]) {
    if (value && clean(value) !== title && !/^\s*#{1,6}\s/u.test(value)) return value;
  }
  // Keep this a read compatibility fallback; the normal writer supplies a
  // separate summary and never needs a second model call to display old rows.
  const section = memory.memoryValue.match(/^##\s+Memory summary\s*\n([\s\S]*?)(?=^#{1,3}\s|$(?![\s\S]))/imu)?.[1]?.trim();
  return section || undefined;
}

/**
 * Waiting list text. L1 uses its own exchange. L2 uses source-evidence memories
 * passed in by the caller; an L2 row alone has no user sentence.
 */
export function waitingSourceText(memory: MemoryRow, evidence: readonly MemoryRow[] = []): string | undefined {
  const sources = memory.memoryLayer === "L2" ? evidence : [memory];
  for (const source of sources) {
    const user = userSentence(source);
    if (user) return clip(user, 120);
  }
  return undefined;
}

export function displayFieldsForMemory(
  memory: MemoryRow,
  evidence: readonly MemoryRow[] = []
): { sourceText?: string; generatedTitle?: string; experienceDraft?: boolean } {
  const generatedTitle = storedGeneratedTitle(memory);
  const sourceText = memory.memoryLayer === "L1" || memory.memoryLayer === "L2"
    ? waitingSourceText(memory, evidence)
    : undefined;
  const experienceDraft = policyDraftTitle(memory);
  return {
    ...(generatedTitle ? { generatedTitle } : {}),
    ...(sourceText ? { sourceText } : {}),
    ...(experienceDraft ? { experienceDraft: true } : {})
  };
}

function userSentence(memory: MemoryRow): string | undefined {
  const trace = memory.properties.internal_info.trace;
  if (isRecord(trace)) {
    const userText = [trace.userText, trace.user_text].find((value): value is string =>
      typeof value === "string" && Boolean(value.trim()));
    // A present but context-only query must not fall back to the same raw body.
    if (userText) return firstContentLine(semanticUserText(userText));
  }
  // Also handle unstructured legacy bodies that start with an envelope; role
  // headings inside that envelope are source data, not conversation boundaries.
  const body = semanticUserText(memory.memoryValue.replace(/^\s*Summary:[ \t]*/i, ""));
  const lines = body.split(/\r?\n/);
  let hasRole = false;
  let fence = "";
  for (const [index, raw] of lines.entries()) {
    const marker = raw.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1]!;
      else if (marker[1]![0] === fence[0] && marker[1]!.length >= fence.length) fence = "";
      continue;
    }
    if (fence) continue;
    const role = roleMarker(raw);
    if (!role) continue;
    hasRole = true;
    if (role === "user") {
      // Strip envelopes before splitting role sections: browser context can
      // itself contain headings such as "## assistant" or "## user".
      const userLines = semanticUserText(lines.slice(index + 1).join("\n")).split(/\r?\n/);
      const nextRole = userLines.findIndex((line) => Boolean(roleMarker(line)));
      return firstContentLine((nextRole < 0 ? userLines : userLines.slice(0, nextRole)).join("\n"));
    }
  }
  if (hasRole) return undefined;
  // Legacy unstructured memories have no role sections. Clean the whole value,
  // not each line, so a rejected block cannot leak through the next line.
  return firstContentLine(body);
}

function firstContentLine(value: string): string | undefined {
  for (const raw of value.split(/\r?\n/)) {
    const line = raw
      .replace(/^\s*#{1,6}\s+/, "")
      .replace(/^\s*[-*]\s+/, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .trim();
    if (!line || PLACEHOLDER_LINE.test(line) || INTERNAL_LINE.test(line) || DRAFT_TITLE.test(line) || isInternalId(line)) {
      continue;
    }
    return line;
  }
  return undefined;
}

function roleMarker(value: string): string | undefined {
  const trimmed = value.trim();
  const markdown = trimmed.match(/^#{1,6}\s+(user|assistant|system|tool|developer)\b/i);
  if (markdown?.[1]) return markdown[1].toLowerCase();
  const label = trimmed.match(/^(User|Assistant|Agent|System|Tool|Developer):$/i);
  if (!label?.[1]) return undefined;
  const role = label[1].toLowerCase();
  return role === "agent" ? "assistant" : role;
}

function isInternalId(value: string): boolean {
  return /^(trace|policy|world|world_model|skill)[:_]/i.test(value)
    || /^episode_[a-f0-9]{8,}$/i.test(value)
    || /^[a-z]+_[a-f0-9]{12,}$/i.test(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function policyDraftTitle(memory: MemoryRow): boolean {
  if (memory.memoryLayer !== "L2") return false;
  const internal = memory.properties.internal_info;
  const policy = isRecord(internal.policy) ? internal.policy : {};
  const title = text(policy.title) || text(internal.title) || text(memory.info.title);
  return Boolean(title && DRAFT_TITLE.test(title));
}

function distinct(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
