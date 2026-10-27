import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { MemoryServiceError } from "../utils/error.js";

const PAGE_SIZE = 20;
const PREVIEW_CHARACTERS = 1024;
const PAGE_BYTE_BUDGET = 256 * 1024;
const CHUNK_CHARACTERS = 4096;
const FIELDS = {
  userText: "user_text",
  assistantText: "assistant_text",
  reasoningSummary: "reasoning_summary",
  toolCalls: "tool_calls_json",
  toolResults: "tool_results_json"
} as const;
interface ToolSummary {
  id: string;
  field: "toolCalls" | "toolResults";
  name: string;
  characters: number;
}
export type PanelTurnField = keyof typeof FIELDS;
interface TurnKey {
  createdAt: string;
  id: string;
}

interface FieldCache {
  key: string;
  generation: string;
  text: string;
  revision: string;
  nextOffset: number;
  nextIndex: number;
}
// One explicitly opened field per connection; no persistence or background hydration.
const fieldCaches = new WeakMap<Database.Database, FieldCache>();
const FIELD_CACHE_BYTES = 16 * 1024 * 1024;

/** Display-only SQL: large dialogue and tool payloads never cross this boundary implicitly. */
export class PanelTaskReader {
  constructor(private readonly db: Database.Database) {
    db.function("panel_field_hash", { deterministic: true }, (value: unknown) =>
      createHash("sha256")
        .update(String(value ?? ""))
        .digest("hex")
    );
  }

  summaries(ids: string[]): Map<string, { firstUserText: string; firstAssistantText: string; toolCallCount: number }> {
    if (!ids.length) return new Map();
    const rows = this.db
      .prepare(
        `SELECT e.id,
      coalesce((SELECT substr(r.user_text, 1, 180) FROM raw_turns r WHERE r.episode_id=e.id AND r.deleted_at IS NULL AND r.redacted_at IS NULL AND r.user_id=e.user_id AND trim(coalesce(r.user_text,'')) != '' ORDER BY r.created_at, r.id LIMIT 1),'') AS firstUserText,
      coalesce((SELECT substr(r.assistant_text, 1, 180) FROM raw_turns r WHERE r.episode_id=e.id AND r.deleted_at IS NULL AND r.redacted_at IS NULL AND r.user_id=e.user_id AND trim(coalesce(r.assistant_text,'')) != '' ORDER BY r.created_at, r.id LIMIT 1),'') AS firstAssistantText,
      (SELECT count(*) FROM raw_turns r, json_each(r.tool_calls_json) c WHERE r.episode_id=e.id AND r.deleted_at IS NULL AND r.redacted_at IS NULL AND r.user_id=e.user_id AND c.type='object') AS toolCallCount
      FROM episodes e WHERE e.id IN (SELECT value FROM json_each(?))`
      )
      .all(JSON.stringify(ids)) as Array<{
      id: string;
      firstUserText: string;
      firstAssistantText: string;
      toolCallCount: number;
    }>;
    return new Map(rows.map(({ id, ...value }) => [id, value]));
  }

  turns(episodeId: string, cursor?: string) {
    let before: TurnKey | undefined;
    let anchor: TurnKey | undefined;
    if (cursor) {
      try {
        const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (value.episodeId !== episodeId || !validKey(value.before) || !validKey(value.anchor)) throw new Error();
        before = value.before;
        anchor = value.anchor;
      } catch {
        throw new MemoryServiceError("invalid_argument", "Invalid task turn cursor");
      }
    }
    const rows = this.db
      .prepare(
        `SELECT id AS rawTurnId, turn_id AS turnId, created_at AS createdAt,
      substr(user_text,1,${PREVIEW_CHARACTERS}) AS userText, substr(assistant_text,1,${PREVIEW_CHARACTERS}) AS assistantText,
      substr(reasoning_summary,1,${PREVIEW_CHARACTERS}) AS reasoningSummary,
      length(coalesce(user_text,'')) > ${PREVIEW_CHARACTERS} AS moreUser,
      length(coalesce(assistant_text,'')) > ${PREVIEW_CHARACTERS} AS moreAssistant,
      length(coalesce(reasoning_summary,'')) > ${PREVIEW_CHARACTERS} AS moreReasoning,
      json_array_length(tool_calls_json) AS toolCallCount, json_array_length(tool_results_json) AS toolResultCount
      FROM raw_turns WHERE episode_id=? AND deleted_at IS NULL AND redacted_at IS NULL AND raw_turns.user_id=(SELECT user_id FROM episodes WHERE id=raw_turns.episode_id)
      ${before ? "AND (created_at, id) < (?, ?)" : ""}
      ORDER BY created_at DESC, id DESC LIMIT ?`
      )
      .all(...[episodeId, ...(before ? [before.createdAt, before.id] : []), PAGE_SIZE + 1]) as Array<{
      rawTurnId: string;
      turnId: string;
      createdAt: string;
      userText: string | null;
      assistantText: string | null;
      reasoningSummary: string | null;
      moreUser: number;
      moreAssistant: number;
      moreReasoning: number;
      toolCallCount: number;
      toolResultCount: number;
    }>;
    const newest = this.latest(episodeId);
    anchor ??= newest;
    const page: Array<(typeof rows)[number] & { tools: ToolSummary[] }> = [];
    let bytes = 4096;
    for (const row of rows.slice(0, PAGE_SIZE)) {
      const tools = [
        ...this.tools(episodeId, row.rawTurnId, "toolCalls", 0, 10).tools,
        ...this.tools(episodeId, row.rawTurnId, "toolResults", 0, 10).tools
      ];
      const size = Buffer.byteLength(JSON.stringify({ ...row, tools }), "utf8") + 512;
      if (page.length && bytes + size > PAGE_BYTE_BUDGET) break;
      page.push({ ...row, tools });
      bytes += size;
    }
    const hasMore = rows.length > page.length;
    const oldest = page.at(-1);
    return {
      turns: page
        .reverse()
        .map(({ moreUser, moreAssistant, moreReasoning, ...row }) => ({
          ...row,
          episodeId,
          userText: row.userText ?? undefined,
          assistantText: row.assistantText ?? undefined,
          reasoningSummary: row.reasoningSummary ?? undefined,
          moreFields: [
            ...(moreUser ? ["userText"] : []),
            ...(moreAssistant ? ["assistantText"] : []),
            ...(moreReasoning ? ["reasoningSummary"] : []),
            ...(row.toolCallCount ? ["toolCalls"] : []),
            ...(row.toolResultCount ? ["toolResults"] : [])
          ] as PanelTurnField[]
        })),
      nextCursor:
        hasMore && oldest
          ? Buffer.from(
              JSON.stringify({ episodeId, before: { createdAt: oldest.createdAt, id: oldest.rawTurnId }, anchor })
            ).toString("base64url")
          : undefined,
      hasNewer: Boolean(
        anchor &&
        newest &&
        (newest.createdAt > anchor.createdAt || (newest.createdAt === anchor.createdAt && newest.id > anchor.id))
      )
    };
  }

  latest(episodeId: string): TurnKey | undefined {
    return this.db
      .prepare(
        `SELECT id, created_at AS createdAt FROM raw_turns WHERE episode_id=? AND deleted_at IS NULL AND redacted_at IS NULL AND raw_turns.user_id=(SELECT user_id FROM episodes WHERE id=raw_turns.episode_id) ORDER BY created_at DESC,id DESC LIMIT 1`
      )
      .get(episodeId) as TurnKey | undefined;
  }

  field(episodeId: string, turnId: string, field: PanelTurnField, offset = 0, revision?: string, toolId?: string) {
    const column = FIELDS[field];
    if (!column || !Number.isSafeInteger(offset) || offset < 0)
      throw new MemoryServiceError("invalid_argument", "Invalid turn field or offset");
    if ((field === "toolCalls" || field === "toolResults") && !toolId) {
      if (
        !this.db
          .prepare(
            "SELECT 1 FROM raw_turns WHERE id=? AND episode_id=? AND deleted_at IS NULL AND redacted_at IS NULL AND raw_turns.user_id=(SELECT user_id FROM episodes WHERE id=raw_turns.episode_id)"
          )
          .get(turnId, episodeId)
      )
        throw new MemoryServiceError("not_found", "Task turn is unavailable");
      return { text: "", revision: "tools", ...this.tools(episodeId, turnId, field, offset, 20) };
    }
    const visible = this.db
      .prepare(
        `SELECT 1 FROM raw_turns WHERE id=? AND episode_id=?
      AND deleted_at IS NULL AND redacted_at IS NULL
      AND raw_turns.user_id=(SELECT user_id FROM episodes WHERE id=raw_turns.episode_id)`
      )
      .get(turnId, episodeId);
    if (!visible) throw new MemoryServiceError("not_found", "Task turn is unavailable");
    const generation = `${this.db.pragma("data_version", { simple: true })}:${this.db.prepare("SELECT total_changes()").pluck().get()}`;
    const key = JSON.stringify([episodeId, turnId, field, toolId]);
    let cached = fieldCaches.get(this.db);
    if (!cached || cached.key !== key || cached.generation !== generation) {
      let expression: string = column;
      let expectedHash: string | undefined;
      if (toolId) {
        if (field !== "toolCalls" && field !== "toolResults")
          throw new MemoryServiceError("invalid_argument", "Tool id requires a tool field");
        const decoded = this.toolKey(toolId);
        expression = `json_extract(${column},'$[${decoded.index}]')`;
        expectedHash = decoded.hash;
      }
      const row = this.db.prepare(`SELECT ${expression} AS text FROM raw_turns WHERE id=?`).get(turnId) as {
        text: unknown;
      };
      const text = row.text === null ? "" : String(row.text);
      const hash = createHash("sha256").update(text).digest("hex");
      if (expectedHash && hash !== expectedHash)
        throw new MemoryServiceError("conflict", "Tool content changed; reload the conversation");
      cached = { key, generation, text, revision: hash, nextOffset: 0, nextIndex: 0 };
      fieldCaches.delete(this.db);
      if (text.length * 2 <= FIELD_CACHE_BYTES) fieldCaches.set(this.db, cached);
    }
    if (offset > 0 && revision !== cached.revision)
      throw new MemoryServiceError("conflict", "Turn content changed; reload the field");
    // Walk code points without allocating an array proportional to the full field.
    const advance = (index: number, count: number) => {
      while (count-- > 0 && index < cached.text.length) index += cached.text.codePointAt(index)! > 0xffff ? 2 : 1;
      return index;
    };
    const start = offset === cached.nextOffset ? cached.nextIndex : advance(0, offset);
    const end = advance(start, CHUNK_CHARACTERS);
    cached.nextOffset = offset + CHUNK_CHARACTERS;
    cached.nextIndex = end;
    return {
      text: cached.text.slice(start, end),
      revision: cached.revision,
      nextOffset: end < cached.text.length ? cached.nextOffset : undefined
    };
  }

  private toolKey(id: string): { index: number; hash: string } {
    try {
      const value = JSON.parse(Buffer.from(id, "base64url").toString());
      if (!Number.isSafeInteger(value.index) || value.index < 0 || typeof value.hash !== "string") throw new Error();
      return value;
    } catch {
      throw new MemoryServiceError("invalid_argument", "Invalid tool identifier");
    }
  }
  private tools(
    episodeId: string,
    turnId: string,
    field: "toolCalls" | "toolResults",
    offset: number,
    limit: number
  ): { tools: ToolSummary[]; nextOffset?: number } {
    const rows = this.db
      .prepare(
        `SELECT tool.key AS position,
      substr(coalesce(json_extract(CASE WHEN tool.type='object' THEN tool.value ELSE '{}' END,'$.name'),json_extract(CASE WHEN tool.type='object' THEN tool.value ELSE '{}' END,'$.toolName'),json_extract(CASE WHEN tool.type='object' THEN tool.value ELSE '{}' END,'$.tool_call_id'),'Tool'),1,80) AS name,
      length(tool.value) AS characters,panel_field_hash(tool.value) AS hash
      FROM raw_turns, json_each(${FIELDS[field]}) tool
      WHERE raw_turns.id=? AND episode_id=? AND deleted_at IS NULL AND redacted_at IS NULL AND raw_turns.user_id=(SELECT user_id FROM episodes WHERE id=raw_turns.episode_id) AND tool.key>=?
      ORDER BY tool.key LIMIT ?`
      )
      .all(turnId, episodeId, offset, limit + 1) as Array<{
      position: number;
      name: string;
      characters: number;
      hash: string;
    }>;
    return {
      tools: rows
        .slice(0, limit)
        .map((row) => ({
          id: Buffer.from(JSON.stringify({ index: row.position, hash: row.hash })).toString("base64url"),
          field,
          name: row.name,
          characters: row.characters
        })),
      nextOffset: rows.length > limit ? offset + limit : undefined
    };
  }
}

function validKey(value: unknown): value is TurnKey {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "createdAt" in value &&
    typeof value.createdAt === "string"
  );
}
