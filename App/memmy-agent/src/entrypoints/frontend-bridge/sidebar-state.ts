import fs from "node:fs";
import path from "node:path";
import { getWebuiDir } from "../../config/paths.js";

export const WEBUI_SIDEBAR_STATE_SCHEMA_VERSION = 1;
const MAX_STATE_FILE_BYTES = 256 * 1024;
const MAX_LIST_ITEMS = 2_000;
const MAX_MAP_ITEMS = 2_000;
const MAX_KEY_LEN = 512;
const MAX_TITLE_LEN = 160;
const MAX_TAG_LEN = 40;
const ALLOWED_DENSITIES = new Set(["comfortable", "compact"]);
const ALLOWED_SORTS = new Set(["updated_desc", "created_desc", "title_asc"]);

export function webuiSidebarStatePath(): string {
  return path.join(getWebuiDir(), "sidebar-state.json");
}

export function defaultWebuiSidebarState(): Record<string, any> {
  return {
    schema_version: WEBUI_SIDEBAR_STATE_SCHEMA_VERSION,
    pinned_keys: [],
    archived_keys: [],
    title_overrides: {},
    tags_by_key: {},
    collapsed_groups: {},
    view: {
      density: "comfortable",
      show_previews: false,
      show_timestamps: false,
      show_archived: false,
      sort: "updated_desc",
    },
    updated_at: null,
  };
}

function cleanString(value: any, maxLen = MAX_KEY_LEN): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned ? cleaned.slice(0, maxLen) : null;
}

function cleanStringList(value: any, maxLen = MAX_KEY_LEN): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value.slice(0, MAX_LIST_ITEMS)) {
    const cleaned = cleanString(item, maxLen);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

function cleanBoolMap(value: any): Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, boolean> = {};
  for (const [key, raw] of Object.entries(value).slice(0, MAX_MAP_ITEMS)) {
    const cleaned = cleanString(key);
    if (cleaned) out[cleaned] = Boolean(raw);
  }
  return out;
}

function cleanTitleOverrides(value: any): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, rawTitle] of Object.entries(value).slice(0, MAX_MAP_ITEMS)) {
    const cleanedKey = cleanString(key);
    const cleanedTitle = cleanString(rawTitle, MAX_TITLE_LEN);
    if (cleanedKey && cleanedTitle) out[cleanedKey] = cleanedTitle;
  }
  return out;
}

function cleanTagsByKey(value: any): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string[]> = {};
  for (const [key, rawTags] of Object.entries(value).slice(0, MAX_MAP_ITEMS)) {
    const cleanedKey = cleanString(key);
    if (!cleanedKey) continue;
    const tags = cleanStringList(rawTags, MAX_TAG_LEN).slice(0, 12);
    if (tags.length) out[cleanedKey] = tags;
  }
  return out;
}

function cleanView(value: any): Record<string, any> {
  const defaults = defaultWebuiSidebarState().view;
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...defaults };
  return {
    density: ALLOWED_DENSITIES.has(value.density) ? value.density : defaults.density,
    show_previews: Boolean(value.show_previews ?? defaults.show_previews),
    show_timestamps: Boolean(value.show_timestamps ?? defaults.show_timestamps),
    show_archived: Boolean(value.show_archived ?? defaults.show_archived),
    sort: ALLOWED_SORTS.has(value.sort) ? value.sort : defaults.sort,
  };
}

export function normalizeWebuiSidebarState(raw: any): Record<string, any> {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const state = defaultWebuiSidebarState();
  state.pinned_keys = cleanStringList(source.pinned_keys);
  state.archived_keys = cleanStringList(source.archived_keys);
  state.title_overrides = cleanTitleOverrides(source.title_overrides);
  state.tags_by_key = cleanTagsByKey(source.tags_by_key);
  state.collapsed_groups = cleanBoolMap(source.collapsed_groups);
  state.view = cleanView(source.view);
  state.updated_at = typeof source.updated_at === "string" ? source.updated_at : null;
  return state;
}

export function readWebuiSidebarState(): Record<string, any> {
  const file = webuiSidebarStatePath();
  if (!fs.existsSync(file)) return defaultWebuiSidebarState();
  try {
    if (fs.statSync(file).size > MAX_STATE_FILE_BYTES) return defaultWebuiSidebarState();
    return normalizeWebuiSidebarState(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return defaultWebuiSidebarState();
  }
}

function stableJsonValue(value: any): any {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableJsonValue(value[key])]),
  );
}

function fsyncDirBestEffort(dir: string): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch {
    // Some filesystems do not support directory fsync; the file fsync still protects the payload.
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

export function writeWebuiSidebarState(raw: Record<string, any>): Record<string, any> {
  const state = normalizeWebuiSidebarState(raw);
  state.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const encoded = `${JSON.stringify(stableJsonValue(state), null, 2)}\n`;
  if (Buffer.byteLength(encoded) > MAX_STATE_FILE_BYTES) throw new Error("sidebar state is too large");
  const file = webuiSidebarStatePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, "w");
    fs.writeFileSync(fd, encoded, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
    fsyncDirBestEffort(path.dirname(file));
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
  }
  return state;
}

export function sidebarState(): Record<string, any> {
  return readWebuiSidebarState();
}
