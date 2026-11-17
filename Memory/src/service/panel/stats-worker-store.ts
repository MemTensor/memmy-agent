import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, readdirSync, rmdirSync } from "node:fs";
import type { StoredStats } from "./stats-store.js";
import { panelSafetyToken } from "../../storage/panel-security.js";
import { panelCacheRevision } from "../../storage/panel-cache.js";

function valid(value: unknown): value is StoredStats<unknown> {
  if (!value || typeof value !== "object") return false;
  const v=value as Record<string,unknown>;
  return v.data !== undefined && ["generatedAt","safety","revision","day"].every(key=>typeof v[key]==="string");
}
export function saveStatistics(cache:Database.Database,section:string,key:string,value:unknown):void {
  if(!valid(value))throw new Error("Invalid statistics snapshot");
  cache.prepare("INSERT OR REPLACE INTO panel_statistics VALUES(?,?,?)").run(section,key,JSON.stringify(value));
}
export function loadStatistics(source:Database.Database,cache:Database.Database,path:string,section:string,key:string):StoredStats<unknown>|undefined {
  const file=["overview","full"].includes(section)
    ? `${path}.panel-statistics/${section}-${createHash("sha256").update(key).digest("hex")}.json` : undefined;
  const saved=cache.prepare("SELECT snapshot_json FROM panel_statistics WHERE section=? AND cache_key=?").pluck().get(section,key);
  if(typeof saved==="string") {
    try {const value:unknown=JSON.parse(saved);if(valid(value)){
      // A prior crash may have committed SQLite without removing its old file.
      if(file)try{rmSync(file,{force:true});}catch{/* Retry cleanup on the next read. */}
      return value;
    }}catch{/* Rebuild malformed derived data. */}
  }
  // Only the known old overview/full file is eligible. A failed cache write leaves it for retry.
  if(!file)return undefined;
  let old: {format?:unknown;database?:unknown;key?:unknown;snapshot?:unknown};
  try {old=JSON.parse(readFileSync(file,"utf8"));}catch(error){
    if(error instanceof SyntaxError)rmSync(file,{force:true});
    return undefined;
  }
  const snapshot=old.snapshot;
  if(old.format===1 && old.database===path && old.key===key && valid(snapshot) && snapshot.safety===panelSafetyToken(source)) {
    // Legacy cache revisions are not source journal cursors. Mark imported data stale.
    const value={...snapshot,bytes:Buffer.byteLength(JSON.stringify(snapshot.data)),revision:panelCacheRevision(source).replace(/:[^:]+$/u,":legacy")};
    cache.transaction(()=>{cache.prepare("INSERT OR IGNORE INTO panel_statistics VALUES(?,?,?)").run(section,key,JSON.stringify(value));})();
    rmSync(file,{force:true});
    return value;
  }
  rmSync(file,{force:true});
  return undefined;
}
export function clearLegacyStatistics(path:string):void {
  const directory=`${path}.panel-statistics`;
  try {
    for(const name of readdirSync(directory))if(/^(overview|full)-[a-f0-9]{64}\.json(?:\..*\.tmp)?$/u.test(name))rmSync(`${directory}/${name}`,{force:true});
    if(!readdirSync(directory).length)rmdirSync(directory);
  }catch{/* Missing legacy cache is harmless. */}
}
