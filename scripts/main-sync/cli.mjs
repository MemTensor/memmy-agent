import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { GitHubCLI } from './github.mjs';
import { assertSha, positiveInteger, normalizeConfig, validateRelease, digest, requireValue } from './core.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const metadata=['MD5SUMS.txt','SHA256SUMS.txt','RELEASE_NOTES.md','RELEASE_NOTES_SOURCE.json','QUALITY_REPORT.json','RELEASE_EVIDENCE.json'];
export async function tagCommit(api,tag) {
  let value=api.request('GET','/git/ref/tags/'+encodeURIComponent(tag),undefined,{optional404:true});
  if (!value) return undefined;
  for (let depth=0;depth<5;depth++) {
    if (value.object?.type ==='commit') return assertSha(value.object.sha);
    requireValue(value.object?.type ==='tag','Unsupported tag object');
    value=api.request('GET','/git/tags/'+assertSha(value.object.sha));
  }
  throw new Error('Tag nesting limit exceeded');
}
async function fileDigest(file) {
  const hash=createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function createRequest({api,env,configBytes,assetDirectory,allowPublished=false}) {
  const config=normalizeConfig(JSON.parse(configBytes));
  requireValue(env.GITHUB_REPOSITORY ===config.repository && env.GITHUB_REF ==='refs/heads/main','Trusted main workflow required');
  const repositoryId=positiveInteger(env.GITHUB_REPOSITORY_ID,'repository id');
  const sourceSha=assertSha(env.SYNC_SOURCE_SHA);
  const controllerSha=assertSha(env.GITHUB_WORKFLOW_SHA || env.SYNC_CONTROLLER_SHA);
  const release=env.SYNC_RELEASE_ID ? api.request('GET','/releases/'+positiveInteger(env.SYNC_RELEASE_ID,'release id')) :
    api.request('GET','/releases/tags/'+encodeURIComponent(env.SYNC_TAG));
  const assets=release.assets;
  requireValue(Array.isArray(assets) && assets.filter(item=>item.name?.startsWith('Memmy-')).length >=6 &&
    metadata.every(name=>assets.some(item=>item.name ===name)),'Canonical release assets are missing');
  let expectedAssets;
  if (assetDirectory) {
    const names=fs.readdirSync(assetDirectory).filter(name=>name.startsWith('Memmy-') || metadata.includes(name)).sort();
    requireValue(names.filter(name=>name.startsWith('Memmy-')).length >=6 && metadata.every(name=>names.includes(name)),'Local release assets are missing');
    expectedAssets=[];
    for (const name of names) {
      const file=path.join(assetDirectory,name),stat=fs.lstatSync(file);
      requireValue(stat.isFile() && !stat.isSymbolicLink(),'Only ordinary release files may be emitted');
      expectedAssets.push({name,size:stat.size,sha256:await fileDigest(file)});
    }
  }
  const releaseInfo=validateRelease(release,{releaseId:release.id,sourceSha,tagSha:await tagCommit(api,release.tag_name),expectedAssets,allowPublished});
  const main=api.request('GET','/git/ref/heads/main');
  const comparison=api.request('GET','/compare/'+sourceSha+'...'+assertSha(main.object?.sha));
  requireValue(comparison.merge_base_commit?.sha ===sourceSha,'Release source is not in main history');
  const workflowRunId=positiveInteger(env.GITHUB_RUN_ID,'workflow run');
  const workflowRunAttempt=positiveInteger(env.GITHUB_RUN_ATTEMPT,'workflow attempt');
  const event=env.GITHUB_EVENT_NAME;
  requireValue(['pull_request_target','workflow_dispatch'].includes(event),'Unsupported request producer event');
  const pullRequestNumber=event ==='pull_request_target' ? positiveInteger(env.SYNC_RELEASE_PR_NUMBER,'release pull request') : null;
  return {schemaVersion:1,kind:'memmy.main-sync-request',
    requestId:digest([repositoryId,releaseInfo.releaseId,sourceSha].join(':')),
    repository:config.repository,repositoryId,...releaseInfo,controllerSha,
    configPath:'.github/main-sync.json',configSha256:digest(configBytes),
    workflowRunId,workflowRunAttempt,event,pullRequestNumber,
    phase:allowPublished?'manual_recovery':'draft_ready',
    assets:(expectedAssets || assets.map(item=>({name:item.name,size:item.size,sha256:item.digest?.replace(/^sha256:/,'') || null}))).sort((a,b)=>a.name.localeCompare(b.name))};
}
export async function main(env=process.env) {
  const configBytes=fs.readFileSync(path.join(root,'.github/main-sync.json'));
  const request=await createRequest({api:new GitHubCLI('MemTensor/memmy-agent',{env}),env,configBytes,
    assetDirectory:env.SYNC_ASSET_DIR ? path.resolve(env.SYNC_ASSET_DIR) : undefined,
    allowPublished:process.argv[2] ==='recover'});
  const output=path.resolve(env.MAIN_SYNC_REQUEST_PATH);
  fs.mkdirSync(path.dirname(output),{recursive:true});
  fs.writeFileSync(output,JSON.stringify(request,null,2)+'\n',{mode:0o600});
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT,'sync_ready=true\nrelease_id='+request.releaseId+'\nsource_sha='+request.sourceSha+'\n');
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY,'## CodingAgent synchronization requested\n\n- Release: '+request.tag+'\n- Source: '+request.sourceSha+'\n- Request: '+request.requestId+'\n- CodingAgent must independently validate this request before creating or resuming tasks.\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) ===fileURLToPath(import.meta.url)) main().catch(error=>{console.error('Main sync request blocked: '+error.message);process.exitCode=1;});
