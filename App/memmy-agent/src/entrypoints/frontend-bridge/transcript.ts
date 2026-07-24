import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { lookup as lookupMime } from "mime-types";
import { getWebuiDir } from "../../config/paths.js";

export const WEBUI_TRANSCRIPT_SCHEMA_VERSION = 3;

const MAX_TRANSCRIPT_FILE_BYTES = 8 * 1024 * 1024;
const MARKDOWN_LOCAL_IMAGE_RE = /!\[([^\]]*)\]\((<[^>]+>|[^)\s]+)(\s+(?:"[^"]*"|'[^']*'))?\)/g;
const INLINE_MARKDOWN_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const UNSAFE_FILENAME_CHARS = /[<>:"/\\|?*]/g;
const PHASE_RANK: Record<string, number> = { start: 1, end: 2, error: 3 };

type Dict = Record<string, any>;
type AugmentUserMedia = (paths: string[]) => Dict[];
type AugmentAssistantMedia = (paths: string[]) => Dict[];
type AugmentAssistantText = (text: string) => string;
type TranscriptMediaKind = "image" | "video" | "file";

export interface ReplayTranscriptOptions {
  augmentUserMedia?: AugmentUserMedia | null;
  augmentAssistantMedia?: AugmentAssistantMedia | null;
  augmentAssistantText?: AugmentAssistantText | null;
  sessionMessages?: Dict[] | null;
}

export interface BuildWebuiThreadResponseOptions extends ReplayTranscriptOptions {}

export interface RewriteLocalMarkdownImagesOptions {
  workspacePath?: string;
  signPath?: (filePath: string) => Dict | null;
}

function isDict(value: any): value is Dict {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isCronProactiveRecord(rec: Dict): boolean {
  return isDict(rec.metadata) && rec.metadata.proactiveDelivery === "cron";
}

function isTranscriptMediaKind(value: any): value is TranscriptMediaKind {
  return value === "image" || value === "video" || value === "file";
}

function stringValue(value: any): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function transcriptCreatedAt(rec: Dict): number | undefined {
  const raw = rec.createdAt ?? rec.created_at ?? rec.timestamp;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.trunc(raw > 10_000_000_000 ? raw : raw * 1000);
  }
  if (typeof raw === "string" && raw.trim()) {
    const time = Date.parse(raw);
    return Number.isNaN(time) ? undefined : time;
  }
  return undefined;
}

function createdAtPatch(rec: Dict): Dict {
  const createdAt = transcriptCreatedAt(rec);
  return createdAt == null ? {} : { createdAt };
}

function mediaKindFromValue(value: string | null | undefined): TranscriptMediaKind | null {
  if (!value) return null;
  const dataUrlMime = /^data:([^;]+)(?:;|,)/i.exec(value)?.[1]?.toLowerCase();
  const mime = dataUrlMime ?? String(lookupMime(value) || "");
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  return mime ? "file" : null;
}

function mediaKindForTranscriptAttachment(values: Array<string | null | undefined>): TranscriptMediaKind {
  for (const value of values) {
    const kind = mediaKindFromValue(value);
    if (kind) return kind;
  }
  return "file";
}

function basenameFromValue(value: string | null | undefined): string | null {
  if (!value) return null;
  const clean = value.split(/[?#]/, 1)[0] ?? value;
  const base = path.basename(clean);
  return base && base !== "/" && base !== "." ? base : null;
}

function normalizeTranscriptMediaAttachments(rec: Dict): Dict[] {
  const mediaUrls = Array.isArray(rec.media_urls) ? rec.media_urls : [];
  const rawMedia = Array.isArray(rec.media) ? rec.media : [];
  const mediaPaths = Array.isArray(rec.media_paths) ? rec.media_paths : [];
  const count = Math.max(mediaUrls.length, rawMedia.length, mediaPaths.length);
  const out: Dict[] = [];
  for (let index = 0; index < count; index += 1) {
    const item = isDict(mediaUrls[index]) ? mediaUrls[index] : {};
    const url = stringValue(item.url);
    const explicitPath = stringValue(item.path);
    const mediaPath = stringValue(rawMedia[index]) ?? stringValue(mediaPaths[index]);
    const attachmentPath = explicitPath ?? mediaPath;
    const name = stringValue(item.name) ?? basenameFromValue(attachmentPath) ?? basenameFromValue(url);
    const kind = isTranscriptMediaKind(item.kind)
      ? item.kind
      : mediaKindForTranscriptAttachment([name, attachmentPath, mediaPath, url]);
    if (!url && !name && !attachmentPath) continue;
    out.push({
      kind,
      ...(url ? { url } : {}),
      ...(name ? { name } : {}),
      ...(attachmentPath ? { path: attachmentPath } : {}),
    });
  }
  return out;
}

function normalizeAssistantMediaAttachments(rec: Dict, augmentAssistantMedia: AugmentAssistantMedia | null): Dict[] {
  const base = normalizeTranscriptMediaAttachments(rec);
  const rawMedia = Array.isArray(rec.media) ? rec.media : [];
  const mediaPaths = rawMedia.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
  const mediaUrls = Array.isArray(rec.media_urls) ? rec.media_urls : [];
  if (!augmentAssistantMedia || !mediaPaths.length || mediaUrls.length >= mediaPaths.length) {
    return base;
  }

  const augmented = augmentAssistantMedia(mediaPaths);
  if (!augmented.length) {
    return base;
  }
  const merged = [...base];
  for (const item of augmented) {
    const itemPath = stringValue(item.path);
    const itemName = stringValue(item.name);
    const existingIndex = merged.findIndex((candidate) => {
      const candidatePath = stringValue(candidate.path);
      const candidateName = stringValue(candidate.name);
      return (itemPath && candidatePath === itemPath) || (!itemPath && itemName && candidateName === itemName);
    });
    if (existingIndex >= 0) {
      merged[existingIndex] = { ...merged[existingIndex], ...item };
    } else {
      merged.push(item);
    }
  }
  return merged;
}

function safeFilename(name: string): string {
  return name.replace(UNSAFE_FILENAME_CHARS, "_").trim();
}

function safeSessionStem(sessionKey: string): string {
  return safeFilename(String(sessionKey).replace(/:/g, "_"));
}

function legacyTranscriptPath(root: string, id: string): string {
  return path.join(root, `${id}.jsonl`);
}

export function webuiTranscriptPath(sessionKey: string): string;
export function webuiTranscriptPath(root: string, id: string): string;
export function webuiTranscriptPath(sessionKeyOrRoot: string, id?: string): string {
  if (id !== undefined) return legacyTranscriptPath(sessionKeyOrRoot, id);
  return path.join(getWebuiDir(), `${safeSessionStem(sessionKeyOrRoot)}.jsonl`);
}

export function readTranscriptLines(sessionKey: string): Dict[] {
  const file = webuiTranscriptPath(sessionKey);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return [];
  if (fs.statSync(file).size > MAX_TRANSCRIPT_FILE_BYTES) return [];
  const out: Dict[] = [];
  try {
    for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (isDict(obj)) out.push(obj);
      } catch {
        continue;
      }
    }
  } catch {
    return [];
  }
  return out;
}

export function appendTranscriptObject(sessionKey: string, obj: Dict): void;
export function appendTranscriptObject(root: string, id: string, obj: Dict): void;
export function appendTranscriptObject(sessionKeyOrRoot: string, objOrId: Dict | string, maybeObj?: Dict): void {
  const file = typeof objOrId === "string"
    ? webuiTranscriptPath(sessionKeyOrRoot, objOrId)
    : webuiTranscriptPath(sessionKeyOrRoot);
  const obj = typeof objOrId === "string" ? maybeObj : objOrId;
  if (!isDict(obj)) throw new Error("webui transcript object must be a JSON object");

  const raw = JSON.stringify(obj);
  if (Buffer.byteLength(raw, "utf8") > MAX_TRANSCRIPT_FILE_BYTES) {
    throw new Error("webui transcript line too large");
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, "a");
  try {
    fs.writeSync(fd, `${raw}\n`, undefined, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function deleteWebuiTranscript(sessionKey: string): boolean;
export function deleteWebuiTranscript(root: string, id: string): boolean;
export function deleteWebuiTranscript(sessionKeyOrRoot: string, id?: string): boolean {
  const file = id === undefined ? webuiTranscriptPath(sessionKeyOrRoot) : webuiTranscriptPath(sessionKeyOrRoot, id);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

export function rewriteLocalMarkdownImages(text: string, options: RewriteLocalMarkdownImagesOptions): string {
  if (!text.includes("![")) return text;
  const workspaceRoot = path.resolve(options.workspacePath ?? ".");
  const signPath = options.signPath;
  if (!signPath) return text;
  const signer = signPath;

  function resolveUrl(rawUrl: string): string | null {
    let url = rawUrl.trim();
    if (url.startsWith("<") && url.endsWith(">")) url = url.slice(1, -1).trim();
    if (!url || url.startsWith("/api/media/") || url.startsWith("#")) return null;
    if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(url) || url.startsWith("//") || url.includes("?") || url.includes("#")) {
      return null;
    }
    let pathText = url;
    try {
      pathText = decodeURIComponent(url);
    } catch {
      pathText = url;
    }
    if (!INLINE_MARKDOWN_IMAGE_EXTS.has(path.extname(pathText).toLowerCase())) return null;
    const candidate = path.isAbsolute(pathText) ? path.resolve(pathText) : path.resolve(workspaceRoot, pathText);
    const relative = path.relative(workspaceRoot, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return null;
    const signed = signer(candidate);
    return signed?.url ? String(signed.url) : null;
  }

  return text.replace(MARKDOWN_LOCAL_IMAGE_RE, (full, alt: string, rawUrl: string, title: string = "") => {
    const signedUrl = resolveUrl(rawUrl);
    return signedUrl ? `![${alt}](${signedUrl}${title})` : full;
  });
}

function jsonWithCompactSpacing(value: any): string {
  const raw = JSON.stringify(value);
  if (raw === undefined) return "";
  return raw.replace(/:/g, ": ").replace(/,/g, ", ");
}

function formatToolCallTrace(call: any): string | null {
  if (!isDict(call)) return null;
  const fn = isDict(call.function) ? call.function : null;
  let name = typeof fn?.name === "string" && fn.name ? fn.name : "";
  if (!name && typeof call.name === "string") name = call.name;
  if (!name) return null;
  const args = fn && fn.arguments !== undefined ? fn.arguments : call.arguments;
  if (typeof args === "string" && args.trim()) return `${name}(${args})`;
  if (isDict(args)) return `${name}(${jsonWithCompactSpacing(args)})`;
  return `${name}()`;
}

export function toolTraceLinesFromEvents(events: any): string[] {
  if (!Array.isArray(events)) return [];
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (!isDict(event)) continue;
    if (!["start", "end", "error"].includes(String(event.phase))) continue;
    const callId = typeof event.call_id === "string" ? event.call_id : "";
    if (callId) {
      if (seen.has(callId)) continue;
      seen.add(callId);
    }
    const trace = formatToolCallTrace(event);
    if (trace) lines.push(trace);
  }
  return lines;
}

function normalizeToolEvents(events: any): Dict[] {
  if (!Array.isArray(events)) return [];
  const out: Dict[] = [];
  for (const event of events) {
    if (!isDict(event)) continue;
    if (!["start", "end", "error"].includes(String(event.phase))) continue;
    if (typeof event.name !== "string") {
      const fn = isDict(event.function) ? event.function : null;
      if (typeof fn?.name !== "string") continue;
    }
    out.push({ ...event });
  }
  return out;
}

function toolEventKey(event: Dict): string {
  const callId = typeof event.call_id === "string" ? event.call_id : "";
  return callId ? `call:${callId}` : formatToolCallTrace(event) ?? jsonWithCompactSpacing(event);
}

function mergeToolEvents(previous: any, incoming: Dict[]): Dict[] {
  if (!Array.isArray(previous) || previous.length === 0) return incoming;
  if (incoming.length === 0) return previous.filter(isDict).map((event) => ({ ...event }));
  const merged = previous.filter(isDict).map((event) => ({ ...event }));
  const indexByKey = new Map<string, number>();
  merged.forEach((event, idx) => indexByKey.set(toolEventKey(event), idx));
  for (const event of incoming) {
    const key = toolEventKey(event);
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, merged.length);
      merged.push(event);
      continue;
    }
    const existing = merged[existingIndex];
    const incomingRank = PHASE_RANK[String(event.phase)] ?? 0;
    const existingRank = PHASE_RANK[String(existing.phase)] ?? 0;
    if (incomingRank >= existingRank) merged[existingIndex] = { ...existing, ...event };
  }
  return merged;
}

function mergeUniqueToolTraceLines(previousTraces: string[], lines: string[]): [string[], boolean] {
  const seen = new Set(previousTraces);
  const traces = [...previousTraces];
  let added = false;
  for (const line of lines) {
    if (seen.has(line)) continue;
    seen.add(line);
    traces.push(line);
    added = true;
  }
  return [traces, added];
}

function sessionCreatedAts(messages: Dict[] | null, role: "user" | "assistant"): number[] {
  return (messages ?? [])
    .filter((message) => message.role === role)
    .map(transcriptCreatedAt)
    .filter((createdAt): createdAt is number => createdAt != null);
}

export function replayTranscriptToUiMessages(lines: Dict[], options: ReplayTranscriptOptions = {}): Dict[] {
  const augmentUserMedia = options.augmentUserMedia ?? null;
  const augmentAssistantMedia = options.augmentAssistantMedia ?? null;
  const augmentAssistantText = options.augmentAssistantText ?? null;
  const sessionCreatedAtByRole = {
    user: sessionCreatedAts(options.sessionMessages ?? null, "user"),
    assistant: sessionCreatedAts(options.sessionMessages ?? null, "assistant"),
  };
  const sessionCreatedAtIndexByRole = { user: 0, assistant: 0 };
  let messages: Dict[] = [];
  let bufferMessageId: string | null = null;
  let closedAnswerMessageId: string | null = null;
  let bufferParts: string[] = [];
  let suppressUntilTurnEnd = false;
  let activeActivitySegmentId: string | null = null;
  let activeFileEditSegmentId: string | null = null;
  let activitySegmentCounter = 0;
  const newId = (prefix: string, idx: number): string => `${prefix}-${idx}-${randomUUID().slice(0, 8)}`;

  function roleCreatedAtPatch(role: "user" | "assistant"): Dict {
    const index = sessionCreatedAtIndexByRole[role];
    sessionCreatedAtIndexByRole[role] = index + 1;
    const createdAt = sessionCreatedAtByRole[role][index];
    return createdAt == null ? {} : { createdAt };
  }

  function newActivitySegment({ activate = true }: { activate?: boolean } = {}): string {
    activitySegmentCounter += 1;
    const segmentId = `activity-${activitySegmentCounter}`;
    if (activate) activeActivitySegmentId = segmentId;
    return segmentId;
  }

  function ensureActivitySegment(): string {
    return activeActivitySegmentId ?? newActivitySegment();
  }

  function normalizeContextCompactionStatus(value: any): "running" | "done" | "error" {
    return value === "running" || value === "done" || value === "error" ? value : "done";
  }

  function contextCompactionFallbackText(status: "running" | "done" | "error"): string {
    if (status === "running") return "会话压缩中";
    if (status === "error") return "压缩失败";
    return "压缩已完成";
  }

  function upsertContextCompactionDivider(rec: Dict, idx: number): void {
    const compactionId = stringValue(rec.compaction_id) ?? `transcript-${idx}`;
    const status = normalizeContextCompactionStatus(rec.status);
    const content = stringValue(rec.text) ?? stringValue(rec.content) ?? contextCompactionFallbackText(status);
    const existingIndex = messages.findIndex((message) => (
      message.kind === "context_compaction"
      && message.compactionId === compactionId
    ));
    const next = {
      role: "tool",
      kind: "context_compaction",
      content,
      compactionId,
      compactionStatus: status,
      isStreaming: status === "running",
    };
    if (existingIndex >= 0) {
      const { traces, toolEvents, fileEdits, activitySegmentId, ...previous } = messages[existingIndex];
      void traces;
      void toolEvents;
      void fileEdits;
      void activitySegmentId;
      messages[existingIndex] = {
        ...previous,
        ...next,
      };
      return;
    }
    messages.push({
      id: `context-compaction:${compactionId}`,
      ...next,
      ...createdAtPatch(rec),
    });
  }

  function currentTurnStartIndex(): number {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === "user") return i + 1;
    }
    return 0;
  }

  function firstActivitySegmentIdInCurrentTurn(): string | null {
    for (let i = currentTurnStartIndex(); i < messages.length; i += 1) {
      const segment = messages[i].activitySegmentId;
      if (typeof segment === "string" && segment) return segment;
    }
    return null;
  }

  function currentTurnActivitySegment(): string {
    const segment = firstActivitySegmentIdInCurrentTurn();
    if (segment) {
      activeActivitySegmentId = segment;
      return segment;
    }
    return ensureActivitySegment();
  }

  function closeFileEditPhaseBeforeActivity(): void {
    if (activeFileEditSegmentId) {
      activeFileEditSegmentId = null;
    }
  }

  function attachReasoningChunk(prev: Dict[], chunk: string, rec: Dict, idx: number): void {
    detachOpenAnswerBeforeActivity();
    for (let i = prev.length - 1; i >= 0; i -= 1) {
      const candidate = prev[i];
      if (candidate.role === "user") break;
      if (candidate.kind === "trace") break;
      if (candidate.role !== "assistant") continue;
      const content = String(candidate.content ?? "");
      const hasAnswer = content.length > 0;
      if (candidate.reasoningStreaming || candidate.reasoning != null || hasAnswer || candidate.isStreaming) {
        prev[i] = {
          ...candidate,
          reasoning: String(candidate.reasoning ?? "") + chunk,
          reasoningStreaming: true,
          activitySegmentId: candidate.activitySegmentId ?? currentTurnActivitySegment(),
        };
        return;
      }
      if (!hasAnswer && candidate.isStreaming) {
        prev[i] = {
          ...candidate,
          reasoning: chunk,
          reasoningStreaming: true,
          activitySegmentId: candidate.activitySegmentId ?? currentTurnActivitySegment(),
        };
        return;
      }
      break;
    }
    const segment = currentTurnActivitySegment();
    prev.push({
      id: newId("as", idx),
      role: "assistant",
      content: "",
      isStreaming: true,
      reasoning: chunk,
      reasoningStreaming: true,
      activitySegmentId: segment,
      ...createdAtPatch(rec),
    });
  }

  function findActivePlaceholder(prev: Dict[]): string | null {
    const last = prev.at(-1);
    if (!last) return null;
    if (last.role !== "assistant" || last.kind === "trace") return null;
    if (last.reasoning) return null;
    if (String(last.content ?? "")) return null;
    if (!last.isStreaming) return null;
    return String(last.id);
  }

  function closeReasoning(prev: Dict[]): void {
    for (let i = prev.length - 1; i >= 0; i -= 1) {
      if (prev[i].reasoningStreaming) {
        prev[i] = { ...prev[i], reasoningStreaming: false };
        return;
      }
    }
  }

  function isReasoningOnlyPlaceholder(message: Dict): boolean {
    return (
      message.role === "assistant"
      && message.kind !== "trace"
      && !String(message.content ?? "").trim()
      && Boolean(message.reasoning)
      && !message.media
    );
  }

  function isLikelyNarrativeProgressText(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) return false;
    if (/^[A-Za-z_][\w.-]*\s*\(/u.test(trimmed)) return false;
    return trimmed.length > 140
      || trimmed.includes("\n\n")
      || /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|\|.+\|)/u.test(trimmed);
  }

  function pruneReasoningOnly(): void {
    messages = messages.map((message) => (
      isReasoningOnlyPlaceholder(message)
        ? { ...message, reasoningStreaming: false, isStreaming: false }
        : message
    ));
  }

  function isTerminalToolPhase(phase: any): boolean {
    return phase === "end" || phase === "error";
  }

  function finishToolEventsForTurnEnd(events: any): any {
    if (!Array.isArray(events) || events.length === 0) return events;
    let changed = false;
    const finished = events.map((event) => {
      if (!isDict(event) || isTerminalToolPhase(event.phase)) return event;
      changed = true;
      return { ...event, phase: "end" };
    });
    return changed ? finished : events;
  }

  function finishFileEditsForTurnEnd(edits: any): any {
    if (!Array.isArray(edits) || edits.length === 0) return edits;
    let changed = false;
    const finished = edits.map((edit) => {
      if (!isDict(edit) || edit.status === "done" || edit.status === "error") return edit;
      changed = true;
      return { ...edit, phase: "end", status: "done" };
    });
    return changed ? finished : edits;
  }

  function finishActivityProgressForTurnEnd(message: Dict): Dict {
    const toolEvents = finishToolEventsForTurnEnd(message.toolEvents);
    const fileEdits = finishFileEditsForTurnEnd(message.fileEdits);
    const shouldFinishStreaming = Boolean(message.isStreaming || message.reasoningStreaming);
    if (toolEvents === message.toolEvents && fileEdits === message.fileEdits && !shouldFinishStreaming) {
      return message;
    }

    return {
      ...message,
      ...(toolEvents !== message.toolEvents ? { toolEvents } : {}),
      ...(fileEdits !== message.fileEdits ? { fileEdits } : {}),
      ...(shouldFinishStreaming ? { isStreaming: false, reasoningStreaming: false } : {}),
    };
  }

  function stampLatency(latencyMs: number): void {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === "assistant" && messages[i].kind !== "trace" && messages[i].kind !== "narration") {
        messages[i] = { ...messages[i], latencyMs, isStreaming: false };
        return;
      }
    }
  }

  function absorbComplete(extra: Dict, rec: Dict, idx: number): void {
    const last = messages.at(-1);
    if (last && isReasoningOnlyPlaceholder(last)) {
      messages[messages.length - 1] = {
        ...last,
        reasoningStreaming: false,
        isStreaming: false,
        activitySegmentId: last.activitySegmentId ?? currentTurnActivitySegment(),
      };
      messages.push({
        id: newId("as", idx),
        role: "assistant",
        ...roleCreatedAtPatch("assistant"),
        ...extra,
      });
    } else {
      messages.push({
        id: newId("as", idx),
        role: "assistant",
        ...roleCreatedAtPatch("assistant"),
        ...extra,
      });
    }
    activeFileEditSegmentId = null;
  }

  function absorbCompleteIntoMessage(messageId: string | null, extra: Dict): boolean {
    if (!messageId) return false;
    const messageIndex = messages.findIndex((message) => (
      message.id === messageId
      && message.role === "assistant"
      && message.kind !== "trace"
    ));
    if (messageIndex < 0) return false;

    const target = messages[messageIndex];
    const content = typeof extra.content === "string" && extra.content ? extra.content : String(target.content ?? "");
    messages[messageIndex] = {
      ...target,
      ...extra,
      content,
      isStreaming: true,
      reasoningStreaming: false,
    };
    activeFileEditSegmentId = null;
    return true;
  }

  function findLatestFoldableAssistantAnswerIndex(): number | null {
    for (let i = messages.length - 1; i >= currentTurnStartIndex(); i -= 1) {
      const candidate = messages[i];
      if (
        candidate.role === "assistant"
        && candidate.kind !== "trace"
        && candidate.kind !== "narration"
        && String(candidate.content ?? "").trim()
        && !candidate.media
      ) {
        return i;
      }
    }
    return null;
  }

  /**
   * Reclassify a mid-turn assistant draft as activity narration.
   *
   * The runtime marks these segments explicitly (`stream_end` with
   * `resuming: true`): the loop will continue with more tools/text, so this
   * text is a working draft, not the turn's answer. It stays verbatim in the
   * message list as `kind: "narration"` and renders inside the activity
   * timeline. This replaces the old behavior of folding the text into tool
   * trace lines (which polluted `traces[]` with prose) — and it never deletes
   * or rewrites content, so live rendering and history replay stay identical.
   */
  function convertAssistantAnswerToNarration(index: number): void {
    const target = messages[index];
    if (
      !target
      || target.role !== "assistant"
      || target.kind === "trace"
      || target.kind === "narration"
      || target.media
    ) {
      return;
    }
    const hasContent = Boolean(String(target.content ?? "").trim());
    const hasReasoning = Boolean(String(target.reasoning ?? "").trim());
    if (!hasContent && !hasReasoning) return;
    const segment = typeof target.activitySegmentId === "string" && target.activitySegmentId
      ? target.activitySegmentId
      : currentTurnActivitySegment();
    messages[index] = {
      ...target,
      ...(hasContent ? { kind: "narration" } : {}),
      isStreaming: false,
      reasoningStreaming: false,
      activitySegmentId: segment,
    };
    activeActivitySegmentId = segment;
  }

  function detachOpenAnswerBeforeActivity(): void {
    closedAnswerMessageId = null;
    bufferMessageId = null;
    bufferParts = [];
  }

  function fileEditKey(edit: Dict): string {
    const callId = String(edit.call_id ?? "");
    const tool = String(edit.tool ?? "");
    return callId ? `${callId}|${tool}` : `${tool}|${edit.path ?? ""}`;
  }

  function findFileEditTraceIndex(segment: string | null, edits: Dict[]): number | null {
    const incomingKeys = new Set(edits.filter(isDict).map(fileEditKey));
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const candidate = messages[i];
      if (candidate.role === "user") break;
      if (candidate.kind !== "trace" || !candidate.fileEdits) continue;
      const existingEdits = candidate.fileEdits;
      if (!Array.isArray(existingEdits)) continue;
      for (const existing of existingEdits) {
        if (isDict(existing) && incomingKeys.has(fileEditKey(existing))) return i;
      }
    }
    return null;
  }

  function toolEventName(event: Dict): string {
    if (typeof event.name === "string" && event.name) {
      return event.name;
    }
    const fn = isDict(event.function) ? event.function : null;
    return typeof fn?.name === "string" && fn.name ? fn.name : "";
  }

  function toolEventCallId(event: Dict): string {
    return typeof event.call_id === "string" && event.call_id ? event.call_id : "";
  }

  function fileEditCallId(edit: Dict): string {
    const callId = typeof edit.call_id === "string" && edit.call_id ? edit.call_id : "";
    const tool = String(edit.tool ?? "");
    const editPath = String(edit.path ?? "");
    const fallbackCallId = `${tool}:${editPath || "pending"}`;
    return callId && callId !== fallbackCallId ? callId : "";
  }

  function fileEditMatchesToolEvent(edit: Dict, event: Dict): boolean {
    const editCallId = fileEditCallId(edit);
    const eventCallId = toolEventCallId(event);
    if (!editCallId || !eventCallId || editCallId !== eventCallId) {
      return false;
    }
    const name = toolEventName(event);
    return !name || String(edit.tool ?? "") === name;
  }

  function toolEventsMatch(left: Dict, right: Dict): boolean {
    const leftCallId = toolEventCallId(left);
    const rightCallId = toolEventCallId(right);
    if (!leftCallId || !rightCallId || leftCallId !== rightCallId) {
      return false;
    }
    const leftName = toolEventName(left);
    const rightName = toolEventName(right);
    return !leftName || !rightName || leftName === rightName;
  }

  function hasFileEdits(message: Dict | undefined): boolean {
    return Boolean(message?.kind === "trace" && Array.isArray(message.fileEdits) && message.fileEdits.length);
  }

  function findFileEditTraceIndexForToolEvents(events: Dict[]): number | null {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const candidate = messages[i];
      if (candidate.role === "user") break;
      if (candidate.kind !== "trace" || !Array.isArray(candidate.fileEdits)) continue;
      if (candidate.fileEdits.some((edit: unknown) => isDict(edit) && events.some((event) => fileEditMatchesToolEvent(edit, event)))) {
        return i;
      }
    }
    return null;
  }

  function findToolTraceIndexForToolEvents(events: Dict[], segment: string): number | null {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const candidate = messages[i];
      if (candidate.role === "user") break;
      if (candidate.kind !== "trace" || candidate.activitySegmentId !== segment || !Array.isArray(candidate.toolEvents)) continue;
      if (candidate.toolEvents.some((event: unknown) => isDict(event) && events.some((incoming) => toolEventsMatch(event, incoming)))) {
        return i;
      }
    }
    return null;
  }

  function findToolTraceSegmentIdForFileEdits(edits: Dict[]): string | null {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const candidate = messages[i];
      if (candidate.role === "user") break;
      if (candidate.kind !== "trace" || !Array.isArray(candidate.toolEvents)) continue;
      if (candidate.toolEvents.some((event: unknown) => isDict(event) && edits.some((edit) => fileEditMatchesToolEvent(edit, event)))) {
        return typeof candidate.activitySegmentId === "string" ? candidate.activitySegmentId : null;
      }
    }
    return null;
  }

  function upsertFileEdits(edits: Dict[], rec: Dict, idx: number): void {
    if (edits.length === 0) return;
    detachOpenAnswerBeforeActivity();
    const relatedToolSegmentId = findToolTraceSegmentIdForFileEdits(edits);
    let segment = activeFileEditSegmentId ?? relatedToolSegmentId ?? currentTurnActivitySegment();
    let targetIndex = findFileEditTraceIndex(segment, edits);
    let last: Dict;
    if (targetIndex !== null) {
      last = messages[targetIndex];
      segment = String(last.activitySegmentId ?? relatedToolSegmentId ?? segment);
      activeFileEditSegmentId = segment;
    } else {
      activeFileEditSegmentId = segment;
      messages.push({
        id: newId("tr", idx),
        role: "tool",
        kind: "trace",
        content: "",
        traces: [],
        fileEdits: [],
        activitySegmentId: segment,
        ...createdAtPatch(rec),
      });
      targetIndex = messages.length - 1;
      last = messages[targetIndex];
    }
    if (!segment) {
      segment = relatedToolSegmentId ?? currentTurnActivitySegment();
      activeFileEditSegmentId = segment;
    }
    const existing = Array.isArray(last.fileEdits) ? [...last.fileEdits] : [];
    const indexByKey = new Map<string, number>();
    existing.forEach((edit, pos) => {
      if (isDict(edit)) indexByKey.set(fileEditKey(edit), pos);
    });
    for (const edit of edits) {
      if (!isDict(edit)) continue;
      const key = fileEditKey(edit);
      const pos = indexByKey.get(key);
      if (pos !== undefined) {
        const merged = { ...existing[pos], ...edit };
        if (edit.path && !edit.pending) delete merged.pending;
        existing[pos] = merged;
      } else {
        indexByKey.set(key, existing.length);
        existing.push({ ...edit });
      }
    }
    messages[targetIndex] = {
      ...last,
      content: "",
      traces: [],
      fileEdits: existing,
      activitySegmentId: last.activitySegmentId ?? relatedToolSegmentId ?? segment,
    };
  }

  for (const [idx, rec] of lines.entries()) {
    const ev = rec.event;
    if (ev === "user") {
      suppressUntilTurnEnd = false;
      activeActivitySegmentId = null;
      activeFileEditSegmentId = null;
      closedAnswerMessageId = null;
      const text = typeof rec.text === "string" ? rec.text : "";
      const rawMediaPaths = Array.isArray(rec.media_paths) ? rec.media_paths : [];
      const mediaPaths = rawMediaPaths.filter(Boolean).map((item) => String(item));
      const mediaAttachments = mediaPaths.length && augmentUserMedia ? augmentUserMedia(mediaPaths) : null;
      const row: Dict = {
        id: newId("u", idx),
        role: "user",
        content: text,
        ...roleCreatedAtPatch("user"),
      };
      if (mediaAttachments?.length) {
        row.media = mediaAttachments;
        if (mediaAttachments.every((item) => item.kind === "image")) {
          row.images = mediaAttachments.map((item) => ({ url: item.url, name: item.name }));
        }
      }
      if (Array.isArray(rec.mcp_presets) && rec.mcp_presets.length) {
        row.mcpPresets = rec.mcp_presets.filter(isDict).map((preset) => ({ ...preset }));
      }
      messages.push(row);
      continue;
    }

    if (ev === "file_edit") {
      if (Array.isArray(rec.edits)) upsertFileEdits(rec.edits.filter(isDict), rec, idx);
      continue;
    }

    if (ev === "context_compaction") {
      upsertContextCompactionDivider(rec, idx);
      continue;
    }

    if (ev === "delta") {
      if (suppressUntilTurnEnd) continue;
      const chunk = rec.text;
      if (typeof chunk !== "string") continue;
      closedAnswerMessageId = null;
      const adopted: string | null = bufferMessageId === null ? findActivePlaceholder(messages) : null;
      if (bufferMessageId === null) {
        if (adopted) {
          bufferMessageId = adopted;
          const messageIndex = messages.findIndex((message) => message.id === adopted);
          if (messageIndex >= 0 && messages[messageIndex].createdAt == null) {
            messages[messageIndex] = { ...messages[messageIndex], ...roleCreatedAtPatch("assistant") };
          }
        } else {
          bufferMessageId = newId("buf", idx);
          messages.push({
            id: bufferMessageId,
            role: "assistant",
            content: "",
            isStreaming: true,
            ...roleCreatedAtPatch("assistant"),
          });
        }
      }
      bufferParts.push(chunk);
      const combined = bufferParts.join("");
      const messageIndex = messages.findIndex((message) => message.id === bufferMessageId);
      if (messageIndex >= 0) messages[messageIndex] = { ...messages[messageIndex], content: combined, isStreaming: true };
      continue;
    }

    if (ev === "stream_end") {
      if (suppressUntilTurnEnd) {
        closedAnswerMessageId = null;
        bufferMessageId = null;
        bufferParts = [];
        continue;
      }
      let closedId = bufferMessageId;
      const finalText = rec.text;
      if (typeof finalText === "string") {
        if (bufferMessageId === null) {
          bufferMessageId = newId("buf", idx);
          closedId = bufferMessageId;
          messages.push({
            id: bufferMessageId,
            role: "assistant",
            content: finalText,
            isStreaming: true,
            ...roleCreatedAtPatch("assistant"),
          });
        } else {
          const messageIndex = messages.findIndex((message) => message.id === bufferMessageId);
          if (messageIndex >= 0) messages[messageIndex] = { ...messages[messageIndex], content: finalText, isStreaming: true };
        }
      }
      if (rec.resuming === true) {
        const targetIndex = closedId
          ? messages.findIndex((message) => message.id === closedId && message.role === "assistant" && message.kind !== "trace")
          : findLatestFoldableAssistantAnswerIndex();
        if (targetIndex !== null && targetIndex >= 0) convertAssistantAnswerToNarration(targetIndex);
        closedAnswerMessageId = null;
      } else {
        closedAnswerMessageId = closedId;
      }
      bufferMessageId = null;
      bufferParts = [];
      continue;
    }

    if (ev === "reasoning_delta") {
      if (suppressUntilTurnEnd) continue;
      const chunk = rec.text;
      if (typeof chunk !== "string" || !chunk) continue;
      closeFileEditPhaseBeforeActivity();
      attachReasoningChunk(messages, chunk, rec, idx);
      continue;
    }

    if (ev === "reasoning_end") {
      if (suppressUntilTurnEnd) continue;
      closeReasoning(messages);
      continue;
    }

    if (ev === "message") {
      const kind = rec.kind;
      if (suppressUntilTurnEnd && (kind === "tool_hint" || kind === "progress" || kind === "reasoning")) {
        continue;
      }
      if (kind === "reasoning") {
        const line = rec.text;
        if (typeof line !== "string" || !line) continue;
        closeFileEditPhaseBeforeActivity();
        attachReasoningChunk(messages, line, rec, idx);
        closeReasoning(messages);
        continue;
      }
      if (kind === "tool_hint" || kind === "progress") {
        detachOpenAnswerBeforeActivity();
        const structuredEvents = normalizeToolEvents(rec.tool_events);
        const structured = toolTraceLinesFromEvents(rec.tool_events);
        const text = rec.text;
        if (!structuredEvents.length && typeof text === "string" && isLikelyNarrativeProgressText(text)) {
          absorbComplete({ content: text }, rec, idx);
          continue;
        }
        const traceLines = structured.length ? structured : (typeof text === "string" && text ? [text] : []);
        if (!traceLines.length) continue;
        const relatedFileEditIndex = structuredEvents.length ? findFileEditTraceIndexForToolEvents(structuredEvents) : null;
        const relatedFileEdit = relatedFileEditIndex !== null ? messages[relatedFileEditIndex] : null;
        const segment = typeof relatedFileEdit?.activitySegmentId === "string" ? relatedFileEdit.activitySegmentId : currentTurnActivitySegment();
        if (structuredEvents.length) {
          const existingToolTraceIndex = findToolTraceIndexForToolEvents(structuredEvents, segment);
          if (existingToolTraceIndex !== null) {
            const target = messages[existingToolTraceIndex];
            const prevTraces = Array.isArray(target.traces) ? [...target.traces] : [target.content].filter(Boolean).map(String);
            const [mergedTraces] = structured.length
              ? mergeUniqueToolTraceLines(prevTraces, structured)
              : [[...prevTraces, ...traceLines], true] as [string[], boolean];
            messages[existingToolTraceIndex] = {
              ...target,
              traces: mergedTraces,
              content: mergedTraces.at(-1) ?? "",
              toolEvents: mergeToolEvents(target.toolEvents, structuredEvents),
              activitySegmentId: target.activitySegmentId ?? segment,
            };
            activeActivitySegmentId = segment;
            continue;
          }
        }
        const last = messages.at(-1);
        if (
          last
          && last.kind === "trace"
          && !hasFileEdits(last)
          && !last.isStreaming
          && (last.activitySegmentId == null || last.activitySegmentId === segment)
        ) {
          const prevTraces = Array.isArray(last.traces) ? [...last.traces] : [last.content].filter(Boolean).map(String);
          let mergedTraces: string[];
          if (structured.length) {
            const [traces, added] = mergeUniqueToolTraceLines(prevTraces, structured);
            if (!added && !structuredEvents.length) continue;
            mergedTraces = traces;
          } else {
            mergedTraces = [...prevTraces, ...traceLines];
          }
          messages[messages.length - 1] = {
            ...last,
            traces: mergedTraces,
            content: mergedTraces.at(-1) ?? "",
            toolEvents: structuredEvents.length ? mergeToolEvents(last.toolEvents, structuredEvents) : last.toolEvents,
            activitySegmentId: last.activitySegmentId ?? segment,
          };
          activeActivitySegmentId = segment;
        } else {
          messages.push({
            id: newId("tr", idx),
            role: "tool",
            kind: "trace",
            content: traceLines.at(-1) ?? "",
            traces: traceLines,
            ...(structuredEvents.length ? { toolEvents: structuredEvents } : {}),
            activitySegmentId: segment,
            ...createdAtPatch(rec),
          });
          activeActivitySegmentId = segment;
        }
        continue;
      }

      const content = typeof rec.text === "string" ? rec.text : "";
      const media = normalizeAssistantMediaAttachments(rec, augmentAssistantMedia);
      const hasAssistantPayload = Boolean(content.trim() || media.length);
      const extra: Dict = { content };
      if (media.length) extra.media = media;
      if (typeof rec.latency_ms === "number" && rec.latency_ms >= 0) extra.latencyMs = Math.trunc(rec.latency_ms);
      if (isCronProactiveRecord(rec)) {
        if (!hasAssistantPayload) continue;
        closedAnswerMessageId = null;
        bufferMessageId = null;
        bufferParts = [];
        absorbComplete(extra, rec, idx);
        continue;
      }
      const targetMessageId = bufferMessageId ?? closedAnswerMessageId;
      if (absorbCompleteIntoMessage(targetMessageId, extra)) {
        closedAnswerMessageId = targetMessageId;
        bufferMessageId = null;
        bufferParts = [];
        if (media.length) suppressUntilTurnEnd = true;
        continue;
      }
      closedAnswerMessageId = null;
      bufferMessageId = null;
      bufferParts = [];
      if (!hasAssistantPayload) continue;
      absorbComplete(extra, rec, idx);
      if (media.length) suppressUntilTurnEnd = true;
      continue;
    }

    if (ev === "turn_end") {
      suppressUntilTurnEnd = false;
      activeActivitySegmentId = null;
      activeFileEditSegmentId = null;
      messages = messages.map(finishActivityProgressForTurnEnd);
      pruneReasoningOnly();
      if (typeof rec.latency_ms === "number" && rec.latency_ms >= 0) stampLatency(Math.trunc(rec.latency_ms));
      closedAnswerMessageId = null;
      bufferMessageId = null;
      bufferParts = [];
    }
  }

  return messages.map((message) => {
    let out = { ...message };
    if (augmentAssistantText && out.role === "assistant" && out.kind !== "trace" && typeof out.content === "string") {
      out = { ...out, content: augmentAssistantText(out.content) };
    }
    if (out.kind !== "context_compaction") delete out.isStreaming;
    delete out.reasoningStreaming;
    return out;
  });
}

export function lastTranscriptUserTurnClosed(lines: Dict[]): boolean {
  let sawUser = false;
  let closed = false;
  for (const rec of lines) {
    if (rec.event === "user") {
      sawUser = true;
      closed = false;
      continue;
    }
    if (sawUser && rec.event === "turn_end") {
      closed = true;
    }
  }
  return sawUser && closed;
}

function sessionMessageText(message: Dict): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .flatMap((block) => isDict(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [])
    .join("\n");
}

function sessionMessagesToTranscriptLines(messages: Dict[]): Dict[] {
  const lines: Dict[] = [];
  for (const message of messages) {
    if (!isDict(message) || (message.role !== "user" && message.role !== "assistant")) continue;
    if (
      message.role === "assistant"
      && (message.injectedEvent || (Array.isArray(message.tool_calls) && message.tool_calls.length))
    ) continue;
    const text = sessionMessageText(message);
    const media = Array.isArray(message.media)
      ? message.media.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      : [];
    if (!text.trim() && !media.length) continue;

    if (message.role === "user") {
      lines.push({
        event: "user",
        text,
        ...(media.length ? { media_paths: media } : {}),
        ...createdAtPatch(message),
      });
      continue;
    }

    lines.push({
      event: "message",
      text,
      ...(media.length ? { media } : {}),
      ...(typeof message.latency_ms === "number" ? { latency_ms: message.latency_ms } : {}),
      ...createdAtPatch(message),
    });
    lines.push({ event: "turn_end" });
  }
  return lines;
}

export function buildWebuiThreadResponse(sessionKey: string, messages: any[]): Dict;
export function buildWebuiThreadResponse(sessionKey: string, options?: BuildWebuiThreadResponseOptions | null): Dict | null;
export function buildWebuiThreadResponse(sessionKey: string, messagesOrOptions: any[] | BuildWebuiThreadResponseOptions | null = null): Dict | null {
  if (Array.isArray(messagesOrOptions)) return { id: sessionKey, messages: messagesOrOptions };
  const options = messagesOrOptions ?? {};
  const transcriptLines = readTranscriptLines(sessionKey);
  const lines = transcriptLines.length
    ? transcriptLines
    : sessionMessagesToTranscriptLines(options.sessionMessages ?? []);
  if (!lines.length) return null;
  return {
    schemaVersion: WEBUI_TRANSCRIPT_SCHEMA_VERSION,
    sessionKey,
    last_turn_closed: lastTranscriptUserTurnClosed(lines),
    messages: replayTranscriptToUiMessages(lines, options),
  };
}
