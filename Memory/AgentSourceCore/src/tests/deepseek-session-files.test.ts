import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverDeepseekHarnessSessions, findLatestDeepseekHarnessSessionFile, loadDeepseekHarnessEvents, parseDeepseekHarnessLogName } from '../deepseek-session-files.js';
const dirs: string[]=[];
async function fixture(){const p=await mkdtemp(join(tmpdir(),'memmy-dsh-'));dirs.push(p);return p;}
afterEach(async()=>{await Promise.all(dirs.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
function zstd(text:string){const b=Buffer.from(text);const block=Buffer.alloc(3);block.writeUIntLE((b.length<<3)|1,0,3);return Buffer.concat([Buffer.from([0x28,0xb5,0x2f,0xfd,0x20,b.length]),block,b]);}
describe('DSH rotated session history',()=>{
 it.each(['session.jsonl.bak-123','session.v4.jsonl.zstd.bak-123','session.v0.jsonl.zstd.bak-0'])('recognizes %s',name=>expect(parseDeepseekHarnessLogName(name)?.backupTimestamp).toMatch(/^\d+$/));
 it.each(['session.jsonl.bak-','session.jsonl.bak-no','session.jsonl.orig','session.jsonl.bak-123.txt'])('rejects unrelated %s',name=>expect(parseDeepseekHarnessLogName(name)).toBeUndefined());
 it('keeps latest live generation and compressed preference, adds backups only for history',async()=>{
  const p=await fixture();const names=['session.v1.jsonl','session.v4.jsonl','session.v4.jsonl.zstd','session.v1.jsonl.bak-12','session.v4.jsonl.zstd.bak-34'];
  for(const name of names)await writeFile(join(p,name),'');
  expect((await discoverDeepseekHarnessSessions({root:p})).map(x=>basename(x.sessionFilePath))).toEqual(['session.v4.jsonl.zstd']);
  expect((await discoverDeepseekHarnessSessions({root:p,includeBackups:true}))).toHaveLength(3);
  expect(await findLatestDeepseekHarnessSessionFile(p)).toBe(join(p,'session.v4.jsonl.zstd'));
 });
 it('does not choose a backup as the current plugin session',async()=>{const p=await fixture();await writeFile(join(p,'session.jsonl.bak-1'),'');expect(await findLatestDeepseekHarnessSessionFile(p)).toBeUndefined();expect(await discoverDeepseekHarnessSessions({root:p,includeBackups:true})).toHaveLength(1);});
 it.each(['session.jsonl.zstd','session.v4.jsonl.zstd.bak-123'])('decodes valid zstd under %s',async name=>{const p=await fixture();const file=join(p,name);await writeFile(file,zstd('{"type":"session","id":"test"}\n'));expect(await loadDeepseekHarnessEvents(file)).toEqual([{type:'session',id:'test'}]);});
 it('rejects corrupt compressed backup instead of silently returning no records',async()=>{const p=await fixture();const file=join(p,'session.jsonl.zstd.bak-123');await writeFile(file,'not zstd');await expect(loadDeepseekHarnessEvents(file)).rejects.toThrow('Zstandard');});
 it('deduplicates aliased and overlapping roots, applies one global limit',async()=>{const p=await fixture();const a=join(p,'a');const b=join(p,'b');await mkdir(a);await mkdir(b);await writeFile(join(a,'session.jsonl'),'');await writeFile(join(b,'session.jsonl'),'');const alias=join(p,'alias');await symlink(a,alias,'dir');expect(await discoverDeepseekHarnessSessions({root:p,roots:[a,alias,p,join(p,'missing')]})).toHaveLength(2);expect(await discoverDeepseekHarnessSessions({root:p,roots:[a,b],maxSessions:1})).toHaveLength(1);});
 it('honors cancellation before scanning or reading',async()=>{const p=await fixture();const c=new AbortController();c.abort();await expect(discoverDeepseekHarnessSessions({root:p,signal:c.signal})).rejects.toThrow();await expect(loadDeepseekHarnessEvents(join(p,'session.jsonl'),c.signal)).rejects.toThrow();});
});
