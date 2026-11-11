import {openCacheFixture} from "../fixtures/panel-cache-fixture.js";
import {SCHEMA_VERSION} from "../../src/storage/schema.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { MemoryDb } from "../../src/storage/db.js";
import { PanelLogReader } from "../../src/storage/panel-log-read.js";
import { ensurePanelCache, fillPanelCacheBatch, panelMemoryStats, panelAnalysisLogs, installPanelCache, PANEL_CACHE_VERSION } from "../../src/storage/panel-cache.js";
import { panelRecallScore } from "../../src/service/read-model/model-costs.js";
import { Repositories } from "../../src/storage/repositories.js";
const now = "2026-10-29T08:00:00Z";
function addMemory(db: MemoryDb, id: string, properties: unknown = {}) {
  db.db.prepare("INSERT INTO memories(id,timeline,user_id,memory_value,memory_layer,created_at,updated_at,properties_json) VALUES(?,'now','owner','content','L1',?,?,?)").run(id, now, now, JSON.stringify(properties));
}
function log(db: MemoryDb, content: string, source = "codex") {
  return new Repositories(db.db).runtime.insertApiLog({ toolName: "memory_add", sourceAgent: source, inputJson: JSON.stringify({ content }), outputJson: "{}", success: true, durationMs: 3, calledAt: now });
}
describe("persistent panel projections", () => {
  it("keeps internal spans and imported plugin registrations out of the shared panel projection", () => {
    const db = new MemoryDb({ path: ":memory:" });
    try {
      addMemory(db, "ordinary");
      addMemory(db, "span", { internal_info: { memory_kind: "span" } });
      addMemory(db, "plugin", { internal_info: { source_kind: "plugin", read_only: true } });
      db.db.prepare("UPDATE memories SET memory_layer='Skill' WHERE id='plugin'").run();
      ensurePanelCache(db.db, ["memories"]);
      expect([...panelMemoryStats(db.db)].map(row => row.id)).toEqual(["ordinary"]);
      db.db.prepare("UPDATE memories SET properties_json=? WHERE id='ordinary'")
        .run(JSON.stringify({ internal_info: { memory_kind: "span" } }));
      ensurePanelCache(db.db, ["memories"]);
      expect([...panelMemoryStats(db.db)]).toEqual([]);
      // Projection exclusions do not delete source rows or remove them from recall storage.
      expect(db.db.prepare("SELECT count(*) FROM memories").pluck().get()).toBe(3);
    } finally { db.close(); }
  });
  it("resumes committed batches after reopening and keeps source facts unchanged", () => {
    const root=mkdtempSync(join(tmpdir(),"panel-cache-resume-")),path=join(root,"memory.sqlite");
    const db=new MemoryDb({path});let reader=openCacheFixture(path);
    try {
      for(let i=0;i<150;i++)addMemory(db,`memory-${i}`);
      reader.ingest();expect(fillPanelCacheBatch(reader.source.db,"memories",32)).toBe(32);
      reader.close();reader=openCacheFixture(path);
      expect(reader.cache.prepare("SELECT count(*) FROM panel_memory_facts").pluck().get()).toBe(32);
      reader.prepare(["memories"]);expect([...panelMemoryStats(reader.source.db,true)]).toHaveLength(150);
      db.db.prepare("UPDATE memories SET memory_layer='Skill',info_json='{\"source\":\"cursor-agent\"}' WHERE id='memory-0'").run();
      reader.prepare(["memories"]);expect([...panelMemoryStats(reader.source.db,true)].filter(x=>x.memoryLayer==="Skill")).toMatchObject([{id:"memory-0",infoSource:"cursor"}]);
      db.db.prepare("DELETE FROM memories WHERE id='memory-0'").run();reader.prepare(["memories"]);
      expect([...panelMemoryStats(reader.source.db,true)]).toHaveLength(149);
    }finally{reader.close();db.close();rmSync(root,{recursive:true,force:true});}
  });
  it("preserves exact full-payload substring searches after updates and deletes", () => {
    const db = new MemoryDb({ path: ":memory:" });
    try {
      const text = 'x'.repeat(20000) + ' Deep-Match 中文例子 "quoted" aB';
      const item = log(db, text), reader = new PanelLogReader(db.db);
      for (const query of ['deep-match', '中文例子', '"quoted"', 'aB', 'content']) {
        const expected = db.db.prepare('SELECT id FROM api_logs WHERE instr(lower(input_json),lower(?))>0 OR instr(lower(output_json),lower(?))>0').pluck().all(query, query);
        expect(reader.list({ q: query }).logs.map(row => row.id)).toEqual(expected);
      }
      expect(reader.detail(item.id).inputJson).toBe(JSON.stringify({ content: text }));
      db.db.prepare("UPDATE api_logs SET input_json=? WHERE id=?").run(JSON.stringify({ content: "changed needle" }), item.id);
      expect(reader.list({ q: "deep-match" }).total).toBe(0);
      expect(reader.list({ q: "changed needle" }).total).toBe(1);
      db.db.prepare("DELETE FROM api_logs WHERE id=?").run(item.id);
      expect(reader.list({ q: "changed needle" }).total).toBe(0);
    }
    finally {
      db.close();
    }
  });
  it("does not mix counts for opposite source filters or reuse counts after a write", () => {
    const db = new MemoryDb({ path: ":memory:" });
    try {
      log(db, "a", "codex");
      log(db, "b", "cursor");
      log(db, "c", "cursor");
      const reader = new PanelLogReader(db.db);
      expect(reader.list({ sourceAgent: "codex" }).total).toBe(1);
      expect(reader.list({ excludedSourceAgents: ["codex"] }).total).toBe(2);
      log(db, "d", "codex");
      expect(reader.list({ sourceAgent: "codex" }).total).toBe(2);
    }
    finally {
      db.close();
    }
  });
  it("keeps every reference live, including references beyond the displayed summary", () => {
    const db = new MemoryDb({ path: ":memory:" });
    try {
      addMemory(db, "first");
      addMemory(db, "second");
      new Repositories(db.db).runtime.insertApiLog({ toolName: "memory_add", inputJson: "{}", outputJson: JSON.stringify({ details: [{ traceId: "first" }, { spanId: "scope::second" }] }), success: true, durationMs: 1, calledAt: now });
      const reader = new PanelLogReader(db.db), id = reader.list({}).logs[0]!.id;
      expect(reader.list({}).total).toBe(1);
      db.db.prepare("UPDATE memories SET deleted_at=? WHERE id='second'").run(now);
      expect(reader.list({}).logs).toEqual([]);
      expect(reader.list({}).total).toBe(0);
      expect(() => reader.detail(id)).toThrow("unavailable");
    }
    finally {
      db.close();
    }
  });
  it("rebuilds a cache format change without altering source data", () => {
    const db = new MemoryDb({ path: ":memory:" });
    try {
      addMemory(db, "kept");
      log(db, "preserved");
      ensurePanelCache(db.db, ["memories", "logs", "visibility", "metrics"]);
      db.db.prepare("UPDATE panel_cache_meta SET version=999").run();
      installPanelCache(db.db);
      expect([...panelMemoryStats(db.db)]).toHaveLength(1);
      expect(new PanelLogReader(db.db).list({ q: "preserved" }).total).toBe(1);
      expect(db.db.prepare("SELECT memory_value FROM memories WHERE id='kept'").pluck().get()).toBe("content");
    }
    finally {
      db.close();
    }
  });
  it("removes old business-file projections on upgrade without changing source rows",()=>{
    const root=mkdtempSync(join(tmpdir(),"panel-cache-v1-")),path=join(root,"memory.sqlite");
    let db=new MemoryDb({path});
    try {
      addMemory(db,"kept-v1");log(db,"kept payload");
      const before={memories:db.db.prepare("SELECT * FROM memories").all(),logs:db.db.prepare("SELECT * FROM api_logs").all()};
      db.db.exec("CREATE TABLE panel_memory_facts(id TEXT PRIMARY KEY);CREATE TABLE panel_cache_meta(version INTEGER);INSERT INTO panel_cache_meta VALUES(1)");
      db.close();db=new MemoryDb({path});
      expect(db.schemaVersion().version).toBe(SCHEMA_VERSION);
      expect(db.db.prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND name GLOB 'panel_*'").all()).toEqual([]);
      const reader=openCacheFixture(path);
      try{reader.prepare(["memories","logs","visibility"]);expect([...panelMemoryStats(reader.source.db,true)]).toHaveLength(1);expect(new PanelLogReader(reader.source.db).list({q:"kept payload"}).total).toBe(1);}finally{reader.close();}
      expect({memories:db.db.prepare("SELECT * FROM memories").all(),logs:db.db.prepare("SELECT * FROM api_logs").all()}).toEqual(before);
    }finally{db.close();rmSync(root,{recursive:true,force:true});}
  });

  it("materializes only requested legacy detail IDs and validates raw source rebinding", () => {
    const db = new MemoryDb({ path: ":memory:" });
    try {
      const first = log(db, "first"), second = log(db, "second");
      const reader = new PanelLogReader(db.db);
      expect(reader.visibleIds([first.id])).toEqual(new Set([first.id]));
      expect(reader.detail(first.id).inputJson).toContain("first");
      expect(db.db.prepare("SELECT id FROM panel_log_dirty").pluck().all()).toEqual([second.id]);
      addMemory(db, "linked", { internal_info: { trace: { raw_turn_id: "missing" } } });
      db.db.prepare("UPDATE api_logs SET output_json=? WHERE id=?").run(JSON.stringify({ details: [{ traceId: "linked" }] }), first.id);
      expect(reader.list({}).logs.map(item => item.id)).toEqual([second.id]);
      db.db.prepare("UPDATE memories SET properties_json='{}' WHERE id='linked'").run();
      expect(reader.list({}).total).toBe(2);
    }
    finally {
      db.close();
    }
  });
  it("preserves the analysis log window, numeric scores and tool latency inputs", () => {
    const db = new MemoryDb({ path: ":memory:" });
    try {
      const outputs = ['{}', '"not-object"', '{"stats":{"topRelevance":-0.7}}', '{"stats":{"topRelevance":0.83}}', '{"stats":{"topRelevance":"0.9"}}', '{"stats":{"topRelevance":1e400}}'];
      const insert = db.db.prepare("INSERT INTO api_logs(tool_name,source_agent,input_json,output_json,duration_ms,success,called_at) VALUES(?,?,?,?,?,?,?)");
      for (let i = 0; i < outputs.length; i++)
        insert.run(i % 2 ? "memory_search" : "memory_add", "codex", "{}", outputs[i], i * 3.5 - 1, i % 2, now);
      insert.run("skill_generate", "codex", "{}", "{}", 900, 1, now);
      const repos = new Repositories(db.db);
      const expected = repos.runtime.listApiLogs({ limit: 10000, offset: 0 }).logs;
      const actual = panelAnalysisLogs(db.db);
      const scalar = (rows: typeof actual | typeof expected) => rows.map(({ id, toolName, sourceAgent, calledAt, durationMs, success, outputJson }) => ({ id, toolName, sourceAgent, calledAt, durationMs, success, score: panelRecallScore(outputJson) }));
      expect(scalar(actual)).toEqual(scalar(expected));
      db.db.prepare("UPDATE api_logs SET duration_ms=123,output_json='{\"stats\":{\"topRelevance\":0.95}}' WHERE id=2").run();
      expect(scalar(panelAnalysisLogs(db.db))).toEqual(scalar(repos.runtime.listApiLogs({ limit: 10000, offset: 0 }).logs));
    }
    finally {
      db.close();
    }
  });
  it("replays updates committed after a source row was read for a cache batch", () => {
    const db=new MemoryDb({path:":memory:"});
    try {
      const item=log(db,"old");ensurePanelCache(db.db,["logs"]);
      db.db.prepare("UPDATE api_logs SET input_json='{\"content\":\"first\"}' WHERE id=?").run(item.id);
      ensurePanelCache(db.db,[]);
      const prepare=db.db.prepare.bind(db.db);
      const changed=vi.spyOn(db.db,"prepare").mockImplementation(sql=>{
        if(sql.startsWith("DELETE FROM panel_log_facts"))prepare("UPDATE api_logs SET input_json='{\"content\":\"latest\"}' WHERE id=?").run(item.id);
        return prepare(sql);
      });
      fillPanelCacheBatch(db.db,"logs",1);changed.mockRestore();
      expect(new PanelLogReader(db.db).list({}).logs[0]?.inputJson).toContain("latest");
    }finally{db.close();}
  });

});
