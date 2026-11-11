import Database from "better-sqlite3";
import { chmodSync, existsSync, renameSync, statSync } from "node:fs";
import { installPanelCache, resetPanelCache } from "./panel-cache.js";
import { packagedNativeBindingPath } from "./db.js";

export function openPanelCache(source: Database.Database, path: string): Database.Database {
  if(!source.readonly)throw new Error("Persistent panel cache requires a readonly source connection");
  const cachePath = `${path}.panel-cache.sqlite`;
  const nativeBinding = packagedNativeBindingPath();
  const open = () => new Database(cachePath, { ...(nativeBinding ? {nativeBinding} : {}) });
  let cache: Database.Database | undefined;
  try {
    cache = open();
    cache.pragma("journal_mode = WAL");
    cache.pragma("synchronous = NORMAL");
    cache.pragma("busy_timeout = 100");
    installPanelCache(source,cache);
  } catch (error) {
    cache?.close();
    const code = (error as {code?:string}).code;
    if (code !== "SQLITE_CORRUPT" && code !== "SQLITE_NOTADB") throw error;
    // Only this worker owns the cache. Close before quarantining all SQLite files.
    const suffix = `.corrupt-${Date.now()}`;
    for (const ext of ["", "-wal", "-shm"]) if (existsSync(cachePath+ext)) renameSync(cachePath+ext,cachePath+suffix+ext);
    cache = open();
    cache.pragma("journal_mode = WAL");
    cache.pragma("busy_timeout = 100");
    installPanelCache(source,cache);
  }
  try {
    chmodSync(cachePath,0o600);
    for (const ext of ["-wal","-shm"]) if (existsSync(cachePath+ext)) chmodSync(cachePath+ext,0o600);
    cache.exec("CREATE TABLE IF NOT EXISTS panel_source_file(singleton INTEGER PRIMARY KEY, identity TEXT NOT NULL)");
    const stat = statSync(path);
    const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    if (cache.prepare("SELECT identity FROM panel_source_file WHERE singleton=1").pluck().get() !== identity) {
      resetPanelCache(source);
      cache.prepare("INSERT OR REPLACE INTO panel_source_file VALUES(1,?)").run(identity);
    }
    // This attachment inherits the source connection's readonly open mode.
    // All cross-database joins are reads; only the separate cache handle writes.
    source.prepare("ATTACH DATABASE ? AS panel").run(cachePath);
    return cache;
  } catch (error) { cache.close(); throw error; }
}
