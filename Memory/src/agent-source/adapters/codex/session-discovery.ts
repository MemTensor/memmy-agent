/** Session discovery module. */
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { readJsonlObjects } from "../jsonl-lines.js";
import { readDirectoryIfExists } from "../read-directory.js";

export interface CodexSessionFile {
  /** Session file path. */
  sessionFilePath: string;
  workspacePath: string | null;
  gitRoot: string | null;
  externalImport?: { sourcePath: string; contentHash?: string; importedThreadId: string };
}

export interface DiscoverCodexSessionsOptions {
  /** Root. */
  root: string;
  order?: "path_asc" | "recent_first";
  maxSessions?: number;
}

/** Handles discover codex sessions. */
export async function discoverCodexSessions(options: DiscoverCodexSessionsOptions): Promise<CodexSessionFile[]> {
  const files = await listRolloutFiles(options.root, options.order ?? "path_asc", options.maxSessions);
  const imports = await readCodexImportLedger(join(dirname(options.root), "external_agent_session_imports.json"));
  const sessions: CodexSessionFile[] = [];

  for (const filePath of files) {
    const { workspacePath, threadId } = await readSessionMetadata(filePath);
    const externalImport = imports.get(threadId);
    sessions.push({
      sessionFilePath: filePath,
      workspacePath,
      gitRoot: workspacePath ? findGitRoot(workspacePath) : null,
      ...(externalImport ? { externalImport } : {})
    });
  }

  return sessions;
}

async function readCodexImportLedger(path: string): Promise<Map<string, { sourcePath: string; contentHash?: string; importedThreadId: string }>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(parsed)) return new Map();
    // records/content_sha256 is the native ledger protocol; accept the
    // imports/content_hash shape for compatibility as well.
    const records = Array.isArray(parsed.records) ? parsed.records : Array.isArray(parsed.imports) ? parsed.imports : [];
    const imports = new Map<string, { sourcePath: string; contentHash?: string; importedThreadId: string }>();
    for (const entry of records) {
      if (!isRecord(entry) || typeof entry.source_path !== "string" || !entry.source_path.trim()
        || typeof entry.imported_thread_id !== "string" || !entry.imported_thread_id.trim()) continue;
      const contentHash = typeof entry.content_sha256 === "string" ? entry.content_sha256 : entry.content_hash;
      imports.set(entry.imported_thread_id.trim(), {
        sourcePath: entry.source_path,
        ...(typeof contentHash === "string" ? { contentHash } : {}),
        importedThreadId: entry.imported_thread_id.trim()
      });
    }
    return imports;
  } catch {
    return new Map();
  }
}

function rolloutThreadId(filePath: string): string {
  const name = basename(filePath).replace(/^rollout-/u, "").replace(/\.jsonl$/u, "");
  return name.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu)?.[0] ?? name;
}

/** Handles list rollout files. */
async function listRolloutFiles(
  root: string,
  order: "path_asc" | "recent_first",
  maxSessions: number | undefined
): Promise<string[]> {
  const files: Array<{ path: string; mtimeMs: number }> = [];
  const directories = [root];

  for (let directoryIndex = 0; directoryIndex < directories.length; directoryIndex += 1) {
    const currentDirectory = directories[directoryIndex]!;
    const entries = await readDirectoryIfExists(currentDirectory);

    for (const entry of entries) {
      const path = join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        directories.push(path);
        continue;
      }

      if (entry.isFile() && entry.name.startsWith("rollout-") && (entry.name.indexOf(".jsonl") === entry.name.length - 6) && !/\.jsonl\.bak-/u.test(entry.name)) {
        const fileStat = await stat(path);
        files.push({ path, mtimeMs: fileStat.mtimeMs });
      }
    }
  }

  return files
    .sort((left, right) => order === "recent_first"
      ? right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path)
      : left.path.localeCompare(right.path))
    .slice(0, maxSessions ?? files.length)
    .map((file) => file.path);
}

async function readSessionMetadata(filePath: string): Promise<{ workspacePath: string | null; threadId: string }> {
  let workspacePath: string | null = null;
  let threadId = rolloutThreadId(filePath);
  let foundSessionMetadata = false;
  try {
    for await (const record of readJsonlObjects(filePath)) {
      const payload = isRecord(record.payload) ? record.payload : undefined;
      if (record.type === "session_meta") {
        if (typeof payload?.id === "string" && payload.id.trim()) threadId = payload.id.trim();
        foundSessionMetadata = true;
      }
      if (workspacePath === null) {
        if (typeof record.cwd === "string") workspacePath = record.cwd;
        else if (typeof payload?.cwd === "string") workspacePath = payload.cwd;
      }
      if (foundSessionMetadata && workspacePath !== null) break;
    }
  } catch {
    // Keep filename fallback and any metadata recovered before a corrupt line.
  }
  return { workspacePath, threadId };
}

function findGitRoot(workspacePath: string): string | null {
  let current = workspacePath;
  while (current !== dirname(current)) {
    if (existsSync(join(current, ".git"))) {
      return current;
    }

    current = dirname(current);
  }

  return existsSync(join(current, ".git")) ? current : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
