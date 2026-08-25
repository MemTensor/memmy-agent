import fs from "node:fs";
import path from "node:path";
import { scanPatchEnvelopePrefix } from "../core/agent-runtime/tools/patch-envelope.js";
import {
  bindUiToolCallId,
  createUiToolCallId,
  getOrCreateUiToolCallId,
} from "./progress-events.js";

export type FileEditEvent = { path: string; action?: string; [key: string]: any };

export const TRACKED_FILE_EDIT_TOOLS = new Set(["write_file", "edit_file", "apply_patch"]);
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const LIVE_EMIT_INTERVAL_MS = 180;
const LIVE_EMIT_LINE_STEP = 24;

export function fileEditEvent(filePath: string, action: string): FileEditEvent {
  return { path: filePath, action };
}

export class FileSnapshot {
  path: string;
  exists: boolean;
  text: string | null;
  unreadable: boolean;
  binary: boolean;
  oversized: boolean;

  constructor({
    path: filePath,
    exists,
    text,
    unreadable = false,
    binary = false,
    oversized = false,
  }: {
    path: string;
    exists: boolean;
    text: string | null;
    unreadable?: boolean;
    binary?: boolean;
    oversized?: boolean;
  }) {
    this.path = filePath;
    this.exists = exists;
    this.text = text;
    this.unreadable = unreadable;
    this.binary = binary;
    this.oversized = oversized;
  }

  get countable(): boolean {
    return this.text != null && !this.binary && !this.oversized && !this.unreadable;
  }
}

export class FileEditTracker {
  callId: string;
  uiToolCallId: string;
  tool: string;
  path: string;
  displayPath: string;
  before: FileSnapshot;

  constructor({
    callId,
    uiToolCallId,
    tool,
    path: filePath,
    displayPath,
    before,
  }: {
    callId?: string;
    uiToolCallId?: string;
    tool: string;
    path: string;
    displayPath?: string;
    before: FileSnapshot;
  }) {
    this.callId = callId ?? "";
    this.uiToolCallId = uiToolCallId ?? createUiToolCallId();
    this.tool = tool;
    this.path = filePath;
    this.displayPath = displayPath ?? filePath;
    this.before = before;
  }
}

function workspacePath(workspace: string | null | undefined, raw: string): string {
  return workspace ? path.resolve(workspace, raw) : path.resolve(raw);
}

function resolveWithTool(tool: any, workspace: string | null | undefined, raw: string): string | null {
  const resolver = tool?.resolve;
  if (typeof resolver === "function") {
    try {
      const resolved = resolver.call(tool, raw);
      if (resolved) return path.resolve(String(resolved));
    } catch {
      return null;
    }
  }
  return workspacePath(workspace, raw);
}

export function isFileEditTool(toolName?: string | null): boolean {
  return Boolean(toolName && TRACKED_FILE_EDIT_TOOLS.has(toolName));
}

export function resolveFileEditPath(tool: any, workspace: string | null | undefined, params?: Record<string, any> | null): string | null {
  if (!params || typeof params !== "object") return null;
  const raw = params.path;
  if (typeof raw !== "string" || !raw.trim()) return null;
  return resolveWithTool(tool, workspace, raw);
}

export function displayFileEditPath(filePath: string, workspace?: string | null): string {
  if (workspace) {
    const rel = path.relative(path.resolve(workspace), path.resolve(filePath));
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel.split(path.sep).join("/");
    if (!rel) return ".";
  }
  return path.resolve(filePath).split(path.sep).join("/");
}

export function readFileSnapshot(
  filePath: string,
  {
    maxBytes = MAX_SNAPSHOT_BYTES,
    fatalUtf8 = false,
  }: { maxBytes?: number; fatalUtf8?: boolean } = {},
): FileSnapshot {
  const resolved = path.resolve(filePath);
  try {
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return new FileSnapshot({ path: resolved, exists: false, text: "" });
    }
    const stat = fs.statSync(resolved);
    if (stat.size > maxBytes) return new FileSnapshot({ path: resolved, exists: true, text: null, oversized: true });
    const raw = fs.readFileSync(resolved);
    if (raw.includes(0)) return new FileSnapshot({ path: resolved, exists: true, text: null, binary: true });
    try {
      const text = fatalUtf8
        ? new TextDecoder("utf-8", { fatal: true }).decode(raw)
        : raw.toString("utf8");
      return new FileSnapshot({ path: resolved, exists: true, text: text.replace(/\r\n/g, "\n") });
    } catch {
      return new FileSnapshot({ path: resolved, exists: true, text: null, binary: true });
    }
  } catch {
    return new FileSnapshot({ path: resolved, exists: fs.existsSync(resolved), text: null, unreadable: true });
  }
}

export function textLineCount(text: string): number {
  if (!text) return 0;
  let lineCount = 0;
  let lastWasNewline = false;
  let lastWasCr = false;
  for (const ch of text) {
    if (ch === "\r") {
      lineCount += 1;
      lastWasNewline = true;
      lastWasCr = true;
    } else if (ch === "\n") {
      if (!lastWasCr) lineCount += 1;
      lastWasNewline = true;
      lastWasCr = false;
    } else {
      lastWasNewline = false;
      lastWasCr = false;
    }
  }
  return lastWasNewline ? lineCount : lineCount + 1;
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split(/\n/).filter((line, idx, arr) => idx < arr.length - 1 || line !== "");
}

export function lineDiffStats(before?: string | null, after?: string | null): [number, number] {
  if (before == null || after == null) return [0, 0];
  if (before === after) return [0, 0];
  if (before === "") return [textLineCount(after), 0];
  const a = splitLines(before);
  const b = splitLines(after);
  const dp = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const lcs = dp[0][0];
  return [Math.max(0, b.length - lcs), Math.max(0, a.length - lcs)];
}

export function resolveFileEditPaths(toolName: string, tool: any, workspace: string | null | undefined, params?: Record<string, any> | null): string[] {
  if (toolName === "apply_patch") return resolveApplyPatchPaths(tool, workspace, params);
  const filePath = resolveFileEditPath(tool, workspace, params);
  return filePath ? [filePath] : [];
}

function resolveApplyPatchPaths(tool: any, _workspace: string | null | undefined, params?: Record<string, any> | null): string[] {
  if (!params || typeof params.input !== "string" || typeof tool?.resolve !== "function") return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const file of scanPatchEnvelopePrefix(`${params.input}\n`)) {
    for (const relativePath of [file.path, file.moveTo]) {
      if (!relativePath) continue;
      let resolved: string;
      try {
        resolved = path.resolve(tool.resolve(relativePath));
      } catch {
        continue;
      }
      const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(resolved);
      }
    }
  }
  return out;
}

export function prepareFileEditTrackers({
  callId = "",
  uiToolCallId,
  toolName,
  tool,
  workspace,
  params,
}: {
  callId?: string;
  uiToolCallId?: string;
  toolName?: string;
  tool: any;
  workspace?: string | null;
  params?: Record<string, any> | null;
}): FileEditTracker[] {
  const name = toolName ?? "";
  if (!isFileEditTool(name)) return [];
  const resolvedUiToolCallId = uiToolCallId ?? createUiToolCallId();
  const seen = new Set<string>();
  return resolveFileEditPaths(name, tool, workspace, params)
    .filter((filePath) => {
      const resolved = path.resolve(filePath);
      const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((filePath) => new FileEditTracker({
      callId,
      uiToolCallId: resolvedUiToolCallId,
      tool: name,
      path: path.resolve(filePath),
      displayPath: displayFileEditPath(filePath, workspace),
      before: readFileSnapshot(filePath, { fatalUtf8: name === "apply_patch" }),
    }));
}

export function prepareFileEditTracker(args: Parameters<typeof prepareFileEditTrackers>[0]): FileEditTracker | null {
  return prepareFileEditTrackers(args)[0] ?? null;
}

function eventPayload(
  tracker: FileEditTracker,
  { phase, status, added, deleted, approximate, binary = false }: { phase: string; status: string; added: number; deleted: number; approximate: boolean; binary?: boolean },
): Record<string, any> {
  const payload: Record<string, any> = {
    version: 1,
    call_id: tracker.callId,
    ui_tool_call_id: tracker.uiToolCallId,
    tool: tracker.tool,
    path: tracker.displayPath,
    absolute_path: path.resolve(tracker.path).split(path.sep).join("/"),
    phase,
    added: Math.max(0, Math.trunc(added)),
    deleted: Math.max(0, Math.trunc(deleted)),
    approximate,
    status,
  };
  if (binary) payload.binary = true;
  return payload;
}

function predictAfterText(toolName: string, params: Record<string, any>, before: FileSnapshot): string | null {
  if (!before.countable) return null;
  const beforeText = before.text ?? "";
  if (toolName === "write_file") return typeof params.content === "string" ? params.content : "";
  if (toolName === "edit_file") {
    const oldText = params.old_text ?? params.oldText;
    const newText = params.new_text ?? params.newText;
    if (typeof oldText !== "string" || typeof newText !== "string") return null;
    if (oldText === "") return before.exists ? beforeText : newText;
    if (!beforeText.includes(oldText)) return null;
    return params.replace_all ?? params.replaceAll ? beforeText.split(oldText).join(newText) : beforeText.replace(oldText, newText);
  }
  return null;
}

export function buildFileEditStartEvent(tracker: FileEditTracker, params?: Record<string, any> | null): Record<string, any> {
  const predicted = predictAfterText(tracker.tool, params ?? {}, tracker.before);
  const [added, deleted] = tracker.before.countable && predicted != null ? lineDiffStats(tracker.before.text, predicted) : [0, 0];
  return eventPayload(tracker, { phase: "start", status: "editing", added, deleted, approximate: true });
}

export function buildFileEditEndEvent(
  tracker: FileEditTracker,
  params?: Record<string, any> | null,
  outcome?: { changed: boolean } | null,
): Record<string, any> {
  if (outcome?.changed === false) {
    return {
      ...eventPayload(tracker, {
        phase: "end",
        status: "done",
        added: 0,
        deleted: 0,
        approximate: false,
      }),
      unchanged: true,
    };
  }
  const after = readFileSnapshot(tracker.path, { fatalUtf8: tracker.tool === "apply_patch" });
  let counted = false;
  let added = 0;
  let deleted = 0;
  if (tracker.before.countable && after.countable) {
    [added, deleted] = lineDiffStats(tracker.before.text, after.text);
    counted = true;
  } else {
    const predicted = predictAfterText(tracker.tool, params ?? {}, tracker.before);
    if (tracker.before.countable && predicted != null) {
      [added, deleted] = lineDiffStats(tracker.before.text, predicted);
      counted = true;
    }
  }
  return eventPayload(tracker, {
    phase: "end",
    status: "done",
    added,
    deleted,
    approximate: false,
    binary: (after.binary || after.oversized || after.unreadable) && !counted,
  });
}

export function buildFileEditErrorEvent(tracker: FileEditTracker, error?: string | null): Record<string, any> {
  const payload = eventPayload(tracker, { phase: "error", status: "error", added: 0, deleted: 0, approximate: false });
  if (error) payload.error = error.trim().slice(0, 240);
  return payload;
}

export function buildFileEditLiveEvent(tracker: FileEditTracker, { added, deleted = 0 }: { added: number; deleted?: number }): Record<string, any> {
  return eventPayload(tracker, { phase: "start", status: "editing", added, deleted, approximate: true });
}

export function buildFileEditPendingEvent({
  callId,
  uiToolCallId,
  toolName,
  added = 0,
  deleted = 0,
}: {
  callId?: string;
  uiToolCallId: string;
  toolName?: string;
  added?: number;
  deleted?: number;
}): Record<string, any> {
  return {
    version: 1,
    call_id: String(callId ?? ""),
    ui_tool_call_id: uiToolCallId,
    tool: toolName ?? "",
    path: "",
    phase: "start",
    added: Math.max(0, Math.trunc(added)),
    deleted: Math.max(0, Math.trunc(deleted)),
    approximate: true,
    status: "editing",
    pending: true,
  };
}

export function buildFileEditPendingErrorEvent({
  callId,
  uiToolCallId,
  toolName,
  error = "Task cancelled.",
}: {
  callId?: string;
  uiToolCallId: string;
  toolName?: string;
  error?: string | null;
}): Record<string, any> {
  const payload: Record<string, any> = {
    version: 1,
    call_id: String(callId ?? ""),
    ui_tool_call_id: uiToolCallId,
    tool: toolName ?? "",
    path: "",
    phase: "error",
    added: 0,
    deleted: 0,
    approximate: false,
    status: "error",
    pending: true,
    cancellation_terminal: true,
  };
  if (error) payload.error = error.trim().slice(0, 240);
  return payload;
}

function withCancellationTerminal(event: Record<string, any>): Record<string, any> {
  return { ...event, cancellation_terminal: true };
}

function terminalEventKey(event: Record<string, any>): string {
  const uiToolCallId = String(event.ui_tool_call_id ?? "");
  const callId = String(event.call_id ?? "");
  const pathKey = String(event.absolute_path ?? event.path ?? "");
  const identity = uiToolCallId || callId;
  if (event.pending === true) return `pending:${identity}:${event.tool ?? ""}`;
  return `file:${identity}:${pathKey}`;
}

function streamKey(payload: Record<string, any>): string {
  if (payload.index != null) return `idx:${payload.index}`;
  if (typeof payload.call_id === "string" && payload.call_id) return `id:${payload.call_id}`;
  if (typeof payload.callId === "string" && payload.callId) return `id:${payload.callId}`;
  return "";
}

function extractJsonStringPrefix(source: string, key: string, requireClosed = false): string | null {
  const re = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*"`);
  const match = re.exec(source);
  if (!match) return null;
  const out: string[] = [];
  let escape = false;
  for (let i = match.index + match[0].length; i < source.length; i += 1) {
    const ch = source[i];
    if (escape) {
      escape = false;
      if (ch === "n") out.push("\n");
      else if (ch === "r") out.push("\r");
      else if (ch === "t") out.push("\t");
      else if (ch === "u") {
        const digits = source.slice(i + 1, i + 5);
        if (digits.length < 4) {
          if (requireClosed) return null;
          break;
        }
        const code = Number.parseInt(digits, 16);
        if (!Number.isNaN(code)) out.push(String.fromCharCode(code));
        i += 4;
      } else out.push(ch);
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') return out.join("");
    out.push(ch);
  }
  return requireClosed ? null : out.join("");
}

export function extractCompleteJsonString(source: string, key: string): string | null {
  return extractJsonStringPrefix(source, key, true);
}

class StreamingPatchFileState {
  tracker: FileEditTracker;
  emittedOnce = false;
  lastEmittedAdded = -1;
  lastEmittedDeleted = -1;
  lastEmitAt = 0;
  lastAdded = 0;
  lastDeleted = 0;

  constructor(tracker: FileEditTracker) {
    this.tracker = tracker;
  }

  shouldEmit(added: number, deleted: number, now: number): boolean {
    this.lastAdded = added;
    this.lastDeleted = deleted;
    if (!this.emittedOnce) return true;
    if (added === this.lastEmittedAdded && deleted === this.lastEmittedDeleted) return false;
    if (Math.max(Math.abs(added - this.lastEmittedAdded), Math.abs(deleted - this.lastEmittedDeleted)) >= LIVE_EMIT_LINE_STEP) return true;
    return now - this.lastEmitAt >= LIVE_EMIT_INTERVAL_MS;
  }

  markEmitted(added: number, deleted: number, now: number): void {
    this.emittedOnce = true;
    this.lastAdded = this.lastEmittedAdded = added;
    this.lastDeleted = this.lastEmittedDeleted = deleted;
    this.lastEmitAt = now;
  }
}

export class StreamingJsonStringField {
  key: string;
  scanPos: number | null = null;
  closed = false;
  escape = false;
  unicodeRemaining = 0;
  unicodeBuffer = "";
  newlineCount = 0;
  hasChars = false;
  lastCharNewline = false;
  lastCharCr = false;

  constructor(key: string) {
    this.key = key;
  }

  get lineCount(): number {
    if (!this.hasChars) return 0;
    return this.newlineCount + (this.lastCharNewline ? 0 : 1);
  }

  reset(): void {
    this.scanPos = null;
    this.closed = false;
    this.escape = false;
    this.unicodeRemaining = 0;
    this.unicodeBuffer = "";
    this.newlineCount = 0;
    this.hasChars = false;
    this.lastCharNewline = false;
    this.lastCharCr = false;
  }

  scan(source: string): void {
    if (this.closed) return;
    if (this.scanPos == null) {
      const re = new RegExp(`"${this.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*"`);
      const match = re.exec(source);
      if (!match) return;
      this.scanPos = match.index + match[0].length;
    }
    let i = this.scanPos;
    while (i < source.length) {
      const ch = source[i];
      if (this.unicodeRemaining > 0) {
        this.unicodeBuffer += ch;
        this.unicodeRemaining -= 1;
        if (this.unicodeRemaining === 0) {
          const code = Number.parseInt(this.unicodeBuffer, 16);
          this.unicodeBuffer = "";
          this.markChar(Number.isNaN(code) ? "x" : String.fromCharCode(code));
        }
        i += 1;
        continue;
      }
      if (this.escape) {
        this.escape = false;
        if (ch === "u") {
          this.unicodeRemaining = 4;
          this.unicodeBuffer = "";
        } else if (ch === "n") this.markChar("\n");
        else if (ch === "r") this.markChar("\r");
        else if (ch === "t") this.markChar("\t");
        else this.markChar(ch);
        i += 1;
        continue;
      }
      if (ch === "\\") {
        this.escape = true;
        i += 1;
        continue;
      }
      if (ch === '"') {
        this.closed = true;
        i += 1;
        break;
      }
      this.markChar(ch);
      i += 1;
    }
    this.scanPos = i;
  }

  markChar(ch: string): void {
    this.hasChars = true;
    if (ch === "\r") {
      this.newlineCount += 1;
      this.lastCharNewline = true;
      this.lastCharCr = true;
    } else if (ch === "\n") {
      if (!this.lastCharCr) {
        this.newlineCount += 1;
      }
      this.lastCharNewline = true;
      this.lastCharCr = false;
    } else {
      this.lastCharNewline = false;
      this.lastCharCr = false;
    }
  }
}

export class StreamingFileEditState {
  key: string;
  index: number | null = null;
  callId = "";
  uiToolCallId = createUiToolCallId();
  name = "";
  arguments = "";
  path: string | null = null;
  tracker: FileEditTracker | null = null;
  content = new StreamingJsonStringField("content");
  oldTextField = new StreamingJsonStringField("old_text");
  newTextField = new StreamingJsonStringField("new_text");
  patchFiles = new Map<string, StreamingPatchFileState>();
  inputPrefix = "";
  inputClosed = false;
  boundFinal = false;
  emittedOnce = false;
  lastEmittedAdded = -1;
  lastEmittedDeleted = -1;
  lastEmitAt = 0;
  pendingEmitted = false;
  lastPendingAdded = -1;
  lastPendingDeleted = -1;
  lastPendingAt = 0;

  constructor(key: string) {
    this.key = key;
  }

  applyDelta(payload: Record<string, any>): void {
    if (Number.isInteger(payload.index) && payload.index >= 0) this.index = payload.index;
    if (typeof payload.call_id === "string" && payload.call_id) this.callId = payload.call_id;
    if (typeof payload.callId === "string" && payload.callId) this.callId = payload.callId;
    if (typeof payload.name === "string" && payload.name) this.name = payload.name;
    if (typeof payload.arguments === "string") {
      this.arguments = payload.arguments;
      this.content.reset();
      this.oldTextField.reset();
      this.newTextField.reset();
      this.patchFiles.clear();
      this.inputPrefix = "";
      this.inputClosed = false;
      return;
    }
    const delta = payload.arguments_delta ?? payload.argumentsDelta;
    if (typeof delta === "string") this.arguments += delta;
  }

  liveDiffCounts(): [number, number] {
    if (this.name === "write_file") {
      this.content.scan(this.arguments);
      return [this.content.lineCount, 0];
    }
    if (this.name === "edit_file") {
      this.oldTextField.scan(this.arguments);
      this.newTextField.scan(this.arguments);
      return [this.newTextField.lineCount, this.oldTextField.lineCount];
    }
    return [0, 0];
  }

  shouldEmit(added: number, deleted: number, now: number): boolean {
    if (!this.emittedOnce) return true;
    if (added === this.lastEmittedAdded && deleted === this.lastEmittedDeleted) return false;
    if (Math.max(Math.abs(added - this.lastEmittedAdded), Math.abs(deleted - this.lastEmittedDeleted)) >= LIVE_EMIT_LINE_STEP) return true;
    return now - this.lastEmitAt >= LIVE_EMIT_INTERVAL_MS;
  }

  markEmitted(added: number, deleted: number, now: number): void {
    this.emittedOnce = true;
    this.lastEmittedAdded = added;
    this.lastEmittedDeleted = deleted;
    this.lastEmitAt = now;
  }

  shouldEmitPending(added: number, deleted: number, now: number): boolean {
    if (!this.pendingEmitted) return true;
    if (added === this.lastPendingAdded && deleted === this.lastPendingDeleted) return false;
    if (Math.max(Math.abs(added - this.lastPendingAdded), Math.abs(deleted - this.lastPendingDeleted)) >= LIVE_EMIT_LINE_STEP) return true;
    return now - this.lastPendingAt >= LIVE_EMIT_INTERVAL_MS;
  }

  markPendingEmitted(added: number, deleted: number, now: number): void {
    this.pendingEmitted = true;
    this.lastPendingAdded = added;
    this.lastPendingDeleted = deleted;
    this.lastPendingAt = now;
  }

  matchesFinalToolCall(toolCall: any): boolean {
    if (toolCall?.id && this.callId && toolCall.id === this.callId) return true;
    if (toolCall?.name !== this.name) return false;
    if (this.name === "apply_patch") {
      return typeof toolCall?.arguments?.input === "string" && toolCall.arguments.input === this.inputPrefix;
    }
    const finalPath = toolCall?.arguments?.path;
    if (this.path == null && typeof finalPath === "string") {
      this.path = finalPath;
      return true;
    }
    return typeof finalPath === "string" && finalPath === this.path;
  }
}

export class StreamingFileEditTracker {
  workspace: string | null;
  tools: any;
  emit: (events: Record<string, any>[]) => Promise<void> | void;
  states = new Map<string, StreamingFileEditState>();
  private closed = false;
  private terminalKeys = new Set<string>();

  constructor({
    workspace = null,
    tools = {},
    emit,
  }: {
    workspace?: string | null;
    tools?: any;
    emit: (events: Record<string, any>[]) => Promise<void> | void;
  }) {
    this.workspace = workspace;
    this.tools = tools;
    this.emit = emit;
  }

  async update(payload: Record<string, any>): Promise<void> {
    if (this.closed) return;
    const key = streamKey(payload);
    if (!key) return;
    let state = this.states.get(key);
    if (!state) {
      state = new StreamingFileEditState(key);
      this.states.set(key, state);
    }
    state.applyDelta(payload);
    if (state.name === "apply_patch") return this.updateApplyPatch(state);
    if (!["write_file", "edit_file"].includes(state.name)) return;
    if (state.path == null) state.path = extractJsonStringPrefix(state.arguments, "path", true);
    const [added, deleted] = state.liveDiffCounts();
    const now = Date.now();
    if (state.path == null) {
      if (state.shouldEmitPending(added, deleted, now)) {
        state.markPendingEmitted(added, deleted, now);
        await this.emit([buildFileEditPendingEvent({
          callId: state.callId,
          uiToolCallId: state.uiToolCallId,
          toolName: state.name,
          added,
          deleted,
        })]);
      }
      return;
    }
    if (!state.tracker) {
      const tool = typeof this.tools?.get === "function" ? this.tools.get(state.name) : undefined;
      state.tracker = prepareFileEditTracker({
        callId: state.callId,
        uiToolCallId: state.uiToolCallId,
        toolName: state.name,
        tool,
        workspace: this.workspace,
        params: { path: state.path },
      });
      if (!state.tracker) return;
    }
    if (state.shouldEmit(added, deleted, now)) {
      state.markEmitted(added, deleted, now);
      await this.emit([buildFileEditLiveEvent(state.tracker, { added, deleted })]);
    }
  }

  private async updateApplyPatch(state: StreamingFileEditState): Promise<void> {
    state.inputPrefix = extractJsonStringPrefix(state.arguments, "input") ?? "";
    state.inputClosed = extractCompleteJsonString(state.arguments, "input") != null;
    if (!state.inputPrefix) return;

    const tool = typeof this.tools?.get === "function" ? this.tools.get("apply_patch") : undefined;
    if (typeof tool?.resolve !== "function") return;
    const events: Record<string, any>[] = [];
    const now = Date.now();
    const getFileState = (relativePath: string): StreamingPatchFileState | null => {
      let filePath: string;
      try {
        filePath = path.resolve(tool.resolve(relativePath));
      } catch {
        return null;
      }
      const key = process.platform === "win32" ? filePath.toLowerCase() : filePath;
      let fileState = state.patchFiles.get(key);
      if (!fileState) {
        fileState = new StreamingPatchFileState(new FileEditTracker({
          callId: state.callId,
          uiToolCallId: state.uiToolCallId,
          tool: "apply_patch",
          path: filePath,
          displayPath: displayFileEditPath(filePath, this.workspace),
          before: readFileSnapshot(filePath, { fatalUtf8: true }),
        }));
        state.patchFiles.set(key, fileState);
      }
      return fileState;
    };
    const emitFile = (fileState: StreamingPatchFileState, added: number, deleted: number): void => {
      if (!fileState.shouldEmit(added, deleted, now)) return;
      fileState.markEmitted(added, deleted, now);
      events.push(buildFileEditLiveEvent(fileState.tracker, { added, deleted }));
    };

    for (const file of scanPatchEnvelopePrefix(state.inputPrefix)) {
      const sourceState = getFileState(file.path);
      if (!sourceState) continue;
      const beforeLines = sourceState.tracker.before.countable
        ? textLineCount(sourceState.tracker.before.text ?? "")
        : 0;
      if (file.moveTo) {
        emitFile(sourceState, 0, beforeLines);
        const targetState = getFileState(file.moveTo);
        if (targetState) emitFile(targetState, Math.max(0, beforeLines + file.added - file.deleted), 0);
      } else if (file.kind === "delete") {
        emitFile(sourceState, 0, beforeLines);
      } else {
        emitFile(sourceState, file.added, file.deleted);
      }
    }
    if (events.length) await this.emit(events);
  }

  async flush(): Promise<void> {
    if (this.closed) return;
    const events: Record<string, any>[] = [];
    const now = Date.now();
    for (const state of this.states.values()) {
      for (const fileState of state.patchFiles.values()) {
        if (!fileState.emittedOnce) continue;
        if (fileState.lastAdded === fileState.lastEmittedAdded && fileState.lastDeleted === fileState.lastEmittedDeleted) continue;
        fileState.markEmitted(fileState.lastAdded, fileState.lastDeleted, now);
        events.push(buildFileEditLiveEvent(fileState.tracker, { added: fileState.lastAdded, deleted: fileState.lastDeleted }));
      }
      if (!state.tracker) {
        if (state.path == null) state.path = extractJsonStringPrefix(state.arguments, "path", true);
        if (state.path != null) {
          state.tracker = prepareFileEditTracker({
            callId: state.callId,
            uiToolCallId: state.uiToolCallId,
            toolName: state.name,
            tool: undefined,
            workspace: this.workspace,
            params: { path: state.path },
          });
        }
      }
      if (!state.tracker) continue;
      const [added, deleted] = state.liveDiffCounts();
      if (state.emittedOnce && state.lastEmittedAdded === added && state.lastEmittedDeleted === deleted) continue;
      state.markEmitted(added, deleted, now);
      events.push(buildFileEditLiveEvent(state.tracker, { added, deleted }));
    }
    if (events.length) await this.emit(events);
  }

  bindFinalToolCalls(finalToolCalls: any[]): void {
    const states = [...this.states.values()];
    const boundStates = new Set<StreamingFileEditState>();
    const boundCalls = new Set<any>();

    const canBind = (state: StreamingFileEditState, toolCall: any): boolean => {
      if (state.name !== "apply_patch") return true;
      return toolCall?.name === "apply_patch" && typeof toolCall?.arguments?.input === "string";
    };
    const bind = (state: StreamingFileEditState, toolCall: any): boolean => {
      if (boundStates.has(state) || boundCalls.has(toolCall) || !canBind(state, toolCall)) return false;
      bindUiToolCallId(toolCall, state.uiToolCallId);
      boundStates.add(state);
      boundCalls.add(toolCall);
      state.boundFinal = true;
      return true;
    };

    for (const state of states) {
      if (state.index == null || state.index >= finalToolCalls.length) continue;
      bind(state, finalToolCalls[state.index]);
    }

    const stateIds = new Map<string, StreamingFileEditState[]>();
    const callIds = new Map<string, any[]>();
    for (const state of states) {
      if (!boundStates.has(state) && state.callId) {
        const matching = stateIds.get(state.callId) ?? [];
        matching.push(state);
        stateIds.set(state.callId, matching);
      }
    }
    for (const toolCall of finalToolCalls) {
      const callId = String(toolCall?.id ?? "");
      if (!boundCalls.has(toolCall) && callId) {
        const matching = callIds.get(callId) ?? [];
        matching.push(toolCall);
        callIds.set(callId, matching);
      }
    }
    for (const [callId, matchingStates] of stateIds) {
      const matchingCalls = callIds.get(callId) ?? [];
      if (matchingStates.length === 1 && matchingCalls.length === 1) {
        bind(matchingStates[0], matchingCalls[0]);
      }
    }

    const inputStates = new Map<string, StreamingFileEditState[]>();
    const inputCalls = new Map<string, any[]>();
    for (const state of states) {
      if (boundStates.has(state) || state.name !== "apply_patch" || !state.inputClosed) continue;
      const key = `apply_patch\0${state.inputPrefix}`;
      const matching = inputStates.get(key) ?? [];
      matching.push(state);
      inputStates.set(key, matching);
    }
    for (const toolCall of finalToolCalls) {
      const input = toolCall?.arguments?.input;
      if (boundCalls.has(toolCall) || toolCall?.name !== "apply_patch" || typeof input !== "string") continue;
      const key = `apply_patch\0${input}`;
      const matching = inputCalls.get(key) ?? [];
      matching.push(toolCall);
      inputCalls.set(key, matching);
    }
    for (const [key, matchingStates] of inputStates) {
      const matchingCalls = inputCalls.get(key) ?? [];
      if (matchingStates.length === 1 && matchingCalls.length === 1) {
        bind(matchingStates[0], matchingCalls[0]);
      }
    }

    const remainingStates = states.filter((state) => !boundStates.has(state));
    const remainingCalls = finalToolCalls.filter((toolCall) => !boundCalls.has(toolCall));
    for (const state of remainingStates) {
      const callIndex = remainingCalls.findIndex((toolCall) => !boundCalls.has(toolCall) && canBind(state, toolCall));
      if (callIndex >= 0) bind(state, remainingCalls[callIndex]);
    }
    for (const toolCall of finalToolCalls) getOrCreateUiToolCallId(toolCall);
  }

  async errorUnmatched(_finalToolCalls: any[], error: string): Promise<void> {
    if (this.closed) return;
    const events: Record<string, any>[] = [];
    for (const state of this.states.values()) {
      if (state.boundFinal) continue;
      for (const fileState of state.patchFiles.values()) events.push(buildFileEditErrorEvent(fileState.tracker, error));
      if (state.tracker) events.push(buildFileEditErrorEvent(state.tracker, error));
    }
    if (events.length) await this.emit(events);
  }

  close(): void {
    this.closed = true;
  }

  private pushTerminal(events: Record<string, any>[], event: Record<string, any>): void {
    const key = terminalEventKey(event);
    if (this.terminalKeys.has(key)) return;
    this.terminalKeys.add(key);
    events.push(event);
  }

  async abort(error = "Task cancelled."): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const events: Record<string, any>[] = [];
    for (const state of this.states.values()) {
      for (const fileState of state.patchFiles.values()) {
        if (!fileState.emittedOnce) continue;
        this.pushTerminal(events, withCancellationTerminal(buildFileEditErrorEvent(fileState.tracker, error)));
      }
      if (state.tracker && state.emittedOnce) {
        this.pushTerminal(events, withCancellationTerminal(buildFileEditErrorEvent(state.tracker, error)));
      }
      if (state.pendingEmitted) {
        this.pushTerminal(events, buildFileEditPendingErrorEvent({
          callId: state.callId,
          uiToolCallId: state.uiToolCallId,
          toolName: state.name,
          error,
        }));
      }
    }
    if (events.length) await this.emit(events);
  }
}
