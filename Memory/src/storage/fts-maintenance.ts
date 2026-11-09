import type Database from "better-sqlite3";
import { retrievalDocumentForMemory } from "../algorithm/plugin-algorithms.js";
import type { MemoryRow } from "../types.js";

type Kind = "memories" | "user_memories";
/** A savepoint also protects callers already inside a business transaction. */
export function writeFts(db: Database.Database, kind: Kind, id: string, values?: readonly string[]): void {
  db.transaction(() => {
    db.prepare(`INSERT OR IGNORE INTO ${kind}_fts_ids(memory_id) VALUES(?)`).run(id);
    const rowid = db.prepare(`SELECT fts_rowid FROM ${kind}_fts_ids WHERE memory_id=?`).pluck().get(id) as number;
    db.prepare(`DELETE FROM ${kind}_fts WHERE rowid=?`).run(rowid);
    if (values) {
      const columns = kind === "memories" ? "identifier,memory_value,tags" : "content,memory_types";
      db.prepare(`INSERT INTO ${kind}_fts(rowid,id,${columns}) VALUES(${Array(values.length + 2).fill("?").join(",")})`).run(rowid,id,...values);
    }
    db.prepare("DELETE FROM fts_repair_queue WHERE kind=? AND memory_id=?").run(kind,id);
  })();
}

/** Rebuild only on schema upgrade; canonical source rows repair missing/duplicate/orphan FTS entries. */
export function installFtsMappings(db: Database.Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS fts_repair_queue(kind TEXT NOT NULL,memory_id TEXT NOT NULL,PRIMARY KEY(kind,memory_id))");
  for (const kind of ["memories", "user_memories"] as const) {
    const exists = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(`${kind}_fts_ids`));
    db.exec(`CREATE TABLE IF NOT EXISTS ${kind}_fts_ids(fts_rowid INTEGER PRIMARY KEY AUTOINCREMENT,memory_id TEXT NOT NULL UNIQUE)`);
    if (!exists) {
      db.exec(`INSERT INTO ${kind}_fts_ids(fts_rowid,memory_id) SELECT min(f.rowid),f.id FROM ${kind}_fts f JOIN ${kind} s ON s.id=f.id GROUP BY f.id;
        DELETE FROM ${kind}_fts;`);
      let after = "";
      while (true) {
        const ids = db.prepare(`SELECT id FROM ${kind} WHERE id>? ORDER BY id LIMIT 256`).pluck().all(after) as string[];
        if (!ids.length) break;
        for (const id of ids) repairFts(db,kind,id);
        after = ids.at(-1)!;
      }
    }
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${kind}_fts_delete AFTER DELETE ON ${kind} BEGIN
      DELETE FROM ${kind}_fts WHERE rowid=(SELECT fts_rowid FROM ${kind}_fts_ids WHERE memory_id=OLD.id);
      DELETE FROM ${kind}_fts_ids WHERE memory_id=OLD.id;
      DELETE FROM fts_repair_queue WHERE kind='${kind}' AND memory_id=OLD.id;
    END`);
  }
}

export function repairFts(db: Database.Database, kind: Kind, id: string): void {
  if (kind === "user_memories") {
    const row = db.prepare("SELECT content,memory_types_json,status,deleted_at FROM user_memories WHERE id=?").get(id) as
      {content:string;memory_types_json:string;status:string;deleted_at:string|null} | undefined;
    writeFts(db,kind,id,row && row.status === "active" && !row.deleted_at ? [row.content,stringArray(row.memory_types_json).join(" ")] : undefined);
  } else {
    const row = db.prepare("SELECT id,memory_layer,memory_key,memory_value,tags_json,info_json,properties_json,status,deleted_at FROM memories WHERE id=?").get(id) as
      {id:string;memory_layer:MemoryRow["memoryLayer"];memory_key:string|null;memory_value:string;tags_json:string;info_json:string;properties_json:string;status:string;deleted_at:string|null} | undefined;
    const memory = row && {id:row.id,memoryLayer:row.memory_layer,memoryKey:row.memory_key,memoryValue:row.memory_value,
      tags:stringArray(row.tags_json),info:jsonObject(row.info_json),properties:jsonObject(row.properties_json)} as MemoryRow | undefined;
    writeFts(db,kind,id,row && memory && row.status !== "deleted" && !row.deleted_at ? [id,retrievalDocumentForMemory(memory),memory.tags.join(" ")] : undefined);
  }
}

export function retryFtsRepairs(db: Database.Database, limit = 16): void {
  for (const row of db.prepare("SELECT kind,memory_id FROM fts_repair_queue LIMIT ?").all(limit) as Array<{kind:Kind;memory_id:string}>) {
    try { repairFts(db,row.kind,row.memory_id); }
    catch (error) { if (isBusy(error)) throw error; }
  }
}
export function isBusy(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && String(error.code).startsWith("SQLITE_BUSY");
}

function stringArray(text:string):string[] {try{const value:unknown=JSON.parse(text);return Array.isArray(value)?value.filter((x):x is string=>typeof x==="string"):[];}catch{return [];}}
function jsonObject(text:string):Record<string,unknown> {try{const value:unknown=JSON.parse(text);return value && typeof value==="object" && !Array.isArray(value)?value as Record<string,unknown>:{};}catch{return {};}}
