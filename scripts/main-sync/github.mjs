import { spawnSync } from 'node:child_process';

export class GitHubCLIError extends Error {
  constructor(message, status, cause) { super(message,{cause});this.status=status;this.statusCode=status; }
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
    catch(cause) { throw new GitHubCLIError('GitHub read failed',null,cause); }
    const stdout=String(result.stdout ?? ''),stderr=String(result.stderr ?? '');
    const header=stdout.match(/^HTTP\/[\d.]+\s+(\d{3})[^\r\n]*(?:\r?\n[^\r\n]+)*\r?\n\r?\n/);
    const status=Number(header?.[1] ?? stderr.match(/\(HTTP (\d{3})\)/)?.[1]) || null;
    if (result.error || result.status !== 0 || (status && status >=400)) {
      if (!result.error && optional404 && status ===404) return null;
      throw new GitHubCLIError('GitHub read failed'+(status?' (HTTP '+status+')':''),status,result.error);
    }
    try { return JSON.parse(header?stdout.slice(header[0].length):stdout); }
    catch(cause) { throw new GitHubCLIError('GitHub returned invalid JSON',status,cause); }
  }
}
