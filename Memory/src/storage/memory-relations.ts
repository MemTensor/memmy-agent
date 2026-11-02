import type Database from "better-sqlite3";
import { invalidatePanelViews } from "./panel-security.js";
import { isRecord, parseJson } from "../utils/json.js";

/** These are already-declared provenance fields, never semantic guesses. */
export const RAW_SOURCE_SQL = `coalesce(nullif(json_extract(m.properties_json,'$.internal_info.source_raw_turn_id'),''),
  nullif(json_extract(m.properties_json,'$.internal_info.raw_turn_id'),''),
  nullif(json_extract(m.properties_json,'$.internal_info.trace.raw_turn_id'),''),json_extract(m.info_json,'$.raw_turn_id'))`;
const EPISODE_SOURCE_SQL = `coalesce(json_extract(m.properties_json,'$.internal_info.trace.episode_id'),json_extract(m.info_json,'$.episode_id'))`;
const POLICY_SOURCES_SQL = `coalesce(json_extract(m.properties_json,'$.internal_info.policy.source_trace_ids'),json_extract(m.properties_json,'$.internal_info.source_trace_ids'))`;

interface TurnSource { id: string; sessionId: string; episodeId?: string }
interface TurnMemorySource {
  id: string; session_id: string | null; info_json: string; properties_json: string;
  parent_id: string | null; parent_session: string | null;
  parent_info: string | null; parent_properties: string | null; parent_layer: string | null;
}

/** Resolve a turn's explicit sources before changing its task. UID is provenance,
 * while contradictory session/raw/task references must never be moved. */
export function turnMigrationMemoryIds(db: Database.Database, raw: TurnSource, candidateIds?: readonly string[]): string[] {
  const parentRaw = RAW_SOURCE_SQL.replaceAll("m.", "t.");
  const rows = db.prepare(`SELECT m.id,m.session_id,m.info_json,m.properties_json,
    t.id AS parent_id,t.session_id AS parent_session,t.info_json AS parent_info,
    t.properties_json AS parent_properties,t.memory_layer AS parent_layer
    FROM ${candidateIds ? "json_each(@ids) candidates CROSS JOIN " : ""}memories m LEFT JOIN memories t
      ON t.id=CASE WHEN json_extract(m.properties_json,'$.internal_info.memory_kind')='span'
        THEN json_extract(m.properties_json,'$.internal_info.span.source_trace_id') END
    WHERE ${candidateIds ? "m.id=candidates.value AND" : ""} m.memory_layer='L1' AND (${RAW_SOURCE_SQL}=@raw
      OR json_extract(m.properties_json,'$.internal_info.span.raw_turn_id')=@raw OR ${parentRaw}=@raw)`)
    .all({ raw: raw.id, ...(candidateIds ? {ids:JSON.stringify([...new Set(candidateIds)])} : {}) }) as TurnMemorySource[];
  const agrees = (values: unknown[], expected: string | undefined) => values.every(value =>
    value === undefined || value === null || value === "" || value === expected);
  const source = (session: string | null, infoJson: string, propertiesJson: string) => {
    const info = parseJson<unknown>(infoJson, {});
    const properties = parseJson<unknown>(propertiesJson, {});
    if (!isRecord(info) || !isRecord(properties)) return {valid:false,direct:false,parent:undefined,kind:undefined};
    const internal = isRecord(properties.internal_info) ? properties.internal_info : {};
    const trace = isRecord(internal.trace) ? internal.trace : {};
    const span = isRecord(internal.span) ? internal.span : {};
    const nested = isRecord(properties.info) ? properties.info : {};
    const rawIds = [internal.source_raw_turn_id, internal.raw_turn_id, trace.raw_turn_id, info.raw_turn_id, span.raw_turn_id];
    const episodes = [info.episode_id, nested.episode_id, internal.episode_id, trace.episode_id, span.episode_id];
    return { valid: (session === null || session === raw.sessionId) && agrees(rawIds, raw.id) && agrees(episodes, raw.episodeId),
      direct: rawIds.includes(raw.id), parent: span.source_trace_id, kind:internal.memory_kind };
  };
  return rows.filter(row => {
    const own = source(row.session_id, row.info_json, row.properties_json);
    if (!own.valid) return false;
    if (own.parent !== undefined && own.parent !== null && own.parent !== "") {
      if (own.parent !== row.parent_id || row.parent_id === row.id || row.parent_layer !== "L1") return false;
      const parent = source(row.parent_session, row.parent_info!, row.parent_properties!);
      return parent.valid && parent.direct && parent.kind !== "span";
    }
    return own.direct;
  }).map(row => row.id);
}

/** Validate a live L1's declared provenance, without treating historical UID as
 * a local ownership boundary. Each policy source is checked independently. */
export function resolveL1Source(db: Database.Database, id: string): { episodeId?: string; rawTurnId?: string } | undefined {
  const parentRaw = RAW_SOURCE_SQL.replaceAll("m.", "t.");
  const row = db.prepare(`SELECT m.user_id AS owner,m.session_id AS session, m.info_json AS info,m.properties_json AS properties,
    coalesce(nullif(${RAW_SOURCE_SQL},''),nullif(json_extract(m.properties_json,'$.internal_info.span.raw_turn_id'),''),nullif(${parentRaw},'')) AS raw,
    coalesce(${EPISODE_SOURCE_SQL},json_extract(m.properties_json,'$.internal_info.span.episode_id')) AS episode,
    json_extract(m.properties_json,'$.internal_info.span.source_trace_id') AS parent,
    t.id AS parentId,t.deleted_at AS parentDeleted,t.status AS parentStatus
    FROM memories m LEFT JOIN memories t ON t.id=CASE
      WHEN json_extract(m.properties_json,'$.internal_info.memory_kind')='span'
      THEN json_extract(m.properties_json,'$.internal_info.span.source_trace_id') END
    WHERE m.id=? AND m.memory_layer='L1' AND m.deleted_at IS NULL AND m.status!='deleted'`).get(id) as {
      owner: string; session: string | null; info: string; properties: string;
      raw: unknown; episode: unknown; parent: unknown; parentId: string | null;
      parentDeleted: string | null; parentStatus: string | null;
    } | undefined;
  if (!row) return undefined;
  if (row.parent != null && row.parent !== "" &&
      (row.parent !== row.parentId || row.parentDeleted || row.parentStatus === "deleted")) return undefined;
  if (row.raw != null && row.raw !== "") {
    if (typeof row.raw !== "string") return undefined;
    const raw = db.prepare(`SELECT r.id,r.session_id AS sessionId,r.episode_id AS episodeId
      FROM raw_turns r JOIN sessions s ON s.id=r.session_id LEFT JOIN episodes e ON e.id=r.episode_id
      WHERE r.id=? AND r.deleted_at IS NULL AND r.redacted_at IS NULL
        AND (r.episode_id IS NULL OR e.session_id=r.session_id)`).get(row.raw) as TurnSource | undefined;
    if (!raw) return undefined;
    const source = { ...raw, episodeId: raw.episodeId ?? undefined };
    return turnMigrationMemoryIds(db, source, [id]).includes(id) ? { episodeId: source.episodeId, rawTurnId:source.id } : undefined;
  }
  // A declared parent cannot silently fall back to an unrelated task when its
  // turn is unavailable. Source-free legacy/manual L1s retain their old path.
  if (row.parent != null && row.parent !== "") return undefined;
  if (row.episode == null || row.episode === "") return {};
  if (typeof row.episode !== "string") return undefined;
  const episode = db.prepare("SELECT id,session_id AS session,user_id AS owner FROM episodes WHERE id=?")
    .get(row.episode) as { id: string; session: string; owner: string } | undefined;
  if (!episode || (row.session !== null ? row.session !== episode.session : row.owner !== episode.owner)) return undefined;
  const info = parseJson<unknown>(row.info, {});
  const properties = parseJson<unknown>(row.properties, {});
  if (!isRecord(info) || !isRecord(properties)) return undefined;
  const internal = isRecord(properties.internal_info) ? properties.internal_info : {};
  const trace = isRecord(internal.trace) ? internal.trace : {};
  const span = isRecord(internal.span) ? internal.span : {};
  const nested = isRecord(properties.info) ? properties.info : {};
  return [info.episode_id,nested.episode_id,internal.episode_id,trace.episode_id,span.episode_id]
    .every(value => value == null || value === "" || value === episode.id) ? {episodeId:episode.id} : undefined;
}

/** Internal proof from a migration validated in the current transaction. */
export interface TurnMigrationRelations extends TurnSource { memoryIds: ReadonlySet<string> }

/** Runs inside the memory write transaction. Historical arrays/links stay stored;
 * panel readers validate both endpoints and current declared provenance. */
export function maintainMemoryRelations(db: Database.Database, id: string, invalidate = true, migration?: TurnMigrationRelations): void {
  // New raw turns opt in at creation. Keep this inverse relation in the same
  // transaction as insert/update/import, including tombstones. Stale IDs are
  // harmless: readers revalidate each target's current declared provenance.
  const rawIds = db.prepare(`SELECT json_extract(info_json,'$.raw_turn_id') AS direct,
    json_extract(properties_json,'$.internal_info.trace.raw_turn_id') AS trace,
    json_extract(properties_json,'$.internal_info.span.raw_turn_id') AS span,
    CASE WHEN json_extract(properties_json,'$.internal_info.memory_kind')='span'
      THEN json_extract(properties_json,'$.internal_info.span.source_trace_id') END AS parent
    FROM memories WHERE id=?`)
    .get(id) as { direct: unknown; trace: unknown; span: unknown; parent: unknown } | undefined;
  const parent = typeof rawIds?.parent === "string" ? db.prepare(`SELECT ${RAW_SOURCE_SQL} AS raw FROM memories m WHERE m.id=? AND m.memory_layer='L1'`)
    .get(rawIds.parent) as {raw:unknown}|undefined : undefined;
  for (const rawId of new Set([rawIds?.direct, rawIds?.trace, rawIds?.span, parent?.raw])) {
    if (typeof rawId !== "string" || !rawId) continue;
    db.prepare(`UPDATE raw_turns SET message_payload_json=json_insert(message_payload_json,'$.captured_memory_ids[#]',?)
      WHERE id=? AND json_type(message_payload_json,'$.captured_memory_ids')='array'
        AND NOT EXISTS(SELECT 1 FROM json_each(message_payload_json,'$.captured_memory_ids') WHERE value=?)`)
      .run(id, rawId, id);
  }
  const memory = db
    .prepare(
      `SELECT id,user_id AS userId,session_id AS sessionId,memory_layer AS layer,updated_at AS at,
    ${RAW_SOURCE_SQL} AS rawId,${EPISODE_SOURCE_SQL} AS episodeId,${POLICY_SOURCES_SQL} AS sources
    FROM memories m WHERE id=? AND deleted_at IS NULL AND status!='deleted'`
    )
    .get(id) as
    | {
        id: string;
        userId: string;
        sessionId: string | null;
        layer: string;
        at: string;
        rawId: string | null;
        episodeId: string | null;
        sources: string | null;
      }
    | undefined;
  if (!memory) return;
  let changed = false;
  const append = (episodeId: string, column: "l1_memory_ids_json" | "l2_policy_ids_json", memoryId: string) => {
    const result = db
      .prepare(
        `UPDATE episodes SET ${column}=json_insert(${column},'$[#]',?)
      WHERE id=? AND NOT EXISTS(SELECT 1 FROM json_each(${column}) WHERE value=?)`
      )
      .run(memoryId, episodeId, memoryId);
    changed ||= result.changes > 0;
  };
  if (migration?.episodeId && (memory.sessionId === null || memory.sessionId === migration.sessionId)) {
    const valid = db.prepare(`SELECT 1 FROM raw_turns r JOIN episodes e ON e.id=r.episode_id
      WHERE r.id=? AND r.session_id=? AND e.session_id=r.session_id AND e.id=?
        AND r.deleted_at IS NULL AND r.redacted_at IS NULL`).get(migration.id, migration.sessionId, migration.episodeId);
    if (valid && memory.layer === "L1" && migration.memoryIds.has(id)) append(migration.episodeId, "l1_memory_ids_json", id);
    if (valid && memory.layer === "L2" && memory.sources) {
      const declared = parseJson<unknown>(memory.sources, []);
      const linked = db.prepare("SELECT l.l1_memory_id AS id FROM trace_policy_links l JOIN memories m ON m.id=l.l1_memory_id WHERE l.l2_memory_id=? AND m.memory_layer='L1' AND m.deleted_at IS NULL AND m.status!='deleted'")
        .all(id) as Array<{id:string}>;
      if (Array.isArray(declared) && linked.some(trace => migration.memoryIds.has(trace.id) && declared.includes(trace.id))) {
        append(migration.episodeId, "l2_policy_ids_json", id);
      }
    }
  }
  if (migration) {
    if (changed && invalidate) invalidatePanelViews(db);
    return;
  }
  if (memory.layer === "L1") {
    const source = resolveL1Source(db, id);
    if (source?.episodeId) append(source.episodeId, "l1_memory_ids_json", id);
  }
  if (memory.layer === "L2" && memory.sources) {
    const traces = db
      .prepare(
        `SELECT DISTINCT m.id FROM memories m
      WHERE m.id IN(SELECT value FROM json_each(?)) AND m.memory_layer='L1' AND m.deleted_at IS NULL AND m.status!='deleted'`
      )
      .all(memory.sources) as Array<{ id: string }>;
    const insert =
      db.prepare(`INSERT OR IGNORE INTO trace_policy_links(id,user_id,l1_memory_id,l2_memory_id,relation,strength,created_at)
      VALUES(lower(hex(randomblob(16))),?,?,?,'supports',1,?)`);
    for (const trace of traces) {
      const source = resolveL1Source(db, trace.id);
      if (!source) continue;
      const exists = db
        .prepare("SELECT 1 FROM trace_policy_links WHERE l1_memory_id=? AND l2_memory_id=?")
        .get(trace.id, id);
      if (!exists) changed = insert.run(memory.userId, trace.id, id, memory.at).changes > 0 || changed;
      if (source.episodeId) append(source.episodeId, "l2_policy_ids_json", id);
    }
  }
  if (changed && invalidate) invalidatePanelViews(db);
}

/** Bounded, idempotent repair for missing historical links with known sources.
 * Call explicitly during maintenance, never while listing cards. */
export function repairMemoryRelations(
  db: Database.Database,
  afterId = "",
  limit = 100
): { scanned: number; nextId?: string } {
  return db.transaction(() => {
    const ids = db
      .prepare(
        "SELECT id FROM memories WHERE id>? AND memory_layer IN ('L1','L2') AND deleted_at IS NULL ORDER BY id LIMIT ?"
      )
      .pluck()
      .all(afterId, Math.min(1000, Math.max(1, limit))) as string[];
    for (const id of ids) maintainMemoryRelations(db, id);
    return { scanned: ids.length, nextId: ids.at(-1) };
  })();
}

/** Batch validate historical Episode arrays against live, currently owned endpoints. */
export function effectiveEpisodeMemoryIds(
  db: Database.Database,
  episodes: Array<{ id: string; userId?: string; sessionId?:string; l1MemoryIds: string[] }>,
  local=false
): Map<string, Set<string>> {
  const ids = [...new Set(episodes.flatMap((episode) => episode.l1MemoryIds))];
  if (!ids.length) return new Map();
  const rows = db
    .prepare(
      `SELECT m.id,coalesce(r.episode_id,${EPISODE_SOURCE_SQL}) AS episodeId,
    ${RAW_SOURCE_SQL} AS rawId,r.id AS foundRaw,m.user_id AS owner,r.user_id AS rawOwner,m.session_id AS memorySession,r.session_id AS rawSession
    FROM memories m LEFT JOIN raw_turns r ON r.id=${RAW_SOURCE_SQL}
    WHERE m.id IN(SELECT value FROM json_each(?)) AND m.memory_layer='L1' AND m.deleted_at IS NULL AND m.status!='deleted'
    AND (r.id IS NULL OR (r.deleted_at IS NULL AND r.redacted_at IS NULL))`
    )
    .all(JSON.stringify(ids)) as Array<{
    id: string;
    episodeId: string | null;
    rawId: string | null;
    foundRaw: string | null;
    owner: string;
    rawOwner: string | null;
    memorySession:string|null; rawSession:string|null;
  }>;
  const live = new Map(rows.map((row) => [row.id, row]));
  return new Map(
    episodes.map((episode) => [
      episode.id,
      new Set(
        episode.l1MemoryIds.filter((id) => {
          const row = live.get(id);
          return (
            row &&
            (local || !episode.userId || row.owner === episode.userId) &&
            (!row.rawId || (row.foundRaw && (local
              ? (!episode.sessionId || row.rawSession===episode.sessionId) && (!row.memorySession || row.memorySession===row.rawSession)
              : row.owner === row.rawOwner))) &&
            (!row.episodeId || row.episodeId === episode.id)
          );
        })
      )
    ])
  );
}

/** Governance uses current ownership, including invisible raw-turn tombstones.
 * Historical membership alone must not delete a trace rebound to another task. */
export function ownedEpisodeMemoryIds(
  db: Database.Database,
  episode: { id: string; userId: string; l1MemoryIds: string[] },
  local = false
): string[] {
  if (!episode.l1MemoryIds.length) return [];
  return selectOwnedL1Ids(db, episode, "m.id IN(SELECT value FROM json_each(?))", episode.l1MemoryIds, local);
}

/** Old split generations may be absent from a parent's latest span_ids. */
export function ownedTaskSpanIds(db: Database.Database, userId: string, id: string, sourceTraceIds: string[], local = false): string[] {
  if (!sourceTraceIds.length) return [];
  return selectOwnedL1Ids(db, {userId,id},
    "json_extract(m.properties_json,'$.internal_info.memory_kind')='span' AND json_extract(m.properties_json,'$.internal_info.span.source_trace_id') IN(SELECT value FROM json_each(?))",
    sourceTraceIds, local);
}

function selectOwnedL1Ids(db: Database.Database, episode: {userId:string;id:string}, selection: string, ids: string[], local: boolean): string[] {
  const traceRaw = RAW_SOURCE_SQL.replaceAll("m.", "t.");
  const traceEpisode = EPISODE_SOURCE_SQL.replaceAll("m.", "t.");
  // Local historical UIDs are provenance. Task and session links still have to
  // agree, including tombstoned sources; cloud keeps its owner boundary.
  const owner = local ? "1=1" : "m.user_id=?";
  const parent = local ? "(m.session_id IS NULL OR t.session_id IS NULL OR m.session_id=t.session_id)" : "t.user_id=m.user_id";
  const raw = local ? "(m.session_id IS NULL OR r.session_id=m.session_id)" : "r.user_id=m.user_id";
  const parentRaw = local ? "(t.session_id IS NULL OR tr.session_id=t.session_id)" : "tr.user_id=m.user_id";
  const taskEpisode = `coalesce(tr.episode_id,r.episode_id,${traceEpisode},${EPISODE_SOURCE_SQL},json_extract(m.properties_json,'$.internal_info.span.episode_id'))`;
  const params = [JSON.stringify(ids), ...(local ? [] : [episode.userId]), episode.id, episode.id, episode.id, episode.id];
  return db.prepare(`SELECT m.id FROM memories m
    LEFT JOIN memories t ON t.id=CASE WHEN json_extract(m.properties_json,'$.internal_info.memory_kind')='span'
      THEN json_extract(m.properties_json,'$.internal_info.span.source_trace_id') END
    LEFT JOIN raw_turns r ON r.id=coalesce(${RAW_SOURCE_SQL},json_extract(m.properties_json,'$.internal_info.span.raw_turn_id'))
    LEFT JOIN raw_turns tr ON tr.id=${traceRaw}
    WHERE ${selection} AND ${owner} AND m.memory_layer='L1' AND m.deleted_at IS NULL AND m.status!='deleted'
      AND (t.id IS NULL OR (${parent} AND t.memory_layer='L1'))
      AND (r.id IS NULL OR (${raw} AND r.episode_id=?))
      AND (tr.id IS NULL OR (${parentRaw} AND tr.episode_id=?))
      AND coalesce(${taskEpisode},?)=?
      ${local ? `AND (${taskEpisode} IS NOT NULL OR m.user_id=?)` : ""}
    ORDER BY m.id`).pluck().all(...params, ...(local ? [episode.userId] : [])) as string[];
}
