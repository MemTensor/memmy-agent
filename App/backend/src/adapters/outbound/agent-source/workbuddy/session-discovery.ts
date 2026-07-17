import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { readWorkbuddyHistory } from "./history-reader.js";

export interface WorkbuddySessionFile {
  sessionFilePath: string;
  workspacePath: string | null;
  gitRoot: string | null;
}

export interface DiscoverWorkbuddySessionsOptions {
  projectsRoot: string;
  order?: "path_asc" | "recent_first";
  maxSessions?: number;
}

export async function discoverWorkbuddySessions(
  options: DiscoverWorkbuddySessionsOptions
): Promise<WorkbuddySessionFile[]> {
  const files = await listJsonlFiles(options.projectsRoot);
  const selected = files
    .sort((left, right) => options.order === "recent_first"
      ? right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path)
      : left.path.localeCompare(right.path))
    .slice(0, options.maxSessions ?? files.length);

  return Promise.all(selected.map(async (file) => {
    const workspacePath = await readWorkspacePath(file.path);
    return {
      sessionFilePath: file.path,
      workspacePath,
      gitRoot: workspacePath ? findGitRoot(workspacePath) : null
    };
  }));
}

async function listJsonlFiles(root: string): Promise<Array<{ path: string; mtimeMs: number }>> {
  const files: Array<{ path: string; mtimeMs: number }> = [];
  const directories = [root];

  for (let index = 0; index < directories.length; index += 1) {
    const directory = directories[index]!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }

    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(path);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push({ path, mtimeMs: (await stat(path)).mtimeMs });
      }
    }
  }

  return files;
}

async function readWorkspacePath(filePath: string): Promise<string | null> {
  const fromMeta = await readWorkspacePathFromMeta(filePath);
  if (fromMeta) {
    return fromMeta;
  }
  try {
    for await (const message of readWorkbuddyHistory(filePath)) {
      if (message.workspacePath) {
        return message.workspacePath;
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function readWorkspacePathFromMeta(filePath: string): Promise<string | null> {
  const metaPath = join(dirname(filePath), `${basename(filePath, ".jsonl")}.meta.json`);
  try {
    const parsed: unknown = JSON.parse(await readFile(metaPath, "utf8"));
    if (isRecord(parsed) && typeof parsed.cwd === "string" && parsed.cwd.trim()) {
      return parsed.cwd;
    }
  } catch (error) {
    if (error instanceof SyntaxError || (isNodeError(error) && error.code === "ENOENT")) {
      return null;
    }
    throw error;
  }
  return null;
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
