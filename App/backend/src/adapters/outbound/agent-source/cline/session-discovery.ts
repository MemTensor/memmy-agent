/** Discovers Cline conversation JSON files.
 *
 * Cline stores task histories as individual JSON task files.
 */

import { readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";

export interface DiscoveredClineSession {
  filePath: string;
  workspacePath: string | null;
  gitRoot: string | null;
  lastModified: number;
}

export interface DiscoverClineOptions {
  root: string;
  order?: "recent_first" | "path_asc";
  maxSessions?: number;
}

export async function discoverClineSessions(options: DiscoverClineOptions): Promise<DiscoveredClineSession[]> {
  const tasksDir = join(options.root, "tasks");

  let entries: string[];
  try {
    entries = await readdir(tasksDir);
  } catch {
    return [];
  }

  const sessions = await Promise.all(
    entries
      .filter((e) => extname(e) === ".json")
      .map(async (entry) => {
        const filePath = join(tasksDir, entry);
        let lastModified = 0;
        try {
          const s = await stat(filePath);
          lastModified = s.mtimeMs;
        } catch {
          // ignore
        }
        return { filePath, workspacePath: null, gitRoot: null, lastModified };
      }),
  );

  if (options.order === "recent_first") {
    sessions.sort((a, b) => b.lastModified - a.lastModified);
  } else {
    sessions.sort((a, b) => a.filePath.localeCompare(b.filePath));
  }

  if (options.maxSessions !== undefined && sessions.length > options.maxSessions) {
    return sessions.slice(0, options.maxSessions);
  }

  return sessions;
}
