import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveDeepseekHarnessSessionDirectories } from '../src/agent-source/agent-paths.js';
import { createDeepseekHarnessSourceAdapter } from '../src/agent-source/adapters/deepseek-harness/adapter.js';
const dirs:string[]=[];
afterEach(async()=>{vi.unstubAllEnvs();await Promise.all(dirs.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
const events=[{type:'session',id:'491-history',cwd:'/fixture'}, {type:'turn/start',seq:0,time:1780404000000,data:{turn:1}}, {type:'user/message',seq:1,time:1780404001000,data:{id:'q1',source:{kind:'user'},content:[{type:'text',text:'491 test question'}]}},{type:'assistant/message',seq:2,time:1780404002000,data:{message:{id:'a1',content:[{type:'text',text:'491 test answer'}]}}},{type:'turn/end',seq:3,time:1780404003000,data:{turn:1,reason:{kind:'completed'}}}];
async function collect<T>(iter:AsyncIterable<T>){const out:T[]=[];for await(const x of iter)out.push(x);return out;}
describe('DSH history roots and backup scan',()=>{
 it.each([
 ['win32','C:\\Users\\fixture',{APPDATA:'D:\\Roaming'},'D:\\Roaming\\dsh-desktop\\harness\\sessions'],
 ['darwin','/Users/fixture',{},'/Users/fixture/Library/Application Support/dsh-desktop/harness/sessions'],
 ['linux','/home/fixture',{XDG_CONFIG_HOME:'/custom/config'},'/custom/config/dsh-desktop/harness/sessions']
 ] as const)('includes Desktop history on %s',(platform,homeDirectory,environment,expected)=>{expect(resolveDeepseekHarnessSessionDirectories({platform,homeDirectory,environment})).toContain(expected);});
 it('keeps explicit DSH_HOME exclusive',()=>{expect(resolveDeepseekHarnessSessionDirectories({platform:'darwin',homeDirectory:'/Users/test',environment:{DSH_HOME:'/custom/dsh'}})).toEqual(['/custom/dsh/sessions']);});
 it('scans a backup-only directory through the real adapter with stable message identity',async()=>{
  const p=await mkdtemp(join(tmpdir(),'memmy-dsh-scan-'));dirs.push(p);const sessions=join(p,'sessions');await mkdir(sessions);const text=events.map(e=>JSON.stringify(e)).join('\n');await writeFile(join(sessions,'session.v4.jsonl.bak-123'),text);
  const a=createDeepseekHarnessSourceAdapter({rootDirectory:p});expect(await a.detect()).toBe(true);
  const first=await collect(a.scan({fullHistory:true}));expect(first.length).toBeGreaterThan(0);expect(first.some(m=>m.content==='491 test question')).toBe(true);
  await writeFile(join(sessions,'session.v4.jsonl'),text);const second=await collect(a.scan({fullHistory:true}));
  expect(first.every(m=>typeof m.messageId==='string'&&m.messageId.length>0)).toBe(true);
  expect(new Set(second.map(m=>m.messageId))).toEqual(new Set(first.map(m=>m.messageId)));
  expect(await collect(a.scan({fullHistory:true}))).toEqual(second);
 });
 it('detects and scans a Desktop-only macOS home without requiring .dsh',async()=>{
  if(process.platform!=='darwin')return;
  const p=await mkdtemp(join(tmpdir(),'memmy-dsh-desktop-'));dirs.push(p);vi.stubEnv('HOME',p);vi.stubEnv('DSH_HOME','');
  const sessions=join(p,'Library','Application Support','dsh-desktop','harness','sessions');await mkdir(sessions,{recursive:true});await writeFile(join(sessions,'session.jsonl.bak-123'),events.map(e=>JSON.stringify(e)).join('\n'));
  const a=createDeepseekHarnessSourceAdapter();expect(await a.detect()).toBe(true);expect((await collect(a.scan({fullHistory:true}))).length).toBeGreaterThan(0);
 });
 it('honors explicit sessionsRoot even when default home is absent',async()=>{const p=await mkdtemp(join(tmpdir(),'memmy-dsh-root-'));dirs.push(p);const a=createDeepseekHarnessSourceAdapter({rootDirectory:join(p,'missing'),sessionsRoot:p});expect(await a.detect()).toBe(true);});
});

import { mkdirSync, writeFileSync } from 'node:fs';
import { MemoryDb } from '../src/index.js';
import { createAgentSourceExecutor } from '../src/agent-source/runtime.js';
import { createSourceRegistry } from '../src/agent-source/adapters/source-registry.js';
import { createMemoryServiceFixture, createBatchReflectionLlm, settleCaptureWork } from './fixtures/memory-service-fixture.js';
const serviceFixture=createMemoryServiceFixture();
const executors:ReturnType<typeof createAgentSourceExecutor>[]=[];
afterEach(async()=>{for(const e of executors.splice(0))await e.dispose();await serviceFixture.cleanup();});
function makeExecutor(root:string,service:Parameters<typeof createAgentSourceExecutor>[0]['service']){
 const scan=createAgentSourceExecutor({service,sourceRegistry:createSourceRegistry([createDeepseekHarnessSourceAdapter({sessionsRoot:join(root,'dsh')})]),configPath:join(root,'config.yaml'),statePath:join(root,'state.json'),scanStoreDirectory:join(root,'scans'),resolveAgentSkillRoot:()=>null});executors.push(scan);return scan;
}
async function runScan(scan:ReturnType<typeof makeExecutor>,mode:'full'|'incremental'='full'){await scan.startScan({sourceId:'deepseek_harness',mode});await vi.waitFor(()=>expect(scan.scanStatus().running).toBe(false),{timeout:10000});expect(scan.scanStatus().error).toBeNull();}
function writeTurn(root:string,id:string,complete:boolean,at:number,backup=true){const p=join(root,'dsh',id);mkdirSync(p,{recursive:true});const rows=events.map((e,i)=>i===0?{...e,id}:({...e,time:at+i*1000}));writeFileSync(join(p,backup?'session.v4.jsonl.bak-123':'session.v4.jsonl'),(complete?rows:rows.slice(0,-1)).map(e=>JSON.stringify(e)).join('\n'));}
const captureCount=(db:MemoryDb)=>db.db.prepare('SELECT COUNT(*) AS count FROM source_turn_captures').get();
const savedMemories=(db:MemoryDb)=>db.db.prepare('SELECT id FROM memories WHERE deleted_at IS NULL ORDER BY id').all();
describe('DSH backup through SQLite and Memory worker',()=>{
 it('deduplicates live/backup and restart, rejects incomplete turns and backfills old history',async()=>{
 const llm=createBatchReflectionLlm([]);const {root,service,db}=serviceFixture.createTestService({llm});
 writeTurn(root,'recent',true,4070959200000);writeTurn(root,'recent',true,4070959200000,false);writeTurn(root,'pending',false,4070959300000);
 const scan=makeExecutor(root,service);await runScan(scan);expect(captureCount(db)).toEqual({count:1});await settleCaptureWork(service);
 const before=savedMemories(db);expect(before).toHaveLength(1);
 expect(service.memoryProcessingStatus(before.map(row=>(row as {id:string}).id)).items).toEqual([expect.objectContaining({state:'ready'})]);
 await runScan(scan);expect(savedMemories(db)).toEqual(before);
 writeTurn(root,'old',true,1780404000000);await runScan(scan,'incremental');expect(captureCount(db)).toEqual({count:1});await runScan(scan);expect(captureCount(db)).toEqual({count:2});await settleCaptureWork(service);
 await scan.dispose();await service.stop();db.close();const reopened=new MemoryDb({path:join(root,'memory.sqlite')});const restarted=serviceFixture.createTestMemoryService({db:reopened,llm});const next=makeExecutor(root,restarted);await runScan(next);expect(captureCount(reopened)).toEqual({count:2});
 writeTurn(root,'pending',true,4070959300000);await runScan(next);expect(captureCount(reopened)).toEqual({count:3});
 },30000);
});
