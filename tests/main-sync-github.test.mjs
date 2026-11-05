import { describe,expect,it } from 'vitest';
import { GitHubCLI,GitHubCLIError } from '../scripts/main-sync/github.mjs';
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

const responseFailure=(status,message,headers={},extra={})=>({
 status:1,
 stdout:`HTTP/2.0 ${status} Failure\r\n${Object.entries(headers).map(([name,value])=>`${name}: ${value}\r\n`).join('')}\r\n${JSON.stringify({message,...extra})}`,
 stderr:`gh: request failed (HTTP ${status})`,
});
function captureFailure(result,{env={GH_TOKEN:'fixture'},route='/releases/435451150',throws=false}={}) {
 let calls=0,error;
 const api=new GitHubCLI(undefined,{env,exec:()=>{calls++;if(throws)throw result;return result;}});
 try { api.request('GET',route); } catch(caught) { error=caught; }
 expect(calls).toBe(1);
 expect(error).toBeInstanceOf(GitHubCLIError);
 return error;
}

describe('bounded GitHub read diagnostics',()=>{
 it('preserves primary-rate evidence without treating every 403 as permission failure',()=>{
  const error=captureFailure(responseFailure(403,'API rate limit exceeded',{
   'X-GitHub-Request-Id':'REQUEST-PRIMARY','X-RateLimit-Limit':'1000',
   'X-RateLimit-Remaining':'0','X-RateLimit-Reset':'1800000000','X-RateLimit-Resource':'core',
  }));
  expect(error.status).toBe(403);expect(error.statusCode).toBe(403);
  expect(error.diagnostic).toMatchObject({method:'GET',route:'/releases/435451150',status:403,
   requestId:'REQUEST-PRIMARY',message:'API rate limit exceeded',
   rateLimit:{limit:1000,remaining:0,reset:1800000000,resource:'core'}});
  expect(error.message.startsWith('GitHub read failed (HTTP 403)')).toBe(true);
  expect(error.message).toContain(JSON.stringify(error.diagnostic));
  expect(error.diagnostic).not.toHaveProperty('cause');
 });
 it('keeps an integration-access response distinct from exhausted-rate evidence',()=>{
  const error=captureFailure(responseFailure(403,'Resource not accessible by integration',{
   'x-github-request-id':'REQUEST-ACCESS','x-ratelimit-remaining':'700',
  }));
  expect(error.diagnostic).toMatchObject({status:403,requestId:'REQUEST-ACCESS',
   message:'Resource not accessible by integration',rateLimit:{remaining:700}});
  expect(error.diagnostic.rateLimit).not.toHaveProperty('limit');
  expect(error.diagnostic).not.toHaveProperty('cause');
 });
 it('retains a secondary-rate message and numeric Retry-After on 429',()=>{
  const error=captureFailure(responseFailure(429,'You have exceeded a secondary rate limit.',{
   'X-GitHub-Request-Id':'REQUEST-SECONDARY','Retry-After':'60',
  }));
  expect(error.diagnostic).toMatchObject({status:429,requestId:'REQUEST-SECONDARY',
   message:'You have exceeded a secondary rate limit.',rateLimit:{retryAfter:60}});
 });
 it('reports a 500 response as observed without retrying',()=>{
  const error=captureFailure(responseFailure(500,'Internal Server Error',{'X-GitHub-Request-Id':'REQUEST-SERVER'}));
  expect(error.diagnostic).toMatchObject({status:500,requestId:'REQUEST-SERVER',message:'Internal Server Error'});
  expect(error.message).toContain('GitHub read failed (HTTP 500)');
 });
 it('uses only a numeric status from stderr when include headers are unavailable',()=>{
  const error=captureFailure({status:1,stdout:JSON.stringify({message:'Forbidden'}),stderr:'gh: Forbidden (HTTP 403)'});
  expect(error.diagnostic).toMatchObject({method:'GET',status:403,message:'Forbidden'});
 });
 it.each([
  {name:'returned network error',code:'ECONNRESET',kind:'transport',throws:false},
  {name:'returned timeout',code:'ETIMEDOUT',kind:'timeout',throws:false},
  {name:'thrown execution error',code:'ENOTFOUND',kind:'transport',throws:true},
 ])('keeps $name diagnostics safe and makes only one invocation',({code,kind,throws})=>{
  const token=['configured','credential','for','redaction'].join('-');
  const cause=Object.assign(new Error(`private transport details ${token}`),{code});
  const result=throws?cause:{status:null,error:cause,stdout:'',stderr:`private stderr ${token}`};
  const error=captureFailure(result,{throws,env:{GH_TOKEN:token}});
  expect(error.diagnostic).toMatchObject({method:'GET',route:'/releases/435451150',status:null,kind,errorCode:code});
  expect(error.message).not.toContain(token);
  expect(error.message).not.toContain('private transport details');
  expect(error.message).not.toContain('private stderr');
  expect(error.cause?.message??'').not.toContain(token);
 });
 it('does not expose an invalid JSON response or parser cause',()=>{
  const token=['gh','p','_'].join('')+'j'.repeat(36);
  const error=captureFailure({status:0,stdout:`HTTP/2.0 200 OK\r\nX-GitHub-Request-Id: REQUEST-JSON\r\n\r\ninvalid ${token}`,stderr:''},
   {env:{GH_TOKEN:token}});
  expect(error.diagnostic).toMatchObject({status:200,requestId:'REQUEST-JSON',kind:'invalid_json'});
  expect(error.message).toContain('GitHub returned invalid JSON');
  expect(error.message).not.toContain(token);
  expect(error.cause?.message??'').not.toContain(token);
 });
 it('redacts token patterns, Bearer values and configured credentials in every diagnostic string',()=>{
  const token=['gh','p','_'].join('')+'a'.repeat(36);
  const fineToken=['github','pat',''].join('_')+'b'.repeat(80);
  const bearer='c'.repeat(35),configured=['configured','exact','credential'].join('-');
  const message=`Failed ${token} ${fineToken} Bearer ${bearer} ${configured}\r\nforged log line`;
  const route='/releases/'+encodeURIComponent(configured)+'?access_token='+fineToken;
  const error=captureFailure(responseFailure(403,message,{
   'X-GitHub-Request-Id':token,'X-RateLimit-Resource':configured,
   'Authorization':`Bearer ${bearer}`,'Set-Cookie':`session=${configured}`,'X-Private-Debug':'raw-header-sentinel',
  },{private:'raw-body-sentinel'}),{route,env:{GH_TOKEN:configured,GITHUB_TOKEN:token}});
  expect(error.diagnostic).toBeDefined();
  const output=error.message+JSON.stringify(error.diagnostic)+(error.cause?.message??'');
  for(const value of [token,fineToken,bearer,configured,'raw-header-sentinel','raw-body-sentinel'])expect(output).not.toContain(value);
  expect(error.diagnostic.route).not.toContain('access_token=');
  expect(error.diagnostic.message).not.toMatch(/[\r\n\x00-\x1f\x7f]/);
  expect(error.message).not.toMatch(/[\r\n\x00-\x1f\x7f]/);
 });
 it('ignores invalid numeric headers and never copies arbitrary response headers',()=>{
  const error=captureFailure(responseFailure(403,'Forbidden',{
   'X-RateLimit-Limit':'Infinity','X-RateLimit-Remaining':'-1','X-RateLimit-Reset':'9007199254740992',
   'Retry-After':'not-a-number','X-RateLimit-Resource':'core\r\nX-Private: injected',
   'X-GitHub-Request-Id':'REQUEST-SAFE','X-Private':'raw-private-header',
  }));
  expect(error.diagnostic).toBeDefined();
  expect(error.diagnostic.rateLimit).toEqual({resource:'core'});
  expect(JSON.stringify(error.diagnostic)).not.toMatch(/Infinity|9007199254740992|injected|raw-private-header/);
 });
 it.each(['message','requestId','resource','route'])('redacts an opaque configured token reconstructed by ANSI removal in %s',location=>{
  const configured=['opaque','legacy','credential','fixture'].join('-');
  const split=configured.slice(0,12)+'\x1b[31m'+configured.slice(12)+'\x1b[0m';
  const headers={
   'X-GitHub-Request-Id':location==='requestId'?split:'REQUEST-ANSI',
   'X-RateLimit-Resource':location==='resource'?split:'core',
  };
  const route=location==='route'?'/releases/'+encodeURIComponent(split):'/releases/435451150';
  const error=captureFailure(responseFailure(403,location==='message'?split:'Forbidden',headers),
   {route,env:{GH_TOKEN:configured}});
  expect(error.diagnostic).toBeDefined();
  const serialization=String(error)+JSON.stringify({message:error.message,diagnostic:error.diagnostic,cause:error.cause});
  expect(serialization).not.toContain(configured);
  const values=[error.message,error.diagnostic.message,error.diagnostic.requestId,error.diagnostic.route,error.diagnostic.rateLimit?.resource];
  for(const value of values.filter(value=>typeof value==='string'))expect(value).not.toMatch(/[\r\n\x00-\x1f\x7f]/);
 });
 it.each(['raw','percent-encoded'])('keeps ordinary %s configured-token redaction intact',format=>{
  const configured=['legacy','fixture','value'].join('/')+'+=';
  const value=format==='raw'?configured:encodeURIComponent(configured);
  const error=captureFailure(responseFailure(403,'Rejected '+value),{env:{GH_TOKEN:configured}});
  expect(error.diagnostic.message).toBe('Rejected [REDACTED]');
  expect(error.message).not.toContain(configured);
  expect(error.message).not.toContain(encodeURIComponent(configured));
 });
 it('bounds route, request id, resource and message before exposing the error',()=>{
  const error=captureFailure(responseFailure(500,'m'.repeat(20000),{
   'X-GitHub-Request-Id':'r'.repeat(1000),'X-RateLimit-Resource':'s'.repeat(1000),
  }),{route:'/releases/'+'p'.repeat(2000)});
  expect(error.diagnostic).toBeDefined();
  expect(error.diagnostic.route.length).toBeLessThanOrEqual(512);
  expect(error.diagnostic.requestId.length).toBeLessThanOrEqual(128);
  expect(error.diagnostic.rateLimit.resource.length).toBeLessThanOrEqual(64);
  expect(error.diagnostic.message.length).toBeLessThanOrEqual(512);
  expect(error.message.length).toBeLessThanOrEqual(2048);
 });
 it('retains constructor and encoded-path restrictions without executing gh',()=>{
  expect(()=>new GitHubCLI('Other/repo')).toThrow(/Unexpected repository/);
  const exec=()=>{throw new Error('must not execute');};
  for(const route of ['//evil.example/path','/releases/%2e%2e/other','/git/ref/%0Aheader','/%252e%252e/other']) {
   expect(()=>new GitHubCLI(undefined,{exec}).request('GET',route)).toThrow();
  }
 });
});
