import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryDb } from "../../src/storage/db.js";
import { ensurePanelCache } from "../../src/storage/panel-cache.js";
import { Repositories } from "../../src/storage/repositories.js";
import { panelSourceForStatsRow } from "../../src/utils/panel-source.js";
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

  it("preserves source precedence, History classification, full-text/tag combinations and tied ordering", () => {
    const db = new MemoryDb({path: ":memory:"});
    try {
      const repos = new Repositories(db.db);
      const cases = [
        {info: {source: " Claude-old "}, internal: {source: "cursor"}},
        {info: {source: "turn.complete"}, internal: {source: "open-code-host"}},
        {info: {source: ["cursor"]}, internal: {source: {bad: "value"}}, session: "codex-legacy"},
        {info: {}, internal: {}, conversation: "cursor-legacy"},
        {info: {}, internal: {}, agent: "hermes"},
        {info: {}, internal: {}, app: "codex"},
        {info: {source: "memmy-onboarding"}, internal: {}},
        {info: {source: "cursor"}, internal: {memory_kind: "observed_activity", external_evidence: {source: "computer_history"}}},
        {info: {source: "cursor"}, internal: {external_evidence_candidate: {source: "computer_history"}}, layer: "Skill"},
        {info: {}, internal: {external_evidence_candidate: {source: "memmy", sourceRecordIds: ["2026-10-09T04-10-00Z-10min-summary", "2026-10-09T04-20-00Z-10min-summary"]}}, agent: "memmy", layer: "Skill"},
        {info: {source: "manual_%custom"}, internal: {}},
        {info: {source: "worker"}, internal: {}},
        {info: {}, internal: {}}
      ];
      const insert = db.db.prepare(`INSERT INTO memories(id,user_id,timeline,memory_key,memory_value,memory_layer,status,
        created_at,updated_at,info_json,properties_json,tags_json,session_id,conversation_id,agent_id,app_id)
        VALUES(?,'owner','now',?,?,?,?,'2026-10-30','2026-10-31',?,?,?,?,?,?,?)`);
      for (const [i, sample] of cases.entries()) {
        insert.run(`source-${i}`, `key-${i}`, "x".repeat(20000) + " deep-tail 中文 a%b_c", sample.layer ?? "L1",
          i % 3 === 0 ? "archived" : "activated", JSON.stringify({...sample.info, tags: ["info-tag"]}),
          JSON.stringify({internal_info: sample.internal, tags: ["property-tag"]}), '["stored-tag"]',
          sample.session ?? null, sample.conversation ?? null, sample.agent ?? null, sample.app ?? null);
      }
      ensurePanelCache(db.db, ["memories"]);
      const filters: MemoryFilter[] = [];
      for (const memoryLayer of [undefined, "L1", "Skill", ["L1", "Skill"]] as const)
        for (const agentId of [undefined, "cursor", "codex", "claude_code", "opencode", "memmy-agent", "computer_history", "manual_%custom", "unknown"])
          filters.push({panelSource:true, panelVisible:true, memoryLayer: typeof memoryLayer === "string" ? memoryLayer : memoryLayer && [...memoryLayer], agentId});
      filters.push({panelSource:true,panelVisible:true,excludedAgentIds:["memmy-agent","cursor","codex","claude_code","opencode","hermes","computer_history"]});
      const samples = filters.flatMap(filter => [undefined,"deep-tail","中文","a%b_c","key-1"].map(query=>({filter,query})));
      for (const tag of ["stored-tag", "info-tag", "property-tag", "missing"])
        samples.push({filter:{panelSource:true,panelVisible:true,agentId:"cursor",tags:[tag],status:["activated","archived"]},query:"deep-tail"});
      const expected = samples.map(({filter,query})=>repos.memories.panelMemberIds({...filter,ids:[]},query));
      db.db.function("panel_source",{deterministic:true},()=>{throw new Error("clean source projection was ignored");});
      samples.forEach(({filter,query},i)=>expect(repos.memories.panelMemberIds(filter,query),JSON.stringify({filter,query})).toEqual(expected[i]));
      expect(repos.memories.panelMemberIds({panelSource:true,panelVisible:true,agentId:"memmy-agent"})).toEqual(expect.arrayContaining(["source-7","source-8","source-9"]));
    } finally { db.close(); }
  });

  it("reclassifies only dirty memories and installs indexes on an existing clean cache without rebuilding it", () => {
    const root = mkdtempSync(join(tmpdir(), "panel-member-upgrade-"));
    const path = join(root, "memory.sqlite");
    let db = new MemoryDb({path});
    try {
      const insert = db.db.prepare(`INSERT INTO memories(id,user_id,timeline,memory_value,memory_layer,created_at,updated_at,info_json)
        VALUES(?,'owner','now','body','L1','2026-10-30','2026-10-31','{"source":"cursor"}')`);
      db.db.transaction(()=>{for(let i=0;i<300;i++)insert.run(`m-${i}`);})();
      ensurePanelCache(db.db,["memories"]);
      const before = db.db.prepare("SELECT * FROM panel_memory_facts ORDER BY id").all();
      const meta = db.db.prepare("SELECT * FROM panel_cache_meta").get();
      db.db.exec("DROP INDEX idx_panel_memory_source; DROP INDEX idx_panel_memory_order");
      db.close(); db = new MemoryDb({path});
      expect(db.db.prepare("SELECT * FROM panel_cache_meta").get()).toEqual(meta);
      expect(db.db.prepare("SELECT * FROM panel_memory_facts ORDER BY id").all()).toEqual(before);
      expect(db.db.prepare("SELECT count(*) FROM panel_memory_dirty").pluck().get()).toBe(0);
      expect(db.db.prepare("SELECT name FROM sqlite_master WHERE name IN ('idx_panel_memory_source','idx_panel_memory_order')").all()).toHaveLength(2);
      let classified = 0;
      const register = () => db.db.function("panel_source",{deterministic:true},(infoSource,internalSource,sessionId,conversationId,agentId,appId)=>{
        classified++;
        return panelSourceForStatsRow({infoSource,internalSource,sessionId:sessionId as string,conversationId:conversationId as string,agentId:agentId as string,appId:appId as string});
      });
      // Register after the existing cache writer has registered its own function.
      ensurePanelCache(db.db,["memories"]);
      const repos = new Repositories(db.db), filter: MemoryFilter = {panelSource:true,panelVisible:true,memoryLayer:"L1",agentId:"cursor"};
      register(); expect(repos.memories.panelMemberIds(filter)).toHaveLength(300); expect(classified).toBe(0);
      db.db.prepare("UPDATE memories SET info_json=? WHERE id='m-0'").run(JSON.stringify({source:"codex"}));
      // First dirty batch on a reopened connection registers its canonical function.
      ensurePanelCache(db.db,["memories"]); register(); classified = 0;
      db.db.prepare("UPDATE memories SET info_json=? WHERE id='m-1'").run(JSON.stringify({source:"codex"}));
      expect(repos.memories.panelMemberIds(filter)).toHaveLength(298); expect(classified).toBe(1);
      expect(repos.memories.panelMemberIds({...filter,agentId:"codex"})).toEqual(["m-1","m-0"]); expect(classified).toBe(1);
      db.db.exec("DELETE FROM memories WHERE id='m-1'");
      expect(repos.memories.panelMemberIds({...filter,agentId:"codex"})).toEqual(["m-0"]); expect(classified).toBe(1);
    } finally { if(db.db.open)db.close(); rmSync(root,{recursive:true,force:true}); }
  });
});
