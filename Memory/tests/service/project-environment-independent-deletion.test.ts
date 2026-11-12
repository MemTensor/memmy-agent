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

it.each(['keep-contract','delete-queued','delete-inflight'] as const)('preserves independent profile refresh after deleting contract: %s',async mode=>{
  const x=legacyScan();await x.runner.processProfileJob(x.job);
  const independent=x.repos.l3WorldModels.getMemory(device,x.opened.projectId)!;
  const before=x.repos.memories.get(independent.id);
  const current=deviceScan(x,'independent-refresh');
  const contract=x.repos.l3WorldModels.upsertField({userId:device,projectId:current.opened.projectId,
    targetField:'project_contract',value:'Only a contract in this record'})!;
  expect(context(x.service,current.opened)).toBe('Latest profile');
  let release:((value:string)=>void)|undefined;let pending:Promise<void>|undefined;
  if(mode==='delete-inflight'){
    const claimed=x.repos.runtime.claimQueuedJob(current.job.id);expect(claimed?.status).toBe('leased');
    x.model.complete.mockImplementationOnce(()=>new Promise<string>(resolve=>{release=resolve;}));
    pending=x.runner.processProfileJob(claimed!);await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
  }
  if(mode!=='keep-contract'){
    x.service.deleteMemory(contract.id);
    expect(context(x.service,current.opened)).toBe('Latest profile');
    expect(x.repos.memories.get(independent.id)).toEqual(before);
  }
  const output='{"op":"update","profile":"Updated independent profile"}';
  if(pending){release!(output);await pending;}
  else{x.model.complete.mockResolvedValue(output);await x.runner.processProfileJob(current.job);}
  const expected='Updated independent profile';
  expect(context(x.service,current.opened)).toBe(expected);
  const state=x.repos.projectEnvironments.getState(device,current.opened.projectId!);
  const restarted=await reopen(x);expect(context(restarted.service,current.opened)).toBe(expected);
});

it('full clear prevents an old directory scan from creating a profile',async()=>{
  const x=legacyScan();x.service.clearAllData();
  await x.runner.processProfileJob(x.job);expect(x.model.complete).not.toHaveBeenCalled();
  expect(x.repos.memories.list({memoryLayer:'L3',status:'activated'})).toHaveLength(0);
});

it.each(['queued','inflight'] as const)('preserves a first independent profile request when %s',async mode=>{
  const x=legacyScan();const current=deviceScan(x,'first-independent-profile');
  const contract=x.repos.l3WorldModels.upsertField({userId:device,projectId:current.opened.projectId,
    targetField:'project_contract',value:'Contract only; there is no profile yet'})!;
  let release:((value:string)=>void)|undefined;let pending:Promise<void>|undefined;
  if(mode==='inflight'){
    const claim=x.repos.runtime.claimQueuedJob(current.job.id)!;
    x.model.complete.mockImplementationOnce(()=>new Promise<string>(resolve=>{release=resolve;}));
    pending=x.runner.processProfileJob(claim);await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
  }
  x.service.deleteMemory(contract.id);
  const result='{"op":"create","profile":"First independent profile"}';
  if(pending){release!(result);await pending;}
  else{x.model.complete.mockResolvedValue(result);await x.runner.processProfileJob(current.job);}
  expect(context(x.service,current.opened)).toBe('First independent profile');
  const restarted=await reopen(x);expect(context(restarted.service,current.opened)).toBe('First independent profile');
});
