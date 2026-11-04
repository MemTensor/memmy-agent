/**
 * The title an agent generated for a conversation, read from its own session store.
 *
 * A person recognises a conversation by the name its agent shows, not by the first sentence they typed.
 * Claude Code and WorkBuddy append a title record to the session file; without reading it the association
 * picker could only guess from the first message.
 */
import { open } from "node:fs/promises";

/** How much of a session file's end to read; agents rewrite the title as the conversation moves on. */
const TAIL_WINDOW_BYTES = 512 * 1024;
/** How much of the start to read when the end has no title, for a title written once and never updated. */
const HEAD_WINDOW_BYTES = 512 * 1024;
/** Matching a title row without parsing every line first: a session file can be tens of megabytes. */
const TITLE_ROW_PATTERN = /"type"\s*:\s*"(?:custom-title|ai-title|agent-name)"/u;

/**
 * The title kinds agents write, best first. A title a person or the agent settled on outranks the name
 * derived from the work, which in turn outranks the agent's own display name.
 */
const TITLE_KINDS = [
  { type: "custom-title", field: "customTitle" },
  { type: "ai-title", field: "aiTitle" },
  { type: "agent-name", field: "agentName" }
] as const;

/** Collects title rows while a session file streams, so no second pass over the file is needed. */
export interface JsonlTitleTracker {
  /** The title this row carries, if any; `null` for every other row. */
  observe(record: Record<string, unknown>): string | null;
  /** The best title seen so far, or `null` before the agent has written one. */
  current(): string | null;
}

/** Creates a tracker over one conversation's rows. */
export function createJsonlTitleTracker(): JsonlTitleTracker {
  const found = new Map<string, string>();
  const current = (): string | null => {
    for (const kind of TITLE_KINDS) {
      const title = found.get(kind.type);
      if (title) return title;
    }
    return null;
  };
  return {
    observe(record) {
      const type = typeof record.type === "string" ? record.type : "";
      const kind = TITLE_KINDS.find((candidate) => candidate.type === type);
      if (!kind) return null;
      const title = oneLineText(record[kind.field]) ?? oneLineText(record.title);
      if (!title) return null;
      found.set(kind.type, title);
      return current();
    },
    current
  };
}

/**
 * Reads the title out of a session file the caller does not stream itself: the last title row wins,
 * falling back to a title written once at the start of a conversation that was never retitled.
 */
export async function readJsonlSessionTitle(filePath: string): Promise<string | null> {
  return (await readTitleWindow(filePath, "tail")) ?? (await readTitleWindow(filePath, "head"));
}

async function readTitleWindow(filePath: string, from: "head" | "tail"): Promise<string | null> {
  const windowBytes = from === "tail" ? TAIL_WINDOW_BYTES : HEAD_WINDOW_BYTES;
  let handle;
  try {
    handle = await open(filePath, "r");
  } catch {
    return null;
  }
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, windowBytes);
    if (length <= 0) return null;
    const start = from === "tail" ? size - length : 0;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return lastTitleRow(buffer.subarray(0, bytesRead).toString("utf8"));
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** The last title row in the text, or `null`; a window may cut the first or last line, so parse failures drop. */
function lastTitleRow(text: string): string | null {
  const tracker = createJsonlTitleTracker();
  let title: string | null = null;
  for (const line of text.split("\n")) {
    if (!TITLE_ROW_PATTERN.test(line)) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(record)) continue;
    const observed = tracker.observe(record);
    if (observed) title = observed;
  }
  return title;
}

function oneLineText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const collapsed = value.replace(/\s+/gu, " ").trim();
  return collapsed.length > 0 ? collapsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
