/**
 * Codex keeps the names it generated for its threads in one index next to the session files, so a
 * conversation's title is read there instead of from the rollout it belongs to.
 */
import { dirname, join } from "node:path";
import { readJsonlObjects } from "../jsonl-lines.js";

const INDEX_FILE = "session_index.jsonl";

/** The generated title of every thread Codex has indexed, by thread id; a missing index yields none. */
export async function readCodexThreadTitles(sessionsRoot: string): Promise<ReadonlyMap<string, string>> {
  const titles = new Map<string, string>();
  const indexPath = join(dirname(sessionsRoot), INDEX_FILE);
  try {
    for await (const record of readJsonlObjects(indexPath)) {
      const id = text(record.id);
      const title = oneLine(record.thread_name);
      if (id && title) {
        titles.set(id, title);
      }
    }
  } catch {
    // An older Codex has no index; its sessions fall back to a title derived from their first question.
  }
  return titles;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function oneLine(value: unknown): string | null {
  const title = text(value);
  return title ? title.replace(/\s+/gu, " ") : null;
}
