import { readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

import { isDeepseekHarnessSessionFile } from "./session-file.js";

export interface DeepseekHarnessSessionFile {
  sessionFilePath: string;
  gitRoot: string | null;
}

export async function discoverDeepseekHarnessSessions(options: {
  root: string;
  roots?: readonly string[];
  signal?: AbortSignal;
  order?: "path_asc" | "recent_first";
  maxSessions?: number;
}): Promise<DeepseekHarnessSessionFile[]> {
  const files: Array<{ path: string; mtimeMs: number }> = [];
  const directories = [...(options.roots ?? [options.root])];
  const visited = new Set<string>();
  for (let index = 0; index < directories.length; index += 1) {
    options.signal?.throwIfAborted();
    const directory = directories[index]!;
    let entries;
    try {
      const canonicalDirectory = await realpath(directory);
      if (visited.has(canonicalDirectory)) continue;
      visited.add(canonicalDirectory);
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) continue;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) directories.push(path);
      if (entry.isFile() && isDeepseekHarnessSessionFile(entry.name)) {
        try {
          files.push({ path, mtimeMs: (await stat(path)).mtimeMs });
        } catch (error) {
          // A live session can be rotated between readdir and stat.
          if (isNodeError(error) && error.code === "ENOENT") continue;
          throw error;
        }
      }
    }
  }
  return files
    .sort((left, right) => options.order === "recent_first"
      ? right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path)
      : left.path.localeCompare(right.path))
    .slice(0, options.maxSessions ?? files.length)
    .map((file) => ({ sessionFilePath: file.path, gitRoot: null }));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
