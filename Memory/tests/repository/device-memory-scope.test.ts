import { L3WorldModelTraceFieldPipeline } from "../../src/service/evolution/l3-world-model-pipeline.js";
import type { LlmClient } from "../../src/model/types.js";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryDb } from "../../src/storage/db.js";
import { Repositories } from "../../src/storage/repositories.js";
import { canonicalJson, sha256Hex } from "../../src/contracts/index.js";
import { canonicalProjectId, refreshProjectAliases } from "../../src/storage/device-scope.js";
import { resolveWorkspaceIdentity } from "../../src/service/namespace/workspace-identity.js";
import { stableHash } from "../../src/utils/id.js";
import { createMemoryServiceFixture } from "../fixtures/memory-service-fixture.js";
const fixture = createMemoryServiceFixture();
afterEach(fixture.cleanup);
const at = "2026-10-01T00:00:00.000Z", uri = "file:///workspace/shared", host = "a".repeat(64);
const identity = resolveWorkspaceIdentity(null, {workspaceUri: uri, workspaceHostId: host});
function legacyProject(user: string) {
  const workspaceId = sha256Hex(`${user}\0local\0${host}\0${uri}`);
  return {projectId: `ws_${workspaceId}`, workspaceId};
}
function seedV9(path: string) {
  const db = new Database(path);
  db.exec(readFileSync(new URL("../fixtures/schema-v9.sql", import.meta.url), "utf8"));
  for (const user of ["account-a", "account-b"]) {
    const {projectId, workspaceId} = legacyProject(user);
    const namespaceKey = stableHash({tenantId: null, projectId, workspaceId});
    db.prepare(`INSERT INTO sessions(id,user_id,project_id,source,profile_id,workspace_id,host_session_key,conversation_id,meta_json,opened_at,last_seen_at,updated_at)
      VALUES (?, ?, ?, 'codex', 'default', ?, ?, 'native-conversation', ?, ?, ?, ?)`)
      .run(`session-${user}`,user,projectId,workspaceId,`host-${user}`,JSON.stringify({workspace_uri:uri,workspace_host_id:host,l3_world_model_protocol_version:2,source_namespace_key:namespaceKey}),at,at,at);
    for (const layer of ["L1","L3"] as const) {
      const info = {project_id:projectId,...(layer === "L1" ? {turn_id:"native-turn"} : {})};
      const internal = layer === "L1" ? {memory_layer:layer,memory_kind:"trace",trace:{turn_id:"native-turn",step_index:0}} : {
        memory_layer:layer,memory_kind:"world_model",schema_version:2,world_model:{
          general_rules_and_safety_constraints:null,project_environment_profile:null,
          project_contract:user === "account-a" ? "Run tests" : null,
          domain_knowledge:user === "account-b" ? "Parser accepts UTF-8" : null
        }};
      db.prepare(`INSERT INTO memories(id,timeline,user_id,session_id,memory_key,memory_value,info_json,properties_json,memory_layer,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(`${layer}-${user}`,at,user,`session-${user}`,`world_model:project:${user}:${projectId}`,"original",
          JSON.stringify(info),JSON.stringify({internal_info:internal}),layer,at,at);
    }
    db.prepare(`INSERT INTO l3_world_model_scopes(scope_key,user_id,project_id,workspace_uri,memory_id,updated_at) VALUES (?,?,?,?,?,?)`)
      .run(`l3wm:${sha256Hex(canonicalJson({userId:user,projectId}))}`,user,projectId,uri,`L3-${user}`,at);
    db.prepare(`INSERT INTO user_memories(id,source_turn_id,user_id,memory_types_json,content,normalized_user_text_hash,created_at,updated_at)
      VALUES (?, ?, ?, '["User Preference"]', 'Prefer Chinese', 'same-user-text', ?, ?)`)
      .run(`user-memory-${user}`,`raw-${user}`,user,at,at);
    const scopeKey = `l3wm:${sha256Hex(canonicalJson({userId:user,projectId}))}`;
    const payload = {scopeKey,scopeSeq:1,userId:user,projectId,sessionId:`session-${user}`,trigger:"session_close",startTraceSeq:1,endTraceSeq:1,l1MemoryIds:[`L1-${user}`],rawTurnIds:[`raw-${user}`],feedbackIds:[]};
    db.prepare(`INSERT INTO episodes(id,session_id,user_id,project_id,opened_at,updated_at) VALUES (?,?,?,?,?,?)`).run(`episode-${user}`,`session-${user}`,user,projectId,at,at);
    db.prepare(`INSERT INTO raw_turns(id,session_id,episode_id,turn_id,user_id,user_text,assistant_text,created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(`raw-${user}`,`session-${user}`,`episode-${user}`,"native-turn",user,"Please preserve the project rule.","The rule is already recorded.",at);
    db.prepare(`INSERT INTO l3_world_model_input_traces(session_id,trace_seq,l1_memory_id,raw_turn_id,created_at) VALUES (?,1,?,?,?)`)
      .run(`session-${user}`,`L1-${user}`,`raw-${user}`,at);
    db.prepare(`INSERT INTO l3_world_model_evidence_batches(id,scope_key,scope_seq,user_id,project_id,session_id,trigger,start_trace_seq,end_trace_seq,l1_memory_ids_json,raw_turn_ids_json,feedback_ids_json,payload_hash,created_at,updated_at)
      VALUES (?,?,1,?,?,?,'session_close',1,1,?,?,'[]',?,?,?)`)
      .run(`batch-${user}`,scopeKey,user,projectId,`session-${user}`,JSON.stringify(payload.l1MemoryIds),JSON.stringify(payload.rawTurnIds),sha256Hex(canonicalJson(payload)),at,at);
    db.prepare(`INSERT INTO l3_world_model_batch_targets(batch_id,target_field,field_scope_key,scope_seq,updated_at) VALUES (?,'project_contract',?,1,?)`)
      .run(`batch-${user}`,`${scopeKey}:project_contract`,at);
    db.prepare(`INSERT INTO evolution_jobs(id,job_type,user_id,session_id,scope_key,scope_seq,payload_json,created_at,updated_at)
      VALUES (?,'l3_world_model_update',?,?,?,1,?,?,?)`)
      .run(`job-${user}`,user,`session-${user}`,`${scopeKey}:project_contract`,JSON.stringify({batchId:`batch-${user}`,targetField:"project_contract"}),at,at);
    db.prepare(`INSERT INTO source_turn_captures(user_id,source,profile_id,namespace_key,conversation_id,turn_id,content_hash,session_id,response_json,started_at,completed_at,created_at)
      VALUES (?,'codex','default',?,'native-conversation','native-turn','hash',?,'{"status":"rejected","reason":"fixture"}',?,?,?)`)
      .run(user,namespaceKey,`session-${user}`,at,at,at);
  }
  db.prepare(`INSERT INTO token_usage_outbox VALUES (1,'old-token-event',?)`).run(JSON.stringify({ownerAccountId:"account-a",totalTokens:1234}));
  db.prepare(`INSERT INTO runtime_kv VALUES ('token-budget-fixture', ?, ?)`).run(JSON.stringify({accountId:"account-a",used:1234,limit:5678}),at);
  db.prepare(`INSERT INTO runtime_kv VALUES ('source_turn_capture_activated_at', ?, ?)`).run(JSON.stringify(at),at);
  db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES ('memory_change_log',9000)").run();
  return db;
}
describe("device memory / preserved schema-v9 history", () => {
  it("upgrades NOT NULL tables verbatim, resolves aliases and never resurrects deleted legacy fields", () => {
    const root = mkdtempSync(join(tmpdir(),"memmy-uid-upgrade-")), path = join(root,"memory.sqlite");
    try {
      const old = seedV9(path);
      const snapshots = ["memories","sessions","l3_world_model_scopes","source_turn_captures","user_memories","runtime_kv","token_usage_outbox","raw_turns","l3_world_model_evidence_batches","evolution_jobs"].map(table => [table,old.prepare(`SELECT * FROM ${table}`).all()] as const);
      old.close();
      const db = new MemoryDb({path});
      expect(db.schemaVersion().version).toBe(10);
      expect(existsSync(`${path}.pre-v10.bak`)).toBe(true);
      for (const [table,rows] of snapshots) expect(db.db.prepare(`SELECT * FROM ${table}`).all()).toEqual(rows);
      expect(db.db.pragma("foreign_key_check")).toEqual([]);
      expect(db.db.pragma("table_info(memories)")).toEqual(expect.arrayContaining([expect.objectContaining({name:"user_id",notnull:0})]));
      const repos = new Repositories(db.db), a = legacyProject("account-a"), b = legacyProject("account-b");
      expect(canonicalProjectId(db.db,a.projectId)).toBe(identity.projectId);
      expect(canonicalProjectId(db.db,b.projectId)).toBe(identity.projectId);
      expect(canonicalProjectId(db.db,"unknown-project")).toBe("unknown-project");
      const scope = {userId:"new-account",source:"codex",profileId:"default",namespaceKey:stableHash({tenantId:null,projectId:identity.projectId,workspaceId:identity.workspaceId}),conversationId:"native-conversation"};
      expect(repos.runtime.getSourceTurnCapture(scope,"native-turn")?.sessionId).toMatch(/^session-account-/);
      expect(repos.memories.nativeDuplicates(repos.memories.get("L1-account-a")!)).toEqual({ids:["L1-account-a","L1-account-b"],deleted:false});
      repos.memories.softDelete("L1-account-a");
      expect(repos.memories.nativeDuplicates(repos.memories.get("L1-account-b")!).deleted).toBe(true);
      expect(repos.userMemories.listActive("any-account").map(row=>row.id)).toEqual(["user-memory-account-a"]);
      repos.userMemories.softDelete("user-memory-account-a");
      expect(repos.userMemories.listActive("account-b")).toEqual([]);
      expect(db.db.prepare("SELECT COUNT(*) FROM user_memories").pluck().get()).toBe(2);
      expect(db.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='memory_change_log'").pluck().get()).toBe(9000);
      const fields = repos.l3WorldModels.fields("new-account",identity.projectId);
      expect(fields).toMatchObject({projectContract:"Run tests",domainKnowledge:"Parser accepts UTF-8"});
      expect(repos.l3WorldModels.fields("account-b",b.projectId)).toEqual(fields);
      const saved = repos.l3WorldModels.upsertField({userId:"account-c",projectId:identity.projectId,targetField:"project_contract",value:null})!;
      expect(repos.l3WorldModels.fields("account-a",a.projectId)).toMatchObject({projectContract:null,domainKnowledge:"Parser accepts UTF-8"});
      expect(db.db.prepare(`SELECT user_id FROM memories WHERE id=?`).get(saved.id)).toEqual({user_id:null});
      expect(db.db.prepare(`SELECT user_id FROM memories WHERE id='L3-account-a'`).get()).toEqual({user_id:"account-a"});
      repos.l3WorldModels.deleteScopeMemory(saved.id);
      expect(repos.l3WorldModels.fields(null,identity.projectId)).toEqual({generalRulesAndSafetyConstraints:null,projectEnvironmentProfile:null,projectContract:null,domainKnowledge:null});
      db.close();
      const reopened = new MemoryDb({path});
      expect(new Repositories(reopened.db).l3WorldModels.fields("account-d",identity.projectId).projectContract).toBeNull();
      expect(reopened.db.prepare(`SELECT value_json FROM runtime_kv WHERE key='token-budget-fixture'`).pluck().get()).toBe(JSON.stringify({accountId:"account-a",used:1234,limit:5678}));
      reopened.close();
      const readonly = new MemoryDb({path,readonly:true});
      expect(new Repositories(readonly.db).l3WorldModels.fields("account-e",a.projectId).projectContract).toBeNull();
      readonly.close();
    } finally { rmSync(root,{recursive:true,force:true}); }
  });
  it("continues immutable legacy L3 batches once and serializes different account scopes", async () => {
    const root = mkdtempSync(join(tmpdir(),"memmy-uid-batches-")), path = join(root,"memory.sqlite");
    try {
      seedV9(path).close();
      const db = new MemoryDb({path}), repos = new Repositories(db.db);
      const complete = vi.fn(async () => JSON.stringify({op:"noop",project_contract:"",reason:"already recorded"}));
      const llm = {config:{},isConfigured:()=>true,complete,completeJson:vi.fn(),status:()=>({provider:"fixture",configured:true,remote:false})} as unknown as LlmClient;
      const jobs = repos.runtime.leaseQueuedJobs(10,60,undefined,false,["l3_world_model_update"]);
      expect(jobs.map(job=>job.id)).toEqual(["job-account-a"]);
      expect(repos.runtime.leaseQueuedJobs(10,60,undefined,false,["l3_world_model_update"])).toEqual([]);
      const pipeline = new L3WorldModelTraceFieldPipeline({repos,skillLlm:llm});
      await pipeline.updateField(jobs[0]!);
      expect(complete).toHaveBeenCalledTimes(1);
      await pipeline.updateField(jobs[0]!);
      expect(complete).toHaveBeenCalledTimes(1);
      expect(repos.l3WorldModels.getTarget("batch-account-a","project_contract")?.status).toBe("applied");
      db.db.prepare(`UPDATE evolution_jobs SET status='succeeded' WHERE id='job-account-a'`).run();
      expect(repos.runtime.leaseQueuedJobs(10,60,undefined,false,["l3_world_model_update"]).map(job=>job.id)).toEqual(["job-account-b"]);
      expect(repos.l3WorldModels.getStoredBatch("batch-account-a")?.userId).toBe("account-a");
      expect(repos.l3WorldModels.getBatch("batch-account-a")?.userId).toBeNull();
      expect(repos.l3WorldModels.getBatch("batch-account-a")?.projectId).toBe(identity.projectId);
      db.close();
    } finally {rmSync(root,{recursive:true,force:true});}
  });
  it("shares writes and project identity across accounts, retaining separate host identities", () => {
    const {db,service} = fixture.createTestService();
    const namespace = {source:"codex",profileId:"default",sessionKey:"shared-session",userId:"account-a"};
    const request = {l3WorldModelProtocolVersion:2 as const,l3WorldModelTransition:"resume_only" as const,workspaceUri:uri,workspaceHostId:host,namespace};
    const first = service.openSession(request), second = service.openSession({...request,namespace:{...namespace,userId:"account-b"}});
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.projectId).toBe(first.projectId);
    expect(resolveWorkspaceIdentity("account-c",{workspaceUri:uri,workspaceHostId:host})).toEqual(identity);
    expect(resolveWorkspaceIdentity(null,{workspaceUri:uri,workspaceHostId:"b".repeat(64)}).projectId).not.toBe(identity.projectId);
    service.completeTurn("shared-turn",{sessionId:first.sessionId,namespace,query:"我最喜欢的水果是苹果",answer:"记住了。"});
    const a = service.panelItems({layer:"UserMemory",namespace}), b = service.panelItems({layer:"UserMemory",namespace:{...namespace,userId:"account-b"}});
    expect(a.items.length).toBeGreaterThan(0);
    expect(b.items).toEqual(a.items);
    for (const table of ["memories","user_memories","sessions","raw_turns","episodes","evolution_jobs"]) expect(db.db.prepare(`SELECT COUNT(*) FROM ${table} WHERE user_id IS NOT NULL`).pluck().get()).toBe(0);
    service.deleteMemory(a.items[0]!.id,{namespace:{...namespace,userId:"account-b"}});
    expect(service.panelItems({layer:"UserMemory",namespace}).items).toEqual([]);
  });
  it("retries new and historical idempotency entries across accounts without accepting changed content", () => {
    const {db,service} = fixture.createTestService();
    const repos = new Repositories(db.db);
    const request = {adapterId:"fixture",requestId:"open",timeZone:"+00:00",namespace:{source:"codex",profileId:"default",userId:"account-a"}};
    const opened = service.openSession(request);
    expect(service.openSession({...request,namespace:{...request.namespace,userId:"account-b"}}))
      .toMatchObject({sessionId:opened.sessionId,userId:null,duplicate:true});
    // Reproduce the exact pre-upgrade cache and session owner, without rewriting them on read.
    db.db.prepare("UPDATE sessions SET user_id='account-a' WHERE id=?").run(opened.sessionId);
    repos.runtime.saveIdempotency("session.open:fixture:open",stableHash({operation:"session.open",request}),{...opened,userId:"account-a"});
    expect(service.openSession({...request,namespace:{...request.namespace,userId:"account-b"}})).toMatchObject({userId:null,duplicate:true});
    expect(()=>service.openSession({...request,source:"different"})).toThrow(/different session.open request/);
    const turn = {adapterId:"fixture",requestId:"complete",timeZone:"+00:00",sessionId:opened.sessionId,namespace:request.namespace,query:"Remember UTF-8",answer:"Confirmed"};
    const completed = service.completeTurn("turn",turn);
    const switched = {...turn,namespace:{...turn.namespace,userId:"account-b"}};
    expect(service.completeTurn("turn",switched)).toMatchObject({duplicate:true,rawTurnId:completed.rawTurnId,jobs:[]});
    repos.runtime.saveIdempotency("turn.complete:fixture:complete",stableHash({turnId:"turn",request:turn}),completed);
    expect(service.completeTurn("turn",switched)).toMatchObject({duplicate:true,rawTurnId:completed.rawTurnId});
    expect(()=>service.completeTurn("turn",{...switched,answer:"Different"})).toThrow(/different request body/);
  });
  it("invalidates ambiguous imported aliases and keeps remote identity without session evidence", () => {
    const {db,service} = fixture.createTestService();
    const opened = service.openSession({l3WorldModelProtocolVersion:2,l3WorldModelTransition:"resume_only",workspaceUri:uri,workspaceHostId:host,namespace:{source:"codex",profileId:"default",sessionKey:"alias-a"}});
    db.db.prepare("UPDATE sessions SET project_id='legacy',workspace_id='legacy-workspace' WHERE id=?").run(opened.sessionId);
    refreshProjectAliases(db.db);
    expect(canonicalProjectId(db.db,"legacy")).toBe(identity.projectId);
    const other = service.openSession({l3WorldModelProtocolVersion:2,l3WorldModelTransition:"resume_only",workspaceUri:uri,workspaceHostId:"b".repeat(64),namespace:{source:"codex",profileId:"default",sessionKey:"alias-b"}});
    db.db.prepare("UPDATE sessions SET project_id='legacy',workspace_id='legacy-workspace' WHERE id=?").run(other.sessionId);
    refreshProjectAliases(db.db);
    expect(canonicalProjectId(db.db,"legacy")).toBe("legacy");
    expect(canonicalProjectId(db.db,"legacy-workspace")).toBe("legacy-workspace");
    const remoteUri = "git://github.com/example/project";
    db.db.prepare("INSERT INTO l3_world_model_scopes(scope_key,user_id,project_id,workspace_uri,updated_at) VALUES ('old-remote','old-owner','old-project',?,?)").run(remoteUri,at);
    refreshProjectAliases(db.db);
    expect(canonicalProjectId(db.db,"old-project")).toBe(resolveWorkspaceIdentity(null,{workspaceUri:remoteUri}).projectId);
  });
  it("shares HTTP operation fingerprints across accounts and keeps content conflicts", async () => {
    const {db,service} = fixture.createTestService();
    const request = {adapterId:"fixture",requestId:"generic",namespace:{source:"codex",profileId:"default",userId:"a"}};
    const fingerprint = {path:"/memory/add",request:{...request,content:"same content"}};
    const run = vi.fn(async()=>({id:"result"}));
    await service.idempotent("memory.add",request,fingerprint,run);
    const switched = {...request,namespace:{...request.namespace,userId:"b"}};
    expect(await service.idempotent("memory.add",switched,{...fingerprint,request:{...fingerprint.request,...switched}},run)).toMatchObject({id:"result",duplicate:true});
    expect(run).toHaveBeenCalledTimes(1);
    await expect(service.idempotent("memory.add",switched,{...fingerprint,request:{...fingerprint.request,...switched,content:"different"}},run)).rejects.toThrow(/different request body/);
    expect(db.db.prepare("SELECT COUNT(*) FROM idempotency_keys").pluck().get()).toBe(1);
  });
});
