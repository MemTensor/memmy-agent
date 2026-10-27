import { RAW_SOURCE_SQL } from "./memory-relations.js";
import type Database from "better-sqlite3";
import { agentIdMatchClause, agentIdExclusionClause, type ApiLogRecord } from "./repositories.js";
import { MemoryServiceError } from "../utils/error.js";
// Match the renderer's deduplication key across both candidate arrays.
const CANDIDATE_COUNT = (column: string) => `(SELECT count(DISTINCT CASE
  WHEN coalesce(json_extract(c.value,'$.refId'),'')!='' THEN coalesce(json_extract(c.value,'$.refKind'),'memory')||':'||json_extract(c.value,'$.refId')
  ELSE coalesce(json_extract(c.value,'$.refKind'),'')||'|'||coalesce(json_extract(c.value,'$.tier'),'')||'|'||coalesce(json_extract(c.value,'$.memoryLayer'),'')||'|'||coalesce(json_extract(c.value,'$.content'),json_extract(c.value,'$.snippet'),json_extract(c.value,'$.summary'),'') END)
  FROM (SELECT value FROM json_each(${column},'$.candidates') WHERE type='object'
    UNION ALL SELECT value FROM json_each(${column},'$.filtered') WHERE type='object') c)`;
const PROJECT = (column: string) => `CASE WHEN json_valid(${column}) THEN json_object(
 'skillId',json_extract(${column},'$.skillId'),'skill_id',json_extract(${column},'$.skill_id'),
 'kind',json_extract(${column},'$.kind'),'phase',json_extract(${column},'$.phase'),
 'name',substr(json_extract(${column},'$.name'),1,180),'title',substr(json_extract(${column},'$.title'),1,180),
 'summary',substr(json_extract(${column},'$.summary'),1,180),'reason',substr(json_extract(${column},'$.reason'),1,180),
 'content',substr(json_extract(${column},'$.content'),1,180),'query',substr(json_extract(${column},'$.query'),1,180),
 'stats',json_object('ranked',max(coalesce(json_extract(${column},'$.stats.ranked'),0),${CANDIDATE_COUNT(column)}),
   'finalReturned',coalesce(json_extract(${column},'$.stats.llmFilter.kept'),json_extract(${column},'$.stats.finalReturned'),json_array_length(${column},'$.filtered'),0)),
 'details',json(CASE WHEN json_array_length(${column},'$.details')>0 THEN json_array(json_object(
   'role',json_extract(${column},'$.details[0].role'),'traceId',json_extract(${column},'$.details[0].traceId'),
   'spanId',json_extract(${column},'$.details[0].spanId'),'summary',substr(json_extract(${column},'$.details[0].summary'),1,180),
   'spanGoal',substr(coalesce(json_extract(${column},'$.details[0].spanGoal'),json_extract(${column},'$.details[0].span_goal')),1,180),
   'query',substr(json_extract(${column},'$.details[0].query'),1,180),'content',substr(json_extract(${column},'$.details[0].content'),1,180))) ELSE '[]' END)
 ) ELSE '{}' END`;
/** Explicit log references follow the same live endpoint rules as evidence links.
 * The historical payload remains stored, but cannot resurrect removed content. */
const VISIBLE_LOG = `NOT EXISTS (
  SELECT 1 FROM (
    SELECT coalesce(json_extract(d.value,'$.spanId'),json_extract(d.value,'$.traceId')) AS memoryId
    FROM json_each(CASE WHEN json_valid(output_json) THEN output_json ELSE '{}' END,'$.details') d WHERE d.type='object'
    UNION ALL SELECT json_extract(c.value,'$.refId') FROM json_each(CASE WHEN json_valid(output_json) THEN output_json ELSE '{}' END,'$.candidates') c WHERE c.type='object'
    UNION ALL SELECT json_extract(c.value,'$.refId') FROM json_each(CASE WHEN json_valid(output_json) THEN output_json ELSE '{}' END,'$.filtered') c WHERE c.type='object'
    UNION ALL SELECT coalesce(json_extract(CASE WHEN json_valid(output_json) THEN output_json ELSE '{}' END,'$.skillId'),json_extract(CASE WHEN json_valid(output_json) THEN output_json ELSE '{}' END,'$.skill_id'),json_extract(CASE WHEN json_valid(input_json) THEN input_json ELSE '{}' END,'$.skillId'),json_extract(CASE WHEN json_valid(input_json) THEN input_json ELSE '{}' END,'$.skill_id'))
  ) reference WHERE reference.memoryId IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM memories m LEFT JOIN raw_turns r ON r.id=${RAW_SOURCE_SQL}
    WHERE m.id=panel_log_ref(reference.memoryId)
    AND m.deleted_at IS NULL AND m.status!='deleted'
    AND (${RAW_SOURCE_SQL} IS NULL OR (r.id IS NOT NULL AND r.deleted_at IS NULL AND r.redacted_at IS NULL AND r.user_id=m.user_id))
    UNION ALL SELECT 1 FROM user_memories u WHERE u.id=panel_log_ref(reference.memoryId) AND u.deleted_at IS NULL AND u.status!='deleted'
    UNION ALL SELECT 1 FROM episodes e WHERE e.id=panel_log_ref(reference.memoryId)
  )
)`;
export class PanelLogReader {
  constructor(private readonly db: Database.Database) {
    db.function("panel_log_ref", {deterministic:true}, (id: unknown) => String(id ?? "").split("::").at(-1)!.trim());
  }
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
    const tools = input.skillId
      ? ["skill_generate", "skill_evolve"]
      : input.tools?.length
        ? input.tools
        : ["memory_add", "memory_search"];
    const conditions = ["tool_name IN (SELECT value FROM json_each(?))", VISIBLE_LOG];
    const params: (string | number)[] = [JSON.stringify(tools)];
    if (input.sourceAgent) {
      const match = agentIdMatchClause("source_agent", input.sourceAgent);
      conditions.push(match.sql);
      params.push(...match.params);
    }
    const excluded = agentIdExclusionClause("source_agent", input.excludedSourceAgents ?? []);
    if (excluded) {
      conditions.push(excluded.sql);
      params.push(...excluded.params);
    }
    if (input.q?.trim()) {
      conditions.push("(instr(lower(input_json),lower(?))>0 OR instr(lower(output_json),lower(?))>0)");
      params.push(input.q.trim(), input.q.trim());
    }
    if (input.skillId) {
      const id = input.skillId.split("::").at(-1)!.trim();
      const skill = `coalesce(nullif(trim(json_extract(CASE WHEN json_valid(output_json) THEN output_json ELSE '{}' END,'$.skillId')),''),nullif(trim(json_extract(CASE WHEN json_valid(output_json) THEN output_json ELSE '{}' END,'$.skill_id')),''),nullif(trim(json_extract(CASE WHEN json_valid(input_json) THEN input_json ELSE '{}' END,'$.skillId')),''),json_extract(CASE WHEN json_valid(input_json) THEN input_json ELSE '{}' END,'$.skill_id'))`;
      conditions.push(`(${skill}=? OR substr(${skill},-?)=?)`);
      params.push(id, id.length + 2, `::${id}`);
    }
    const base = conditions.join(" AND ");
    const total = Number(
      this.db
        .prepare(`SELECT count(*) FROM api_logs WHERE ${base}`)
        .pluck()
        .get(...params)
    );
    if (input.cursor) {
      try {
        const key = JSON.parse(Buffer.from(input.cursor, "base64url").toString());
        if (typeof key.at !== "string" || !Number.isSafeInteger(key.id) || key.skillId !== input.skillId)
          throw new Error();
        conditions.push("(called_at,id)<(?,?)");
        params.push(key.at, key.id);
      } catch {
        throw new MemoryServiceError("invalid_argument", "Invalid log cursor");
      }
    }
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 20);
    const offset = input.skillId ? 0 : Math.max(input.offset ?? 0, 0);
    const rows = this.db
      .prepare(
        `SELECT id,tool_name AS toolName,source_agent AS sourceAgent,${PROJECT("input_json")} AS inputJson,${PROJECT("output_json")} AS outputJson,duration_ms AS durationMs,success,called_at AS calledAt FROM api_logs WHERE ${conditions.join(" AND ")} ORDER BY called_at DESC,id DESC LIMIT ? OFFSET ?`
      )
      .all(...params, limit + 1, offset) as Array<Omit<ApiLogRecord, "success"> & { success: number }>;
    const logs = rows
      .slice(0, limit)
      .map((row) => ({
        ...row,
        sourceAgent: row.sourceAgent ?? undefined,
        success: Boolean(row.success),
        detailAvailable: true
      }));
    const last = logs.at(-1);
    return {
      logs,
      total,
      limit,
      offset,
      nextOffset: offset + logs.length < total ? offset + logs.length : undefined,
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(JSON.stringify({ at: last.calledAt, id: last.id, skillId: input.skillId })).toString(
              "base64url"
            )
          : undefined,
      serverTime: new Date().toISOString()
    };
  }
  visibleIds(ids: number[]): Set<number> {
    if (!ids.length) return new Set();
    return new Set(this.db.prepare(`SELECT id FROM api_logs WHERE id IN (SELECT value FROM json_each(?)) AND ${VISIBLE_LOG}`)
      .pluck().all(JSON.stringify(ids)) as number[]);
  }
  detail(id: number) {
    const row = this.db
      .prepare(
        `SELECT id,tool_name AS toolName,source_agent AS sourceAgent,input_json AS inputJson,output_json AS outputJson,duration_ms AS durationMs,success,called_at AS calledAt FROM api_logs WHERE id=? AND ${VISIBLE_LOG}`
      )
      .get(id) as (Omit<ApiLogRecord, "success"> & { success: number }) | undefined;
    if (!row) throw new MemoryServiceError("not_found", "Log unavailable");
    return { ...row, sourceAgent: row.sourceAgent ?? undefined, success: Boolean(row.success) };
  }
}
