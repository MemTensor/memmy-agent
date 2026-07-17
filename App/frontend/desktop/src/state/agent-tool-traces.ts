/**
 * memmy-agent WebUI tool trace helpers.
 *
 * The gateway can send structured tool progress frames as start/end/error
 * updates for the same call. These helpers keep the reducer logic small and
 * make live WebSocket events match the persisted /webui-thread shape.
 */

export interface AgentToolProgressEvent {
  version?: number;
  phase?: "start" | "end" | "error" | string;
  call_id?: string;
  name?: string;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
  files?: unknown[];
  embeds?: unknown[];
  function?: {
    name?: unknown;
    arguments?: unknown;
  };
  [key: string]: unknown;
}

export interface AgentFileEdit {
  version?: number;
  call_id: string;
  tool: string;
  path: string;
  absolute_path?: string;
  phase?: "start" | "end" | "error" | string;
  status?: "editing" | "done" | "error";
  added?: number;
  deleted?: number;
  approximate?: boolean;
  binary?: boolean;
  pending?: boolean;
  error?: string;
  [key: string]: unknown;
}

const VALID_PHASES = new Set(["start", "end", "error"]);
const PHASE_RANK: Record<string, number> = { start: 1, end: 2, error: 3 };

/**
 * Semantic categories used to pick an icon / visual treatment for a tool
 * call trace line. The renderer maps `category` → icon, so new categories
 * added here should also be handled in the trace row component.
 */
export type ToolTraceCategory =
  | "shell"
  | "read"
  | "grep"
  | "glob"
  | "list"
  | "edit"
  | "write"
  | "delete"
  | "search"
  | "web"
  | "browser"
  | "task"
  | "mcp"
  | "image"
  | "notebook"
  | "generic";

export interface ToolTraceSummary {
  /** Human friendly one-line summary such as "Ran echo hi" or "Read app.tsx". */
  line: string;
  /** Semantic category used to pick an icon in the renderer. */
  category: ToolTraceCategory;
  /** Verb portion (e.g. "Ran", "Read"). Kept separate so callers can style it. */
  verb: string;
  /** Trailing detail portion. Empty when the verb alone is enough. */
  detail: string;
  /** Original tool name for tests / accessibility fallbacks. */
  toolName: string;
}

const TOOL_NAME_ALIASES: Record<string, string> = {
  execute_command: "exec",
  run_terminal_cmd: "exec",
  run_command: "exec",
  run_shell: "exec",
  shell: "exec",
  Shell: "exec",
  bash: "exec",
  terminal: "exec",
  cmd: "exec",
  readfile: "read_file",
  read: "read_file",
  cat: "read_file",
  view: "read_file",
  view_file: "read_file",
  view_range: "read_file",
  open_file: "read_file",
  file_read: "read_file",
  ripgrep: "grep",
  code_search: "grep",
  search_code: "grep",
  regex_search: "grep",
  ls: "list_dir",
  list: "list_dir",
  list_directory: "list_dir",
  find: "glob",
  file_search: "glob",
  glob_search: "glob",
  applypatch: "edit_file",
  edit: "edit_file",
  patch: "edit_file",
  apply_patch: "edit_file",
  str_replace: "edit_file",
  str_replace_editor: "edit_file",
  write: "write_file",
  create_file: "write_file",
  save_file: "write_file",
  new_file: "write_file",
  delete: "delete_file",
  remove_file: "delete_file",
  rm: "delete_file",
  fetch: "web_fetch",
  http_fetch: "web_fetch",
  open_url: "web_fetch",
  goto: "web_fetch",
  websearch: "search_web",
  web_search: "search_web",
  google_search: "search_web",
  bing_search: "search_web",
  duckduckgo_search: "search_web",
  search: "search_web",
  webfetch: "web_fetch",
  browse: "browser_use",
  browser: "browser_use",
  browser_navigate: "browser_use",
  subagent: "subagent",
  task: "subagent",
  askquestion: "ask_question",
  ask_question: "ask_question",
  switchmode: "switch_mode",
  switch_mode: "switch_mode",
  todowrite: "todo_write",
  todo: "todo_write",
  todo_list: "todo_write",
  update_todo_list: "todo_write",
  callmcptool: "mcp_tool",
  call_mcp_tool: "mcp_tool",
  fetchmcpresource: "fetch_mcp_resource",
  fetch_mcp_resource: "fetch_mcp_resource",
  generateimage: "image_generate",
  generate_image: "image_generate",
  editnotebook: "notebook_edit",
  jupyter: "notebook_edit",
  notebook: "notebook_edit"
};

/**
 * Format a provider/tool-call-like object as a Cursor-style one-liner such as
 * "Read app.tsx" or "Ran echo hello". Falls back to `Called <toolName>` when
 * the arguments are unrecognised so we never leak raw JSON into the UI.
 */
export function formatToolCallTrace(call: unknown): string | null {
  const summary = summarizeToolCall(call);
  return summary ? summary.line : null;
}

export function summarizeToolCall(call: unknown): ToolTraceSummary | null {
  if (!isRecord(call)) {
    return null;
  }

  const fn = isRecord(call.function) ? call.function : null;
  const rawName = typeof fn?.name === "string" && fn.name
    ? fn.name
    : typeof call.name === "string" && call.name
      ? call.name
      : "";
  if (!rawName) {
    return null;
  }

  const args = parseToolArguments(fn && "arguments" in fn ? fn.arguments : call.arguments);
  const canonicalName = canonicalToolName(rawName);
  return describeToolCall(canonicalName, rawName, args);
}

const CANONICAL_TOOL_NAMES = new Set([
  "exec",
  "read_file",
  "grep",
  "glob",
  "list_dir",
  "edit_file",
  "write_file",
  "delete_file",
  "search_web",
  "web_fetch",
  "browser_use",
  "subagent",
  "ask_question",
  "switch_mode",
  "todo_write",
  "mcp_tool",
  "fetch_mcp_resource",
  "image_generate",
  "notebook_edit"
]);

function canonicalToolName(name: string): string {
  const trimmed = name.trim();
  const lower = trimmed.toLowerCase();
  if (TOOL_NAME_ALIASES[lower]) return TOOL_NAME_ALIASES[lower]!;
  if (CANONICAL_TOOL_NAMES.has(lower)) return lower;
  // Match prefixed variants like `mcp_<server>_<tool>` or `namespace.action`
  // by scanning suffixes right-to-left against the alias/canonical tables.
  // The longest matching suffix wins so `mcp_office_read_file` resolves to
  // `read_file` even though the last single segment is just `file`.
  const separator = /[._-]/u;
  const segments = lower.split(separator);
  for (let index = 1; index < segments.length; index += 1) {
    const suffix = segments.slice(index).join("_");
    if (!suffix) continue;
    if (TOOL_NAME_ALIASES[suffix]) return TOOL_NAME_ALIASES[suffix]!;
    if (CANONICAL_TOOL_NAMES.has(suffix)) return suffix;
  }
  return lower;
}

function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  if (typeof raw !== "string") return {};
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function describeToolCall(
  canonicalName: string,
  toolName: string,
  args: Record<string, unknown>
): ToolTraceSummary {
  const summary = buildToolSummary(canonicalName, toolName, args);
  const detail = summary.detail.trim();
  const line = detail ? `${summary.verb} ${detail}` : `${summary.verb} ${humanizeToolName(toolName)}`;
  return {
    line,
    category: summary.category,
    verb: summary.verb,
    detail,
    toolName
  };
}

function buildToolSummary(
  canonicalName: string,
  toolName: string,
  args: Record<string, unknown>
): { verb: string; detail: string; category: ToolTraceCategory } {
  switch (canonicalName) {
    case "exec": {
      const command = firstStringField(args, ["command", "cmd", "script", "code"]);
      return { verb: "Ran", detail: command ? truncate(collapseWhitespace(command), 140) : "", category: "shell" };
    }
    case "read_file": {
      const target = firstPathField(args, ["path", "file_path", "target_file", "file", "filename", "filepath"]);
      const range = fileLineRange(args);
      const detail = target ? (range ? `${basename(target)} ${range}` : basename(target)) : "";
      return { verb: "Read", detail, category: "read" };
    }
    case "grep": {
      const pattern = firstStringField(args, ["pattern", "query", "regex", "search", "expression"]);
      return { verb: "Grepped", detail: pattern ? truncate(pattern, 96) : "", category: "grep" };
    }
    case "glob": {
      const pattern = firstStringField(args, ["glob_pattern", "pattern", "glob", "query"]);
      return { verb: "Globbed", detail: pattern ? truncate(pattern, 96) : "", category: "glob" };
    }
    case "list_dir": {
      const target = firstPathField(args, ["path", "target_directory", "directory", "dir", "target"]);
      return { verb: "Listed", detail: target ? basename(target) || target : "", category: "list" };
    }
    case "edit_file": {
      const target = firstPathField(args, ["path", "file_path", "target_file", "file"]);
      return { verb: "Edited", detail: target ? basename(target) : "", category: "edit" };
    }
    case "write_file": {
      const target = firstPathField(args, ["path", "file_path", "target_file", "file"]);
      return { verb: "Wrote", detail: target ? basename(target) : "", category: "write" };
    }
    case "delete_file": {
      const target = firstPathField(args, ["path", "file_path", "target_file", "file"]);
      return { verb: "Deleted", detail: target ? basename(target) : "", category: "delete" };
    }
    case "search_web": {
      const query = firstStringField(args, ["query", "search_term", "q"]);
      return { verb: "Searched web for", detail: query ? truncate(query, 96) : "", category: "search" };
    }
    case "web_fetch": {
      const url = firstStringField(args, ["url", "href", "endpoint"]);
      return { verb: "Fetched", detail: url ? hostnameOrTail(url) : "", category: "web" };
    }
    case "browser_use": {
      const detail = firstStringField(args, ["action", "task", "instruction", "goal", "url"]);
      return { verb: "Used browser", detail: detail ? truncate(detail, 96) : "", category: "browser" };
    }
    case "subagent": {
      const detail = firstStringField(args, ["description", "task", "prompt", "subagent_type"]);
      return { verb: "Launched", detail: detail ? truncate(detail, 96) : "subagent", category: "task" };
    }
    case "ask_question": {
      return { verb: "Asked", detail: "user for input", category: "task" };
    }
    case "switch_mode": {
      const target = firstStringField(args, ["target_mode_id", "mode", "target"]);
      return { verb: "Switched mode", detail: target ? truncate(target, 48) : "", category: "task" };
    }
    case "todo_write": {
      return { verb: "Updated", detail: "todo list", category: "task" };
    }
    case "mcp_tool": {
      const server = firstStringField(args, ["server"]);
      const tool = firstStringField(args, ["toolName", "tool_name", "name"]);
      const detail = [server, tool].filter(Boolean).join(" / ");
      return { verb: "Called MCP", detail: detail ? truncate(detail, 96) : "", category: "mcp" };
    }
    case "fetch_mcp_resource": {
      const server = firstStringField(args, ["server"]);
      const uri = firstStringField(args, ["uri", "resource"]);
      const detail = [server, uri ? hostnameOrTail(uri) : ""].filter(Boolean).join(" / ");
      return { verb: "Fetched MCP", detail: detail ? truncate(detail, 96) : "resource", category: "mcp" };
    }
    case "image_generate": {
      const filename = firstStringField(args, ["filename", "name"]);
      const description = firstStringField(args, ["description", "prompt"]);
      return { verb: "Generated image", detail: filename || (description ? truncate(description, 96) : ""), category: "image" };
    }
    case "notebook_edit": {
      const target = firstPathField(args, ["target_notebook", "path", "file_path"]);
      return { verb: "Updated notebook", detail: target ? basename(target) : "", category: "notebook" };
    }
    default:
      return {
        verb: "Called",
        detail: humanizeToolName(toolName),
        category: "generic"
      };
  }
}

function firstStringField(args: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function firstPathField(args: Record<string, unknown>, keys: string[]): string | null {
  const stringValue = firstStringField(args, keys);
  if (stringValue) return stringValue;
  for (const key of keys) {
    const value = args[key];
    if (Array.isArray(value) && value.length > 0) {
      const first = value.find((entry) => typeof entry === "string" && entry.trim());
      if (typeof first === "string") return first.trim();
    }
  }
  return null;
}

function fileLineRange(args: Record<string, unknown>): string | null {
  const explicit = firstStringField(args, ["range", "line_range"]);
  if (explicit) return `L${explicit.replace(/^L?/i, "")}`;
  const start = normalizeLineNumber(args.start_line ?? args.line ?? args.offset);
  const end = normalizeLineNumber(args.end_line ?? args.limit);
  if (start != null && end != null) return `L${start}-${end}`;
  if (start != null) return `L${start}`;
  return null;
}

function normalizeLineNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return parseInt(value.trim(), 10);
  return null;
}

function humanizeToolName(name: string): string {
  const clean = name.replace(/[._-]+/gu, " ").trim();
  if (!clean) return name;
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function basename(value: string): string {
  const clean = value.replace(/[/\\]+$/u, "");
  const index = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  return index >= 0 ? clean.slice(index + 1) : clean;
}

function hostnameOrTail(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url.length > 60 ? `${url.slice(0, 57)}...` : url;
  }
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
}

export function normalizeToolProgressEvents(events: unknown): AgentToolProgressEvent[] {
  if (!Array.isArray(events)) {
    return [];
  }

  return events.flatMap((event) => {
    if (!isRecord(event) || !VALID_PHASES.has(String(event.phase))) {
      return [];
    }
    const fn = isRecord(event.function) ? event.function : null;
    if (typeof event.name !== "string" && typeof fn?.name !== "string") {
      return [];
    }
    return [{ ...event } as AgentToolProgressEvent];
  });
}

export function toolTraceLinesFromEvents(events: unknown): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];

  for (const event of normalizeToolProgressEvents(events)) {
    const callId = typeof event.call_id === "string" ? event.call_id : "";
    if (callId) {
      if (seen.has(callId)) {
        continue;
      }
      seen.add(callId);
    }
    const line = formatToolCallTrace(event);
    if (line) {
      lines.push(line);
    }
  }

  return lines;
}

export function mergeToolProgressEvents(
  previous: AgentToolProgressEvent[] | undefined,
  incoming: AgentToolProgressEvent[]
): AgentToolProgressEvent[] {
  if (!previous?.length) {
    return incoming;
  }
  if (!incoming.length) {
    return previous;
  }

  const next = [...previous];
  const indexByKey = new Map(next.map((event, index) => [toolEventKey(event), index]));
  for (const event of incoming) {
    const key = toolEventKey(event);
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, next.length);
      next.push(event);
      continue;
    }

    const existing = next[existingIndex];
    if (!existing) {
      indexByKey.set(key, next.length);
      next.push(event);
      continue;
    }
    const incomingRank = PHASE_RANK[String(event.phase)] ?? 0;
    const existingRank = PHASE_RANK[String(existing.phase)] ?? 0;
    next[existingIndex] = incomingRank >= existingRank ? { ...existing, ...event } : existing;
  }

  return next;
}

export function mergeUniqueToolTraceLines(previousTraces: string[], lines: string[]): { traces: string[]; added: boolean } {
  const seen = new Set(previousTraces);
  const traces = [...previousTraces];
  let added = false;

  for (const line of lines) {
    if (seen.has(line)) {
      continue;
    }
    seen.add(line);
    traces.push(line);
    added = true;
  }

  return { traces, added };
}

export function normalizeFileEdits(edits: unknown): AgentFileEdit[] {
  const raw = Array.isArray(edits) ? edits : edits == null ? [] : [edits];
  return raw.flatMap((edit) => {
    if (!isRecord(edit)) {
      return [];
    }
    const tool = typeof edit.tool === "string" && edit.tool.trim() ? edit.tool.trim() : "file_edit";
    const path = typeof edit.path === "string" ? edit.path : "";
    const pending = edit.pending === true;
    if (!path && !pending) {
      return [];
    }
    const phase = typeof edit.phase === "string" ? edit.phase : undefined;
    const status = normalizeFileEditStatus(edit.status, phase);
    const normalized: AgentFileEdit = {
      ...edit,
      call_id: typeof edit.call_id === "string" && edit.call_id ? edit.call_id : `${tool}:${path || "pending"}`,
      tool,
      path,
      ...(typeof edit.absolute_path === "string" ? { absolute_path: edit.absolute_path } : {}),
      ...(phase ? { phase } : {}),
      status,
      added: normalizeCount(edit.added),
      deleted: normalizeCount(edit.deleted),
      ...(typeof edit.error === "string" ? { error: edit.error } : {}),
      ...(pending ? { pending: true } : {}),
      ...(edit.approximate === true ? { approximate: true } : {}),
      ...(edit.binary === true ? { binary: true } : {})
    };
    return [normalized];
  });
}

export function mergeFileEdits(previous: AgentFileEdit[] | undefined, incoming: AgentFileEdit[]): AgentFileEdit[] {
  if (!previous?.length) {
    return incoming;
  }
  if (!incoming.length) {
    return previous;
  }

  const next = [...previous];
  const indexByKey = new Map(next.map((edit, index) => [fileEditKey(edit), index]));
  for (const edit of incoming) {
    const key = fileEditKey(edit);
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, next.length);
      next.push(edit);
      continue;
    }

    const merged = { ...next[existingIndex], ...edit };
    if (edit.path && !edit.pending) {
      delete merged.pending;
    }
    next[existingIndex] = merged;
  }

  return next;
}

function toolEventKey(event: AgentToolProgressEvent): string {
  if (event.call_id) {
    return `call:${event.call_id}`;
  }
  return formatToolCallTrace(event) ?? safeJson(event);
}

function fileEditKey(edit: AgentFileEdit): string {
  return edit.call_id ? `call:${edit.call_id}:${edit.tool}` : `${edit.tool}:${edit.path}`;
}

function normalizeFileEditStatus(value: unknown, phase: string | undefined): "editing" | "done" | "error" {
  if (value === "editing" || value === "done" || value === "error") {
    return value;
  }
  if (phase === "error") {
    return "error";
  }
  if (phase === "end") {
    return "done";
  }
  return "editing";
}

function normalizeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function safeJson(value: unknown): string {
  try {
    const raw = JSON.stringify(value);
    return raw === undefined ? "" : raw.replace(/:/g, ": ").replace(/,/g, ", ");
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
