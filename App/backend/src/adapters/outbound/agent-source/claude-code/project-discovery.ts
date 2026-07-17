/** Project discovery module. */
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readJsonlObjects } from "../jsonl-lines.js";
import { readDirectoryIfExists } from "../read-directory.js";

/** Contract for claude code session file. */
export interface ClaudeCodeSessionFile {
  sessionFilePath: string;
  workspacePath: string | null;
  gitRoot: string | null;
}

/** Contract for discover claude code sessions options. */
export interface DiscoverClaudeCodeSessionsOptions {
  root: string;
  order?: "path_asc" | "recent_first";
  maxSessions?: number;
}

/** Handles discover claude code sessions. */
export async function discoverClaudeCodeSessions(
  options: DiscoverClaudeCodeSessionsOptions
): Promise<ClaudeCodeSessionFile[]> {
  const projectEntries = await readDirectoryIfExists(options.root);
  const sessionFiles: Array<{ projectName: string; sessionFilePath: string; mtimeMs: number }> = [];

  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) {
      continue;
    }

    const projectPath = join(options.root, projectEntry.name);
    const files = await readDirectoryIfExists(projectPath);
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) {
        continue;
      }

      const sessionFilePath = join(projectPath, file.name);
      const fileStat = await stat(sessionFilePath);
      sessionFiles.push({ projectName: projectEntry.name, sessionFilePath, mtimeMs: fileStat.mtimeMs });
    }
  }

  const orderedFiles = sessionFiles
    .sort((left, right) => options.order === "recent_first"
      ? right.mtimeMs - left.mtimeMs || right.sessionFilePath.localeCompare(left.sessionFilePath)
      : left.sessionFilePath.localeCompare(right.sessionFilePath))
    .slice(0, options.maxSessions ?? sessionFiles.length);

  const sessions: ClaudeCodeSessionFile[] = [];
  for (const file of orderedFiles) {
    const workspacePath = (await readFirstCwd(file.sessionFilePath)) ?? decodeClaudeProjectSlug(file.projectName);
    sessions.push({
      sessionFilePath: file.sessionFilePath,
      workspacePath,
      gitRoot: workspacePath ? findGitRoot(workspacePath) : null
    });
  }

  return sessions;
}

/** Reads read first cwd. */
async function readFirstCwd(filePath: string): Promise<string | null> {
  try {
    for await (const record of readJsonlObjects(filePath)) {
      if (typeof record.cwd === "string" && record.cwd.length > 0) {
        return record.cwd;
      }
    }
  } catch {
    return null;
  }

  return null;
}

/** Handles decode claude project slug. */
function decodeClaudeProjectSlug(slug: string): string | null {
  if (!slug.startsWith("-")) {
    return null;
  }

  return `/${slug.slice(1).split("-").filter(Boolean).join("/")}`;
}

/**
 * Searches upward from the workspace to find the git root.
 *
 * @param workspacePath Workspace path.
 * @returns The git root, or null.
 */
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
