import type { MemoryRow } from "../../types.js";
import { asStringArray, isRecord } from "../../utils/json.js";

const PLACEHOLDER_LINE = /^(user|assistant|system|tool|developer|摘要排队中|摘要整理中|建立索引中|索引建立中|索引已建立|反思生成中)$/i;
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
  const trace = isRecord(internal.trace) ? internal.trace : {};
  return text(trace.title);
}

/**
 * Waiting list text. L1 uses its own exchange. L2 uses source-evidence memories
 * passed in by the caller; an L2 row alone has no user sentence.
 */
export function waitingSourceText(memory: MemoryRow, evidence: readonly MemoryRow[] = []): string | undefined {
  const sources = memory.memoryLayer === "L2" ? evidence : [memory];
  for (const source of sources) {
    const user = userSentence(source);
    if (user) return user;
  }
  for (const source of sources) {
    const line = readableLine(source.memoryValue);
    if (line) return line;
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
    const fromTrace = firstContentLine(text(trace.userText) ?? text(trace.user_text) ?? "");
    if (fromTrace) return fromTrace;
  }
  let inUserSection = false;
  for (const raw of memory.memoryValue.split(/\r?\n/)) {
    const role = roleMarker(raw);
    if (role) {
      inUserSection = role === "user";
      continue;
    }
    if (!inUserSection) continue;
    const line = readableLine(raw);
    if (line) return line;
  }
  return undefined;
}

function readableLine(value: string): string | undefined {
  for (const raw of value.split(/\r?\n/)) {
    if (roleMarker(raw)) continue;
    const line = firstContentLine(raw.replace(/^\s*Summary:\s*/i, ""));
    if (line) return line;
  }
  return undefined;
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
