import { describe,expect,it } from 'vitest';
import { GitHubCLI } from '../scripts/main-sync/github.mjs';
const success=data=>({status:0,stdout:'HTTP/2.0 200 OK\r\ncontent-type: application/json\r\n\r\n'+JSON.stringify(data),stderr:''});
describe('read-only synchronization producer GitHub adapter',()=>{
 it('uses argv and GitHub API JSON without a shell',()=>{
  let invocation;
  const api=new GitHubCLI('MemTensor/memmy-agent',{env:{GH_TOKEN:'fixture'},exec:(...args)=>{invocation=args;return success({id:123});}});
  expect(api.request('GET','/releases/123')).toEqual({id:123});
  expect(invocation[0]).toBe('gh');
  expect(invocation[1]).toContain('/repos/MemTensor/memmy-agent/releases/123');
  expect(invocation[2].shell).toBeUndefined();
  expect(invocation[2].timeout).toBe(60000);
 });
 it.each(['POST','PATCH','DELETE','PUT'])('never allows producer mutations: %s',method=>{
  const api=new GitHubCLI(undefined,{exec:()=>{throw new Error('must not execute');}});
  expect(()=>api.request(method,'/git/refs',{ref:'refs/heads/main'})).toThrow(/reads/);
 });
 it.each(['https://evil.example/api','/repos/Other/repo/releases','/../Other/repo','/releases\ninjected'])('rejects unsafe routes %s',route=>{
  const api=new GitHubCLI(undefined,{exec:()=>{throw new Error('must not execute');}});
  expect(()=>api.request('GET',route)).toThrow();
 });
 it('only converts explicit provider 404 into an optional not-found result',()=>{
  const missing=new GitHubCLI(undefined,{exec:()=>({status:1,stdout:'',stderr:'gh: Not Found (HTTP 404)'})});
  expect(missing.request('GET','/git/ref/tags/v1',undefined,{optional404:true})).toBeNull();
  const unavailable=new GitHubCLI(undefined,{exec:()=>({status:1,error:new Error('network'),stdout:'',stderr:''})});
  expect(()=>unavailable.request('GET','/git/ref/tags/v1',undefined,{optional404:true})).toThrow();
  const forbidden=new GitHubCLI(undefined,{exec:()=>({status:1,stdout:'',stderr:'Forbidden (HTTP 403)'})});
  expect(()=>forbidden.request('GET','/git/ref/tags/v1',undefined,{optional404:true})).toThrow();
 });
 it('rejects malformed JSON instead of treating it as a successful read',()=>{
  expect(()=>new GitHubCLI(undefined,{exec:()=>({status:0,stdout:'not JSON'})}).request('GET','/releases/1')).toThrow(/invalid JSON/);
 });
});
