import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareSqliteStorage } from "../src/server/storage-startup.js";
import { MemoryDb } from "../src/storage/db.js";
import { SCHEMA_VERSION } from "../src/storage/schema.js";
import { PanelReader } from "../src/service/panel/reader.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("SQLite startup preparation", () => {
  it("prepares a database before the main service opens it without rerunning migrations", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-storage-startup-"));
    directories.push(root);
    const path = join(root, "memory.sqlite");
    const phases: string[] = [];
    await prepareSqliteStorage({ sqlitePath: path, onStage: (stage) => phases.push(stage.phase) });
    expect(phases).toContain("migration.completed");
    const database = new MemoryDb({ path, skipMigrations: true });
    expect(database.schemaVersion().version).toBe(SCHEMA_VERSION);
    database.close();
  });

  it("reads panel projections after startup preparation while keeping the reader connection readonly",async()=>{
    const root=mkdtempSync(join(tmpdir(),"memmy-startup-panel-"));
    directories.push(root);
    const path=join(root,"memory.sqlite");
    await prepareSqliteStorage({sqlitePath:path});
    const database=new MemoryDb({path,skipMigrations:true});
    const reader=new PanelReader(path);
    try{
      database.db.prepare(`INSERT INTO memories(id,timeline,user_id,memory_value,memory_layer,status,info_json,created_at,updated_at)
        VALUES('prepared-panel','now','history-owner','visible body','L1','activated','{"source":"codex"}','now','now')`).run();
      const result=await reader.run<{total:number;items:{id:string}[]}>("items",[{layer:"L1"}]);
      expect(result.data).toMatchObject({total:1,items:[{id:"prepared-panel"}]});
      const readonly=new MemoryDb({path,readonly:true});
      try{
        expect(readonly.db.pragma("query_only",{simple:true})).toBe(1);
        expect(()=>readonly.db.prepare("DELETE FROM memories").run()).toThrow(/readonly/);
      }finally{readonly.close();}
    }finally{await reader.stop();database.close();}
  });
});
