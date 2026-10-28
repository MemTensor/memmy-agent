import type Database from "better-sqlite3";
import { invalidatePanelViews } from "./panel-security.js";

/** These are already-declared provenance fields, never semantic guesses. */
export const RAW_SOURCE_SQL = `coalesce(nullif(json_extract(m.properties_json,'$.internal_info.source_raw_turn_id'),''),
  nullif(json_extract(m.properties_json,'$.internal_info.raw_turn_id'),''),
  nullif(json_extract(m.properties_json,'$.internal_info.trace.raw_turn_id'),''),json_extract(m.info_json,'$.raw_turn_id'))`;
const EPISODE_SOURCE_SQL = `coalesce(json_extract(m.properties_json,'$.internal_info.trace.episode_id'),json_extract(m.info_json,'$.episode_id'))`;
const POLICY_SOURCES_SQL = `coalesce(json_extract(m.properties_json,'$.internal_info.policy.source_trace_ids'),json_extract(m.properties_json,'$.internal_info.source_trace_ids'))`;

/** Runs inside the memory write transaction. Historical arrays/links stay stored;
 * panel readers validate both endpoints and current declared provenance. */
export function maintainMemoryRelations(db: Database.Database, id: string, invalidate = true): void {
  const memory = db
    .prepare(
      `SELECT id,user_id AS userId,memory_layer AS layer,updated_at AS at,
    ${RAW_SOURCE_SQL} AS rawId,${EPISODE_SOURCE_SQL} AS episodeId,${POLICY_SOURCES_SQL} AS sources
    FROM memories m WHERE id=? AND deleted_at IS NULL AND status!='deleted'`
    )
    .get(id) as
    | {
        id: string;
        userId: string;
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
  if (memory.layer === "L1") {
    const episode = memory.rawId
      ? db
          .prepare(
            `SELECT e.id FROM raw_turns r JOIN episodes e ON e.id=r.episode_id
          WHERE r.id=? AND r.deleted_at IS NULL AND r.redacted_at IS NULL AND e.user_id=r.user_id AND r.user_id=?`
          )
          .get(memory.rawId, memory.userId)
      : db.prepare("SELECT id FROM episodes WHERE id=? AND user_id=?").get(memory.episodeId, memory.userId);
    if (episode) append((episode as { id: string }).id, "l1_memory_ids_json", id);
  }
  if (memory.layer === "L2" && memory.sources) {
    const traces = db
      .prepare(
        `SELECT DISTINCT m.id,coalesce(r.episode_id,${EPISODE_SOURCE_SQL}) AS episodeId
      FROM memories m LEFT JOIN raw_turns r ON r.id=${RAW_SOURCE_SQL}
      WHERE m.id IN(SELECT value FROM json_each(?)) AND m.user_id=? AND m.memory_layer='L1' AND m.deleted_at IS NULL AND m.status!='deleted'
      AND (${RAW_SOURCE_SQL} IS NULL OR (r.id IS NOT NULL AND r.deleted_at IS NULL AND r.redacted_at IS NULL AND r.user_id=m.user_id))`
      )
      .all(memory.sources, memory.userId) as Array<{ id: string; episodeId: string | null }>;
    const insert =
      db.prepare(`INSERT OR IGNORE INTO trace_policy_links(id,user_id,l1_memory_id,l2_memory_id,relation,strength,created_at)
      VALUES(lower(hex(randomblob(16))),?,?,?,'supports',1,?)`);
    for (const trace of traces) {
      const exists = db
        .prepare("SELECT 1 FROM trace_policy_links WHERE l1_memory_id=? AND l2_memory_id=?")
        .get(trace.id, id);
      if (!exists) changed = insert.run(memory.userId, trace.id, id, memory.at).changes > 0 || changed;
      if (trace.episodeId) append(trace.episodeId, "l2_policy_ids_json", id);
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
  episodes: Array<{ id: string; userId?: string; l1MemoryIds: string[] }>
): Map<string, Set<string>> {
  const ids = [...new Set(episodes.flatMap((episode) => episode.l1MemoryIds))];
  if (!ids.length) return new Map();
  const rows = db
    .prepare(
      `SELECT m.id,coalesce(r.episode_id,${EPISODE_SOURCE_SQL}) AS episodeId,
    ${RAW_SOURCE_SQL} AS rawId,r.id AS foundRaw,m.user_id AS owner,r.user_id AS rawOwner
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
            (!episode.userId || row.owner === episode.userId) &&
            (!row.rawId || (row.foundRaw && row.owner === row.rawOwner)) &&
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
  episode: { id: string; userId: string; l1MemoryIds: string[] }
): string[] {
  if (!episode.l1MemoryIds.length) return [];
  return selectOwnedL1Ids(db, episode, "m.id IN(SELECT value FROM json_each(?))", episode.l1MemoryIds);
}

/** Old split generations may be absent from a parent's latest span_ids. */
export function ownedTaskSpanIds(db: Database.Database, userId: string, id: string, sourceTraceIds: string[]): string[] {
  if (!sourceTraceIds.length) return [];
  return selectOwnedL1Ids(db, {userId,id},
    "json_extract(m.properties_json,'$.internal_info.memory_kind')='span' AND json_extract(m.properties_json,'$.internal_info.span.source_trace_id') IN(SELECT value FROM json_each(?))",
    sourceTraceIds);
}

function selectOwnedL1Ids(db: Database.Database, episode: {userId:string;id:string}, selection: string, ids: string[]): string[] {
  const traceRaw = RAW_SOURCE_SQL.replaceAll("m.", "t.");
  const traceEpisode = EPISODE_SOURCE_SQL.replaceAll("m.", "t.");
  return db.prepare(`SELECT m.id FROM memories m
    LEFT JOIN memories t ON t.id=CASE WHEN json_extract(m.properties_json,'$.internal_info.memory_kind')='span'
      THEN json_extract(m.properties_json,'$.internal_info.span.source_trace_id') END
    LEFT JOIN raw_turns r ON r.id=coalesce(${RAW_SOURCE_SQL},json_extract(m.properties_json,'$.internal_info.span.raw_turn_id'))
    LEFT JOIN raw_turns tr ON tr.id=${traceRaw}
    WHERE ${selection} AND m.user_id=? AND m.memory_layer='L1' AND m.deleted_at IS NULL AND m.status!='deleted'
      AND (t.id IS NULL OR (t.user_id=m.user_id AND t.memory_layer='L1'))
      AND (r.id IS NULL OR (r.user_id=m.user_id AND r.episode_id=?))
      AND (tr.id IS NULL OR (tr.user_id=m.user_id AND tr.episode_id=?))
      AND coalesce(tr.episode_id,r.episode_id,${traceEpisode},${EPISODE_SOURCE_SQL},json_extract(m.properties_json,'$.internal_info.span.episode_id'),?)=?
    ORDER BY m.id`).pluck().all(JSON.stringify(ids),episode.userId,episode.id,episode.id,episode.id,episode.id) as string[];
}
