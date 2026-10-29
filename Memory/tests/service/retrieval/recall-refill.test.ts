import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryDb } from "../../../src/storage/db.js";
import { Repositories } from "../../../src/storage/repositories.js";
import { compileRetrievalQuery } from "../../../src/algorithm/plugin-algorithms.js";
import { IndexedCandidatePool } from "../../../src/service/retrieval/indexed-candidate-pool.js";
import { deduplicateCrossAccountMemoryCandidates } from "../../../src/service/retrieval/cross-account-candidate-dedup.js";
import type { MemoryRow } from "../../../src/types.js";
import { createFailingLlm, createMemoryServiceFixture, LEGACY_TEST_CONFIG } from "../../fixtures/memory-service-fixture.js";

const services = createMemoryServiceFixture();
afterEach(services.cleanup);

const fixtures: Array<{root: string; db: MemoryDb}> = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "recall-refill-"));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  fixtures.push({root, db});
  const repos = new Repositories(db.db);
  const pool = new IndexedCandidatePool({repos, memoryHasImportPipeline: () => false});
  return {root, db, repos, pool};
}
afterEach(() => { for (const {root, db} of fixtures.splice(0)) {db.close(); rmSync(root, {recursive: true, force: true});} });

function memory(id: string, turn = id, overrides: Partial<MemoryRow> = {}): MemoryRow {
  const at = "2026-10-20T00:00:00.000Z";
  return {id, userId: "owner-a", memoryLayer: "L1", memoryType: "LongTermMemory",
    memoryKey: id, status: "activated", visibility: "private", timeline: at,
    memoryValue: "python specialterm", tags: ["python"], contentHash: "same-body", version: 1,
    createdAt: at, updatedAt: at, deletedAt: null,
    info: {turn_id: turn, native_origin_v1: {version: 1, source: "codex", profileId: "default",
      conversationId: "native-conversation", projectId: "project-a", workspaceId: "workspace-a",
      tenantId: null, namespaceKey: null}},
    properties: {internal_info: {memory_layer: "L1", memory_kind: "trace", trace: {
      key: id, turn_id: turn, step_index: 0, sub_step_total: 1, ts: Date.parse(at),
      summary: "python specialterm", userText: "python specialterm", agentText: "python specialterm",
      tags: ["python"], tool_calls: [], reflection: null, value: 0.8, priority: 0.8,
      vec_summary: [1, 0], vec_action: [1, 0]
    }}}, ...overrides};
}
function input(topK = 20, route: "pattern" | "fts" | "vector" | "structural" = "pattern") {
  const compiledQuery = compileRetrievalQuery("python specialterm", null);
  return {userId: "owner-a", layers: ["L1" as const],
    compiledQuery: {...compiledQuery, ftsMatch: route === "fts" ? '"specialterm"' : null,
      patternTerms: route === "pattern" ? ["specialterm"] : [],
      structuralFragments: route === "structural" ? ["specialterm"] : []},
    ...(route === "vector" ? {queryVector: [1, 0]} : {}),
    config: {tier1TopK: topK, tier2TopK: topK, tier3TopK: topK,
      candidatePoolFactor: 1, keywordTopK: topK, tagFilter: "off" as const}};
}
function snapshot(repos: Repositories) {
  return repos.db.prepare("SELECT rowid,* FROM memories ORDER BY id").all();
}

describe("recall source groups and quota refill", () => {
  it.each(["pattern", "fts", "structural", "vector"] as const)("fills 20 unique sources through %s without changing historical rows", async route => {
    const {repos, pool} = fixture();
    repos.db.transaction(() => {
      for (let i=0;i<35;i++) repos.memories.insert(memory(`z-copy-${i}`, "repeated"));
      for (let i=0;i<25;i++) repos.memories.insert(memory(`a-other-${i}`));
    })();
    const before = snapshot(repos);
    const result = await pool.indexedRetrievalCandidatePool(input(20, route));
    expect(result.memories).toHaveLength(20);
    expect(new Set(result.memories.map(row => row.info.turn_id)).size).toBe(20);
    expect(snapshot(repos)).toEqual(before);
  });

  it("continues beyond the 2,000-row vector window and does not report a duplicate-filled window as exhausted", async () => {
    const {repos, pool} = fixture();
    repos.db.transaction(() => {
      for (let i=0;i<20;i++) repos.memories.insert(memory(`other-${i}`));
      for (let i=0;i<2005;i++) repos.memories.insert(memory(`copy-${i}`, "repeated"));
    })();
    const result = await pool.indexedRetrievalCandidatePool(input(20,"vector"));
    expect(result.memories).toHaveLength(20);
    expect(new Set(result.memories.map(row => row.info.turn_id)).size).toBe(20);
  });

  it("returns six sources when the scoped search really contains only six", async () => {
    const {repos, pool} = fixture();
    for(let i=0;i<35;i++) repos.memories.insert(memory(`z-${i}`,"repeated"));
    for(let i=0;i<5;i++) repos.memories.insert(memory(`a-${i}`));
    const result=await pool.indexedRetrievalCandidatePool(input());
    expect(result.memories).toHaveLength(6);
  });

  it("also fills a quota of 30 rather than stopping at the fixed example of 20", async () => {
    const {repos,pool}=fixture();
    for(let i=0;i<35;i++)repos.memories.insert(memory(`z-${i}`,"repeated"));
    for(let i=0;i<35;i++)repos.memories.insert(memory(`a-${i}`));
    const result=await pool.indexedRetrievalCandidatePool(input(30));
    expect(result.memories).toHaveLength(30);
    expect(new Set(result.memories.map(row=>row.info.turn_id)).size).toBe(30);
  });

  it("does not prefer the requesting UID or borrow scores across different content versions", () => {
    const {repos}=fixture();
    const a=memory("a","repeated",{userId:"owner-a",memoryValue:"obsolete",contentHash:"old"});
    const b=memory("b","repeated",{userId:"owner-b"});
    const scores=new Map([[a.id,{fts:0.1}],[b.id,{fts:0.9}]]);
    const result=deduplicateCrossAccountMemoryCandidates({repos,memories:[a,b],preferredUserId:"owner-a",channelScoresByMemory:scores});
    expect(result.memories.map(row=>row.id)).toEqual(["b"]);
    expect(result.channelScoresByMemory.get("b")).toEqual({fts:0.9});
  });

  it("keeps different scope, kind and step separate and never infers provenance from a mutable Session", () => {
    const {repos}=fixture();
    const base=memory("base","repeated");
    const scope=memory("scope","repeated");
    scope.info.native_origin_v1={...(scope.info.native_origin_v1 as object),tenantId:"other"};
    const step=memory("step","repeated");
    step.properties.internal_info.trace={...step.properties.internal_info.trace!,step_index:1};
    const unknown=memory("unknown","repeated",{info:{turn_id:"repeated"}});
    const unknown2=memory("unknown2","repeated",{info:{turn_id:"repeated"}});
    const result=deduplicateCrossAccountMemoryCandidates({repos,memories:[base,scope,step,unknown,unknown2],preferredUserId:"owner-a"});
    expect(result.memories).toHaveLength(5);
  });

  it("repository exclusion stays inside owner, tag and time constraints", () => {
    const {repos}=fixture();
    repos.memories.insert(memory("a"));
    repos.memories.insert(memory("b", "b", {userId:"owner-b"}));
    repos.memories.insert(memory("c", "c", {tags:["private"]}));
    const filter={userId:"owner-a",tags:["python"],createdAtGte:"2026-10-20",createdAtLt:"2026-10-21",excludedIds:["a"]};
    expect(repos.memories.searchPatternIds(["specialterm"],filter,20)).toEqual([]);
    expect(repos.memories.searchFtsIds('"specialterm"',filter,20)).toEqual([]);
    expect(repos.memories.searchVectorIds([1,0],"vec_summary",filter,20)).toEqual([]);
  });

  it.each([
    [{deadlineAt: 0}, "deadline"],
    [{maxRows: 0}, "work_budget_limited"],
    [{signal: AbortSignal.abort()}, "cancelled"]
  ] as const)("reports an explicit stop instead of false exhaustion: %s", async (budget, reason) => {
    const {repos,pool}=fixture();
    repos.memories.insert(memory("a"));
    const result=await pool.indexedRetrievalCandidatePool({...input(),budget});
    expect(result.memories).toEqual([]);
    expect(result.diagnostics[0]?.stopReason).toBe(reason);
  });

  it("keeps a healthy route when FTS fails, and records the error", async () => {
    const {repos,pool}=fixture();
    repos.memories.insert(memory("a"));
    vi.spyOn(repos.memories,"searchFtsIds").mockImplementation(()=>{throw new Error("fixture FTS unavailable");});
    const request=input();request.compiledQuery.ftsMatch='"specialterm"';
    const result=await pool.indexedRetrievalCandidatePool(request);
    expect(result.memories.map(row=>row.id)).toEqual(["a"]);
    expect(result.diagnostics.find(route=>route.channel==="fts")?.stopReason).toBe("error");
  });

  it("does not repeatedly scan a source when the storage layer makes no progress", async () => {
    const {repos,pool}=fixture();
    repos.memories.insert(memory("a"));
    vi.spyOn(repos.memories,"searchPatternIds").mockImplementation((_terms,_filter,limit)=>
      Array.from({length:limit ?? 20},()=>({id:"a",score:1,channel:"pattern" as const})));
    const result=await pool.indexedRetrievalCandidatePool(input());
    expect(result.memories).toHaveLength(1);
    expect(result.diagnostics[0]?.stopReason).toBe("no_progress");
    expect(result.diagnostics[0]?.rounds).toBe(2);
  });

  it("excludes a recent source even when another copy carries a different raw-turn ID", async () => {
    const {repos,pool}=fixture();
    const a=memory("z-recent","repeated");
    a.info.raw_turn_id="raw-recent";
    repos.memories.insert(a);
    repos.memories.insert(memory("z-copy","repeated"));
    for(let i=0;i<20;i++) repos.memories.insert(memory(`a-${i}`));
    const result=await pool.indexedRetrievalCandidatePool({...input(),excludeTraceRawTurnIds:new Set(["raw-recent"])});
    expect(result.memories).toHaveLength(20);
    expect(result.memories.some(row=>row.info.turn_id==="repeated")).toBe(false);
  });

  it("never uses another owner's capture as provenance and leaves lifecycle state unchanged", () => {
    const {repos}=fixture();
    const a=memory("a","repeated",{info:{turn_id:"repeated"}});
    const b=memory("b","repeated",{info:{turn_id:"repeated"}});
    for(const owner of ["owner-a","owner-b"]) {
      repos.db.prepare(`INSERT INTO source_turn_captures
        (user_id,source,profile_id,namespace_key,conversation_id,turn_id,content_hash,response_json,started_at,completed_at,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(owner,"codex","default","captured-scope","conversation","repeated","hash",
        JSON.stringify({result:{l1MemoryIds:owner==="owner-a"?["a","b"]:["foreign"]}}),"at","at","at");
    }
    const before=repos.db.prepare("SELECT * FROM source_turn_captures ORDER BY user_id").all();
    const result=deduplicateCrossAccountMemoryCandidates({repos,memories:[a,b],preferredUserId:"owner-b"});
    expect(result.memories).toHaveLength(1);
    const foreign={...b,userId:"owner-c"};
    expect(deduplicateCrossAccountMemoryCandidates({repos,memories:[a,foreign]}).memories).toHaveLength(2);
    expect(repos.db.prepare("SELECT * FROM source_turn_captures ORDER BY user_id").all()).toEqual(before);
  });

  it("never enumerates or returns sibling rows outside the route filter", async () => {
    const {repos,pool}=fixture();
    repos.memories.insert(memory("a"));
    repos.memories.insert(memory("b-visible","a"));
    repos.memories.insert(memory("hidden","a",{tags:["hidden"]}));
    const requests:Array<unknown>=[];
    const lookup=repos.memories.recallSourceCandidates.bind(repos.memories);
    vi.spyOn(repos.memories,"recallSourceCandidates").mockImplementation((turn,filter,limit)=>{
      requests.push(filter);return lookup(turn,filter,limit);
    });
    const result=await pool.indexedRetrievalCandidatePool({...input(),tags:["python"]});
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]?.id).not.toBe("hidden");
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every(filter=>(filter as {tags:string[]}).tags.includes("python"))).toBe(true);
  });

  it("fills the public MemoryService search quota and leaves historical rows unchanged", async () => {
    const config={...LEGACY_TEST_CONFIG,algorithm:{...LEGACY_TEST_CONFIG.algorithm,
      retrieval:{...LEGACY_TEST_CONFIG.algorithm.retrieval,tier2TopK:20,candidatePoolFactor:1,keywordTopK:20,
        relativeThresholdFloor:0,minRecallScore:0,llmFilterEnabled:false,mmrLambda:1}}};
    const {db,service}=services.createTestService({config,llm:createFailingLlm()});
    const repos=new Repositories(db.db);
    for(let i=0;i<35;i++) repos.memories.insert(memory(`z-${i}`,"repeated"));
    for(let i=0;i<25;i++) repos.memories.insert(memory(`a-${i}`));
    const before=snapshot(repos);
    const result=await service.search({namespace:{userId:"owner-a",source:"codex",profileId:"default"},
      query:"python specialterm",layers:["L1"],limit:20,contextBudget:20000});
    expect(result.hits).toHaveLength(20);
    const byId=new Map(repos.memories.getMany(result.hits.map(hit=>hit.id)).map(row=>[row.id,row]));
    expect(new Set(result.hits.map(hit=>byId.get(hit.id)?.info.turn_id)).size).toBe(20);
    expect(snapshot(repos)).toEqual(before);
    expect(result.status).toContain("user_memory_recall:disabled");
  });

  it("normalizes different copies across rewritten queries before final quota and RRF", async () => {
    const llm=createFailingLlm();
    let rewriteCalls=0;
    vi.spyOn(llm,"completeJson").mockImplementation(async (_messages,options)=>{
      if(options.operation==="retrieval.query_rewrite.v1") {rewriteCalls++;return {queries:["python specialterm","specialterm"]} as never;}
      if(options.operation.includes("query.extract"))return {keywords:["specialterm"]} as never;
      return {} as never;
    });
    const config={...LEGACY_TEST_CONFIG,algorithm:{...LEGACY_TEST_CONFIG.algorithm,enableQueryRewrite:true,
      retrieval:{...LEGACY_TEST_CONFIG.algorithm.retrieval,tier2TopK:20,candidatePoolFactor:1,keywordTopK:20,
        relativeThresholdFloor:0,minRecallScore:0,llmFilterEnabled:false,mmrLambda:1}}};
    const {db,service}=services.createTestService({config,llm});
    const repos=(service as unknown as {repos:Repositories}).repos;
    repos.memories.insert(memory("000-copy-a","repeated"));
    repos.memories.insert(memory("000-copy-b","repeated",{userId:"owner-b"}));
    for(let i=0;i<25;i++)repos.memories.insert(memory(`other-${i}`));
    vi.spyOn(repos.memories,"searchPatternIds").mockReturnValue([]);
    vi.spyOn(repos.memories,"searchStructuralIds").mockReturnValue([]);
    vi.spyOn(repos.memories,"hasVectorRows").mockReturnValue(false);
    const search=repos.memories.searchFtsIds.bind(repos.memories);
    vi.spyOn(repos.memories,"searchFtsIds").mockImplementation((query,filter,limit,strict)=>
      search(query,{...filter,excludedIds:[...(filter?.excludedIds??[]),query?.includes("python")?"000-copy-b":"000-copy-a"]},limit,strict));
    const before=snapshot(repos);
    const result=await service.search({namespace:{userId:"owner-a",source:"codex",profileId:"default"},query:"python specialterm",layers:["L1"],limit:20});
    expect(result.hits).toHaveLength(20);
    const rows=new Map(repos.memories.getMany(result.hits.map(hit=>hit.id)).map(row=>[row.id,row]));
    expect(new Set(result.hits.map(hit=>rows.get(hit.id)?.info.turn_id)).size).toBe(20);
    expect(rewriteCalls).toBe(1);
    expect(snapshot(repos)).toEqual(before);
    expect(db.db.open).toBe(true);
  });

  it("refills after L1/User Memory merging even when several larger batches add no new final source", async () => {
    const config={...LEGACY_TEST_CONFIG,algorithm:{...LEGACY_TEST_CONFIG.algorithm,enableUserMemoryRecall:true,
      retrieval:{...LEGACY_TEST_CONFIG.algorithm.retrieval,tier2TopK:20,candidatePoolFactor:1,keywordTopK:20,
        relativeThresholdFloor:0,minRecallScore:0,llmFilterEnabled:false,mmrLambda:1}}};
    const {service}=services.createTestService({config,llm:createFailingLlm()});
    const repos=(service as unknown as {repos:Repositories}).repos;
    for(let i=0;i<60;i++) {
      const row=memory(`000-step-${String(i).padStart(3,"0")}`,"one-turn");
      row.properties.internal_info.source_raw_turn_id="shared-raw";
      row.properties.internal_info.trace={...row.properties.internal_info.trace!,step_index:i,sub_step_total:60};
      repos.memories.insert(row);
    }
    for(let i=0;i<25;i++)repos.memories.insert(memory(`zzz-other-${i}`));
    repos.userMemories.insert({id:"user",userId:"owner-a",sourceTurnId:"shared-raw",sourceTurnRefs:["shared-raw"],
      memoryTypes:["User Fact"],content:"python specialterm",normalizedUserTextHash:"hash",status:"active",
      createdAt:"2026-10-20T00:00:00.000Z",updatedAt:"2026-10-20T00:00:00.000Z"});
    vi.spyOn(repos.memories,"searchPatternIds").mockReturnValue([]);
    vi.spyOn(repos.memories,"searchStructuralIds").mockReturnValue([]);
    vi.spyOn(repos.memories,"hasVectorRows").mockReturnValue(false);
    const before=snapshot(repos);
    const result=await service.search({namespace:{userId:"owner-a",source:"codex",profileId:"default"},query:"python specialterm",layers:["L1"],limit:20,contextBudget:30000});
    expect(result.hits).toHaveLength(20);
    expect(result.hits.filter(hit=>hit.sourceTurnId==="shared-raw")).toHaveLength(1);
    expect(snapshot(repos)).toEqual(before);
  });

  it("uses the source-turn index and preserves rows and rowids when an existing library gains the index", () => {
    const {repos,db,root}=fixture();
    repos.memories.insert(memory("a"));
    const before=snapshot(repos);
    repos.db.exec("DROP INDEX idx_memories_recall_turn");
    db.close();fixtures.pop();
    const reopened=new MemoryDb({path:join(root,"memory.sqlite")});fixtures.push({root,db:reopened});
    const restored=new Repositories(reopened.db);
    expect(snapshot(restored)).toEqual(before);
    const plan=restored.db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM memories WHERE deleted_at IS NULL AND
      COALESCE(json_extract(info_json,'$.turn_id'),json_extract(properties_json,'$.internal_info.trace.turn_id'))=? ORDER BY id`).all("a");
    expect(JSON.stringify(plan)).toContain("idx_memories_recall_turn");
  });

  it("refills User Memory after same-turn duplicate expressions without exposing another owner", async () => {
    const config={...LEGACY_TEST_CONFIG,algorithm:{...LEGACY_TEST_CONFIG.algorithm,enableUserMemoryRecall:true,
      retrieval:{...LEGACY_TEST_CONFIG.algorithm.retrieval,relativeThresholdFloor:0,minRecallScore:0,llmFilterEnabled:false,mmrLambda:1}}};
    const {service}=services.createTestService({config,llm:createFailingLlm()});
    const repos=(service as unknown as {repos:Repositories}).repos;
    const insert=(id:string,sourceTurnId:string,userId="owner-a")=>repos.userMemories.insert({id,userId,sourceTurnId,
      sourceTurnRefs:[sourceTurnId],memoryTypes:["User Fact"],content:"python specialterm",normalizedUserTextHash:id,
      status:"active",createdAt:"2026-10-20T00:00:00.000Z",updatedAt:"2026-10-20T00:00:00.000Z"});
    for(let i=0;i<35;i++)insert(`000-copy-${i}`,"shared-raw");
    for(let i=0;i<25;i++)insert(`zzz-other-${i}`,`raw-${i}`);
    insert("hidden-owner","hidden-raw","owner-b");
    vi.spyOn(repos.userMemories,"searchPatternIds").mockReturnValue([]);
    const before=repos.db.prepare("SELECT rowid,* FROM user_memories ORDER BY id").all();
    const result=await service.search({namespace:{userId:"owner-a",source:"codex",profileId:"default"},query:"python specialterm",layers:["L1"],limit:20,contextBudget:30000});
    expect(result.hits).toHaveLength(20);
    expect(new Set(result.hits.map(hit=>hit.sourceTurnId)).size).toBe(20);
    expect(JSON.stringify(result)).not.toContain("hidden-owner");
    expect(repos.db.prepare("SELECT rowid,* FROM user_memories ORDER BY id").all()).toEqual(before);
  });

  it("does not broaden auto-tag vector fallback when one tagged field has results", async () => {
    const {repos,pool}=fixture();
    repos.memories.insert(memory("tagged"));
    const request=input(20,"vector");request.compiledQuery.tags=["python"];
    const search=vi.spyOn(repos.memories,"searchVectorIds").mockImplementation((_query,field,_filter,_limit,options)=>
      field==="vec_action" && options?.anyOfTags?.includes("python") ? [{id:"tagged",score:0.9,channel:field}] : []);
    const result=await pool.indexedRetrievalCandidatePool({...request,config:{...request.config,tagFilter:"auto"}});
    expect(result.memories.map(row=>row.id)).toEqual(["tagged"]);
    expect(search.mock.calls.every(call=>call[4]?.anyOfTags?.includes("python"))).toBe(true);
  });

  it("continues repair's 500-row candidate scan past a duplicate-filled batch", async () => {
    const config={...LEGACY_TEST_CONFIG,algorithm:{...LEGACY_TEST_CONFIG.algorithm,
      retrieval:{...LEGACY_TEST_CONFIG.algorithm.retrieval,relativeThresholdFloor:0,minRecallScore:0}}};
    const {service}=services.createTestService({config,llm:createFailingLlm()});
    const repos=(service as unknown as {repos:Repositories}).repos;
    const session=service.openSession({namespace:{userId:"owner-a",source:"codex",profileId:"default"}});
    for(let i=0;i<505;i++)repos.memories.insert(memory(`z-copy-${i}`,"repeated"));
    for(let i=0;i<10;i++)repos.memories.insert(memory(`a-other-${i}`));
    const before=snapshot(repos);
    const result=await service.repairSuggestion({sessionId:session.sessionId,issue:"python specialterm"});
    const rows=repos.memories.getMany(result.sourceMemoryIds);
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map(row=>row.info.turn_id)).size).toBe(5);
    expect(snapshot(repos)).toEqual(before);
  });

  it.each(["delete","edit"] as const)("rechecks selected bodies after the filter yields to a concurrent %s", async change => {
    const llm=createFailingLlm();
    const config={...LEGACY_TEST_CONFIG,algorithm:{...LEGACY_TEST_CONFIG.algorithm,
      retrieval:{...LEGACY_TEST_CONFIG.algorithm.retrieval,relativeThresholdFloor:0,minRecallScore:0,llmFilterEnabled:true}}};
    const {db,service}=services.createTestService({config,llm});
    const repos=new Repositories(db.db);
    repos.memories.insert(memory("victim"));
    vi.spyOn(llm,"completeJson").mockImplementation(async (_messages,options)=>{
      if(options.operation.includes("query.extract"))return {keywords:["specialterm"]} as never;
      if(options.operation.includes("retrieval.filter")) {
        await Promise.resolve();
        if(change==="delete")repos.memories.softDelete("victim");
        else repos.memories.update({...repos.memories.get("victim")!,memoryValue:"edited while filtering",version:2});
        return {selected:[1]} as never;
      }
      throw new Error("unexpected fixture operation: "+options.operation);
    });
    const result=await service.search({namespace:{userId:"owner-a",source:"codex",profileId:"default"},query:"python specialterm",layers:["L1"],limit:1});
    expect(result.hits).toEqual([]);
    expect(result.status).toContain("recall_refill:concurrent_change");
    expect(JSON.stringify(result.injectedContext)).not.toContain("python specialterm");
    const log=service.apiLogs({tools:["memory_search"],limit:1}).logs[0];
    const stats=JSON.parse(log!.outputJson).stats;
    expect(stats.concurrentChangeDropped).toBe(1);
    expect(stats.llmFilter.dropped).toBe(0);
    expect(stats.llmFilter.kept).toBe(1);
  });
});
