/** Discovers Windsurf conversation JSON files under the data directory.
 *
 * Windsurf stores each conversation as a ``{id}.json`` file under
 * ``~/.codeium/windsurf/conversations/``.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { readDirectoryEntries } from "../read-directory.js";

export interface DiscoveredWindsurfConversation {
  filePath: string;
  workspacePath: string | null;
  gitRoot: string | null;
  lastModified: number;
}

export interface DiscoverWindsurfOptions {
  root: string;
  order?: "recent_first" | "path_asc";
  maxSessions?: number;
}

export async function discoverWindsurfConversations(
  options: DiscoverWindsurfOptions,
): Promise<DiscoveredWindsurfConversation[]> {
  const conversationsDir = join(options.root, "conversations");

  let entries: string[];
  try {
    entries = await readdir(conversationsDir);
  } catch {
    return [];
  }

  const conversations = await Promise.all(
    entries
      .filter((e) => e.endsWith(".json"))
      .map(async (entry) => {
        const filePath = join(conversationsDir, entry);
        let lastModified = 0;
        try {
          const s = await stat(filePath);
          lastModified = s.mtimeMs;
        } catch {
          // ignore stat errors
        }
        return { filePath, workspacePath: null, gitRoot: null, lastModified };
      }),
  );

  if (options.order === "recent_first") {
    conversations.sort((a, b) => b.lastModified - a.lastModified);
  } else {
    conversations.sort((a, b) => a.filePath.localeCompare(b.filePath));
  }

  if (options.maxSessions !== undefined && conversations.length > options.maxSessions) {
    return conversations.slice(0, options.maxSessions);
  }

  return conversations;
}
