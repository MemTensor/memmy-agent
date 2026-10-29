import type Database from "better-sqlite3";
import { agentIdMatchClause, agentIdExclusionClause, type ApiLogRecord } from "./repositories.js";
import { MemoryServiceError } from "../utils/error.js";
import { ensurePanelCache, ensurePanelLogIds, panelLogRevision } from "./panel-cache.js";
import { panelSafetyToken } from "./panel-security.js";
/** References are indexed; visibility always comes from current authoritative endpoints. */
function visibleLog(id: string): string {
  return `NOT EXISTS(SELECT 1 FROM panel_log_refs reference WHERE reference.log_id=${id} AND NOT EXISTS(
  SELECT 1 FROM memories m JOIN panel_memory_visibility f ON f.id=m.id LEFT JOIN raw_turns r ON r.id=f.raw_id
   WHERE m.id=reference.ref_id AND m.deleted_at IS NULL AND m.status!='deleted'
   AND (f.raw_id IS NULL OR (r.id IS NOT NULL AND r.deleted_at IS NULL AND r.redacted_at IS NULL AND r.user_id=m.user_id))
  UNION ALL SELECT 1 FROM user_memories u WHERE u.id=reference.ref_id AND u.deleted_at IS NULL AND u.status!='deleted'
  UNION ALL SELECT 1 FROM episodes e WHERE e.id=reference.ref_id))`;
}
const matches = new WeakMap<Database.Database, {
  revision: string;
  values: Map<string, number[]>;
}>();
const counts = new WeakMap<Database.Database, {
  revision: string;
  values: Map<string, number>;
}>();
export class PanelLogReader {
  constructor(private readonly db: Database.Database) { }
  list(input: {
    tools?: string[];
    sourceAgent?: string;
    excludedSourceAgents?: string[];
    limit?: number;
    offset?: number;
    skillId?: string;
    cursor?: string;
    q?: string;
  }) {
    const query = input.q?.trim();
    ensurePanelCache(this.db, ["logs", "visibility"]);
    const tools = input.skillId ? ["skill_generate", "skill_evolve"] : input.tools?.length ? input.tools : ["memory_add", "memory_search"];
    const conditions = ["l.tool_name IN (SELECT value FROM json_each(?))"];
    const params: Array<string | number> = [JSON.stringify(tools)];
    if (input.sourceAgent) {
      const match = agentIdMatchClause("l.source_agent", input.sourceAgent);
      conditions.push(match.sql);
      params.push(...match.params);
    }
    const excluded = agentIdExclusionClause("l.source_agent", input.excludedSourceAgents ?? []);
    if (excluded) {
      conditions.push(excluded.sql);
      params.push(...excluded.params);
    }
    const revision = `${panelLogRevision(this.db)}:${panelSafetyToken(this.db)}`;
    if (query) {
      let cached = matches.get(this.db);
      if (cached?.revision !== revision) {
        cached = { revision, values: new Map() };
        matches.set(this.db, cached);
      }
      const key = JSON.stringify([conditions, params, query]);
      let ids = cached.values.get(key);
      if (!ids) {
        // Scope-wide original substring matching is done once per query/version, before pagination.
        ids = this.db.prepare(`SELECT l.id FROM api_logs l WHERE ${conditions.join(" AND ")} AND (instr(lower(l.input_json),lower(?))>0 OR instr(lower(l.output_json),lower(?))>0)`).pluck().all(...params, query, query) as number[];
        cached.values.set(key, ids);
        if (cached.values.size > 32)
          cached.values.delete(cached.values.keys().next().value!);
      }
      conditions.push("l.id IN (SELECT value FROM json_each(?))");
      params.push(JSON.stringify(ids));
    }
    conditions.push(visibleLog("l.id"));
    if (input.skillId) {
      conditions.push("l.skill_id=?");
      params.push(input.skillId.split("::").at(-1)!.trim());
    }
    const base = conditions.join(" AND ");
    let cache = counts.get(this.db);
    if (cache?.revision !== revision) {
      cache = { revision, values: new Map() };
      counts.set(this.db, cache);
    }
    const key = JSON.stringify([base, params]);
    let total = cache.values.get(key);
    if (total === undefined) {
      total = Number(this.db.prepare(`SELECT count(*) FROM panel_log_facts l WHERE ${base}`).pluck().get(...params));
      cache.values.set(key, total);
      if (cache.values.size > 32)
        cache.values.delete(cache.values.keys().next().value!);
    }
    if (input.cursor) {
      try {
        const cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString());
        if (typeof cursor.at !== "string" || !Number.isSafeInteger(cursor.id) || cursor.skillId !== input.skillId)
          throw new Error();
        conditions.push("(l.called_at,l.id)<(?,?)");
        params.push(cursor.at, cursor.id);
      }
      catch {
        throw new MemoryServiceError("invalid_argument", "Invalid log cursor");
      }
    }
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 20), offset = input.skillId ? 0 : Math.max(input.offset ?? 0, 0);
    const rows = this.db.prepare(`SELECT l.id,l.tool_name AS toolName,l.source_agent AS sourceAgent,l.input_json AS inputJson,l.output_json AS outputJson,l.duration_ms AS durationMs,l.success,l.called_at AS calledAt
   FROM panel_log_facts l INDEXED BY idx_panel_logs_order WHERE ${conditions.join(" AND ")} ORDER BY l.called_at DESC,l.id DESC LIMIT ? OFFSET ?`).all(...params, limit + 1, offset) as Array<Omit<ApiLogRecord, "success"> & {
      success: number;
    }>;
    const logs = rows.slice(0, limit).map(row => ({ ...row, sourceAgent: row.sourceAgent ?? undefined, success: Boolean(row.success), detailAvailable: true }));
    const last = logs.at(-1);
    return { logs, total, limit, offset, nextOffset: offset + logs.length < total ? offset + logs.length : undefined, nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ at: last.calledAt, id: last.id, skillId: input.skillId })).toString("base64url") : undefined, serverTime: new Date().toISOString() };
  }
  visibleIds(ids: number[]): Set<number> {
    if (!ids.length)
      return new Set();
    ensurePanelLogIds(this.db, ids);
    return new Set(this.db.prepare(`SELECT a.id FROM api_logs a WHERE a.id IN (SELECT value FROM json_each(?)) AND ${visibleLog("a.id")}`).pluck().all(JSON.stringify(ids)) as number[]);
  }
  detail(id: number) {
    ensurePanelLogIds(this.db, [id]);
    const row = this.db.prepare(`SELECT a.id,a.tool_name AS toolName,a.source_agent AS sourceAgent,a.input_json AS inputJson,a.output_json AS outputJson,a.duration_ms AS durationMs,a.success,a.called_at AS calledAt
   FROM api_logs a WHERE a.id=? AND ${visibleLog("a.id")}`).get(id) as (Omit<ApiLogRecord, "success"> & {
      success: number;
    }) | undefined;
    if (!row)
      throw new MemoryServiceError("not_found", "Log unavailable");
    return { ...row, sourceAgent: row.sourceAgent ?? undefined, success: Boolean(row.success) };
  }
}
