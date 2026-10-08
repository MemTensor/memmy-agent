import type { AgentChatMessage } from "../state/agent-chat-slice.js";
import { localArtifactPathFromHref } from "./agent-message-content.js";

export type ThreadPanelView = "overview" | "files" | "changes";

export type ThreadFileKind =
  | "pdf"
  | "doc"
  | "sheet"
  | "slides"
  | "image"
  | "video"
  | "audio"
  | "archive"
  | "markdown"
  | "html"
  | "code"
  | "data"
  | "text"
  | "file";

export type ThreadPreviewKind =
  | "pdf"
  | "image"
  | "video"
  | "markdown"
  | "html"
  | "csv"
  | "code"
  | "text"
  | "unsupported";

export type ThreadArtifact = {
  key: string;
  name: string;
  path?: string;
  url?: string;
};

export type ThreadFileChange = {
  key: string;
  path: string;
  absolutePath?: string;
  name: string;
  added: number;
  deleted: number;
};

export type ThreadPanelTab =
  | { id: string; type: "file"; name: string; path?: string; url?: string }
  | { id: string; type: "change"; name: string; path: string; absolutePath?: string; added: number; deleted: number };

export type ThreadTabState = {
  tabs: ThreadPanelTab[];
  activeId: string | null;
};

export type ConversationPrompt = {
  messageId: string;
  text: string;
};

export const THREAD_PANEL_MIN_WIDTH = 360;
export const THREAD_CHAT_MIN_WIDTH = 540;
export const THREAD_CHAT_FLOOR_WIDTH = 320;
export const THREAD_PANEL_NARROW_WIDTH = 480;
export const THREAD_LIST_DEFAULT_WIDTH = 240;
export const THREAD_LIST_MIN_WIDTH = 200;
export const THREAD_PREVIEW_MIN_WIDTH = 280;
export const THREAD_OVERVIEW_ARTIFACT_LIMIT = 5;

const FILE_EXTENSION_RE = /\.([a-z0-9]{1,12})$/iu;
const PROMPT_PREVIEW_LIMIT = 200;

const EXTENSION_KINDS: Record<string, ThreadFileKind> = {
  pdf: "pdf",
  doc: "doc",
  docx: "doc",
  rtf: "doc",
  pages: "doc",
  odt: "doc",
  xls: "sheet",
  xlsx: "sheet",
  xlsm: "sheet",
  csv: "sheet",
  tsv: "sheet",
  numbers: "sheet",
  ods: "sheet",
  ppt: "slides",
  pptx: "slides",
  key: "slides",
  odp: "slides",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  avif: "image",
  bmp: "image",
  ico: "image",
  mp4: "video",
  webm: "video",
  mov: "video",
  mp3: "audio",
  wav: "audio",
  m4a: "audio",
  zip: "archive",
  gz: "archive",
  tgz: "archive",
  rar: "archive",
  "7z": "archive",
  tar: "archive",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  html: "html",
  htm: "html",
  json: "data",
  jsonl: "data",
  yaml: "data",
  yml: "data",
  toml: "data",
  xml: "data",
  txt: "text",
  log: "text",
  ini: "text",
  env: "text",
  conf: "text",
};

const CODE_EXTENSIONS = new Set([
  "bash", "c", "cc", "cpp", "cs", "css", "dart", "go", "h", "hpp", "java", "js", "jsx", "kt", "less",
  "lua", "m", "mjs", "cjs", "php", "pl", "ps1", "py", "r", "rb", "rs", "sass", "scala", "scss", "sh",
  "sql", "swift", "ts", "tsx", "vue", "zsh",
]);

const PREVIEW_BY_KIND: Partial<Record<ThreadFileKind, ThreadPreviewKind>> = {
  pdf: "pdf",
  image: "image",
  video: "video",
  markdown: "markdown",
  html: "html",
  code: "code",
  data: "code",
  text: "text",
};

export function threadFileExtension(name: string): string {
  return name.match(FILE_EXTENSION_RE)?.[1]?.toLocaleLowerCase() ?? "";
}

export function threadFileKind(name: string): ThreadFileKind {
  const extension = threadFileExtension(name);
  if (!extension) return "file";
  if (CODE_EXTENSIONS.has(extension)) return "code";
  return EXTENSION_KINDS[extension] ?? "file";
}

export function threadPreviewKind(name: string): ThreadPreviewKind {
  const extension = threadFileExtension(name);
  if (extension === "csv" || extension === "tsv") return "csv";
  return PREVIEW_BY_KIND[threadFileKind(name)] ?? "unsupported";
}

export function threadFileName(target: string): string {
  const withoutQuery = target.split(/[?#]/u, 1)[0] ?? target;
  const normalized = withoutQuery.replace(/[/\\]+$/u, "");
  const base = normalized.slice(Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\")) + 1);
  try {
    return decodeURIComponent(base);
  } catch {
    return base;
  }
}

export function normalizeThreadPath(value: string): string {
  return withoutUrlDriveSlash(value.trim().replace(/^file:\/\//iu, "").replace(/\\/gu, "/").replace(/\/{2,}/gu, "/"));
}

function withoutUrlDriveSlash(path: string): string {
  return path.replace(/^\/([a-z]:[\\/])/iu, "$1");
}

export function joinThreadPath(base: string, target: string): string {
  const normalizedTarget = normalizeThreadPath(target);
  if (!base || normalizedTarget.startsWith("/") || /^[a-z]:\//iu.test(normalizedTarget)) return normalizedTarget;
  const parts = `${normalizeThreadPath(base).replace(/\/$/u, "")}/${normalizedTarget}`.split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === ".." && resolved.length > 1) {
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }
  return resolved.join("/");
}

export function relativeThreadPath(root: string, target: string): string | null {
  const normalizedRoot = normalizeThreadPath(root).replace(/\/$/u, "");
  const normalizedTarget = normalizeThreadPath(target);
  if (!normalizedRoot) return null;
  if (normalizedTarget === normalizedRoot) return "";
  const prefix = `${normalizedRoot}/`;
  const caseInsensitive = /^[a-z]:\//iu.test(normalizedRoot);
  const matches = caseInsensitive
    ? normalizedTarget.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())
    : normalizedTarget.startsWith(prefix);
  return matches ? normalizedTarget.slice(prefix.length) : null;
}

export function collectThreadArtifacts(messages: AgentChatMessage[]): ThreadArtifact[] {
  const artifacts = new Map<string, ThreadArtifact>();
  const add = (artifact: Omit<ThreadArtifact, "key">) => {
    const key = normalizeThreadPath(artifact.path ?? artifact.url ?? "");
    if (!key || artifacts.has(key)) return;
    artifacts.set(key, { ...artifact, key });
  };

  for (const message of messages) {
    if (message.role !== "assistant" || message.kind === "trace" || message.kind === "context_compaction") continue;
    for (const media of message.media ?? []) {
      const path = media.path?.trim() || undefined;
      const url = media.url?.trim() || undefined;
      if (!path && !url) continue;
      const name = media.name?.trim() || threadFileName(path ?? url ?? "");
      if (!name) continue;
      add({ name, ...(path ? { path } : {}), ...(url ? { url } : {}) });
    }
    for (const href of markdownLinkTargets(message.content)) {
      const localPath = localArtifactPathFromHref(href);
      if (!localPath || !threadFileExtension(threadFileName(localPath))) continue;
      const path = withoutUrlDriveSlash(localPath);
      add({ name: threadFileName(path), path });
    }
  }
  return [...artifacts.values()];
}

export function collectThreadFileChanges(messages: AgentChatMessage[]): ThreadFileChange[] {
  const changes = new Map<string, ThreadFileChange>();
  for (const message of messages) {
    for (const edit of message.fileEdits ?? []) {
      if (edit.status === "error" || edit.unchanged === true || edit.pending === true) continue;
      const displayPath = edit.path?.trim();
      const absolutePath = typeof edit.absolute_path === "string" && edit.absolute_path.trim()
        ? edit.absolute_path.trim()
        : undefined;
      const identity = normalizeThreadPath(absolutePath ?? displayPath ?? "");
      if (!identity || !displayPath) continue;
      const current = changes.get(identity);
      const added = countOrZero(edit.added);
      const deleted = countOrZero(edit.deleted);
      if (current) {
        current.added += added;
        current.deleted += deleted;
        if (!current.absolutePath && absolutePath) current.absolutePath = absolutePath;
        continue;
      }
      changes.set(identity, {
        key: identity,
        path: displayPath,
        ...(absolutePath ? { absolutePath } : {}),
        name: threadFileName(displayPath),
        added,
        deleted,
      });
    }
  }
  return [...changes.values()];
}

export function sumThreadFileChanges(changes: ThreadFileChange[]): { added: number; deleted: number } {
  return changes.reduce(
    (total, change) => ({ added: total.added + change.added, deleted: total.deleted + change.deleted }),
    { added: 0, deleted: 0 },
  );
}

export function collectConversationPrompts(messages: AgentChatMessage[]): ConversationPrompt[] {
  return messages.flatMap((message) => {
    if (message.role !== "user" || !message.id) return [];
    const text = message.content.replace(/\s+/gu, " ").trim().slice(0, PROMPT_PREVIEW_LIMIT);
    return text ? [{ messageId: message.id, text }] : [];
  });
}

export function threadTabForArtifact(artifact: ThreadArtifact): ThreadPanelTab {
  return {
    id: `file:${artifact.key}`,
    type: "file",
    name: artifact.name,
    ...(artifact.path ? { path: artifact.path } : {}),
    ...(artifact.url ? { url: artifact.url } : {}),
  };
}

export function threadTabForPath(path: string, name = threadFileName(path)): ThreadPanelTab {
  return { id: `file:${normalizeThreadPath(path)}`, type: "file", name, path };
}

export function threadTabForInAppPreview(file: { name: string; path?: string; url?: string }): ThreadPanelTab | null {
  const candidates = [file.name, file.path, file.url]
    .map((value) => (value ? threadFileName(value) : ""))
    .filter(Boolean);
  const name = candidates.find((candidate) => threadPreviewKind(candidate) === "markdown");
  if (!name || (!file.path && !file.url)) return null;
  if (file.path) {
    return {
      ...threadTabForPath(file.path, name),
      ...(file.url ? { url: file.url } : {}),
    };
  }
  return threadTabForArtifact({
    key: file.url || name,
    name,
    ...(file.url ? { url: file.url } : {}),
  });
}

export function threadTabForChange(change: ThreadFileChange): ThreadPanelTab {
  return {
    id: `change:${change.key}`,
    type: "change",
    name: change.name,
    path: change.path,
    ...(change.absolutePath ? { absolutePath: change.absolutePath } : {}),
    added: change.added,
    deleted: change.deleted,
  };
}

export function openThreadTab(state: ThreadTabState, tab: ThreadPanelTab): ThreadTabState {
  const existing = state.tabs.findIndex((item) => item.id === tab.id);
  if (existing >= 0) {
    const tabs = state.tabs.slice();
    tabs[existing] = tab;
    return { tabs, activeId: tab.id };
  }
  return { tabs: [...state.tabs, tab], activeId: tab.id };
}

export function closeThreadTab(state: ThreadTabState, id: string): ThreadTabState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  if (state.activeId !== id) return { tabs, activeId: state.activeId };
  const neighbor = tabs[index] ?? tabs[index - 1] ?? null;
  return { tabs, activeId: neighbor?.id ?? null };
}

export function maxThreadPanelWidth(containerWidth: number): number {
  return Math.max(THREAD_PANEL_MIN_WIDTH, Math.floor(containerWidth - THREAD_CHAT_MIN_WIDTH));
}

export function clampThreadPanelWidth(width: number, containerWidth: number): number {
  const safeWidth = Number.isFinite(width) ? width : THREAD_PANEL_MIN_WIDTH;
  if (!(containerWidth > 0)) return Math.max(THREAD_PANEL_MIN_WIDTH, Math.round(safeWidth));
  return Math.round(Math.min(Math.max(safeWidth, THREAD_PANEL_MIN_WIDTH), maxThreadPanelWidth(containerWidth)));
}

export function threadPanelContentWidth(containerWidth: number): number {
  return clampThreadPanelWidth(Math.round(containerWidth / 2), containerWidth);
}

export function threadPanelOffset(width: number, containerWidth: number): number {
  if (!(containerWidth > 0)) return width;
  return Math.max(0, Math.min(width, containerWidth - THREAD_CHAT_FLOOR_WIDTH));
}

export function clampThreadListWidth(width: number, panelWidth: number): number {
  const max = Math.max(THREAD_LIST_MIN_WIDTH, panelWidth - THREAD_PREVIEW_MIN_WIDTH);
  return Math.round(Math.min(Math.max(width, THREAD_LIST_MIN_WIDTH), max));
}

function markdownLinkTargets(content: string): string[] {
  const targets: string[] = [];
  for (const match of content.matchAll(/\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/gu)) {
    if (match.index != null && match.index > 0 && content[match.index - 1] === "!") continue;
    if (match[1]) targets.push(match[1]);
  }
  return targets;
}

function countOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}
