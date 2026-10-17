import type { OpencodeSession } from "./opencode-source-turn.js";

/**
 * OpenCode V2 renamed its conversation store: `session`/`message`/`part` became
 * `session_v2`/`session_message`, message parts moved inline into `data.content`,
 * and the assistant `parentID` link was dropped. These mappers project V2 rows onto
 * the V1-shaped view the shared turn parser already consumes, so both schemas share
 * one turn pipeline. Rows are fetched by the caller; only the projection lives here.
 */

/** One `session_v2` row. */
export interface OpencodeV2SessionRow {
  id: string;
  parentId: string | null;
  directory: string | null;
  agent?: string | null;
  /** Raw JSON column; `{ messageID }` marks the revert boundary like V1. */
  revert?: string | null;
}

/** One `session_message` row. `type` carries the role (`user`, `assistant`, ...). */
export interface OpencodeV2MessageRow {
  id: string;
  type: string;
  seq: number;
  /** Parsed `data` JSON. */
  data: unknown;
}

export function toOpencodeV2Session(row: OpencodeV2SessionRow): OpencodeSession {
  return {
    id: String(row.id),
    parentId: row.parentId == null ? null : String(row.parentId),
    directory: row.directory == null ? null : String(row.directory),
    agent: typeof row.agent === "string" ? row.agent : null,
    revertMessageId: opencodeV2RevertMessageId(row.revert)
  };
}

/**
 * Maps one session's `session_message` rows onto the message view the shared turn
 * parser expects. V2 has no assistant `parentID`, so turns are grouped sequentially:
 * every assistant row belongs to the latest preceding user row, which reproduces the
 * V1 parent buckets from `seq` order. Rows that are neither user nor assistant are
 * bookkeeping (`idle`, `model-switched`, `system`, `synthetic`) and are dropped.
 */
export function toOpencodeV2MessageView(
  rows: readonly OpencodeV2MessageRow[]
): Array<{ id: string; data: Record<string, unknown> | undefined }> {
  const view: Array<{ id: string; data: Record<string, unknown> | undefined }> = [];
  let parentId = "";
  for (const row of rows) {
    const data = isRecord(row.data) ? row.data : {};
    if (row.type === "user") {
      parentId = row.id;
      view.push({
        id: row.id,
        data: {
          role: "user",
          ...(typeof data.agent === "string" ? { agent: data.agent } : {}),
          time: isRecord(data.time) ? data.time : undefined
        }
      });
      continue;
    }
    if (row.type !== "assistant" || !parentId) continue;
    const time = isRecord(data.time) ? data.time : {};
    const completed = typeof time.completed === "number";
    view.push({
      id: row.id,
      data: {
        role: "assistant",
        parentID: parentId,
        ...(typeof data.agent === "string" ? { agent: data.agent } : {}),
        ...(data.summary === true ? { summary: true } : {}),
        ...(isRecord(data.error) ? { error: data.error } : {}),
        // V2 has no `finish`; a persisted completion timestamp is the stop signal.
        ...(completed ? { finish: "stop" } : {}),
        time
      }
    });
  }
  return view;
}

/**
 * Maps one `session_message` row onto the part view. V2 inlines message content in
 * `data.content`; user text lives directly in `data.text`. Reasoning parts have no V1
 * counterpart and are dropped.
 */
export function toOpencodeV2MessageParts(
  row: OpencodeV2MessageRow
): Array<{ id: string; data: Record<string, unknown> | undefined }> {
  const data = isRecord(row.data) ? row.data : {};
  if (row.type === "user") {
    const text = typeof data.text === "string" ? data.text : "";
    return text ? [{ id: row.id + ":text", data: { type: "text", text } }] : [];
  }
  if (row.type !== "assistant") return [];
  const content = Array.isArray(data.content) ? data.content : [];
  const parts: Array<{ id: string; data: Record<string, unknown> | undefined }> = [];
  for (const [index, item] of content.entries()) {
    if (!isRecord(item)) continue;
    if (item.type === "text" && typeof item.text === "string") {
      parts.push({ id: row.id + ":" + index, data: { type: "text", text: item.text } });
    } else if (item.type === "tool") {
      parts.push({
        id: row.id + ":" + index,
        data: {
          type: "tool",
          callID: typeof item.id === "string" ? item.id : undefined,
          tool: typeof item.name === "string" ? item.name : "tool",
          ...(isRecord(item.state) ? { state: item.state } : {}),
          ...(isRecord(item.metadata) ? { metadata: item.metadata } : {})
        }
      });
    } else if (item.type === "compaction") {
      parts.push({ id: row.id + ":" + index, data: { type: "compaction" } });
    }
  }
  return parts;
}

function opencodeV2RevertMessageId(value: unknown): string | null {
  const parsed = typeof value === "string" ? parseLoose(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const messageId = (parsed as { messageID?: unknown }).messageID;
  return typeof messageId === "string" && messageId ? messageId : null;
}

function parseLoose(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
