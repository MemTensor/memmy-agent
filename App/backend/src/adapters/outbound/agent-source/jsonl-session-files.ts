import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface JsonlSessionFile {
  sessionFilePath: string;
}

export interface DiscoverJsonlSessionFilesOptions {
  root: string;
  order?: "path_asc" | "recent_first";
  maxSessions?: number;
}

export async function discoverJsonlSessionFiles(
  options: DiscoverJsonlSessionFilesOptions
): Promise<JsonlSessionFile[]> {
  const files: Array<{ path: string; mtimeMs: number }> = [];
  const directories = [options.root];

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

  return files
    .sort((left, right) => options.order === "recent_first"
      ? right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path)
      : left.path.localeCompare(right.path))
    .slice(0, options.maxSessions ?? files.length)
    .map((file) => ({ sessionFilePath: file.path }));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
