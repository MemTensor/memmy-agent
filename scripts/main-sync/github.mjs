import { spawnSync } from 'node:child_process';

export class GitHubCLIError extends Error {
  constructor(message, status, _cause, diagnostic) {
    super(message+(diagnostic?' '+JSON.stringify(diagnostic):''));
    this.status=status;this.statusCode=status;
    if (diagnostic) this.diagnostic=diagnostic;
    // Raw transport/parser causes can contain response bodies or credentials.
  }
}

const tokenKeys=['GH_TOKEN','GITHUB_TOKEN','GH_ENTERPRISE_TOKEN','GITHUB_ENTERPRISE_TOKEN'];
function safeText(value,env,limit) {
  let text=value.replace(/\x1b\[[0-9;]*[a-zA-Z]/g,'');
  for (const key of tokenKeys) {
    const token=env[key];
    if (typeof token==='string' && token) {
      text=text.split(token).join('[REDACTED]');
      text=text.split(encodeURIComponent(token)).join('[REDACTED]');
    }
  }
  return text.replace(/(?:gh[pousr]_[a-zA-Z0-9_]+|github_pat_[a-zA-Z0-9_]+)/g,'[REDACTED]')
    .replace(/\bBearer\s+[^\s\"'<>;,]+/gi,'Bearer [REDACTED]')
    .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g,' ').slice(0,limit);
}
function numericHeader(value) {
  value=value?.trim();
  if (!/^\d+$/.test(value??'')) return undefined;
  const number=Number(value);
  return Number.isSafeInteger(number) && number>=0?number:undefined;
}
function readDiagnostic(route,status,header,body,env,kind,error) {
  // The route has already passed repository/path validation. Omit query data.
  const diagnostic={method:'GET',route:safeText(route,env,512),status,kind};
  const headers=new Map();
  for (const line of (header??'').split(/\r?\n/)) {
    const match=/^([a-zA-Z0-9-]+):[ \t]*(.*)$/.exec(line);
    if (match && !headers.has(match[1].toLowerCase())) headers.set(match[1].toLowerCase(),match[2]);
  }
  const requestId=headers.get('x-github-request-id');
  if (requestId) diagnostic.requestId=safeText(requestId,env,128);
  const rateLimit={};
  for (const [name,key] of [['x-ratelimit-limit','limit'],['x-ratelimit-remaining','remaining'],
    ['x-ratelimit-reset','reset'],['retry-after','retryAfter']]) {
    const number=numericHeader(headers.get(name));
    if (number!==undefined) rateLimit[key]=number;
  }
  const resource=headers.get('x-ratelimit-resource');
  if (resource) rateLimit.resource=safeText(resource,env,64);
  if (Object.keys(rateLimit).length) diagnostic.rateLimit=rateLimit;
  if (body) {
    try {
      const data=JSON.parse(body);
      if (data && !Array.isArray(data) && typeof data.message==='string') diagnostic.message=safeText(data.message,env,512);
    } catch { /* Never expose an unparsed response body. */ }
  }
  if (typeof error?.code==='string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(error.code)) diagnostic.errorCode=safeText(error.code,env,32);
  return diagnostic;
}
// This producer only reads GitHub. CodingAgent owns all coding/PR mutations.
export class GitHubCLI {
  constructor(repository='MemTensor/memmy-agent',{env=process.env,exec=spawnSync}={}) {
    if (repository !== 'MemTensor/memmy-agent') throw new Error('Unexpected repository');
    this.repository=repository;this.env={...env,GH_HOST:'github.com',GH_PROMPT_DISABLED:'1'};this.exec=exec;
  }
  request(method,route,data,{optional404=false}={}) {
    if (method !== 'GET' || data !== undefined || typeof route !== 'string' || !route.startsWith('/') ||
        /[\\\r\n#]/.test(route) || route.includes('://') || route.split('/').includes('..') ||
        route.startsWith('/repos/')) throw new Error('Only repository-scoped GitHub reads are permitted');
    const decoded = decodeURIComponent(route.split('?')[0]);
    if (decoded.startsWith('//') || decoded.split('/').some(part => part === '..' || part === '.') ||
        /[%\\\r\n#]/.test(decoded)) throw new Error('Unsafe GitHub read path');
    let result;
    try { result=this.exec('gh',['api','--hostname','github.com','--method','GET','--include',
      '/repos/'+this.repository+route,'-H','Accept: application/vnd.github+json','-H','X-GitHub-Api-Version: 2022-11-28'],
      {env:this.env,encoding:'utf8',maxBuffer:20*1024*1024,timeout:60000}); }
    catch(cause) {
      const diagnostic=readDiagnostic(decoded,null,undefined,undefined,this.env,cause?.code==='ETIMEDOUT'?'timeout':'transport',cause);
      throw new GitHubCLIError('GitHub read failed',null,undefined,diagnostic);
    }
    const stdout=String(result.stdout ?? ''),stderr=String(result.stderr ?? '');
    const header=stdout.match(/^HTTP\/[\d.]+\s+(\d{3})[^\r\n]*(?:\r?\n[^\r\n]+)*\r?\n\r?\n/);
    const status=Number(header?.[1] ?? stderr.match(/\(HTTP (\d{3})\)/)?.[1]) || null;
    if (result.error || result.status !== 0 || (status && status >=400)) {
      if (!result.error && optional404 && status ===404) return null;
      const kind=result.error?(result.error.code==='ETIMEDOUT'?'timeout':'transport'):(status?'http':'command');
      const diagnostic=readDiagnostic(decoded,status,header?.[0],header?stdout.slice(header[0].length):stdout,this.env,kind,result.error);
      throw new GitHubCLIError('GitHub read failed'+(status?' (HTTP '+status+')':''),status,undefined,diagnostic);
    }
    try { return JSON.parse(header?stdout.slice(header[0].length):stdout); }
    catch {
      const diagnostic=readDiagnostic(decoded,status,header?.[0],undefined,this.env,'invalid_json');
      throw new GitHubCLIError('GitHub returned invalid JSON',status,undefined,diagnostic);
    }
  }
}
