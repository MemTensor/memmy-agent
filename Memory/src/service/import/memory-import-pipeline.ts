import type { MemoryAddRequest, MemoryLayer, ToolCallPayload } from "../../types.js";
import { captureTurnSteps, signatureFromTraceParts } from "../../algorithm/plugin-algorithms.js";
import { MemoryServiceError } from "../../utils/error.js";
import { stableHash } from "../../utils/id.js";
import { clip, firstLine } from "../../utils/text.js";

export const IMPORT_SUMMARY_QUEUED_TAG = "摘要排队中";
export const IMPORT_SUMMARY_PROCESSING_TAG = "摘要总结中";
export const IMPORT_INDEXING_TAG = "索引建立中";
export const IMPORT_FAILED_TAG = "处理失败";
export const IMPORT_STATUS_TAGS = [
  IMPORT_SUMMARY_QUEUED_TAG,
  "摘要整理中",
  IMPORT_SUMMARY_PROCESSING_TAG,
  "建立索引中",
  IMPORT_INDEXING_TAG,
  "索引已建立",
  IMPORT_FAILED_TAG
];
export const IMPORT_DEFAULT_ALPHA = 0;
export const IMPORT_DEFAULT_VALUE = 0;
export const IMPORT_DEFAULT_PRIORITY = 0.5;
const IMPORT_TOOL_PAYLOAD_MAX_CHARS = 20_000;

export function memoryAddKey(request: MemoryAddRequest, layer: MemoryLayer, title: string): string {
  if (isAgentSourceImportMemoryAdd(request) && request.adapterId && request.turnId) return `memory.add:${request.adapterId}:turn:${request.turnId}`;
  if (request.adapterId && request.requestId) return `memory.add:${request.adapterId}:${request.requestId}`;
  return `manual:${stableHash(`${layer}:${title}:${request.content}`).slice(0, 20)}`;
}

export function memoryAddTags(request: MemoryAddRequest, importTrace: boolean, traceTags: string[] = []): string[] {
  return importTrace
    ? uniq([...(request.tags ?? []), ...(request.source ? [request.source] : []), ...traceTags])
    : uniq(["manual", ...(request.source ? [request.source] : []), ...(request.tags ?? [])]);
}

export function isAgentSourceImportMemoryAdd(request: MemoryAddRequest): boolean {
  return request.adapterId?.startsWith("agent-source:") === true || request.tags?.some((tag) => tag.trim().toLowerCase() === "agent-source") === true;
}

export function normalizeMemoryAddCreatedAt(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new MemoryServiceError("invalid_argument", "memory.add createdAt must be an ISO timestamp");
  }
  return date.toISOString();
}

export function memoryAddImportTrace(request: MemoryAddRequest, at: string): Record<string, unknown> {
  const sections = parseMemoryAddSections(request.content);
  const toolCalls = toolCallsFromImportSections(sections, {
    parseJsonPayload: !isCodexAgentSourceImport(request)
  });
  const userText = sections.length
    ? sections
        .filter((section) => section.role === "user" || section.role === "system")
        .map((section) => section.role === "system" ? `[system]\n${section.text}` : section.text)
        .join("\n\n")
    : request.content;
  const agentText = sections.length
    ? sections.filter((section) => section.role === "assistant").map((section) => section.text).join("\n\n")
    : "";
  const turnId = request.turnId ?? `import:${stableHash(request.content).slice(0, 16)}`;
  const tags = captureImportTraceTags({
    at,
    turnId,
    sessionId: request.sessionId ?? request.adapterId ?? "memory.add",
    userText,
    agentText,
    toolCalls
  });

  return {
    key: `memory.add:${stableHash(`${request.source ?? "manual"}:${turnId}:${request.content}`).slice(0, 20)}`,
    ts: Date.parse(at),
    turn_id: turnId,
    step_index: 0,
    sub_step_total: 1,
    user_text: userText,
    agent_text: agentText,
    userText,
    agentText,
    raw_span: { user_text: Boolean(userText), agent_text: Boolean(agentText), tool_call_count: toolCalls.length },
    tool_calls: toolCalls,
    reflection: null,
    alpha: IMPORT_DEFAULT_ALPHA,
    usable: false,
    reflection_source: "none",
    summary: IMPORT_SUMMARY_QUEUED_TAG,
    tags,
    value: IMPORT_DEFAULT_VALUE,
    priority: IMPORT_DEFAULT_PRIORITY,
    signature: signatureFromTraceParts(tags, toolCalls, ""),
    error_signatures: []
  };
}

export function titleFromImportTrace(trace: Record<string, unknown>): string | undefined {
  const userText = stringFromRecord(trace, "user_text");
  const title = userText ? firstLine(userText) : "";
  return title ? clip(title, 120) : undefined;
}

export function toolCallsFromUnknown(value: unknown): ToolCallPayload[] {
  return Array.isArray(value) ? value.filter(isToolCallPayload) : [];
}

function captureImportTraceTags(input: {
  at: string;
  turnId: string;
  sessionId: string;
  userText: string;
  agentText: string;
  toolCalls: ToolCallPayload[];
}): string[] {
  return captureTurnSteps({
    episodeId: `import:${input.turnId}`,
    sessionId: input.sessionId,
    turnId: input.turnId,
    userText: input.userText,
    assistantText: input.agentText,
    toolCalls: input.toolCalls,
    createdAtIso: input.at
  })[0]?.tags ?? [];
}

function parseMemoryAddSections(content: string): Array<{ role: "user" | "assistant" | "tool" | "system"; text: string }> {
  const headingPattern = /^## (user|assistant|tool|system)\s*$/gm;
  const headings = [...content.matchAll(headingPattern)];
  return headings
    .map((heading, index) => {
      const nextHeading = headings[index + 1];
      const start = (heading.index ?? 0) + heading[0].length;
      const end = nextHeading?.index ?? content.length;
      return { role: heading[1] as "user" | "assistant" | "tool" | "system", text: content.slice(start, end).trim() };
    })
    .filter((section) => section.text.length > 0);
}

type MemoryAddSection = ReturnType<typeof parseMemoryAddSections>[number];

function toolCallsFromImportSections(
  sections: readonly MemoryAddSection[],
  options: { parseJsonPayload: boolean } = { parseJsonPayload: true }
): ToolCallPayload[] {
  const calls: ToolCallPayload[] = [];
  const indexByCallId = new Map<string, number>();
  for (const [index, section] of sections.filter((item) => item.role === "tool").entries()) {
    const parsed = parseImportedToolSection(section.text, index, options);
    const existingIndex = parsed.id ? indexByCallId.get(parsed.id) : undefined;
    if (existingIndex !== undefined) {
      calls[existingIndex] = mergeImportedToolCall(calls[existingIndex]!, parsed);
      continue;
    }
    if (parsed.id) indexByCallId.set(parsed.id, calls.length);
    calls.push(parsed);
  }
  return calls;
}

function parseImportedToolSection(text: string, index: number, options: { parseJsonPayload: boolean }): ToolCallPayload {
  const fields = parseToolSectionFields(text, options);
  const fallbackOutput = fields.input === undefined && fields.output === undefined
    ? limitImportedToolPayload(stripToolHeaderLines(text).trim())
    : "";
  return {
    id: fields.callId,
    name: fields.name || `tool_${index + 1}`,
    input: fields.input,
    output: fields.output ?? (fallbackOutput.length > 0 ? fallbackOutput : undefined),
    error: fields.error,
    success: fields.error ? false : undefined
  };
}

function parseToolSectionFields(text: string, options: { parseJsonPayload: boolean }): {
  name?: string;
  callId?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
} {
  return {
    name: firstToolLineValue(text, "Tool"),
    callId: firstToolLineValue(text, "Call ID"),
    input: toolBlockValue(text, "Input", options),
    output: toolBlockValue(text, "Output", options),
    error: firstToolLineValue(text, "Error")
  };
}

function firstToolLineValue(text: string, label: string): string | undefined {
  const match = text.match(new RegExp(`^${escapeToolLabelRegExp(label)}:\\s*(.+)$`, "im"));
  return match?.[1]?.trim() || undefined;
}

function toolBlockValue(text: string, label: string, options: { parseJsonPayload: boolean }): unknown {
  const lines = text.split(/\r?\n/);
  const labelPattern = new RegExp(`^${escapeToolLabelRegExp(label)}:[\\t ]*$`, "i");
  const start = lines.findIndex((line) => labelPattern.test(line));
  if (start < 0) return undefined;
  const nextFieldOffset = lines.slice(start + 1).findIndex((line, offset) =>
    lines[start + offset]?.trim() === "" &&
    /^(?:Tool|Call ID|Status|Input|Output|Error):(?:[\t ]*$|[\t ]+.*$)/i.test(line)
  );
  const end = nextFieldOffset < 0 ? lines.length : start + 1 + nextFieldOffset;
  const value = limitImportedToolPayload(lines.slice(start + 1, end).join("\n").trim());
  if (!value) return undefined;
  if (!options.parseJsonPayload) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function stripToolHeaderLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^(Tool|Call ID|Status|Error):\s*/i.test(line.trim()))
    .join("\n");
}

function mergeImportedToolCall(left: ToolCallPayload, right: ToolCallPayload): ToolCallPayload {
  return {
    ...left,
    name: left.name || right.name,
    input: left.input ?? right.input,
    output: left.output ?? right.output,
    error: left.error ?? right.error,
    success: left.success ?? right.success
  };
}

function isCodexAgentSourceImport(request: MemoryAddRequest): boolean {
  const source = request.source?.trim().toLowerCase();
  const adapterId = request.adapterId?.trim().toLowerCase();
  return source === "codex" || adapterId === "agent-source:codex";
}

function limitImportedToolPayload(value: string): string {
  if (value.length <= IMPORT_TOOL_PAYLOAD_MAX_CHARS) return value;
  return `${value.slice(0, IMPORT_TOOL_PAYLOAD_MAX_CHARS)}\n[truncated:${value.length - IMPORT_TOOL_PAYLOAD_MAX_CHARS} chars]`;
}

function escapeToolLabelRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stringFromRecord(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}


function isToolCallPayload(value: unknown): value is ToolCallPayload {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as { name?: unknown }).name === "string";
}

function uniq(values: string[]): string[] { return [...new Set(values)]; }
