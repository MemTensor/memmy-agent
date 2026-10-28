import { L3WorldModelContextReadModel } from "../../src/service/read-model/l3-world-model-context.js";
import { L3WorldModelTraceFieldPipeline } from "../../src/service/evolution/l3-world-model-pipeline.js";
import type { LlmClient } from "../../src/model/types.js";
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryDb } from "../../src/storage/db.js";
import { SCHEMA_VERSION } from "../../src/storage/schema.js";
import { Repositories } from "../../src/storage/repositories.js";
import { canonicalJson, sha256Hex } from "../../src/contracts/index.js";
import { canonicalNamespaceKey, canonicalProjectId, refreshProjectAliases, reloadDeviceScopeAliases } from "../../src/storage/device-scope.js";
import { resolveWorkspaceIdentity } from "../../src/service/namespace/workspace-identity.js";
import { stableHash } from "../../src/utils/id.js";
import { memoryCaptureQaHash } from "../../src/utils/memory-capture-claim.js";
import { createMemoryServiceFixture } from "../fixtures/memory-service-fixture.js";
const fixture = createMemoryServiceFixture();
afterEach(fixture.cleanup);
const at = "2026-10-01T00:00:00.000Z", uri = "file:///workspace/shared", host = "a".repeat(64);
const identity = resolveWorkspaceIdentity(null, {workspaceUri: uri, workspaceHostId: host});
function legacyProject(user: string) {
  const workspaceId = sha256Hex(`${user}\0local\0${host}\0${uri}`);
  return {projectId: `ws_${workspaceId}`, workspaceId};
}
function seedV9(path: string, pendingEpisodeAssignment = false) {
  const db = new Database(path);
  const schema = readFileSync(new URL("../fixtures/schema-v9.sql", import.meta.url), "utf8");
  db.exec(pendingEpisodeAssignment ? schema.replace(/episode_id TEXT NOT NULL/g, "episode_id TEXT") : schema);
  if (pendingEpisodeAssignment) db.exec("UPDATE schema_migrations SET version=10, id='010_pending_episode_assignment'");
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
    // Historical provenance must link the captured turn, not only its mutable Session.
    db.prepare(`INSERT INTO source_turn_captures(user_id,source,profile_id,namespace_key,conversation_id,turn_id,content_hash,session_id,raw_turn_id,response_json,started_at,completed_at,created_at)
      VALUES (?,'codex','default',?,'native-conversation','native-turn','hash',?,?,'{"status":"rejected","reason":"fixture"}',?,?,?)`)
      .run(user,namespaceKey,`session-${user}`,`raw-${user}`,at,at,at);
  }
  db.prepare(`INSERT INTO token_usage_outbox VALUES (1,'old-token-event',?)`).run(JSON.stringify({ownerAccountId:"account-a",totalTokens:1234}));
  db.prepare(`INSERT INTO runtime_kv VALUES ('token-budget-fixture', ?, ?)`).run(JSON.stringify({accountId:"account-a",used:1234,limit:5678}),at);
  db.prepare(`INSERT INTO runtime_kv VALUES ('source_turn_capture_activated_at', ?, ?)`).run(JSON.stringify(at),at);
  db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES ('memory_change_log',9000)").run();
  return db;
}

// A v9 field update has full before/after snapshots, including explicit nulls.
function legacyFieldEdit(db: Database.Database, id: string, field: string, value: string | null, when: string) {
  const row = db.prepare("SELECT properties_json FROM memories WHERE id = ?").get(id) as { properties_json: string };
  const before = { id, properties: JSON.parse(row.properties_json) };
  const after = structuredClone(before);
  after.properties.internal_info.world_model[field] = value;
  db.prepare("UPDATE memories SET properties_json=?, updated_at=? WHERE id=?").run(JSON.stringify(after.properties),when,id);
  db.prepare("UPDATE l3_world_model_scopes SET updated_at=? WHERE memory_id=?").run(when,id);
  db.prepare(`INSERT INTO memory_change_log(memory_id,user_id,change_type,before_json,after_json,created_at,source)
    VALUES (?,'account-a','l3_world_model_update',?,?,?,'worker.l3_world_model.v1')`).run(id,JSON.stringify(before),JSON.stringify(after),when);
}

async function triggerLogRetention(db: MemoryDb, repos: Repositories) {
  db.db.transaction(() => {
    for (let i = 0; i < 10_000; i++) repos.runtime.appendChange({memoryId: "L1-account-a", userId: null,
      changeType: "fixture_unrelated", source: "fixture", createdAt: "2026-10-04T00:00:00.000Z"});
  })();
  await new Promise<void>(resolve => setImmediate(resolve));
}

describe("device memory / review regressions", () => {
  it.each([false, true])("preserves rowids while combining device and pending-Episode upgrades (upstream v10=%s)", pending => {
    const root = mkdtempSync(join(tmpdir(), "memmy-combined-scope-upgrade-"));
    const path = join(root, "memory.sqlite");
    let upgraded: MemoryDb | undefined;
    try {
      const legacy = seedV9(path, pending);
      legacy.exec("UPDATE raw_turns SET rowid=rowid+100");
      const before = legacy.prepare("SELECT rowid,* FROM raw_turns ORDER BY rowid").all();
      legacy.close();
      upgraded = new MemoryDb({ path });
      expect(upgraded.db.prepare("SELECT rowid,* FROM raw_turns ORDER BY rowid").all()).toEqual(before);
      const columns = upgraded.db.prepare("PRAGMA table_info(raw_turns)").all() as Array<{name: string; notnull: number}>;
      expect(columns.filter(column => ["user_id", "episode_id"].includes(column.name)).map(column => column.notnull)).toEqual([0, 0]);
      upgraded.db.prepare("INSERT INTO raw_turns(id,session_id,turn_id,created_at) VALUES ('pending-turn','session-account-a','new-turn',?)").run(at);
      expect(upgraded.db.prepare("SELECT episode_id,user_id FROM raw_turns WHERE id='pending-turn'").get()).toEqual({episode_id: null,user_id: null});
      expect(upgraded.db.pragma("foreign_key_check")).toEqual([]);
    } finally { upgraded?.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("does not apply an unowned deletion override when its device memory was skipped", () => {
    const {db} = fixture.createTestService(), repos = new Repositories(db.db);
    repos.l3WorldModels.upsertField({userId: null, projectId: "project-p", targetField: "project_contract", value: "Keep target rule"});
    const bundle = repos.runtime.exportBundleTables(true);
    bundle.memory_l3_overrides = [{project_key: "project-p", field: "projectContract", memory_id: null, deleted: 1}];
    // No target override conflict: the memory-row skip must govern this insert.
    db.db.exec("DELETE FROM memory_l3_overrides");
    const history = db.db.prepare("SELECT * FROM memories ORDER BY id").all();
    repos.runtime.importBundleTables(bundle, {conflictStrategy: "skip"});
    expect(repos.l3WorldModels.fields("another-account", "project-p").projectContract).toBe("Keep target rule");
    expect(db.db.prepare("SELECT * FROM memories ORDER BY id").all()).toEqual(history);
    expect(db.db.prepare("SELECT COUNT(*) FROM memory_l3_overrides").pluck().get()).toBe(0);
  });

  it("allows L3 model recreation after deleting a shared explicitly archived copy", () => {
    const {db} = fixture.createTestService(), repos = new Repositories(db.db);
    const archivedAt = "2026-01-01T00:00:00.000Z";
    const original = repos.l3WorldModels.upsertField({userId: "old-a", projectId: "p",
      targetField: "project_contract", value: "old rule", at: archivedAt})!;
    const stored = db.db.prepare("SELECT * FROM memories WHERE id=?").get(original.id) as Record<string, unknown>;
    const properties = JSON.parse(String(stored.properties_json)) as {
      status: string;
      internal_info: Record<string, unknown>;
    };
    properties.status = "archived";
    properties.internal_info.l3_world_model_explicitly_archived = true;
    const originalScopeKey = `l3wm:${sha256Hex(canonicalJson({userId: "old-a", projectId: "p"}))}`;
    db.db.prepare(`UPDATE memories SET user_id='old-a', memory_key='world_model:project:old-a:p', status='archived',
      properties_json=?, updated_at=? WHERE id=?`).run(JSON.stringify(properties), archivedAt, original.id);
    db.db.prepare("UPDATE l3_world_model_scopes SET user_id='old-a', scope_key=?, updated_at=? WHERE memory_id=?")
      .run(originalScopeKey, archivedAt, original.id);

    const secondId = "legacy-b";
    const secondUpdatedAt = "2026-01-02T00:00:00.000Z";
    const second: Record<string, unknown> = {...stored, id: secondId, user_id: "old-b", memory_key: "world_model:project:old-b:p",
      updated_at: secondUpdatedAt};
    const columns = Object.keys(second);
    db.db.prepare(`INSERT INTO memories (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
      .run(...columns.map(column => second[column]));
    const secondScopeKey = `l3wm:${sha256Hex(canonicalJson({userId: "old-b", projectId: "p"}))}`;
    db.db.prepare(`INSERT INTO l3_world_model_scopes(scope_key,user_id,project_id,memory_id,updated_at)
      VALUES (?,'old-b','p',?,?)`).run(secondScopeKey, secondId, secondUpdatedAt);
    db.db.exec("DELETE FROM memory_l3_overrides");

    expect(repos.l3WorldModels.getMemory("old-b", "p")?.status).toBe("archived");
    repos.l3WorldModels.deleteScopeMemory(secondId, "2026-01-03T00:00:00.000Z");
    const dbPath = db.path;
    db.close();
    const reopenedDb = new MemoryDb({path: dbPath}), reopenedRepos = new Repositories(reopenedDb.db);
    try {
      const afterDelete = reopenedRepos.l3WorldModels.getMemory("old-b", "p");
      expect(afterDelete?.properties.internal_info.l3_world_model_explicitly_archived).toBeUndefined();
      const recreated = reopenedRepos.l3WorldModels.upsertField({userId: "old-b", projectId: "p",
        targetField: "project_contract", value: "new rule", at: "2026-01-04T00:00:00.000Z"});
      expect(recreated?.status).toBe("activated");
      expect(reopenedRepos.l3WorldModels.fields("old-b", "p").projectContract).toBe("new rule");
    } finally { reopenedDb.close(); }
  });

  it("skips archive evidence for protected L3 rows while importing unrelated bundle data", () => {
    const {db} = fixture.createTestService(), repos = new Repositories(db.db);
    const original = repos.l3WorldModels.upsertField({userId: "legacy", projectId: "p",
      targetField: "project_contract", value: "rule", at: "2026-01-01T00:00:00.000Z"})!;
    repos.l3WorldModels.upsertField({userId: "legacy", projectId: "p", targetField: "project_contract",
      value: null, at: "2026-01-02T00:00:00.000Z"});
    const bundle = repos.runtime.exportBundleTables(true);
    const incomingMemory = bundle.memories!.find(row => row.id === original.id)!;
    const incomingProperties = JSON.parse(incomingMemory.properties_json as string) as {
      internal_info: Record<string, unknown>;
    };
    incomingProperties.internal_info.l3_world_model_explicitly_archived = true;
    incomingMemory.properties_json = JSON.stringify(incomingProperties);
    bundle.audit_logs = [{id: "incoming-archive-audit", user_id: null, actor_json: "{}", action: "archive",
      target_kind: "world_model", target_id: original.id, created_at: "2026-01-03T00:00:00.000Z"}];
    bundle.memory_change_log = [{seq: 99_999, memory_id: original.id, user_id: null, change_type: "archive",
      source: "fixture", created_at: "2026-01-03T00:00:00.000Z"}];
    bundle.artifacts = [{id: "unrelated-artifact", user_id: null, kind: "fixture", payload_json: "{}",
      created_at: "2026-01-03T00:00:00.000Z"}];

    const result = repos.runtime.importBundleTables(bundle, {conflictStrategy: "skip"});
    expect(result.skipped.audit_logs).toBe(1);
    expect(result.skipped.memory_change_log).toBe(1);
    const dbPath = db.path;
    db.close();
    const reopenedDb = new MemoryDb({path: dbPath}), reopenedRepos = new Repositories(reopenedDb.db);
    try {
      expect(reopenedDb.db.prepare("SELECT COUNT(*) FROM artifacts WHERE id='unrelated-artifact'").pluck().get()).toBe(1);
      const projected = reopenedRepos.l3WorldModels.getMemory("legacy", "p");
      expect(projected?.status).toBe("archived");
      expect(projected?.properties.internal_info.l3_world_model_explicitly_archived).toBeUndefined();
    } finally { reopenedDb.close(); }
  });

  it.each([false, true])("keeps skipped historical memories unchanged by imported edit logs or metadata (metadata=%s)", async withMetadata => {
    const root = mkdtempSync(join(tmpdir(), "memmy-l3-skip-import-")), path = join(root, "target.sqlite");
    let db: MemoryDb | undefined;
    try {
      seedV9(path).close(); db = new MemoryDb({path});
      let repos = new Repositories(db.db);
      const bundle = repos.runtime.exportBundleTables(true);
      const history = db.db.prepare("SELECT * FROM memories ORDER BY id").all();
      const incoming = bundle.memories!.find(row => row.id === "L3-account-a")!;
      const before = {properties: JSON.parse(incoming.properties_json as string)};
      const after = structuredClone(before); after.properties.internal_info.world_model.project_contract = null;
      incoming.properties_json = JSON.stringify(after.properties); incoming.memory_value = ""; incoming.updated_at = "2026-10-02T00:00:00.000Z";
      bundle.memory_change_log = [{seq: 9999, memory_id: incoming.id, user_id: "account-a", change_type: "l3_world_model_update",
        before_json: JSON.stringify(before), after_json: JSON.stringify(after), source: "fixture", created_at: incoming.updated_at}];
      if (withMetadata) bundle.memory_l3_legacy_field_edits = [{memory_id: incoming.id, field: "project_contract",
        deleted: 1, edited_at: incoming.updated_at, change_seq: 9999}];
      else delete bundle.memory_l3_legacy_field_edits;
      const result = repos.runtime.importBundleTables(bundle, {conflictStrategy: "skip"});
      expect(result.skipped.memories).toBe(history.length);
      expect(result.skipped.memory_change_log).toBe(1);
      expect(repos.l3WorldModels.fields(null, identity.projectId).projectContract).toBe("Run tests");
      await triggerLogRetention(db, repos);
      db.close(); db = new MemoryDb({path}); repos = new Repositories(db.db);
      expect(repos.l3WorldModels.fields("new-account", identity.projectId).projectContract).toBe("Run tests");
      expect(db.db.prepare("SELECT * FROM memories ORDER BY id").all()).toEqual(history);
      expect(db.db.prepare("SELECT COUNT(*) FROM memory_l3_legacy_field_edits").pluck().get()).toBe(0);
    } finally {db?.close(); rmSync(root, {recursive: true, force: true});}
  });

  it.each([false, true])("preserves old bundle deletion/recreation despite target-local log sequence collisions (recreated=%s)", async recreated => {
    const root = mkdtempSync(join(tmpdir(), "memmy-l3-import-collision-")), path = join(root, "source.sqlite");
    let source: MemoryDb | undefined, target: MemoryDb | undefined;
    try {
      const old = seedV9(path);
      old.prepare(`UPDATE memories SET properties_json=json_set(properties_json,'$.internal_info.world_model.project_contract','Run tests') WHERE id='L3-account-b'`).run();
      legacyFieldEdit(old, "L3-account-a", "project_contract", null, "2026-10-02T00:00:00.000Z");
      if (recreated) legacyFieldEdit(old, "L3-account-b", "project_contract", "Recreated rule", "2026-10-02T00:00:00.000Z");
      const history = old.prepare("SELECT * FROM memories ORDER BY id").all(); old.close();
      source = new MemoryDb({path});
      const bundle = new Repositories(source.db).runtime.exportBundleTables(true);
      delete bundle.memory_l3_legacy_field_edits; // v9/v10 exports have only logs.
      const targetPath = join(root, "target.sqlite");
      target = new MemoryDb({path: targetPath});
      for (const change of bundle.memory_change_log!) target.db.prepare(
        "INSERT INTO memory_change_log(seq,memory_id,change_type,source,created_at) VALUES (?,'unrelated','fixture','fixture',?)"
      ).run(change.seq, at);
      let repos = new Repositories(target.db);
      const logs = target.db.prepare("SELECT * FROM memory_change_log ORDER BY seq").all();
      // Conflict errors must roll back both data and inferred metadata.
      expect(() => repos.runtime.importBundleTables(bundle, {conflictStrategy: "error"})).toThrow("import conflict");
      expect(target.db.prepare("SELECT COUNT(*) FROM memories").pluck().get()).toBe(0);
      expect(target.db.prepare("SELECT COUNT(*) FROM memory_l3_legacy_field_edits").pluck().get()).toBe(0);
      const result = repos.runtime.importBundleTables(bundle);
      expect(result.skipped.memory_change_log).toBe(bundle.memory_change_log!.length);
      expect(target.db.prepare("SELECT * FROM memory_change_log ORDER BY seq").all()).toEqual(logs);
      expect(target.db.prepare("SELECT * FROM memories ORDER BY id").all()).toEqual(history);
      const expected = recreated ? "Recreated rule" : null;
      expect(repos.l3WorldModels.fields("new-account", identity.projectId).projectContract).toBe(expected);
      await triggerLogRetention(target, repos);
      target.close(); target = new MemoryDb({path: targetPath}); repos = new Repositories(target.db);
      expect(repos.l3WorldModels.fields(null, identity.projectId).projectContract).toBe(expected);
    } finally {source?.close(); target?.close(); rmSync(root, {recursive: true, force: true});}
  });

  it.each([null, "2026-10-02T00:00:00.000Z", "2026-10-03T00:00:00.000Z"])(
    "retains historical field deletion/recreation (%s) after actual log pruning, restart and bundle restore", async recreatedAt => {
      const root = mkdtempSync(join(tmpdir(), "memmy-durable-l3-")), path = join(root, "memory.sqlite");
      let db: MemoryDb | undefined, restored: MemoryDb | undefined;
      try {
        const old = seedV9(path);
        old.prepare(`UPDATE memories SET properties_json=json_set(properties_json,'$.internal_info.world_model.project_contract','Run tests') WHERE id='L3-account-b'`).run();
        legacyFieldEdit(old, "L3-account-a", "project_contract", null, "2026-10-02T00:00:00.000Z");
        if (recreatedAt) legacyFieldEdit(old, "L3-account-b", "project_contract", "Recreated rule", recreatedAt);
        legacyFieldEdit(old, "L3-account-b", "domain_knowledge", "Unrelated update", "2026-10-03T01:00:00.000Z");
        const history = old.prepare("SELECT * FROM memories ORDER BY id").all();
        old.close();
        db = new MemoryDb({path});
        let repos = new Repositories(db.db);
        await triggerLogRetention(db, repos);
        expect(db.db.prepare("SELECT COUNT(*) FROM memory_change_log").pluck().get()).toBe(10_000);
        expect(db.db.prepare("SELECT COUNT(*) FROM memory_change_log WHERE change_type='l3_world_model_update'").pluck().get()).toBe(0);
        const expected = {projectContract: recreatedAt ? "Recreated rule" : null, domainKnowledge: "Unrelated update"};
        for (const user of ["account-a", "account-b", "account-c", null]) expect(repos.l3WorldModels.fields(user, identity.projectId)).toMatchObject(expected);
        db.close(); db = new MemoryDb({path}); repos = new Repositories(db.db);
        expect(repos.l3WorldModels.fields("account-c", identity.projectId)).toMatchObject(expected);
        expect(db.db.prepare("SELECT * FROM memories ORDER BY id").all()).toEqual(history);
        const bundle = repos.runtime.exportBundleTables(true);
        expect(bundle.memory_l3_legacy_field_edits).toEqual(expect.arrayContaining([
          expect.objectContaining({memory_id: "L3-account-a", field: "project_contract", deleted: 1})
        ]));
        restored = new MemoryDb({path: join(root, "restored.sqlite")});
        const restoredRepos = new Repositories(restored.db);
        restoredRepos.runtime.importBundleTables(bundle);
        expect(restoredRepos.l3WorldModels.fields("account-d", identity.projectId)).toMatchObject(expected);
        expect(restored.db.prepare("SELECT * FROM memories ORDER BY id").all()).toEqual(history);
        restoredRepos.clearAllMemoryData();
        expect(restored.db.prepare("SELECT COUNT(*) FROM memory_l3_legacy_field_edits").pluck().get()).toBe(0);
        restoredRepos.l3WorldModels.upsertField({userId: "account-d", projectId: identity.projectId, targetField: "project_contract", value: "Fresh rule"});
        expect(restoredRepos.l3WorldModels.fields(null, identity.projectId).projectContract).toBe("Fresh rule");
        db.close(); db = new MemoryDb({path, readonly: true});
        expect(new Repositories(db.db).l3WorldModels.fields("account-d", identity.projectId)).toMatchObject(expected);
      } finally {db?.close(); restored?.close(); rmSync(root, {recursive: true, force: true});}
    }
  );

  it("keeps source logs if persisting deletion evidence fails, then retries atomically", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-l3-prune-failure-")), path = join(root, "memory.sqlite");
    let db: MemoryDb | undefined;
    try {
      seedV9(path).close(); db = new MemoryDb({path});
      legacyFieldEdit(db.db, "L3-account-a", "project_contract", null, "2026-10-02T00:00:00.000Z");
      db.db.exec(`CREATE TRIGGER reject_field_edits BEFORE INSERT ON memory_l3_legacy_field_edits
        BEGIN SELECT RAISE(ABORT, 'fixture persistence failure'); END`);
      const repos = new Repositories(db.db);
      await triggerLogRetention(db, repos);
      expect(db.db.prepare("SELECT COUNT(*) FROM memory_change_log").pluck().get()).toBe(10_001);
      expect(repos.l3WorldModels.fields("account-b", identity.projectId).projectContract).toBeNull();
      db.db.exec("DROP TRIGGER reject_field_edits");
      repos.runtime.appendChange({memoryId: "L1-account-a", userId: null, changeType: "fixture_retry", source: "fixture", createdAt: "2026-10-05T00:00:00.000Z"});
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(db.db.prepare("SELECT COUNT(*) FROM memory_change_log").pluck().get()).toBe(10_000);
      expect(repos.l3WorldModels.fields("account-c", identity.projectId).projectContract).toBeNull();
      expect(db.db.prepare("SELECT deleted FROM memory_l3_legacy_field_edits WHERE field='project_contract'").pluck().get()).toBe(1);
    } finally {db?.close(); rmSync(root, {recursive: true, force: true});}
  });

  it("upgrades v10 metadata without changing historical rows and reads pre-upgrade v10 logs read-only", () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-v10-l3-upgrade-")), path = join(root, "memory.sqlite");
    let db: MemoryDb | undefined;
    try {
      seedV9(path).close(); db = new MemoryDb({path});
      // v10 has the same data tables, but no durable field-edit table.
      db.db.exec(`DROP TABLE memory_l3_legacy_field_edits; DELETE FROM schema_migrations;
        INSERT INTO schema_migrations VALUES ('010_device_memory_scope',10,'2026-10-01','fixture-v10')`);
      legacyFieldEdit(db.db, "L3-account-a", "project_contract", null, "2026-10-02T00:00:00.000Z");
      const history = db.db.prepare("SELECT * FROM memories ORDER BY id").all();
      const logs = db.db.prepare("SELECT * FROM memory_change_log ORDER BY seq").all();
      db.close(); rmSync(`${path}.pre-v${SCHEMA_VERSION}.bak`);
      db = new MemoryDb({path, readonly: true});
      expect(new Repositories(db.db).l3WorldModels.fields("account-c", identity.projectId).projectContract).toBeNull();
      expect(new Repositories(db.db).runtime.exportBundleTables(true).memory_l3_legacy_field_edits).toBeUndefined();
      expect(db.schemaVersion().version).toBe(10);
      db.close(); db = new MemoryDb({path});
      expect(db.schemaVersion().version).toBe(SCHEMA_VERSION);
      expect(db.db.prepare("SELECT * FROM memories ORDER BY id").all()).toEqual(history);
      expect(db.db.prepare("SELECT * FROM memory_change_log ORDER BY seq").all()).toEqual(logs);
      expect(db.db.prepare("SELECT deleted FROM memory_l3_legacy_field_edits WHERE field='project_contract'").pluck().get()).toBe(1);
      const backup = new Database(`${path}.pre-v${SCHEMA_VERSION}.bak`, {readonly: true});
      try {expect(backup.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get()).toBe(10);}
      finally {backup.close();}
    } finally {db?.close(); rmSync(root, {recursive: true, force: true});}
  });

  it("opens an unupgraded v9 database read-only without writing missing device-scope tables", () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-v9-readonly-device-scope-")), path = join(root, "memory.sqlite");
    let db: MemoryDb | undefined;
    try {
      seedV9(path).close();
      db = new MemoryDb({ path, readonly: true });
      expect(db.schemaVersion().version).toBe(9);
      expect(canonicalProjectId(db.db, legacyProject("account-a").projectId)).toBe(identity.projectId);
      const oldNamespaceKey = stableHash({
        tenantId: null,
        projectId: legacyProject("account-a").projectId,
        workspaceId: legacyProject("account-a").workspaceId
      });
      const canonicalNamespace = stableHash({
        tenantId: null,
        projectId: identity.projectId,
        workspaceId: identity.workspaceId
      });
      expect(canonicalNamespaceKey(db.db, oldNamespaceKey)).toBe(canonicalNamespace);
      const repos = new Repositories(db.db);
      expect(repos.l3WorldModels.getMemory(null, identity.projectId)?.memoryValue).toContain("Run tests");
      const bundle = repos.runtime.exportBundleTables(true);
      expect(bundle.memories).toHaveLength(4);
      expect(bundle.memory_project_aliases).toBeUndefined();
      expect(bundle.memory_namespace_aliases).toBeUndefined();
      expect(bundle.memory_l3_overrides).toBeUndefined();
      refreshProjectAliases(db.db);
      reloadDeviceScopeAliases(db.db);
      expect(canonicalNamespaceKey(db.db, oldNamespaceKey)).toBe(canonicalNamespace);
      expect(db.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_project_aliases'").get()).toBeUndefined();
      expect(db.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_namespace_aliases'").get()).toBeUndefined();
      db.close(); db = undefined;

      db = new MemoryDb({ path });
      expect(db.schemaVersion().version).toBe(SCHEMA_VERSION);
      expect(db.db.prepare("SELECT COUNT(*) FROM memory_project_aliases").pluck().get()).toBeGreaterThan(0);
    } finally { db?.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("reports missing metadata tables as corruption when a read-only database claims the current schema", () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-current-readonly-corruption-")), path = join(root, "memory.sqlite");
    let db: MemoryDb | undefined;
    try {
      db = new MemoryDb({ path });
      const repos = new Repositories(db.db);
      repos.l3WorldModels.upsertField({
        userId: "current-account",
        projectId: "current-project",
        targetField: "project_contract",
        value: "Current schema test content."
      });
      db.db.exec("DROP TABLE memory_l3_overrides; DROP TABLE memory_project_aliases;");
      db.close();
      db = new MemoryDb({ path, readonly: true });
      expect(db.schemaVersion().version).toBe(SCHEMA_VERSION);
      const readonlyRepos = new Repositories(db.db);
      expect(() => readonlyRepos.l3WorldModels.getMemory(null, "current-project"))
        .toThrow(/no such table: memory_l3_overrides/);
      expect(() => readonlyRepos.runtime.exportBundleTables(true))
        .toThrow(/no such table: memory_project_aliases/);
    } finally { db?.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it("reads a proven v1 capture through project aliases without rewriting the claim", () => {
    const root=mkdtempSync(join(tmpdir(),"memmy-legacy-claim-")),path=join(root,"memory.sqlite");
    try {
      const old=seedV9(path),qaHash=memoryCaptureQaHash("query","answer");
      old.prepare(`INSERT INTO memory_capture_claims VALUES ('account-a','codex',?,'L1-account-a','turn_complete',?)`).run(qaHash,at);
      const claims=old.prepare("SELECT * FROM memory_capture_claims").all();old.close();
      const db=new MemoryDb({path}),repos=new Repositories(db.db);
      try {
        const scope=repos.captureClaims.identity({projectId:identity.projectId!,workspaceId:identity.workspaceId!,profileId:"default",sessionKey:"native-conversation"},"native-turn")!;
        expect(repos.captureClaims.get("account-c","codex",qaHash,scope)?.primaryMemoryId).toBe("L1-account-a");
        expect(repos.captureClaims.get("account-c","codex",qaHash,{...scope,projectId:"other-project"})).toBeUndefined();
        expect(repos.captureClaims.get("account-c","codex",qaHash)).toBeUndefined();
        expect(db.db.prepare("SELECT * FROM memory_capture_claims").all()).toEqual(claims);
      } finally {db.close();}
    } finally {rmSync(root,{recursive:true,force:true});}
  });

  it("preserves explicit legacy field deletions without mistaking missing fields for tombstones", () => {
    const root = mkdtempSync(join(tmpdir(),"memmy-legacy-field-edit-")), path = join(root,"memory.sqlite");
    let db: MemoryDb | undefined;
    try {
      const old = seedV9(path);
      old.prepare(`UPDATE memories SET properties_json=json_set(properties_json,'$.internal_info.world_model.project_contract','Run tests') WHERE id='L3-account-b'`).run();
      legacyFieldEdit(old,"L3-account-a","project_contract",null,"2026-10-02T00:00:00.000Z");
      // Updating an unrelated field later must not resurrect the stale contract.
      legacyFieldEdit(old,"L3-account-b","domain_knowledge","New unrelated knowledge","2026-10-03T00:00:00.000Z");
      const history = old.prepare("SELECT * FROM memories ORDER BY id").all();
      const logs = old.prepare("SELECT * FROM memory_change_log ORDER BY seq").all();
      old.close();
      db = new MemoryDb({path});
      let repos = new Repositories(db.db);
      expect(repos.l3WorldModels.fields("account-b",identity.projectId)).toMatchObject({projectContract:null,domainKnowledge:"New unrelated knowledge"});
      db.close(); db = new MemoryDb({path}); repos = new Repositories(db.db);
      expect(repos.l3WorldModels.fields("account-c",identity.projectId).projectContract).toBeNull();
      expect(db.db.prepare("SELECT * FROM memories ORDER BY id").all()).toEqual(history);
      expect(db.db.prepare("SELECT * FROM memory_change_log ORDER BY seq").all()).toEqual(logs);
      repos.l3WorldModels.upsertField({userId:"account-c",projectId:identity.projectId,targetField:"project_contract",value:"New deliberate rule"});
      expect(repos.l3WorldModels.fields("account-d",identity.projectId).projectContract).toBe("New deliberate rule");
    } finally {db?.close();rmSync(root,{recursive:true,force:true});}
  });

  it.each(["2026-10-02T00:00:00.000Z", "2026-10-03T00:00:00.000Z"])("allows an explicitly recreated historical field at %s", (recreatedAt) => {
    const root=mkdtempSync(join(tmpdir(),"memmy-legacy-recreate-")),path=join(root,"memory.sqlite");
    try {
      const old=seedV9(path);
      legacyFieldEdit(old,"L3-account-a","project_contract",null,"2026-10-02T00:00:00.000Z");
      legacyFieldEdit(old,"L3-account-b","project_contract","Later rule",recreatedAt);
      old.close();const db=new MemoryDb({path});
      try {expect(new Repositories(db.db).l3WorldModels.fields(null,identity.projectId).projectContract).toBe("Later rule");}
      finally {db.close();}
    } finally {rmSync(root,{recursive:true,force:true});}
  });

  it("inherits the provenance of all selected historical L3 fields on the first device write", () => {
    const root=mkdtempSync(join(tmpdir(),"memmy-l3-lineage-")),path=join(root,"memory.sqlite");
    let db: MemoryDb | undefined;
    try {
      const old=seedV9(path);
      for (const user of ["account-a","account-b"]) old.prepare(`UPDATE memories
        SET info_json=json_set(info_json,'$.source_memory_ids',json(?)),
          properties_json=json_set(properties_json,'$.internal_info.source_memory_ids',json(?)) WHERE id=?`)
        .run(JSON.stringify([`L1-${user}`]),JSON.stringify([`L1-${user}`]),`L3-${user}`);
      const history=old.prepare("SELECT * FROM memories ORDER BY id").all();old.close();
      db=new MemoryDb({path});let repos=new Repositories(db.db);
      expect(repos.l3WorldModels.getMemory(null,identity.projectId)?.info.source_memory_ids).toEqual(expect.arrayContaining(["L1-account-a","L1-account-b"]));
      repos.l3WorldModels.upsertField({userId:"account-c",projectId:identity.projectId,targetField:"domain_knowledge",value:"New knowledge"});
      db.close();db=new MemoryDb({path});repos=new Repositories(db.db);
      const context=new L3WorldModelContextReadModel(repos).load(repos.runtime.getSession("session-account-a")!);
      expect(context.projectContract).toBe("Run tests");
      expect(context.sourceMemoryIds).toHaveLength(2);
      expect(context.sourceMemoryIds).toEqual(expect.arrayContaining(["L1-account-a","L1-account-b"]));
      expect(db.db.prepare("SELECT * FROM memories WHERE user_id IS NOT NULL ORDER BY id").all()).toEqual(history);
    } finally {db?.close();rmSync(root,{recursive:true,force:true});}
  });

  it("changes the context revision when an inherited same-text profile becomes valid", () => {
    const root=mkdtempSync(join(tmpdir(),"memmy-l3-revision-")),path=join(root,"memory.sqlite");
    try {
      const old=seedV9(path);
      old.prepare(`UPDATE memories SET properties_json=json_set(properties_json,'$.internal_info.world_model.project_environment_profile','Uses Node 22') WHERE id='L3-account-a'`).run();old.close();
      const db=new MemoryDb({path}),repos=new Repositories(db.db);
      try {
        repos.l3WorldModels.upsertField({userId:null,projectId:identity.projectId,targetField:"project_contract",value:"Updated rule"});
        const session=repos.runtime.getSession("session-account-a")!,reader=new L3WorldModelContextReadModel(repos);
        const before=reader.load(session);
        repos.projectEnvironments.requestScan({userId:null,projectId:identity.projectId!,sessionId:session.id,trigger:"session_start",dedupeKey:"revision-scan"});
        repos.projectEnvironments.applyProfile({userId:null,projectId:identity.projectId!,scanId:repos.projectEnvironments.getState(null,identity.projectId!)!.currentScanId!,projectKind:"code",fingerprint:"same-tree",expectedCurrentProfile:"Uses Node 22",operation:"noop",profile:""});
        const after=reader.load(session);
        expect(before.projectEnvironmentProfile).toBeNull();
        expect(after.projectEnvironmentProfile).toBe("Uses Node 22");
        expect(after.memoryId).toBe(before.memoryId);
        expect(after.memoryVersion).not.toBe(before.memoryVersion);
        expect(reader.load({...session,userId:"another-account"}).memoryVersion).toBe(after.memoryVersion);
      } finally {db.close();}
    } finally {rmSync(root,{recursive:true,force:true});}
  });

  it("accepts old workspace aliases while rejecting another real workspace", () => {
    const root=mkdtempSync(join(tmpdir(),"memmy-l3-namespace-")),path=join(root,"memory.sqlite");
    try {
      seedV9(path).close();const db=new MemoryDb({path});
      try {
        const service=fixture.createTestMemoryService({db});
        const namespace={source:"codex",profileId:"default",userId:"account-c",...legacyProject("account-a"),sessionKey:"host-account-a"};
        const envelope={adapterId:"fixture",requestId:"123e4567-e89b-42d3-a456-426614174000"};
        expect(service.l3WorldModelContext("session-account-a",{...envelope,namespace}).projectContract).toBe("Run tests");
        expect(()=>service.l3WorldModelContext("session-account-a",{...envelope,namespace:{...namespace,workspaceId:"different-workspace"}})).toThrow("scope_conflict");
      } finally {db.close();}
    } finally {rmSync(root,{recursive:true,force:true});}
  });

  it("leases only runnable historical scope heads without a cross-scope cycle", () => {
    const root=mkdtempSync(join(tmpdir(),"memmy-l3-queue-")),path=join(root,"memory.sqlite");
    try {
      const old=seedV9(path);
      old.prepare("UPDATE evolution_jobs SET id='job-z' WHERE id='job-account-a'").run();
      old.prepare("UPDATE evolution_jobs SET id='job-m' WHERE id='job-account-b'").run();
      old.prepare(`INSERT INTO evolution_jobs(id,job_type,status,user_id,session_id,scope_key,scope_seq,payload_json,attempts,max_attempts,created_at,updated_at)
        SELECT 'job-a',job_type,status,user_id,session_id,scope_key,2,payload_json,attempts,max_attempts,created_at,updated_at FROM evolution_jobs WHERE id='job-z'`).run();
      old.close();const db=new MemoryDb({path}),repos=new Repositories(db.db);
      try {
        const lease=()=>repos.runtime.leaseQueuedJobs(10,60,undefined,false,["l3_world_model_update"]).map(job=>job.id);
        expect(lease()).toEqual(["job-m"]);
        expect(lease()).toEqual([]);
        db.db.prepare("UPDATE evolution_jobs SET status='succeeded' WHERE id='job-m'").run();
        expect(lease()).toEqual(["job-z"]);
        repos.runtime.requeueLeasedJobsAfterRestart();
        expect(lease()).toEqual(["job-z"]);
        db.db.prepare("UPDATE evolution_jobs SET status='succeeded' WHERE id='job-z'").run();
        expect(lease()).toEqual(["job-a"]);
      } finally {db.close();}
    } finally {rmSync(root,{recursive:true,force:true});}
  });

  it.each(["failed", "backoff"])("does not let a %s scope block another runnable scope", (state) => {
    const root=mkdtempSync(join(tmpdir(),"memmy-l3-blocked-head-")),path=join(root,"memory.sqlite");
    try {
      seedV9(path).close();const db=new MemoryDb({path}),repos=new Repositories(db.db);
      try {
        db.db.prepare(`UPDATE evolution_jobs SET status=?,payload_json=json_set(payload_json,'$.runAfter',?) WHERE id='job-account-a'`)
          .run(state==="failed"?"failed":"queued",state==="backoff"?"2099-01-01T00:00:00.000Z":null);
        expect(repos.runtime.leaseQueuedJobs(10,60,undefined,false,["l3_world_model_update"]).map(job=>job.id)).toEqual(["job-account-b"]);
        db.db.prepare("UPDATE evolution_jobs SET status='succeeded' WHERE id='job-account-b'").run();
        db.db.prepare("UPDATE evolution_jobs SET status='queued',payload_json=json_remove(payload_json,'$.runAfter') WHERE id='job-account-a'").run();
        expect(repos.runtime.leaseQueuedJobs(10,60,undefined,false,["l3_world_model_update"]).map(job=>job.id)).toEqual(["job-account-a"]);
      } finally {db.close();}
    } finally {rmSync(root,{recursive:true,force:true});}
  });
});
describe("device memory / preserved schema-v9 history", () => {
  it("upgrades NOT NULL tables verbatim, resolves aliases and never resurrects deleted legacy fields", () => {
    const root = mkdtempSync(join(tmpdir(),"memmy-uid-upgrade-")), path = join(root,"memory.sqlite");
    try {
      const old = seedV9(path);
      const snapshots = ["memories","sessions","l3_world_model_scopes","source_turn_captures","user_memories","runtime_kv","token_usage_outbox","raw_turns","l3_world_model_evidence_batches","evolution_jobs"].map(table => [table,old.prepare(`SELECT * FROM ${table}`).all()] as const);
      old.close();
      const db = new MemoryDb({path});
      expect(db.schemaVersion().version).toBe(SCHEMA_VERSION);
      expect(existsSync(`${path}.pre-v${SCHEMA_VERSION}.bak`)).toBe(true);
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

  it.each(["queued", "failed"] as const)("resumes %s legacy L3 jobs with feedback without rewriting history", async (status) => {
    const root = mkdtempSync(join(tmpdir(), "memmy-feedback-upgrade-")), path = join(root, "memory.sqlite");
    try {
      const old = seedV9(path);
      const projectId = legacyProject("account-a").projectId;
      old.prepare(`INSERT INTO feedback(id,user_id,project_id,session_id,l1_memory_id,raw_turn_id,channel,polarity,rationale,created_at)
        VALUES ('feedback-a','account-a',?,'session-account-a','L1-account-a','raw-account-a','explicit','positive','Keep this rule',?)`).run(projectId,at);
      const payload = {scopeKey:`l3wm:${sha256Hex(canonicalJson({userId:"account-a",projectId}))}`,scopeSeq:1,userId:"account-a",projectId,sessionId:"session-account-a",trigger:"session_close",startTraceSeq:1,endTraceSeq:1,l1MemoryIds:["L1-account-a"],rawTurnIds:["raw-account-a"],feedbackIds:["feedback-a"]};
      old.prepare("UPDATE l3_world_model_evidence_batches SET feedback_ids_json=?,payload_hash=? WHERE id='batch-account-a'")
        .run(JSON.stringify(payload.feedbackIds),sha256Hex(canonicalJson(payload)));
      old.prepare("UPDATE evolution_jobs SET status=? WHERE id='job-account-a'").run(status);
      const feedbackBefore = old.prepare("SELECT * FROM feedback").all();
      const batchBefore = old.prepare("SELECT id,user_id,project_id,scope_key,scope_seq,session_id,trigger,start_trace_seq,end_trace_seq,l1_memory_ids_json,raw_turn_ids_json,feedback_ids_json,payload_hash,created_at FROM l3_world_model_evidence_batches").all();
      const memoriesBefore = old.prepare("SELECT id,user_id,memory_value FROM memories ORDER BY id").all();
      old.close();
      const db = new MemoryDb({path}), repos = new Repositories(db.db);
      try {
        expect(repos.runtime.getFeedback("feedback-a")?.projectId).toBe(identity.projectId);
        expect(repos.runtime.listFeedback({userId:"another-account",sessionId:"session-account-a"})[0]?.projectId).toBe(identity.projectId);
        const complete = vi.fn(async () => JSON.stringify({op:"noop",project_contract:"",reason:"already recorded"}));
        const pipeline = new L3WorldModelTraceFieldPipeline({repos,skillLlm:{config:{},isConfigured:()=>true,complete} as unknown as LlmClient});
        const job = repos.runtime.getJob("job-account-a")!;
        // A different project remains invalid even though account ownership is ignored.
        db.db.prepare("UPDATE feedback SET project_id='unrelated-project' WHERE id='feedback-a'").run();
        await expect(pipeline.updateField(job)).rejects.toThrow("feedback scope mismatch");
        expect(complete).not.toHaveBeenCalled();
        db.db.prepare("UPDATE feedback SET project_id=? WHERE id='feedback-a'").run(projectId);
        db.db.prepare("UPDATE l3_world_model_evidence_batches SET payload_hash='tampered' WHERE id='batch-account-a'").run();
        await expect(pipeline.updateField(job)).rejects.toThrow("batch payload hash mismatch");
        expect(complete).not.toHaveBeenCalled();
        db.db.prepare("UPDATE l3_world_model_evidence_batches SET payload_hash=? WHERE id='batch-account-a'").run(sha256Hex(canonicalJson(payload)));
        await pipeline.updateField(job);
        expect(complete).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(complete.mock.calls)).toContain("Keep this rule");
        expect(repos.l3WorldModels.getTarget("batch-account-a","project_contract")?.status).toBe("applied");
        expect(db.db.prepare("SELECT * FROM feedback").all()).toEqual(feedbackBefore);
        expect(db.db.prepare("SELECT id,user_id,project_id,scope_key,scope_seq,session_id,trigger,start_trace_seq,end_trace_seq,l1_memory_ids_json,raw_turn_ids_json,feedback_ids_json,payload_hash,created_at FROM l3_world_model_evidence_batches").all()).toEqual(batchBefore);
        expect(db.db.prepare("SELECT id,user_id,memory_value FROM memories ORDER BY id").all()).toEqual(memoriesBefore);
      } finally { db.close(); }
    } finally { rmSync(root,{recursive:true,force:true}); }
  });

  it.each(["project_contract", "domain_knowledge"] as const)("inherits the applied profile when first updating %s after upgrade", (targetField) => {
    const root = mkdtempSync(join(tmpdir(), "memmy-profile-upgrade-")), path = join(root,"memory.sqlite");
    try {
      const old = seedV9(path), projectId = legacyProject("account-a").projectId;
      old.prepare(`UPDATE memories SET properties_json=json_set(properties_json,'$.internal_info.world_model.project_environment_profile','Uses Node 22'),
        info_json=json_set(info_json,'$.project_environment_applied_scan_id','scan-a') WHERE id='L3-account-a'`).run();
      old.prepare(`INSERT INTO l3_world_model_project_environment_state(user_id,project_id,status,applied_scan_id,updated_at)
        VALUES ('account-a',?,'clean','scan-a',?)`).run(projectId,at);
      const history = old.prepare("SELECT * FROM memories ORDER BY id").all(); old.close();
      let db = new MemoryDb({path});
      try {
        let repos = new Repositories(db.db);
        const read = () => new L3WorldModelContextReadModel(repos).load({...repos.runtime.getSession("session-account-a")!,userId:"switched-account"});
        expect(read().projectEnvironmentProfile).toBe("Uses Node 22");
        repos.l3WorldModels.upsertField({userId:"account-c",projectId:identity.projectId,targetField,value:"New project fact"});
        expect(read().projectEnvironmentProfile).toBe("Uses Node 22");
        expect(repos.l3WorldModels.getMemory(null,identity.projectId)?.info.project_environment_applied_scan_id).toBe("scan-a");
        expect(db.db.prepare("SELECT * FROM memories WHERE user_id IS NOT NULL ORDER BY id").all()).toEqual(history);
        db.close(); db = new MemoryDb({path}); repos = new Repositories(db.db);
        expect(read().projectEnvironmentProfile).toBe("Uses Node 22");
        repos.l3WorldModels.upsertField({userId:"account-d",projectId:identity.projectId,targetField:"project_environment_profile",value:null});
        repos.l3WorldModels.upsertField({userId:"account-e",projectId:identity.projectId,targetField,value:"Another fact"});
        expect(read().projectEnvironmentProfile).toBeNull();
        db.close(); db = new MemoryDb({path}); repos = new Repositories(db.db);
        expect(read().projectEnvironmentProfile).toBeNull();
      } finally { db.close(); }
    } finally { rmSync(root,{recursive:true,force:true}); }
  });

  it("does not borrow a scan ID from a different historical profile", () => {
    const root = mkdtempSync(join(tmpdir(),"memmy-profile-provenance-")), path=join(root,"memory.sqlite");
    try {
      const old=seedV9(path);
      old.prepare(`UPDATE memories SET properties_json=json_set(properties_json,'$.internal_info.world_model.project_environment_profile','Unapplied newer profile'),updated_at='2026-10-02T00:00:00.000Z' WHERE id='L3-account-a'`).run();
      old.prepare(`UPDATE l3_world_model_scopes SET updated_at='2026-10-02T00:00:00.000Z' WHERE user_id='account-a'`).run();
      old.prepare(`UPDATE memories SET properties_json=json_set(properties_json,'$.internal_info.world_model.project_environment_profile','Applied older profile'),info_json=json_set(info_json,'$.project_environment_applied_scan_id','scan-b') WHERE id='L3-account-b'`).run();
      old.prepare(`INSERT INTO l3_world_model_project_environment_state(user_id,project_id,status,applied_scan_id,updated_at) VALUES ('account-b',?,'clean','scan-b',?)`).run(legacyProject("account-b").projectId,at);
      old.close();
      const db=new MemoryDb({path}),repos=new Repositories(db.db);
      try {
        repos.l3WorldModels.upsertField({userId:null,projectId:identity.projectId,targetField:"project_contract",value:"New rule"});
        expect(repos.l3WorldModels.fields(null,identity.projectId).projectEnvironmentProfile).toBe("Unapplied newer profile");
        expect(repos.l3WorldModels.getMemory(null,identity.projectId)?.info.project_environment_applied_scan_id).toBeUndefined();
        expect(new L3WorldModelContextReadModel(repos).load(repos.runtime.getSession("session-account-a")!).projectEnvironmentProfile).toBeNull();
      } finally {db.close();}
    } finally {rmSync(root,{recursive:true,force:true});}
  });
  it("shares writes and project identity across accounts, retaining separate host identities", async () => {
    const {db,service} = fixture.createTestService();
    const namespace = {source:"codex",profileId:"default",sessionKey:"shared-session",userId:"account-a"};
    const request = {l3WorldModelProtocolVersion:2 as const,l3WorldModelTransition:"resume_only" as const,workspaceUri:uri,workspaceHostId:host,namespace};
    const first = service.openSession(request), second = service.openSession({...request,namespace:{...namespace,userId:"account-b"}});
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.projectId).toBe(first.projectId);
    expect(resolveWorkspaceIdentity("account-c",{workspaceUri:uri,workspaceHostId:host})).toEqual(identity);
    expect(resolveWorkspaceIdentity(null,{workspaceUri:uri,workspaceHostId:"b".repeat(64)}).projectId).not.toBe(identity.projectId);
    (await service.completeTurn("shared-turn",{sessionId:first.sessionId,namespace,query:"我最喜欢的水果是苹果",answer:"记住了。"}));
    const a = service.panelItems({layer:"UserMemory",namespace}), b = service.panelItems({layer:"UserMemory",namespace:{...namespace,userId:"account-b"}});
    expect(a.items.length).toBeGreaterThan(0);
    expect(b.items).toEqual(a.items);
    for (const table of ["memories","user_memories","sessions","raw_turns","episodes","evolution_jobs"]) expect(db.db.prepare(`SELECT COUNT(*) FROM ${table} WHERE user_id IS NOT NULL`).pluck().get()).toBe(0);
    service.deleteMemory(a.items[0]!.id,{namespace:{...namespace,userId:"account-b"}});
    expect(service.panelItems({layer:"UserMemory",namespace}).items).toEqual([]);
  });
  it("resets legacy captures on full clear while retaining project aliases after restart", () => {
    const root = mkdtempSync(join(tmpdir(),"memmy-uid-clear-")), path = join(root,"memory.sqlite");
    try {
      seedV9(path).close();
      const db = new MemoryDb({path}), repos = new Repositories(db.db);
      repos.clearAllMemoryData();
      expect(db.db.prepare("SELECT COUNT(*) FROM sessions").pluck().get()).toBe(0);
      const bundle = repos.runtime.exportBundleTables(true);
      expect(bundle.memory_namespace_aliases?.length ?? 0).toBeGreaterThan(0);
      db.close();
      const reopened = new MemoryDb({path});
      const capture = new Repositories(reopened.db).runtime.getSourceTurnCapture({userId:"account-c",source:"codex",profileId:"default",namespaceKey:stableHash({tenantId:null,projectId:identity.projectId,workspaceId:identity.workspaceId}),conversationId:"native-conversation"},"native-turn");
      expect(capture).toBeUndefined();
      expect(canonicalProjectId(reopened.db,legacyProject("account-a").projectId)).toBe(identity.projectId);
      expect(new Repositories(reopened.db).runtime.getKv("source_turn_capture_activated_at")?.value).toBe(at);
      reopened.close();
      const imported = new MemoryDb({path:join(root,"imported.sqlite")});
      const importedRepos = new Repositories(imported.db);
      importedRepos.runtime.importBundleTables(bundle);
      expect(importedRepos.runtime.getSourceTurnCapture({userId:"account-d",source:"codex",profileId:"default",namespaceKey:stableHash({tenantId:null,projectId:identity.projectId,workspaceId:identity.workspaceId}),conversationId:"native-conversation"},"native-turn")).toBeUndefined();
      imported.close();
    } finally {rmSync(root,{recursive:true,force:true});}
  });
  it("respects pre-upgrade L3 deletion and does not replay older batches into another account's copy", async () => {
    const root = mkdtempSync(join(tmpdir(),"memmy-uid-tombstone-")), path = join(root,"memory.sqlite");
    try {
      const old = seedV9(path);
      old.prepare("UPDATE memories SET deleted_at='2026-10-02T00:00:00.000Z',status='deleted',updated_at='2026-10-02T00:00:00.000Z' WHERE id='L3-account-a'").run();
      old.prepare("UPDATE l3_world_model_scopes SET memory_id=NULL WHERE user_id='account-a'").run();
      old.close();
      const db = new MemoryDb({path}), repos = new Repositories(db.db);
      expect(repos.l3WorldModels.fields("account-c",identity.projectId).domainKnowledge).toBeNull();
      const complete = vi.fn();
      await new L3WorldModelTraceFieldPipeline({repos,skillLlm:{complete} as unknown as LlmClient}).updateField(repos.runtime.getJob("job-account-b")!);
      expect(complete).not.toHaveBeenCalled();
      expect(repos.l3WorldModels.getTarget("batch-account-b","project_contract")).toMatchObject({status:"applied",noChange:true});
      repos.l3WorldModels.upsertField({userId:"account-c",projectId:identity.projectId,targetField:"domain_knowledge",value:"New evidence",at:"2026-10-03T00:00:00.000Z"});
      expect(repos.l3WorldModels.fields("account-d",identity.projectId).domainKnowledge).toBe("New evidence");
      db.close();
    } finally {rmSync(root,{recursive:true,force:true});}
  });
  it("retries new and historical idempotency entries across accounts without accepting changed content", async () => {
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
    const completed = (await service.completeTurn("turn",turn));
    const switched = {...turn,namespace:{...turn.namespace,userId:"account-b"}};
    expect((await service.completeTurn("turn",switched))).toMatchObject({duplicate:true,rawTurnId:completed.rawTurnId,jobs:[]});
    repos.runtime.saveIdempotency("turn.complete:fixture:complete",stableHash({turnId:"turn",request:turn}),completed);
    expect((await service.completeTurn("turn",switched))).toMatchObject({duplicate:true,rawTurnId:completed.rawTurnId});
    await expect(service.completeTurn("turn",{...switched,answer:"Different"})).rejects.toThrow(/different request body/);
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
