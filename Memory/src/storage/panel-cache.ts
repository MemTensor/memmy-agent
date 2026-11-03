import type Database from "better-sqlite3";
import { sourceVersion } from "./source-changes.js";
import {projectPanelLogSql} from "./panel-log-summary.js";
import { memoryDisplayedSourceSql } from "./panel-source-sql.js";
import { RAW_SOURCE_SQL } from "./memory-relations.js";
import type { MemoryStatsRow } from "../types.js";
/** Rebuildable presentation data. Source tables and their authorization remain authoritative. */
export const PANEL_CACHE_VERSION = 3;
export type PanelCachePart = "memories" | "logs" | "metrics" | "visibility";
const cacheConnections = new WeakMap<Database.Database, Database.Database>();
export function bindPanelCache(source: Database.Database, cache: Database.Database): void { cacheConnections.set(source,cache); }
export function panelCacheConnection(source: Database.Database): Database.Database { return cacheConnections.get(source) ?? source; }
export function hasPanelCache(source: Database.Database): boolean { return cacheConnections.has(source); }
/** Persistent callers are owned by the worker. Legacy synchronous APIs use TEMP data only. */
export function installPanelCache(source: Database.Database, cache?: Database.Database): void {
  const db = cache ?? source;
  const temporary = !cache || cache === source;
  bindPanelCache(source,db);
  const schema=temporary?"temp":"main";
  const existing=db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE name='panel_cache_meta'`).get();
  if(existing && db.prepare(`SELECT version FROM ${schema}.panel_cache_meta`).pluck().get()!==PANEL_CACHE_VERSION) {
    for(const row of db.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type='table' AND name GLOB 'panel_*'`).all() as Array<{name:string}>)
      db.exec(`DROP TABLE ${schema}."${row.name.replaceAll('"','""')}"`);
  }
  const ddl = `
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
 `;

  db.exec(temporary ? ddl.replaceAll("CREATE TABLE IF NOT EXISTS", "CREATE TEMP TABLE IF NOT EXISTS").replaceAll("CREATE INDEX IF NOT EXISTS ", "CREATE INDEX IF NOT EXISTS temp.") : ddl);
  db.exec(`${temporary ? "CREATE TEMP" : "CREATE"} TABLE IF NOT EXISTS panel_sync_state(
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), identity TEXT NOT NULL,generation INTEGER NOT NULL,
    seq INTEGER NOT NULL,memory_after TEXT,log_after INTEGER,seeded INTEGER NOT NULL);
    ${temporary ? "CREATE TEMP" : "CREATE"} TABLE IF NOT EXISTS panel_statistics(
    section TEXT NOT NULL,cache_key TEXT NOT NULL,snapshot_json TEXT NOT NULL,PRIMARY KEY(section,cache_key));`);
  const version = db.prepare("SELECT version FROM panel_cache_meta WHERE singleton=1").pluck().get();
  if (version !== PANEL_CACHE_VERSION) resetPanelCache(source);
}
export function resetPanelCache(source: Database.Database): void {
  const db = panelCacheConnection(source), version = sourceVersion(source);
  db.transaction(() => {
    for (const table of ["panel_memory_dirty","panel_log_dirty","panel_metric_dirty","panel_visibility_dirty","panel_memory_facts","panel_memory_visibility","panel_log_facts","panel_log_refs","panel_log_metrics","panel_statistics","panel_sync_state","panel_cache_meta"])
      db.exec(`DELETE FROM ${table}`);
    db.prepare("INSERT INTO panel_cache_meta VALUES(1,?,0,0)").run(PANEL_CACHE_VERSION);
    db.prepare("INSERT INTO panel_sync_state VALUES(1,?,?,?,NULL,NULL,0)").run(version.identity,version.generation,version.seq);
  })();
}
interface SyncState { identity:string;generation:number;seq:number;memory_after:string|null;log_after:number|null;seeded:number }
/** Bounded durable journal ingestion. Pending IDs and the ingestion cursor commit together. */
export function syncPanelCacheBatch(source: Database.Database, target: number, limit=128): boolean {
  const db=panelCacheConnection(source), version=sourceVersion(source);
  let state=db.prepare("SELECT * FROM panel_sync_state WHERE singleton=1").get() as SyncState;
  if (state.identity!==version.identity || state.generation!==version.generation || state.seq<version.floor || state.seq>version.seq) {
    resetPanelCache(source);
    state=db.prepare("SELECT * FROM panel_sync_state WHERE singleton=1").get() as SyncState;
  }
  if (state.seeded < 2) {
    const memories=state.seeded===0, table=memories?"memories":"api_logs";
    const after=memories?state.memory_after:state.log_after;
    const ids=source.prepare(`SELECT id FROM ${table} ${after===null?"":"WHERE id>?"} ORDER BY id LIMIT ?`).pluck().all(...(after===null?[limit]:[after,limit])) as Array<string|number>;
    db.transaction(()=>{
      for(const id of ids) {
        db.prepare(`INSERT OR REPLACE INTO ${memories?"panel_memory_dirty":"panel_log_dirty"} VALUES(?,?)`).run(id,state.seq);
        if(!memories)db.prepare("INSERT OR REPLACE INTO panel_metric_dirty VALUES(?,?)").run(id,state.seq);
      }
      if(ids.length)db.prepare(`UPDATE panel_sync_state SET ${memories?"memory_after":"log_after"}=? WHERE singleton=1`).run(ids.at(-1));
      if(ids.length<limit)db.prepare("UPDATE panel_sync_state SET seeded=seeded+1 WHERE singleton=1").run();
    })();
    return true;
  }
  const changes=source.prepare("SELECT seq,entity_type,entity_id FROM source_changes WHERE seq>? AND seq<=? ORDER BY seq LIMIT ?").all(state.seq,target,limit) as Array<{seq:number;entity_type:string;entity_id:string}>;
  if(!changes.length)return false;
  db.transaction(()=>{
    for(const row of changes) {
      if(row.entity_type==="memories") {
        db.prepare("INSERT OR REPLACE INTO panel_memory_dirty VALUES(?,?)").run(row.entity_id,row.seq);
        db.prepare("INSERT OR REPLACE INTO panel_visibility_dirty SELECT ?,? WHERE EXISTS(SELECT 1 FROM panel_log_refs WHERE ref_id=?) OR EXISTS(SELECT 1 FROM panel_memory_visibility WHERE id=?)").run(row.entity_id,row.seq,row.entity_id,row.entity_id);
      } else if(row.entity_type==="api_logs") {
        db.prepare("INSERT OR REPLACE INTO panel_log_dirty VALUES(?,?)").run(Number(row.entity_id),row.seq);
        db.prepare("INSERT OR REPLACE INTO panel_metric_dirty VALUES(?,?)").run(Number(row.entity_id),row.seq);
      }
    }
    const seq=changes.at(-1)!.seq;
    db.prepare("UPDATE panel_sync_state SET seq=? WHERE singleton=1").run(seq);
    db.prepare("UPDATE panel_cache_meta SET revision=?,log_revision=? WHERE singleton=1").run(seq,seq);
  })();
  return true;
}
function installMemoryIndexesWhenReady(db: Database.Database): void {
  // Bulk backfill builds these once after the final batch. Maintaining both
  // B-trees in every small transaction makes a cold cache substantially slower.
  // Existing indexes stay in place for ordinary incremental updates.
  if (db.prepare("SELECT 1 FROM panel_memory_dirty LIMIT 1").get()) return;
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_panel_memory_order ON panel_memory_facts(memory_layer,created_at DESC,updated_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS idx_panel_memory_source ON panel_memory_facts(source,memory_layer,created_at DESC,updated_at DESC,id DESC);
  `);
}
export function panelCacheRevision(db: Database.Database): string {
  const v=sourceVersion(db);
  return `${v.identity}-${v.generation}:${PANEL_CACHE_VERSION}:${v.seq}`;
}
export const panelLogRevision = panelCacheRevision;
export function panelCachePending(db: Database.Database, parts: readonly PanelCachePart[]): boolean {
  return parts.some(part => Boolean(panelCacheConnection(db).prepare(`SELECT 1 FROM ${dirtyTable(part)} LIMIT 1`).get()));
}
function dirtyTable(part: PanelCachePart) {
  return part === "memories" ? "panel_memory_dirty" : part === "logs" ? "panel_log_dirty" : part === "visibility" ? "panel_visibility_dirty" : "panel_metric_dirty";
}
/** Commit one bounded batch. A changed dirty revision prevents publishing an older projection. */
export function fillPanelCacheBatch(source: Database.Database, part: PanelCachePart, limit = 128, selected?: readonly (string | number)[]): number {
  const db=panelCacheConnection(source),dirty=dirtyTable(part);
  const ids=db.prepare(`SELECT id FROM ${dirty} ${selected?"WHERE id IN (SELECT value FROM json_each(?))":""} ORDER BY rowid LIMIT ?`).pluck().all(...(selected?[JSON.stringify(selected),limit]:[limit])) as Array<string|number>;
  if(!ids.length) { if(part==="memories")installMemoryIndexesWhenReady(db); return 0; }
  const keys=JSON.stringify(ids);
  // Read source rows before beginning a cache-only write transaction.
  if(part==="logs") {
    const rows=source.prepare(`SELECT id,tool_name,source_agent,called_at,duration_ms,success,input_json,output_json,
      ${projectPanelLogSql("input_json")} AS projected_input,${projectPanelLogSql("output_json")} AS projected_output
      FROM api_logs WHERE id IN (SELECT value FROM json_each(?))`).all(keys) as CacheRow[];
    const facts=rows.map(row=>({id:row.id!,value:logFact(row)}));
    db.transaction(()=>{
      db.prepare("DELETE FROM panel_log_facts WHERE id IN (SELECT value FROM json_each(?))").run(keys);
      db.prepare("DELETE FROM panel_log_refs WHERE log_id IN (SELECT value FROM json_each(?))").run(keys);
      for(const {id,value} of facts) {
        db.prepare("INSERT INTO panel_log_facts VALUES(?,?,?,?,?,?,?,?,?)").run(...value.values);
        for(const ref of value.refs) {
          db.prepare("INSERT OR IGNORE INTO panel_log_refs VALUES(?,?)").run(id,ref);
          db.prepare("INSERT OR IGNORE INTO panel_visibility_dirty VALUES(?,0)").run(ref);
        }
      }
      db.prepare(`DELETE FROM ${dirty} WHERE id IN (SELECT value FROM json_each(?))`).run(keys);
    })();
  } else {
    const displayed=memoryDisplayedSourceSql("CASE WHEN json_type(info_json,'$.source')='text' THEN json_extract(info_json,'$.source') END");
    const query=part==="visibility"?`SELECT m.id,${RAW_SOURCE_SQL} FROM memories m WHERE m.id IN (SELECT value FROM json_each(?))`
      :part==="memories"?`WITH projected AS MATERIALIZED (
        SELECT id,memory_layer,status,created_at,updated_at,session_id,conversation_id,agent_id,app_id,
          jsonb(info_json) AS info_json,jsonb(properties_json) AS properties_json
        FROM memories WHERE id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL)
        SELECT m.id,m.memory_layer,m.status,m.created_at,m.updated_at,
        panel_source(${displayed},CASE WHEN json_type(properties_json,'$.internal_info.source')='text' THEN json_extract(properties_json,'$.internal_info.source') END,session_id,conversation_id,agent_id,app_id),${RAW_SOURCE_SQL},m.session_id FROM projected m`
      :`SELECT id,tool_name,source_agent,called_at,duration_ms,success,
        CASE WHEN json_valid(output_json) THEN CASE WHEN json_type(output_json,'$.stats.topRelevance') IN ('integer','real') AND json_extract(output_json,'$.stats.topRelevance') BETWEEN -1.7976931348623157e308 AND 1.7976931348623157e308 THEN max(0,json_extract(output_json,'$.stats.topRelevance')) END END
        FROM api_logs WHERE id IN (SELECT value FROM json_each(?))`;
    const rows=source.prepare(query).raw().all(keys) as Array<Array<string|number|null>>;
    const table=part==="visibility"?"panel_memory_visibility":part==="memories"?"panel_memory_facts":"panel_log_metrics";
    db.transaction(()=>{
      db.prepare(`DELETE FROM ${table} WHERE id IN (SELECT value FROM json_each(?))`).run(keys);
      const insert=db.prepare(`INSERT INTO ${table} VALUES(${Array(part==="visibility"?2:part==="memories"?8:7).fill("?").join(",")})`);
      for(const row of rows)insert.run(...row);
      db.prepare(`DELETE FROM ${dirty} WHERE id IN (SELECT value FROM json_each(?))`).run(keys);
    })();
    if(part==="memories")installMemoryIndexesWhenReady(db);
  }
  return ids.length;
}
/** Direct/in-memory callers use the same projection as the worker. Readonly snapshots must be prepared first. */
export function ensurePanelCache(db: Database.Database, parts: readonly PanelCachePart[]): void {
  if (db.readonly) {
    if (panelCachePending(db, parts))
      throw new Error("Panel cache changed before read snapshot");
    return;
  }
  if (!hasPanelCache(db)) installPanelCache(db);
  const target=sourceVersion(db).seq;
  while(syncPanelCacheBatch(db,target)) { /* synchronous compatibility for embedded callers; production uses the worker */ }
  for (const part of parts)
    while (fillPanelCacheBatch(db, part, part === "logs" ? 64 : 512)) { /* bounded transactions */ }
}
/** Legacy page/detail callers materialize only the requested IDs, never the whole log. */
export function ensurePanelLogIds(db: Database.Database, ids: readonly number[]): void {
  if (!db.readonly) ensurePanelCache(db,[]);
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
export function visibleFactSql(fact: string): string {
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
  for (const row of db.prepare(`SELECT id,memory_layer,status,created_at,updated_at,source FROM panel_memory_facts f WHERE ${visibleFactSql("f")}`).iterate() as IterableIterator<{
    id: string;
    memory_layer: MemoryStatsRow["memoryLayer"];
    status: MemoryStatsRow["status"];
    created_at: string;
    updated_at: string;
    source: string;
  }>) {
    yield { id: row.id, memoryLayer: row.memory_layer, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, infoSource: row.source };
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
