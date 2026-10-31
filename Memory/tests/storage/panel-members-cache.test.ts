import { describe, expect, it } from "vitest";
import { MemoryDb } from "../../src/storage/db.js";
import { ensurePanelCache } from "../../src/storage/panel-cache.js";
import { Repositories } from "../../src/storage/repositories.js";
import type { MemoryFilter } from "../../src/types.js";

describe("panel member projection", () => {
  it("preserves legacy IDs and order while avoiding source parsing on every fresh view", () => {
    const db = new MemoryDb({path: ":memory:"});
    try {
      const repos = new Repositories(db.db);
      const insert = db.db.prepare(`INSERT INTO memories
        (id,user_id,timeline,memory_value,memory_layer,status,created_at,updated_at,info_json,tags_json)
        VALUES(?,'owner','now',?,? ,?,?,?, ?, '["cache"]')`);
      const sources = ["cursor-agent", "codex", "claude-code", "memmy-onboarding", "manual_kimi", "computer_history"];
      db.db.transaction(() => {
        for (let i=0;i<120;i++) insert.run(`m-${i}`, `needle ${i}`, i%7===0 ? "Skill":"L1",
          i%11===0 ? "resolving":"activated", `2026-10-${10+i%20}T00:00:00Z`,
          `2026-10-${10+(i*3)%20}T00:00:00Z`, JSON.stringify({source:sources[i%sources.length]}));
      })();
      ensurePanelCache(db.db,["memories"]);
      const cases: Array<{filter:MemoryFilter; query?:string}> = [];
      for (const agentId of [undefined, ...sources, "cursor", "claude_code", "memmy-agent"])
        for (const query of [undefined, "needle", "needle 11"])
          cases.push({filter:{panelSource:true,panelVisible:true,memoryLayer:"L1",agentId},query});
      cases.push({filter:{panelSource:true,panelVisible:true,excludedAgentIds:["cursor","codex","memmy-agent"],tags:["cache"]},query:"needle"});
      const expected = cases.map(({filter,query}) => repos.memories.panelMemberIds({...filter,ids:[]},query));
      // With a clean cache even a new view/refresh must not call the historical
      // JSON source classifier. The fallback above remains the equivalence oracle.
      db.db.function("panel_source", {deterministic:true}, () => { throw new Error("historical source reparsed"); });
      cases.forEach(({filter,query}, i) => expect(repos.memories.panelMemberIds(filter,query)).toEqual(expected[i]));
    } finally { db.close(); }
  });

  it("updates cached membership after source edits, layer changes and deletion", () => {
    const db = new MemoryDb({path: ":memory:"});
    try {
      const repos = new Repositories(db.db);
      db.db.exec(`INSERT INTO memories(id,user_id,timeline,memory_value,memory_layer,created_at,updated_at,info_json)
        VALUES('m','owner','now','body','L1','2026-10-31','2026-10-31','{"source":"cursor"}')`);
      const filter: MemoryFilter = {panelSource:true,panelVisible:true,memoryLayer:"L1",agentId:"cursor"};
      expect(repos.memories.panelMemberIds(filter)).toEqual(["m"]);
      db.db.exec(`UPDATE memories SET info_json='{"source":"codex"}' WHERE id='m'`);
      expect(repos.memories.panelMemberIds(filter)).toEqual([]);
      expect(repos.memories.panelMemberIds({...filter,agentId:"codex"})).toEqual(["m"]);
      db.db.exec("UPDATE memories SET memory_layer='Skill' WHERE id='m'");
      expect(repos.memories.panelMemberIds({...filter,agentId:"codex"})).toEqual([]);
      expect(repos.memories.panelMemberIds({...filter,agentId:"codex",memoryLayer:"Skill"})).toEqual(["m"]);
      db.db.exec("UPDATE memories SET deleted_at='2026-10-31' WHERE id='m'");
      expect(repos.memories.panelMemberIds({...filter,agentId:"codex",memoryLayer:"Skill"})).toEqual([]);
    } finally { db.close(); }
  });
});
