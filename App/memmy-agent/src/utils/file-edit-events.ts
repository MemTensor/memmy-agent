import fs from "node:fs";
import path from "node:path";

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
  tool: string;
  path: string;
  displayPath: string;
  before: FileSnapshot;

  constructor({
    callId,
    tool,
    path: filePath,
    displayPath,
    before,
  }: {
    callId?: string;
    tool: string;
    path: string;
    displayPath?: string;
    before: FileSnapshot;
  }) {
    this.callId = callId ?? "";
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

export function readFileSnapshot(filePath: string, { maxBytes = MAX_SNAPSHOT_BYTES }: { maxBytes?: number } = {}): FileSnapshot {
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
      return new FileSnapshot({ path: resolved, exists: true, text: raw.toString("utf8").replace(/\r\n/g, "\n") });
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

function resolveRawFileEditPath(tool: any, workspace: string | null | undefined, raw: string): string | null {
  return resolveWithTool(tool, workspace, raw);
}

function resolveApplyPatchPaths(tool: any, workspace: string | null | undefined, params?: Record<string, any> | null): string[] {
  if (!params || !Array.isArray(params.edits) || params.dryRun === true) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const edit of params.edits) {
    if (!edit || typeof edit !== "object" || typeof edit.path !== "string" || !edit.path.trim()) continue;
    const resolved = resolveRawFileEditPath(tool, workspace, edit.path);
    if (resolved && !seen.has(resolved)) {
      seen.add(resolved);
      out.push(resolved);
    }
  }
  return out;
}

export function prepareFileEditTrackers({
  callId = "",
  toolName,
  tool,
  workspace,
  params,
}: {
  callId?: string;
  toolName?: string;
  tool: any;
  workspace?: string | null;
  params?: Record<string, any> | null;
}): FileEditTracker[] {
  const name = toolName ?? "";
  if (!isFileEditTool(name)) return [];
  const seen = new Set<string>();
  return resolveFileEditPaths(name, tool, workspace, params)
    .filter((filePath) => {
      const resolved = path.resolve(filePath);
      if (seen.has(resolved)) return false;
      seen.add(resolved);
      return true;
    })
    .map((filePath) => new FileEditTracker({
      callId,
      tool: name,
      path: path.resolve(filePath),
      displayPath: displayFileEditPath(filePath, workspace),
      before: readFileSnapshot(filePath),
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

export function buildFileEditEndEvent(tracker: FileEditTracker, params?: Record<string, any> | null): Record<string, any> {
  const after = readFileSnapshot(tracker.path);
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
  toolName,
  added = 0,
  deleted = 0,
}: {
  callId?: string;
  toolName?: string;
  added?: number;
  deleted?: number;
}): Record<string, any> {
  return {
    version: 1,
    call_id: String(callId ?? ""),
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
  toolName,
  error = "Task cancelled.",
}: {
  callId?: string;
  toolName?: string;
  error?: string | null;
}): Record<string, any> {
  const payload: Record<string, any> = {
    version: 1,
    call_id: String(callId ?? ""),
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
  const callId = String(event.call_id ?? "");
  const pathKey = String(event.absolute_path ?? event.path ?? "");
  if (event.pending === true) return `pending:${callId}:${event.tool ?? ""}`;
  return `file:${callId}:${pathKey}`;
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

function jsonBoolTrue(source: string, key: string): boolean {
  return new RegExp(`"${key}"\\s*:\\s*true\\b`).test(source);
}

function pathMatches(source: string): Array<{ rawPath: string; start: number; end: number }> {
  const matches = [...source.matchAll(/"path"\s*:\s*"([^"]+)"/g)].map((m) => ({ rawPath: m[1], start: m.index ?? 0, end: 0 }));
  return matches.map((item, idx) => ({ ...item, end: matches[idx + 1]?.start ?? source.length }));
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
  callId = "";
  name = "";
  arguments = "";
  path: string | null = null;
  tracker: FileEditTracker | null = null;
  content = new StreamingJsonStringField("content");
  oldTextField = new StreamingJsonStringField("old_text");
  newTextField = new StreamingJsonStringField("new_text");
  patchFiles = new Map<string, StreamingPatchFileState>();
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
    if (typeof payload.call_id === "string" && payload.call_id) this.callId = payload.call_id;
    if (typeof payload.callId === "string" && payload.callId) this.callId = payload.callId;
    if (typeof payload.name === "string" && payload.name) this.name = payload.name;
    if (typeof payload.arguments === "string") {
      this.arguments = payload.arguments;
      this.content.reset();
      this.oldTextField.reset();
      this.newTextField.reset();
      this.patchFiles.clear();
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

  canonicalCallId(): string {
    return this.callId || this.tracker?.callId || this.key;
  }

  matchesFinalToolCall(toolCall: any): boolean {
    const canonical = this.canonicalCallId();
    if (toolCall?.id && canonical && toolCall.id === canonical) return true;
    if (toolCall?.name !== this.name) return false;
    if (this.name === "apply_patch") return Array.isArray(toolCall?.arguments?.edits) && this.arguments.includes('"edits"');
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
        await this.emit([buildFileEditPendingEvent({ callId: state.callId || state.key, toolName: state.name, added, deleted })]);
      }
      return;
    }
    if (!state.tracker) {
      const tool = typeof this.tools?.get === "function" ? this.tools.get(state.name) : undefined;
      state.tracker = prepareFileEditTracker({
        callId: state.callId || state.key,
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
    if (jsonBoolTrue(state.arguments, "dryRun")) return;
    const tool = typeof this.tools?.get === "function" ? this.tools.get("apply_patch") : undefined;
    const events: Record<string, any>[] = [];
    const now = Date.now();
    for (const match of pathMatches(state.arguments)) {
      const segment = state.arguments.slice(match.start, match.end);
      const action = /"action"\s*:\s*"(replace|add|delete)"/.exec(segment)?.[1] ?? "replace";
      const oldText = extractJsonStringPrefix(segment, "oldText") ?? "";
      const newText = extractJsonStringPrefix(segment, "newText") ?? "";
      let added = ["replace", "add"].includes(action) ? textLineCount(newText) : 0;
      let deleted = ["replace", "delete"].includes(action) ? textLineCount(oldText) : 0;
      let fileState = state.patchFiles.get(match.rawPath);
      if (!fileState) {
        const filePath = resolveRawFileEditPath(tool, this.workspace, match.rawPath);
        if (!filePath) continue;
        fileState = new StreamingPatchFileState(new FileEditTracker({
          callId: state.callId || state.key,
          tool: "apply_patch",
          path: filePath,
          displayPath: displayFileEditPath(filePath, this.workspace),
          before: readFileSnapshot(filePath),
        }));
        state.patchFiles.set(match.rawPath, fileState);
      }
      if (action === "delete" && added === 0 && deleted === 0 && fileState.tracker.before.countable) deleted = textLineCount(fileState.tracker.before.text ?? "");
      if (fileState.shouldEmit(added, deleted, now)) {
        fileState.markEmitted(added, deleted, now);
        events.push(buildFileEditLiveEvent(fileState.tracker, { added, deleted }));
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
            callId: state.callId || state.key,
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

  applyFinalCallIds(finalToolCalls: any[]): void {
    const used = new Set<string>();
    for (const toolCall of finalToolCalls) {
      const canonical = this.canonicalCallIdFor(toolCall);
      if (canonical && !used.has(canonical)) {
        toolCall.id = canonical;
        used.add(canonical);
      }
    }
  }

  canonicalCallIdFor(toolCall: any): string | null {
    for (const state of this.states.values()) {
      if (state.matchesFinalToolCall(toolCall)) return state.canonicalCallId();
    }
    return null;
  }

  async errorUnmatched(finalToolCalls: any[], error: string): Promise<void> {
    if (this.closed) return;
    const events: Record<string, any>[] = [];
    for (const state of this.states.values()) {
      const matched = finalToolCalls.some((call) => state.matchesFinalToolCall(call));
      if (matched) continue;
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
          callId: state.callId || state.key,
          toolName: state.name,
          error,
        }));
      }
    }
    if (events.length) await this.emit(events);
  }
}
