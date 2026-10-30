import type Database from "better-sqlite3";
import {projectPanelLogSql} from "./panel-log-summary.js";
import { memoryDisplayedSourceSql } from "./panel-source-sql.js";
import { RAW_SOURCE_SQL } from "./memory-relations.js";
import type { MemoryStatsRow } from "../types.js";
import { panelSourceForStatsRow } from "../utils/panel-source.js";
/** Rebuildable presentation data. Source tables and their authorization remain authoritative. */
export const PANEL_CACHE_VERSION = 2;
const TABLES = {
  memories: "panel_memory_dirty",
  api_logs: "panel_log_dirty"
} as const;
export type PanelCachePart = "memories" | "logs" | "metrics" | "visibility";
export function installPanelCache(db: Database.Database): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS panel_cache_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, revision INTEGER NOT NULL, log_revision INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS panel_memory_dirty(id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS panel_log_dirty(id INTEGER PRIMARY KEY, revision INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS panel_metric_dirty(id INTEGER PRIMARY KEY, revision INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS panel_memory_facts(id TEXT PRIMARY KEY, memory_layer TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, source TEXT NOT NULL,raw_id TEXT,session_id TEXT);
  CREATE TABLE IF NOT EXISTS panel_memory_visibility(id TEXT PRIMARY KEY,raw_id TEXT);
  CREATE INDEX IF NOT EXISTS idx_panel_memory_raw ON panel_memory_visibility(raw_id,id);
  CREATE TABLE IF NOT EXISTS panel_visibility_dirty(id TEXT PRIMARY KEY,revision INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS panel_log_facts(id INTEGER PRIMARY KEY, tool_name TEXT NOT NULL, source_agent TEXT, called_at TEXT NOT NULL, duration_ms REAL NOT NULL, success INTEGER NOT NULL, input_json TEXT NOT NULL, output_json TEXT NOT NULL, skill_id TEXT);
  CREATE INDEX IF NOT EXISTS idx_panel_logs_order ON panel_log_facts(called_at DESC,id DESC);
  CREATE INDEX IF NOT EXISTS idx_panel_logs_tool ON panel_log_facts(tool_name,called_at DESC,id DESC);
  CREATE INDEX IF NOT EXISTS idx_panel_logs_skill ON panel_log_facts(skill_id,called_at DESC,id DESC);
  CREATE TABLE IF NOT EXISTS panel_log_refs(log_id INTEGER NOT NULL, ref_id TEXT NOT NULL, PRIMARY KEY(log_id,ref_id));
  CREATE INDEX IF NOT EXISTS idx_panel_log_refs_target ON panel_log_refs(ref_id,log_id);
  CREATE TABLE IF NOT EXISTS panel_log_metrics(id INTEGER PRIMARY KEY,tool_name TEXT NOT NULL,source_agent TEXT,called_at TEXT NOT NULL,duration_ms REAL NOT NULL,success INTEGER NOT NULL,recall_score REAL);
  CREATE INDEX IF NOT EXISTS idx_panel_log_metrics_order ON panel_log_metrics(tool_name,called_at DESC,id DESC);
 `);
  const meta = db.prepare("SELECT version FROM panel_cache_meta WHERE singleton=1").get() as {
    version: number;
  } | undefined;
  if (meta && meta.version !== PANEL_CACHE_VERSION) {
    // Cache format changes discard only derived data; source/schema data is untouched.
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'panel_cache_*'").all() as Array<{
      name: string;
    }>)
      db.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
    for (const table of ["panel_cache_meta", "panel_memory_dirty", "panel_log_dirty", "panel_metric_dirty", "panel_visibility_dirty", "panel_memory_facts", "panel_memory_visibility", "panel_log_facts", "panel_log_refs", "panel_log_metrics"])
      db.exec(`DROP TABLE ${table}`);
    installPanelCache(db);
    return;
  }
  if (!meta) {
    db.prepare("INSERT INTO panel_cache_meta VALUES(1,?,1,1)").run(PANEL_CACHE_VERSION);
    // Cheap ID-only initialization. JSON is parsed later in bounded, restartable worker batches.
    db.exec(`INSERT INTO panel_memory_dirty SELECT id,1 FROM memories NOT INDEXED;
   INSERT INTO panel_log_dirty SELECT id,1 FROM api_logs;
   INSERT INTO panel_metric_dirty SELECT id,1 FROM api_logs;`);
  }
  const bump = "UPDATE panel_cache_meta SET revision=revision+1 WHERE singleton=1;";
  for (const [table, dirty] of Object.entries(TABLES)) {
    for (const event of ["INSERT", "UPDATE", "DELETE"] as const) {
      const row = event === "DELETE" ? "OLD" : "NEW";
      const old = event === "UPDATE" ? `INSERT OR REPLACE INTO ${dirty} SELECT OLD.id,revision FROM panel_cache_meta;` : "";
      const metrics = table === "api_logs" ? `INSERT OR REPLACE INTO panel_metric_dirty SELECT ${row}.id,revision FROM panel_cache_meta;
    ${event === "UPDATE" ? "INSERT OR REPLACE INTO panel_metric_dirty SELECT OLD.id,revision FROM panel_cache_meta;" : ""}` : "";
      const visibility = table === "memories" ? `INSERT OR IGNORE INTO panel_visibility_dirty SELECT ${row}.id,revision FROM panel_cache_meta WHERE EXISTS(SELECT 1 FROM panel_log_refs WHERE ref_id=${row}.id) OR EXISTS(SELECT 1 FROM panel_memory_visibility WHERE id=${row}.id);
    ${event === "UPDATE" ? "INSERT OR IGNORE INTO panel_visibility_dirty SELECT OLD.id,revision FROM panel_cache_meta WHERE EXISTS(SELECT 1 FROM panel_log_refs WHERE ref_id=OLD.id) OR EXISTS(SELECT 1 FROM panel_memory_visibility WHERE id=OLD.id);" : ""}` : "";
      const logRevision = table === "api_logs" ? "UPDATE panel_cache_meta SET log_revision=log_revision+1;" : `UPDATE panel_cache_meta SET log_revision=log_revision+1 WHERE EXISTS(SELECT 1 FROM panel_log_refs WHERE ref_id=CAST(${row}.id AS TEXT)${event === "UPDATE" ? " OR ref_id=CAST(OLD.id AS TEXT)" : ""});`;
      db.exec(`CREATE TRIGGER IF NOT EXISTS panel_cache_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN
    ${bump}${logRevision}${old} INSERT OR REPLACE INTO ${dirty} SELECT ${row}.id,revision FROM panel_cache_meta; ${metrics}${visibility} END;`);
    }
  }
  for (const table of ["user_memories", "episodes"])
    for (const event of ["INSERT", "UPDATE", "DELETE"]) {
      const row = event === "DELETE" ? "OLD" : "NEW";
      db.exec(`CREATE TRIGGER IF NOT EXISTS panel_cache_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN
   ${table === "user_memories" ? bump : ""}
   UPDATE panel_cache_meta SET log_revision=log_revision+1 WHERE EXISTS(SELECT 1 FROM panel_log_refs WHERE ref_id=CAST(${row}.id AS TEXT)${event === "UPDATE" ? " OR ref_id=CAST(OLD.id AS TEXT)" : ""}); END;`);
    }
  for (const event of ["INSERT", "UPDATE", "DELETE"]) {
    const row = event === "DELETE" ? "OLD" : "NEW";
    db.exec(`CREATE TRIGGER IF NOT EXISTS panel_cache_raw_${event.toLowerCase()} AFTER ${event} ON raw_turns BEGIN
   UPDATE panel_cache_meta SET log_revision=log_revision+1 WHERE EXISTS(SELECT 1 FROM panel_memory_visibility f JOIN panel_log_refs r ON r.ref_id=f.id WHERE f.raw_id=${row}.id${event === "UPDATE" ? " OR f.raw_id=OLD.id" : ""}); END;`);
  }
}
export function panelCacheRevision(db: Database.Database): string {
  const row = db.prepare("SELECT version,revision FROM panel_cache_meta WHERE singleton=1").get() as {
    version: number;
    revision: number;
  };
  return `${row.version}:${row.revision}`;
}
export function panelLogRevision(db: Database.Database): string {
  const row = db.prepare("SELECT version,log_revision FROM panel_cache_meta WHERE singleton=1").get() as {
    version: number;
    log_revision: number;
  };
  return `${row.version}:${row.log_revision}`;
}
export function panelCachePending(db: Database.Database, parts: readonly PanelCachePart[]): boolean {
  return parts.some(part => Boolean(db.prepare(`SELECT 1 FROM ${dirtyTable(part)} LIMIT 1`).get()));
}
function dirtyTable(part: PanelCachePart) {
  return part === "memories" ? "panel_memory_dirty" : part === "logs" ? "panel_log_dirty" : part === "visibility" ? "panel_visibility_dirty" : "panel_metric_dirty";
}
/** Commit one bounded batch. A changed dirty revision prevents publishing an older projection. */
export function fillPanelCacheBatch(db: Database.Database, part: PanelCachePart, limit = 64, ids?: readonly (string | number)[]): number {
  if (part !== "logs")
    return fillNativeFacts(db, part, limit, ids);
  const dirty = dirtyTable(part);
  const source = "api_logs";
  const columns = `s.id,s.tool_name,s.source_agent,s.called_at,s.duration_ms,s.success,s.input_json,s.output_json,${projectPanelLogSql("s.input_json")} AS projected_input,${projectPanelLogSql("s.output_json")} AS projected_output`;
  const rows = db.prepare(`SELECT d.id AS dirty_id,d.revision AS dirty_revision,${columns} FROM ${dirty} d LEFT JOIN ${source} s ON s.id=d.id ${ids ? "WHERE d.id IN (SELECT value FROM json_each(?))" : ""} ORDER BY d.id LIMIT ?`).all(...(ids ? [JSON.stringify(ids), limit] : [limit])) as CacheRow[];
  if (!rows.length)
    return 0;
  const projected = rows.map(row => ({ row, value: row.id !== null ? logFact(row) : undefined }));
  db.transaction(() => {
    const targets = new Set<string>();
    const current = db.prepare(`SELECT revision FROM ${dirty} WHERE id=?`);
    const done = db.prepare(`DELETE FROM ${dirty} WHERE id=? AND revision=?`);
    const logWrite = db.prepare("INSERT OR REPLACE INTO panel_log_facts VALUES(?,?,?,?,?,?,?,?,?)");
    const logDelete = db.prepare("DELETE FROM panel_log_facts WHERE id=?");
    const refsDelete = db.prepare("DELETE FROM panel_log_refs WHERE log_id=?");
    const ref = db.prepare("INSERT OR IGNORE INTO panel_log_refs VALUES(?,?)");
    for (const { row, value } of projected) {
      if ((current.get(row.dirty_id) as {
        revision: number;
      } | undefined)?.revision !== row.dirty_revision)
        continue;
      refsDelete.run(row.dirty_id);
      if (!value)
        logDelete.run(row.dirty_id);
      else {
        logWrite.run(...value.values);
        for (const id of value.refs) {
          ref.run(row.dirty_id, id);
          targets.add(id);
        }
      }
      done.run(row.dirty_id, row.dirty_revision);
    }
    db.prepare(`INSERT OR IGNORE INTO panel_visibility_dirty SELECT m.id,revision FROM memories m,panel_cache_meta WHERE m.id IN(SELECT value FROM json_each(?)) AND NOT EXISTS(SELECT 1 FROM panel_memory_visibility v WHERE v.id=m.id)`).run(JSON.stringify([...targets]));
  })();
  return rows.length;
}
const registered = new WeakSet<Database.Database>();
function fillNativeFacts(db: Database.Database, part: "memories" | "metrics" | "visibility", limit: number, selected?: readonly (string | number)[]): number {
  const dirty = dirtyTable(part);
  const ids = db.prepare(`SELECT id FROM ${dirty} ${selected ? "WHERE id IN (SELECT value FROM json_each(?))" : ""} ORDER BY rowid LIMIT ?`).pluck().all(...(selected ? [JSON.stringify(selected), limit] : [limit]));
  if (!ids.length)
    return 0;
  if (!registered.has(db)) {
    db.function("panel_source", { deterministic: true }, (infoSource, internalSource, sessionId, conversationId, agentId, appId) => panelSourceForStatsRow({ infoSource, internalSource, sessionId: typeof sessionId === "string" ? sessionId : undefined, conversationId: typeof conversationId === "string" ? conversationId : undefined, agentId: typeof agentId === "string" ? agentId : undefined, appId: typeof appId === "string" ? appId : undefined }));
    registered.add(db);
  }
  const keys = JSON.stringify(ids), source = part === "metrics" ? "api_logs" : "memories", target = part === "memories" ? "panel_memory_facts" : part === "visibility" ? "panel_memory_visibility" : "panel_log_metrics";
  db.transaction(() => {
    if (part === "visibility") {
      db.prepare(`INSERT OR REPLACE INTO panel_memory_visibility SELECT m.id,${RAW_SOURCE_SQL} FROM memories m WHERE m.id IN(SELECT value FROM json_each(?))`).run(keys);
    }
    else if (part === "memories") {
      const displayed = memoryDisplayedSourceSql("CASE WHEN json_type(info_json,'$.source')='text' THEN json_extract(info_json,'$.source') END");
      db.prepare(`WITH projected AS MATERIALIZED (
      SELECT id,memory_layer,status,created_at,updated_at,session_id,conversation_id,agent_id,app_id,
        jsonb(info_json) AS info_json,jsonb(properties_json) AS properties_json
      FROM memories WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL
    ) INSERT OR REPLACE INTO panel_memory_facts SELECT m.id,m.memory_layer,m.status,m.created_at,m.updated_at,
    panel_source(${displayed},CASE WHEN json_type(properties_json,'$.internal_info.source')='text' THEN json_extract(properties_json,'$.internal_info.source') END,session_id,conversation_id,agent_id,app_id),${RAW_SOURCE_SQL},m.session_id
    FROM projected m`).run(keys);
    }
    else {
      db.prepare(`INSERT OR REPLACE INTO panel_log_metrics SELECT id,tool_name,source_agent,called_at,duration_ms,success,
    CASE WHEN json_valid(output_json) THEN CASE WHEN json_type(output_json,'$.stats.topRelevance') IN ('integer','real') AND json_extract(output_json,'$.stats.topRelevance') BETWEEN -1.7976931348623157e308 AND 1.7976931348623157e308 THEN max(0,json_extract(output_json,'$.stats.topRelevance')) END END
    FROM api_logs WHERE id IN (SELECT value FROM json_each(?))`).run(keys);
    }
    db.prepare(`DELETE FROM ${target} WHERE id IN (SELECT value FROM json_each(?)) AND NOT EXISTS(SELECT 1 FROM ${source} s WHERE s.id=${target}.id ${part === "memories" ? "AND s.deleted_at IS NULL" : ""})`).run(keys);
    db.prepare(`DELETE FROM ${dirty} WHERE id IN (SELECT value FROM json_each(?))`).run(keys);
  })();
  return ids.length;
}
/** Direct/in-memory callers use the same projection as the worker. Readonly snapshots must be prepared first. */
export function ensurePanelCache(db: Database.Database, parts: readonly PanelCachePart[]): void {
  if (db.readonly) {
    if (panelCachePending(db, parts))
      throw new Error("Panel cache changed before read snapshot");
    return;
  }
  for (const part of parts)
    while (fillPanelCacheBatch(db, part, part === "logs" ? 64 : 512)) { /* bounded transactions */ }
}
/** Legacy page/detail callers materialize only the requested IDs, never the whole log. */
export function ensurePanelLogIds(db: Database.Database, ids: readonly number[]): void {
  const targets = () => db.prepare("SELECT DISTINCT ref_id FROM panel_log_refs WHERE log_id IN (SELECT value FROM json_each(?))").pluck().all(JSON.stringify(ids)) as string[];
  if (db.readonly) {
    if (panelLogIdsPending(db,ids)) throw new Error("Panel cache changed before read snapshot");
    return;
  }
  while (fillPanelCacheBatch(db, "logs", 64, ids)) { /* bounded transactions */ }
  const referenced = targets();
  while (fillPanelCacheBatch(db, "visibility", 512, referenced)) { /* bounded transactions */ }
}
export function panelLogIdsPending(db: Database.Database, ids: readonly number[]): boolean {
  if (db.prepare("SELECT 1 FROM panel_log_dirty WHERE id IN (SELECT value FROM json_each(?)) LIMIT 1").get(JSON.stringify(ids))) return true;
  return Boolean(db.prepare(`SELECT 1 FROM panel_visibility_dirty d JOIN panel_log_refs r ON r.ref_id=d.id
    WHERE r.log_id IN (SELECT value FROM json_each(?)) LIMIT 1`).get(JSON.stringify(ids)));
}
/** Shared management predicate. Source state is read live through its primary key;
 * only the declared source pointer is cached, so raw privacy changes need no JSON scan. */
function visibleFactSql(fact: string): string {
  return `${fact}.status!='deleted' AND (${fact}.raw_id IS NULL OR EXISTS(
    SELECT 1 FROM raw_turns r WHERE r.id=${fact}.raw_id AND r.deleted_at IS NULL AND r.redacted_at IS NULL
      AND (${fact}.session_id IS NULL OR ${fact}.session_id=r.session_id)))`;
}
export function panelVisibleMemorySql(memory = "memories"): string {
  return `EXISTS(SELECT 1 FROM panel_memory_facts panel_fact WHERE panel_fact.id=${memory}.id AND ${visibleFactSql("panel_fact")})`;
}
export function panelVisibleMemoryIds(db: Database.Database, ids: readonly string[]): Set<string> {
  ensurePanelCache(db,["memories"]);
  if (!ids.length) return new Set();
  return new Set(db.prepare(`SELECT f.id FROM panel_memory_facts f WHERE f.id IN(SELECT value FROM json_each(?)) AND ${visibleFactSql("f")}`)
    .pluck().all(JSON.stringify(ids)) as string[]);
}
export function* panelMemoryStats(db: Database.Database, prepared = false): IterableIterator<MemoryStatsRow> {
  if (!prepared) ensurePanelCache(db, ["memories"]);
  for (const row of db.prepare(`SELECT memory_layer,status,created_at,updated_at,source FROM panel_memory_facts f WHERE ${visibleFactSql("f")}`).iterate() as IterableIterator<{
    memory_layer: MemoryStatsRow["memoryLayer"];
    status: MemoryStatsRow["status"];
    created_at: string;
    updated_at: string;
    source: string;
  }>) {
    yield { memoryLayer: row.memory_layer, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, infoSource: row.source };
  }
}
export function panelAnalysisLogs(db: Database.Database, prepared = false) {
  if (!prepared) ensurePanelCache(db, ["metrics"]);
  return (db.prepare("SELECT id,tool_name AS toolName,source_agent AS sourceAgent,called_at AS calledAt,duration_ms AS durationMs,success,recall_score FROM panel_log_metrics WHERE id IN (SELECT id FROM api_logs WHERE tool_name IN ('memory_add','memory_search') ORDER BY called_at DESC,id DESC LIMIT 10000) ORDER BY called_at DESC,id DESC LIMIT 10000").all() as Array<{
    id: number;
    toolName: "memory_add" | "memory_search";
    sourceAgent: string | null;
    calledAt: string;
    durationMs: number;
    success: number;
    recall_score: number | null;
  }>).map(row => ({ ...row, sourceAgent: row.sourceAgent ?? undefined, success: Boolean(row.success), inputJson: "{}", outputJson: JSON.stringify({ stats: row.recall_score === null ? {} : { topRelevance: row.recall_score } }) }));
}
interface CacheRow {
  dirty_id: string | number;
  dirty_revision: number;
  id: string | number | null;
  tool_name: string;
  source_agent: string | null;
  called_at: string;
  duration_ms: number;
  success: number;
  input_json: string;
  output_json: string;
  projected_input: string;
  projected_output: string;
}
type Fact = {
  values: Array<string | number | null>;
  refs: string[];
};
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function scalar(value: unknown): string | number | null { return value == null ? null : typeof value === "object" ? JSON.stringify(value) : typeof value === "boolean" ? Number(value) : value as string | number; }
function coalesce(...values: unknown[]) { return values.find(value => value !== undefined && value !== null) ?? null; }
function logFact(row: CacheRow): Fact {
  const parse = (text: string): Record<string, unknown> => {
    try { return object(JSON.parse(text)); }
    catch { return {}; }
  };
  const input = parse(row.input_json), output = parse(row.output_json), refs: unknown[] = [];
  for (const item of Array.isArray(output.details) ? output.details : []) {
    const d = object(item);
    refs.push(coalesce(d.spanId, d.traceId));
  }
  for (const item of [...(Array.isArray(output.candidates) ? output.candidates : []), ...(Array.isArray(output.filtered) ? output.filtered : [])])
    refs.push(object(item).refId);
  refs.push(coalesce(output.skillId, output.skill_id, input.skillId, input.skill_id));
  const trimmed = (value: unknown) => String(scalar(value) ?? "").trim() || undefined;
  const skill = coalesce(trimmed(output.skillId), trimmed(output.skill_id), trimmed(input.skillId), input.skill_id);
  return {
    values: [row.id!, row.tool_name, row.source_agent, row.called_at, row.duration_ms, row.success,
      row.projected_input, row.projected_output, skill == null ? null : String(scalar(skill)).split("::").at(-1)!],
    refs: [...new Set(refs.filter(ref => ref != null).map(ref => String(scalar(ref)).split("::").at(-1)!.trim()))]
  };
}

/** Freeze the work set for one statistics generation. Ordinary additions are
 * picked up by the next generation rather than keeping the first one waiting. */
export function panelStatisticsDirtyIds(db: Database.Database, part: "memories" | "metrics"): Array<string | number> {
  return db.prepare(part === "memories" ? "SELECT id FROM panel_memory_dirty ORDER BY rowid" :
    `SELECT d.id FROM panel_metric_dirty d WHERE d.id IN (
       SELECT id FROM api_logs WHERE tool_name IN ('memory_add','memory_search') ORDER BY called_at DESC,id DESC LIMIT 10000
     ) OR NOT EXISTS(SELECT 1 FROM api_logs a WHERE a.id=d.id)`).pluck().all() as Array<string | number>;
}
