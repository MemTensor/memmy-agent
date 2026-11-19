/**
 * Lists local sessions from their stores' metadata instead of from every message they hold.
 *
 * <p>The association picker shows a title, the last question, the directory and a time. Reading a session whole to
 * fill those four fields costs seconds per agent, because an agent's history is mostly tool output. Each source that
 * can answer from the ends of its store does so here; the rest, and anything this path cannot read, keeps the scan
 * path in local-session-reader, which stays the source of truth every field is compared against.</p>
 */
import type { SourceAdapter } from "@memmy/agent-source-readers/adapters/types";
import type { LocalSession } from "../local-session-reader.js";
import { listCursorSessions, planCursorSessions } from "./cursor-facts.js";
import { listJsonlSessions } from "./jsonl-facts.js";
import { planJsonlSessions } from "./jsonl-sources.js";

/** How wide the recent window is, in files, as the scan path computes it. */
export interface MetadataListOptions {
  limit: number;
  /** Files one source may look at, from `recentScanWindow`. */
  window: number;
}

/**
 * The most recent sessions of one source, read from its store's metadata.
 *
 * @returns The sessions, or `null` when this source has no metadata path or it could not read the store.
 */
export async function readRecentSessionsFromMetadata(adapter: SourceAdapter, options: MetadataListOptions): Promise<LocalSession[] | null> {
  try {
    const jsonl = await planJsonlSessions(adapter, options.window);
    if (jsonl && jsonl.files.length) {
      const listed = await listJsonlSessions(adapter, jsonl.source, jsonl.files, options.limit);
      // 一个会话也没读出来，可能是这份存储的格式对不上：交给完整扫描，宁可慢也不漏。
      if (listed.length) {
        return listed;
      }
    }
    const cursor = await planCursorSessions(adapter, options.window);
    if (cursor) {
      return await listCursorSessions(adapter, cursor, options);
    }
    return null;
  } catch {
    // 读不出来就交给完整扫描：这条路慢，但结果一定对。
    return null;
  }
}