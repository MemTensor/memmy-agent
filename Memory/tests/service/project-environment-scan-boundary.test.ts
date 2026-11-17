import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { MemoryDb } from "../../src/storage/db.js";
import { Repositories, l3WorldModelMemoryKey, l3WorldModelScopeKey } from "../../src/storage/repositories.js";
import { deriveWorkspaceHostId, sha256Hex } from "../../src/contracts/index.js";
import { DEVICE_MEMORY_OWNER as device } from "../../src/service/namespace/memory-owner.js";
import { ProjectEnvironmentService } from "../../src/service/project-environment/project-environment-service.js";
import { createMemoryServiceFixture, createFailingLlm } from "../fixtures/memory-service-fixture.js";
import type { MemoryService } from "../../src/service/memory-service.js";
import type { LlmClient } from "../../src/model/types.js";

const f = createMemoryServiceFixture();
afterEach(f.cleanup);
const prefix = "project_environment_scan_boundary_v1:";
function legacyScan() {
  const model = {...createFailingLlm(), complete: vi.fn<LlmClient["complete"]>()
    .mockResolvedValue('{"op":"create","profile":"Latest profile"}')};
  const x = f.createTestService({skillLlm: model});
  const repos = new Repositories(x.db.db);
  const folder = join(x.root, "project");
  mkdirSync(folder); writeFileSync(join(folder, "package.json"), '{"name":"scan-boundary"}');
  const uri = pathToFileURL(realpathSync(folder)).href;
  const host = deriveWorkspaceHostId("scan-boundary-machine");
  const request = {workspaceUri: uri, workspaceHostId: host,
    l3WorldModelProtocolVersion: 2 as const, l3WorldModelTransition: "resume_only" as const};
  const opened = x.service.openSession({...request,
    namespace: {source:"codex",profileId:"default",userId:"account-a",sessionKey:"old"}});
  const projectId = `ws_${sha256Hex(`account-a\0local\0${host}\0${uri}`)}`;
  x.db.db.prepare("UPDATE sessions SET user_id='account-a',project_id=? WHERE id=?").run(projectId, opened.sessionId);
  repos.l3WorldModels.bindWorkspaceUri("account-a", projectId, uri);
  const job = repos.projectEnvironments.requestScan({userId:"account-a", projectId,
    sessionId:opened.sessionId,trigger:"session_start",dedupeKey:"pre-upgrade"}).job;
  x.db.db.prepare("UPDATE l3_world_model_scopes SET user_id='account-a',scope_key=? WHERE project_id=?")
    .run(l3WorldModelScopeKey("account-a",projectId),projectId);
  // Reconstruct a pre-upgrade database, which has no local publication metadata.
  x.db.db.prepare("DELETE FROM runtime_kv WHERE key LIKE ?").run(`${prefix}%`);
  return {...x, repos, model, request, opened:{...opened,projectId}, job,
    runner:new ProjectEnvironmentService({repos,llm:model})};
}
function deviceScan(x:ReturnType<typeof legacyScan>, key="new", service=x.service, repos=x.repos) {
  const opened=service.openSession({...x.request,
    namespace:{source:"codex",profileId:"default",userId:device,sessionKey:key}});
  if(!opened.projectId)throw new Error("expected project");
  const job=repos.projectEnvironments.requestScan({userId:device,projectId:opened.projectId,
    sessionId:opened.sessionId,trigger:"token_compaction",dedupeKey:key}).job;
  return {opened,job};
}
function context(service:MemoryService, opened:{sessionId:string;projectId?:string|null}) {
  return service.l3WorldModelContext(opened.sessionId,{requestId:crypto.randomUUID(),adapterId:"test",
    namespace:{source:"codex",profileId:"default",userId:device,projectId:opened.projectId!}}).projectEnvironmentProfile;
}
async function reopen(x:ReturnType<typeof legacyScan>) {
  await x.service.stop();x.db.close();
  const db=new MemoryDb({path:join(x.root,"memory.sqlite")});
  return {db,service:f.createTestMemoryService({db,skillLlm:x.model}),repos:new Repositories(db.db)};
}

it.each(["keep","delete","clear","clear-whitespace","delete-then-new","clear-then-new","delete-without-metadata","delete-before-upgrade"] as const)(
  "keeps old scans obsolete and new scans usable: %s",async scenario=>{
    const x=legacyScan();const current=deviceScan(x);
    const oldPayload=x.repos.runtime.getJob(x.job.id)!.payload;
    await x.runner.processProfileJob(current.job);
    expect(context(x.service,current.opened)).toBe("Latest profile");
    if(scenario==="delete-without-metadata")x.db.db.prepare("DELETE FROM runtime_kv WHERE key LIKE ?").run(`${prefix}%`);
    if(scenario.startsWith("delete"))x.service.deleteMemory(x.repos.l3WorldModels.getMemory(device,current.opened.projectId)!.id);
    // An already deleted pre-fix database has lost current_scan_id but still has
    // the immutable newer task. Bootstrap must not fall back to the older task.
    if(scenario==="delete-before-upgrade")x.db.db.prepare("DELETE FROM runtime_kv WHERE key LIKE ?").run(`${prefix}%`);
    if(scenario.startsWith("clear"))x.repos.l3WorldModels.upsertField({userId:device,
      projectId:current.opened.projectId,targetField:"project_environment_profile",value:scenario==="clear-whitespace"?"  \n ":null});
    const createsNew=scenario.endsWith("then-new");
    if(createsNew){
      x.model.complete.mockResolvedValue('{"op":"create","profile":"Requested after clear"}');
      const next=deviceScan(x,"after-clear");await x.runner.processProfileJob(next.job);
    }
    x.model.complete.mockResolvedValue('{"op":"create","profile":"Obsolete old profile"}');
    await x.runner.processProfileJob(x.job);
    const expected=scenario==="keep"?"Latest profile":createsNew?"Requested after clear":null;
    expect(context(x.service,current.opened)).toBe(expected);
    expect(x.repos.runtime.getJob(x.job.id)).toMatchObject({userId:"account-a",payload:oldPayload});
    expect(x.repos.runtime.getSession(x.opened.sessionId)?.userId).toBe("account-a");
    const restarted=await reopen(x);expect(context(restarted.service,current.opened)).toBe(expected);
    expect(restarted.repos.runtime.getJob(x.job.id)).toMatchObject({userId:"account-a",payload:oldPayload});
  });

it("deleting an unrelated old contract preserves an in-flight device scan",async()=>{
  const x=legacyScan();
  const old=x.repos.l3WorldModels.upsertField({userId:device,projectId:x.opened.projectId,
    targetField:"project_contract",value:"Old contract"})!;
  x.db.db.prepare("UPDATE memories SET user_id='account-a',memory_key=? WHERE id=?")
    .run(l3WorldModelMemoryKey("account-a",x.opened.projectId),old.id);
  x.db.db.prepare("DELETE FROM l3_world_model_scopes WHERE user_id='account-a' AND project_id=?")
    .run(x.opened.projectId);
  x.db.db.prepare("UPDATE l3_world_model_scopes SET user_id='account-a',scope_key=? WHERE memory_id=?")
    .run(l3WorldModelScopeKey("account-a",x.opened.projectId),old.id);
  const current=deviceScan(x);
  let release:((value:string)=>void)|undefined;
  x.model.complete.mockImplementationOnce(()=>new Promise<string>(resolve=>{release=resolve;}));
  const pending=x.runner.processProfileJob(current.job);
  await vi.waitFor(()=>expect(release).toBeTypeOf("function"));
  x.service.deleteMemory(old.id);
  release!('{"op":"create","profile":"Independent device profile"}');
  await pending;
  expect(context(x.service,current.opened)).toBe("Independent device profile");
  const restarted=await reopen(x);expect(context(restarted.service,current.opened)).toBe("Independent device profile");
});

it.each(["delete","clear","new-scan","provider-error-after-clear"] as const)(
  "discards an old in-flight result when %s occurs",async scenario=>{
    const x=legacyScan();let release:((value:string)=>void)|undefined;let fail:((error:Error)=>void)|undefined;
    x.model.complete.mockImplementationOnce(()=>new Promise<string>((resolve,reject)=>{release=resolve;fail=reject;}));
    const pending=x.runner.processProfileJob(x.job);
    await vi.waitFor(()=>expect(release).toBeTypeOf("function"));
    if(scenario==="clear"||scenario==="provider-error-after-clear"){
      x.repos.l3WorldModels.upsertField({userId:device,projectId:x.opened.projectId,targetField:"project_environment_profile",value:null});
    }else{
      const newer=deviceScan(x);await x.runner.processProfileJob(newer.job);
      if(scenario!=="new-scan")x.service.deleteMemory(x.repos.l3WorldModels.getMemory(device,newer.opened.projectId)!.id);
    }
    if(scenario==="provider-error-after-clear")fail!(new Error("provider failed"));
    else release!('{"op":"create","profile":"Late obsolete output"}');
    await expect(pending).resolves.toBeUndefined();
    const expected=scenario==="new-scan"?"Latest profile":null;
    expect(context(x.service,x.opened)).toBe(expected);
    const restarted=await reopen(x);expect(context(restarted.service,x.opened)).toBe(expected);
  });

function oldBundle(x:ReturnType<typeof legacyScan>) {
  const tables=x.repos.runtime.exportBundleTables(true);
  // Old bundles predate the installation-local scheduling sequence.
  for(const row of tables.evolution_jobs ?? [])delete row.enqueue_seq;
  return tables;
}

it.each([false,true])("an imported old scan cannot cover a newer profile (repeat import=%s)",async repeat=>{
  const source=legacyScan();const tables=oldBundle(source);
  const target=f.createTestService({skillLlm:source.model});const repos=new Repositories(target.db.db);
  const current=deviceScan(source,"target-newer",target.service,repos);
  const runner=new ProjectEnvironmentService({repos,llm:source.model});await runner.processProfileJob(current.job);
  // Exercise upgrade compatibility: the target had the newer scan before this fix.
  target.db.db.prepare("DELETE FROM runtime_kv WHERE key LIKE ?").run(`${prefix}%`);
  repos.runtime.importBundleTables(tables,{conflictStrategy:"skip"});
  if(repeat)repos.runtime.importBundleTables(tables,{conflictStrategy:"skip"});
  const imported=repos.runtime.getJob(source.job.id)!;
  expect(imported.enqueueSeq!).toBeGreaterThan(repos.runtime.getJob(current.job.id)!.enqueueSeq!);
  expect(imported).toMatchObject({userId:"account-a",payload:source.job.payload});
  source.model.complete.mockResolvedValue('{"op":"update","profile":"Stale imported output"}');
  const calls=source.model.complete.mock.calls.length;await runner.processProfileJob(imported);
  expect(source.model.complete).toHaveBeenCalledTimes(calls);
  expect(context(target.service,current.opened)).toBe("Latest profile");
  await target.service.stop();target.db.close();
  const db=new MemoryDb({path:join(target.root,"memory.sqlite")});const service=f.createTestMemoryService({db,skillLlm:source.model});
  const restarted=new Repositories(db.db);await new ProjectEnvironmentService({repos:restarted,llm:source.model}).processProfileJob(restarted.runtime.getJob(imported.id)!);
  expect(context(service,current.opened)).toBe("Latest profile");
});

it("reimport after deletion cannot grant the old task permission; a new scan still works",async()=>{
  const source=legacyScan();const tables=oldBundle(source);
  const target=f.createTestService({skillLlm:source.model});const repos=new Repositories(target.db.db);
  const current=deviceScan(source,"target",target.service,repos);const runner=new ProjectEnvironmentService({repos,llm:source.model});
  await runner.processProfileJob(current.job);repos.runtime.importBundleTables(tables);
  target.service.deleteMemory(repos.l3WorldModels.getMemory(device,current.opened.projectId)!.id);
  repos.runtime.importBundleTables(tables);await runner.processProfileJob(repos.runtime.getJob(source.job.id)!);
  expect(context(target.service,current.opened)).toBeNull();
  const next=deviceScan(source,"requested-after-import",target.service,repos);await runner.processProfileJob(next.job);
  expect(context(target.service,next.opened)).toBe("Latest profile");
});

it("a full import does not mint publication permission for old pending work",async()=>{
  const source=legacyScan();const target=f.createTestService({skillLlm:source.model});const repos=new Repositories(target.db.db);
  repos.runtime.importBundleTables(oldBundle(source));const runner=new ProjectEnvironmentService({repos,llm:source.model});
  await runner.processProfileJob(repos.runtime.getJob(source.job.id)!);expect(source.model.complete).not.toHaveBeenCalled();
  const current=deviceScan(source,"explicit-local-request",target.service,repos);await runner.processProfileJob(current.job);
  expect(context(target.service,current.opened)).toBe("Latest profile");
  expect(repos.runtime.getJob(source.job.id)).toMatchObject({userId:"account-a",payload:source.job.payload});
});

it.each(["skip","replace","error"] as const)("imported publication metadata is ignored with conflict strategy %s",async conflictStrategy=>{
  const x=legacyScan();const current=deviceScan(x);await x.runner.processProfileJob(current.job);
  const boundary=x.db.db.prepare("SELECT * FROM runtime_kv WHERE key LIKE ? AND json_extract(value_json,'$.jobId')=?")
    .get(`${prefix}%`,current.job.id) as Record<string,unknown>;
  const forged={...boundary,value_json:JSON.stringify({jobId:x.job.id,sequence:99999999})};
  const imported=x.repos.runtime.importBundleTables({runtime_kv:[forged]},{conflictStrategy});
  expect(imported.skipped.runtime_kv).toBe(1);
  expect(x.db.db.prepare("SELECT * FROM runtime_kv WHERE key=?").get(boundary.key)).toEqual(boundary);
  await x.runner.processProfileJob(x.job);expect(context(x.service,current.opened)).toBe("Latest profile");
});

it("a newer scan on another host does not supersede the local legacy scan",async()=>{
  const x=legacyScan();const other=x.service.openSession({...x.request,workspaceHostId:deriveWorkspaceHostId("other-host"),
    namespace:{source:"codex",profileId:"default",userId:device,sessionKey:"other-host"}});
  const otherJob=x.repos.projectEnvironments.requestScan({userId:device,projectId:other.projectId!,sessionId:other.sessionId,
    trigger:"session_start",dedupeKey:"other-host"}).job;
  await x.runner.processProfileJob(otherJob);
  x.service.deleteMemory(x.repos.l3WorldModels.getMemory(device,other.projectId)!.id);
  expect(x.repos.projectEnvironments.isCurrentScan("account-a",x.opened.projectId,String(x.job.payload.scanId))).toBe(true);
  await x.runner.processProfileJob(x.job);expect(context(x.service,x.opened)).toBe("Latest profile");
  expect(context(x.service,other)).toBeNull();
});
