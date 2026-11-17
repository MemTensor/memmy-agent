import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { decompress, ZstdErrorCode } from "fzstd";
import type { DeepseekHarnessEvent } from "./deepseek-source-turn.js";

export interface DeepseekHarnessSessionFile {
  sessionFilePath: string;
  gitRoot: string | null;
}

export interface DeepseekHarnessLogName {
  version: number;
  compressed: boolean;
}

const ZSTD_FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * Discovers DeepSeek Harness session logs. Production files are `session.vN.jsonl.zstd`;
 * older `session.jsonl` names still count as version 0. Each session directory contributes
 * only its newest generation so a leftover v1 next to v3 is not imported twice.
 */
export async function discoverDeepseekHarnessSessions(options: {
  root: string;
  order?: "path_asc" | "recent_first";
  maxSessions?: number;
}): Promise<DeepseekHarnessSessionFile[]> {
  const byDirectory = new Map<string, { path: string; version: number; compressed: boolean; mtimeMs: number }>();
  const directories = [options.root];
  for (let index = 0; index < directories.length; index += 1) {
    const directory = directories[index]!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const parsed = parseDeepseekHarnessLogName(entry.name);
      if (!parsed) continue;
      const current = byDirectory.get(directory);
      if (current && !isNewerLog(parsed, current)) continue;
      byDirectory.set(directory, {
        path,
        version: parsed.version,
        compressed: parsed.compressed,
        mtimeMs: (await stat(path)).mtimeMs
      });
    }
  }
  return [...byDirectory.values()]
    .sort((left, right) => options.order === "recent_first"
      ? right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path)
      : left.path.localeCompare(right.path))
    .slice(0, options.maxSessions ?? byDirectory.size)
    .map((file) => ({ sessionFilePath: file.path, gitRoot: null }));
}

/** Picks the newest generation in one session directory. Used by the plugin after flush. */
export async function findLatestDeepseekHarnessSessionFile(directory: string): Promise<string | undefined> {
  const discovered = await discoverDeepseekHarnessSessions({ root: directory, maxSessions: 1 });
  const match = discovered.find((file) => dirname(file.sessionFilePath) === directory);
  return match?.sessionFilePath ?? discovered[0]?.sessionFilePath;
}

export function parseDeepseekHarnessLogName(fileName: string): DeepseekHarnessLogName | undefined {
  const match = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/u.exec(fileName);
  if (!match) return undefined;
  return { version: match[1] ? Number(match[1]) : 0, compressed: Boolean(match[2]) };
}

/** DSH session-directory encoding. Same rules as `session-persistence-jsonl`. */
export function encodeDeepseekHarnessSegment(raw: string): string {
  if (!raw) throw new Error("cannot encode an empty path segment");
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  return [...raw].map((character) => {
    const code = character.charCodeAt(0);
    return character !== "~" && /^[A-Za-z0-9._-]$/u.test(character)
      ? character
      : `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
  }).join("");
}

export function deepseekHarnessProjectKey(cwd: string): string {
  if (!cwd) throw new Error("cannot encode an empty project path");
  let readable = "";
  let separatorRun = false;
  for (const character of cwd) {
    if (character === "/" || character === "\\" || character === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
      continue;
    }
    readable += character !== "~" && /^[A-Za-z0-9._-]$/u.test(character)
      ? character
      : `~${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
    separatorRun = false;
  }
  return `--${(readable.replace(/^-+/u, "") || "root").slice(0, 251)}--`;
}

export function deepseekHarnessSessionDirectory(
  sessionsRoot: string,
  cwd: string,
  sessionId: string
): string {
  return join(sessionsRoot, deepseekHarnessProjectKey(cwd), encodeDeepseekHarnessSegment(sessionId));
}

/** Loads the session file the scan and the plugin both read, including zstd frames. */
export async function loadDeepseekHarnessEvents(
  filePath: string,
  signal?: AbortSignal
): Promise<DeepseekHarnessEvent[]> {
  signal?.throwIfAborted();
  const bytes = await readFile(filePath);
  signal?.throwIfAborted();
  const text = filePath.endsWith(".zstd") ? decompressFrames(bytes) : bytes.toString("utf8");
  return parseDeepseekHarnessEvents(text);
}

export function parseDeepseekHarnessEvents(text: string): DeepseekHarnessEvent[] {
  const events: DeepseekHarnessEvent[] = [];
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) events.push(parsed as DeepseekHarnessEvent);
    } catch {
      continue;
    }
  }
  return events;
}

function decompressFrames(bytes: Buffer): string {
  if (!bytes.subarray(0, ZSTD_FRAME_MAGIC.length).equals(ZSTD_FRAME_MAGIC)) {
    throw new Error("DeepSeek Harness session has no Zstandard frame header");
  }
  try {
    return Buffer.from(decompress(bytes)).toString("utf8");
  } catch (error) {
    if (!isUnexpectedEndOfFile(error)) throw error;
    const trailingFrameOffset = bytes.lastIndexOf(ZSTD_FRAME_MAGIC);
    if (trailingFrameOffset <= 0) throw error;
    return Buffer.from(decompress(bytes.subarray(0, trailingFrameOffset))).toString("utf8");
  }
}

function isUnexpectedEndOfFile(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === ZstdErrorCode.UnexpectedEOF;
}

function isNewerLog(next: DeepseekHarnessLogName, current: { version: number; compressed: boolean }): boolean {
  if (next.version !== current.version) return next.version > current.version;
  return next.compressed && !current.compressed;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
