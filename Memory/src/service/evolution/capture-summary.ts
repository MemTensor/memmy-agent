import type { ToolCallPayload } from "../../types.js";
import { stringifyForMemory } from "../../utils/json.js";
import { clip, firstLine } from "../../utils/text.js";

const ATTACHMENT_READ_INSTRUCTION =
  "请用 read_file 工具按需读取上述附件；PDF 可用 pages 参数分页读取。";
const ATTACHMENT_BLOCK_PATTERN =
  /^\s*<attachments>\s*\r?\n([\s\S]*?)\r?\n<\/attachments>(?:\s*\r?\n)*/i;
const ATTACHMENT_LINE_PATTERN =
  /^-\s+(.+?)\s{2,}\(([^,\r\n]+),\s*([^)]+)\)\s{2,}(.+)$/;
const MAX_ATTACHMENT_METADATA_ITEMS = 5;

export interface CaptureSummarySource {
  userText: string;
  agentText: string;
  toolCalls: ToolCallPayload[];
}

export interface NormalizedCaptureSummaryUserText {
  requestText: string;
  attachmentMetadata: string[];
  recognizedAttachmentManifest: boolean;
}

/**
 * Removes only the attachment envelope emitted by Memmy's agent runtime.
 * User-authored XML is preserved unless it has the exact generated manifest shape.
 */
export function normalizeCaptureSummaryUserText(
  value: string
): NormalizedCaptureSummaryUserText {
  const match = value.match(ATTACHMENT_BLOCK_PATTERN);
  if (!match) {
    return {
      requestText: value.trim(),
      attachmentMetadata: [],
      recognizedAttachmentManifest: false
    };
  }

  const lines = (match[1] ?? "").split(/\r?\n/);
  const instructionIndex = lines.findIndex(
    (line) => line.trim() === ATTACHMENT_READ_INSTRUCTION
  );
  const manifestLines = instructionIndex < 0
    ? []
    : lines.slice(0, instructionIndex).map((line) => line.trim()).filter(Boolean);
  const attachments = manifestLines.map(parseAttachmentManifestLine);
  if (
    instructionIndex < 0 ||
    attachments.length === 0 ||
    attachments.some((attachment) => attachment === null)
  ) {
    return {
      requestText: value.trim(),
      attachmentMetadata: [],
      recognizedAttachmentManifest: false
    };
  }

  const visibleAttachments = attachments
    .slice(0, MAX_ATTACHMENT_METADATA_ITEMS)
    .filter((attachment): attachment is string => Boolean(attachment));
  if (attachments.length > MAX_ATTACHMENT_METADATA_ITEMS) {
    visibleAttachments.push(`以及 ${attachments.length - MAX_ATTACHMENT_METADATA_ITEMS} 个其他附件`);
  }

  return {
    requestText: value.slice(match[0].length).trim(),
    attachmentMetadata: visibleAttachments,
    recognizedAttachmentManifest: true
  };
}

/**
 * Validates a model-produced capture summary and falls back to semantic turn content.
 */
export function sanitizeCaptureSummary(
  value: string,
  source: CaptureSummarySource
): string {
  const cleaned = sanitizeSummaryText(value)
    .replace(/<\/?attachments>/gi, "")
    .trim();
  return isUnusableCaptureSummary(cleaned)
    ? fallbackCaptureSummary(source)
    : cleaned;
}

/**
 * Produces a deterministic semantic summary without using internal attachment markup.
 */
export function fallbackCaptureSummary(source: CaptureSummarySource): string {
  const normalizedUser = normalizeCaptureSummaryUserText(source.userText);
  const toolOutputs = [...source.toolCalls]
    .reverse()
    .map((call) => stringifyForMemory(call.output));
  const candidates = normalizedUser.recognizedAttachmentManifest
    ? [source.agentText, ...toolOutputs, normalizedUser.requestText]
    : [normalizedUser.requestText, source.agentText, ...toolOutputs];
  for (const candidate of candidates) {
    const summary = firstUsableSummaryLine(candidate);
    if (summary) return clip(summary, 200);
  }
  const attachmentName = normalizedUser.attachmentMetadata[0];
  return attachmentName ? clip(`已处理附件：${attachmentName}`, 200) : "trace memory";
}

function parseAttachmentManifestLine(value: string): string | null {
  const match = value.match(ATTACHMENT_LINE_PATTERN);
  if (!match) return null;
  const [, fileName, mime, size] = match;
  return `${fileName?.trim()} (${mime?.trim()}, ${size?.trim()})`;
}

function firstUsableSummaryLine(value: string): string {
  const line = sanitizeSummaryText(firstLine(value))
    .replace(/^\s*#{1,6}\s+/, "")
    .replace(/^\s*[-*]\s+/, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .trim();
  return isUnusableCaptureSummary(line) ? "" : line;
}

function sanitizeSummaryText(value: string): string {
  return value
    .replace(/^```(?:json|text|markdown)?/i, "")
    .replace(/```$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isUnusableCaptureSummary(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) return true;
  if (normalized.includes(ATTACHMENT_READ_INSTRUCTION)) return true;
  if (/^(?:<\/?[a-z_][^>]*>\s*)+$/i.test(normalized)) return true;
  return /^(?:附件|文件|上传的附件|attachment|attachments|file|uploaded file)$/i.test(normalized);
}
