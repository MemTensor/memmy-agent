/** Session discovery module. */
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readJsonlObjects } from "../jsonl-lines.js";

/** Contract for hermes session file. */
export interface HermesSessionFile {
  sessionFilePath: string;
  workspacePath: string | null;
  gitRoot: string | null;
}

/** Contract for discover hermes sessions options. */
export interface DiscoverHermesSessionsOptions {
  root: string;
  order?: "path_asc" | "recent_first";
  maxSessions?: number;
}

/** Handles discover hermes sessions. */
export async function discoverHermesSessions(options: DiscoverHermesSessionsOptions): Promise<HermesSessionFile[]> {
  const files = await listJsonlFiles(join(options.root, "sessions"), options.order ?? "path_asc", options.maxSessions);
  const sessions: HermesSessionFile[] = [];

  for (const filePath of files) {
    const metadata = await readFirstWorkspaceMetadata(filePath);
    sessions.push({
      sessionFilePath: filePath,
      workspacePath: metadata.workspacePath,
      gitRoot: metadata.gitRoot ?? (metadata.workspacePath ? findGitRoot(metadata.workspacePath) : null)
    });
  }

  return sessions;
}

async function listJsonlFiles(root: string, order: "path_asc" | "recent_first", maxSessions: number | undefined): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }

    throw error;
  }

  const files: Array<{ path: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      for (const childPath of await listJsonlFiles(path, order, maxSessions)) {
        const fileStat = await stat(childPath);
        files.push({ path: childPath, mtimeMs: fileStat.mtimeMs });
      }
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      const fileStat = await stat(path);
      files.push({ path, mtimeMs: fileStat.mtimeMs });
    }
  }

  return files
    .sort((left, right) => order === "recent_first"
      ? right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path)
      : left.path.localeCompare(right.path))
    .slice(0, maxSessions ?? files.length)
    .map((file) => file.path);
}

async function readFirstWorkspaceMetadata(filePath: string): Promise<{ workspacePath: string | null; gitRoot: string | null }> {
  try {
    for await (const record of readJsonlObjects(filePath)) {
      const workspacePath = getString(record.cwd) ?? getString(record.workspacePath) ?? getString(record.payload, "cwd");
      const gitRoot = getString(record.gitRoot) ?? getString(record.payload, "gitRoot");
      if (workspacePath || gitRoot) {
        return { workspacePath, gitRoot };
      }
    }
  } catch {
    return { workspacePath: null, gitRoot: null };
  }

  return { workspacePath: null, gitRoot: null };
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

function getString(record: unknown, key?: string): string | null {
  if (!key) {
    return typeof record === "string" && record.length > 0 ? record : null;
  }

  if (!isRecord(record)) {
    return null;
  }

  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
