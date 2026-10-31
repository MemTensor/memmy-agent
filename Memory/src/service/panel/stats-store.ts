import { readFileSync, mkdirSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";
/** Version follows the statistics contract, not the application release. The
 * database's safety token additionally prevents reuse after replacement/reset. */
const FORMAT = 1;
export interface StoredStats<T> { data: T; generatedAt: string; safety: string; revision: string; day: string }
export interface StatsStore<T> {
  load(key: string): StoredStats<T> | undefined;
  save(key: string, value: StoredStats<T>): void;
}
export function statsStore<T>(database: string, section: string): StatsStore<T> | undefined {
  if (database === ":memory:") return undefined;
  const file = (key: string) => `${database}.panel-statistics/${section}-${createHash("sha256").update(key).digest("hex")}.json`;
  return {
    load(key) {
      try {
        const value = JSON.parse(readFileSync(file(key), "utf8"));
        if (value.format === FORMAT && value.database === database && value.key === key && value.snapshot?.data && ["generatedAt", "safety", "revision", "day"].every(field => typeof value.snapshot[field] === "string")) return value.snapshot;
      } catch { /* Missing/incompatible derived data is rebuilt. */ }
      return undefined;
    },
    save(key, snapshot) {
      const target = file(key);
      mkdirSync(dirname(target), {recursive:true,mode:0o700});
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify({format:FORMAT,database,key,snapshot}), {mode:0o600});
        renameSync(temporary,target);
      } finally { rmSync(temporary, {force:true}); }
    }
  };
}
