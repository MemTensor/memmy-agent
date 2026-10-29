// Local acceptance support: real signed Electron app owns backend, gateway and
// plugin execution. This process only serves immutable test artifacts and
// transparently relays the configured real model endpoint for wire assertions.
import fs from 'node:fs/promises';
import {createServer} from 'node:http';
import {spawn, spawnSync} from 'node:child_process';
import {homedir} from 'node:os';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import YAML from 'yaml';
const root=resolve(process.env.WRITING_INSTALLED_PROFILE??'/private/tmp/memmy-literature-installed-20261022');
const repo=resolve(import.meta.dirname,'..');
const pluginRoot=resolve(process.env.LITERATURE_REVIEW_PLUGIN_ROOT??resolve(repo,'../Literature-Review-Plugin'));
const home=join(root,'home');
const configPath=join(home,'.memmy/config.yaml');
const data=join(root,'app-data/Memmy');
const phase=process.argv[2];
const registryPort=43227,modelPort=43228;
const origin=`http://127.0.0.1:${registryPort}`;
if(phase==='prepare'){
  await fs.mkdir(join(home,'.memmy'),{recursive:true,mode:0o700});
  await fs.mkdir(data,{recursive:true,mode:0o700});
  await fs.mkdir(join(root,'verification'),{recursive:true});
  const original=YAML.parse(await fs.readFile(join(homedir(),'.memmy/config.yaml'),'utf8'));
  const selected=Object.values(original.modelPresets).find(p=>p.model==='qwen3.8-max-0902');
  if(!selected)throw Error('Requested real Qwen preset missing');
  const endpoint=original.providers[selected.provider].endpoints[selected.endpoint];
  await fs.writeFile(join(root,'upstream.json'),JSON.stringify({apiBase:endpoint.apiBase}),{mode:0o600});
  endpoint.apiBase=`http://127.0.0.1:${modelPort}/v1`;
  original.agents.defaults.workspace=join(root,'workspace');
  original.tools={...original.tools,mcpServers:{}};
  original.gateway.port=19397;original.channels.websocket.port=19398;
  await fs.writeFile(configPath,YAML.stringify(original),{mode:0o600});
  // Clone the real account, but install plugins afresh: copied artifact paths
  // belong to the original profile and must never be deleted by this fixture.
  const py='import sqlite3,sys\na=sqlite3.connect(sys.argv[1]);b=sqlite3.connect(sys.argv[2]);a.backup(b);b.execute("DELETE FROM installed_plugins");b.commit();b.close();a.close()';
  const result=spawnSync('/usr/bin/python3',['-c',py,join(homedir(),'Library/Application Support/Memmy/app.sqlite'),join(data,'app.sqlite')],{encoding:'utf8'});
  if(result.status)throw Error(result.stderr);
  await fs.chmod(join(data,'app.sqlite'),0o600);
  console.log(JSON.stringify({prepared:root,configPath,data}));
}else if(phase==='serve'){
  const manifest=JSON.parse(await fs.readFile(join(pluginRoot,'plugin.json'),'utf8'));
  const release=JSON.parse(await fs.readFile(join(pluginRoot,'release',`${manifest.id}-${manifest.version}.release.json`),'utf8'));
  const artifact=await fs.readFile(join(pluginRoot,'release',release.artifact.file));
  const bundle=await fs.readFile(join(pluginRoot,'release',release.skillBundles['literature-review'].file));
  const authCache=new Map();
  async function authorized(req){
    const authorization=req.headers.authorization;
    if(!authorization)return false;
    if((authCache.get(authorization)??0)>Date.now())return true;
    const response=await fetch('https://test-api.memmy.cn/api/v1/plugins/literature-review?version=0.5.41',{headers:{authorization},signal:AbortSignal.timeout(15000)});
    if(response.ok){authCache.set(authorization,Date.now()+60000);return true;}return false;
  }
  const send=(res,status,body,type='application/json')=>{const bytes=Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body));res.writeHead(status,{'content-type':type,'content-length':bytes.length,'cache-control':'no-store'});res.end(bytes);};
  const cloudRequest=(req,url)=>fetch(new URL(url,'https://test-api.memmy.cn'),{headers:{...(req.headers.authorization?{authorization:req.headers.authorization}:{}),accept:req.headers.accept??'application/json'},redirect:'manual',signal:AbortSignal.timeout(15000)});
  createServer(async(req,res)=>{try{
    const url=new URL(req.url,origin);
    // Override only this test release; preserve other installed plugins and
    // their ordinary authenticated registry/download routes.
    if(url.pathname.startsWith('/api/v1/plugins/')&&!url.pathname.startsWith('/api/v1/plugins/literature-review')){
      const upstream=await cloudRequest(req,url.pathname+url.search);
      res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')??'application/json',...(upstream.headers.get('location')?{location:upstream.headers.get('location')}:{})});
      if(upstream.body)for await(const chunk of upstream.body)res.write(chunk);res.end();return;
    }
    if(!await authorized(req))return send(res,403,{error:'account_entitlement_required'});
    if(url.pathname==='/api/v1/plugins'){
      const upstream=await cloudRequest(req,'/api/v1/plugins');
      if(!upstream.ok)return send(res,upstream.status,{error:'upstream_catalog_unavailable'});
      const catalog=await upstream.json();if(!Array.isArray(catalog))throw Error('Invalid upstream catalog');
      return send(res,200,[...catalog.filter(p=>p.id!==manifest.id),manifest]);
    }
    if(url.pathname==='/api/v1/plugins/literature-review')return send(res,200,{manifest,artifact:{url:`${origin}/artifact.zip`,sha256:release.artifact.sha256}});
    if(url.pathname==='/artifact.zip')return send(res,200,artifact,'application/zip');
    if(url.pathname==='/api/v1/plugins/literature-review/skills/literature-review/bundle'&&url.searchParams.get('pluginVersion')===manifest.version&&url.searchParams.get('revision')===manifest.skills[0].cloud.revision)return send(res,200,bundle);
    send(res,404,{error:'not_found'});
  }catch(e){console.error(e.message);send(res,502,{error:'upstream_unavailable'});}}).listen(registryPort,'127.0.0.1');
  const upstream=JSON.parse(await fs.readFile(join(root,'upstream.json'),'utf8')).apiBase;
  // Optional regression observer: record wire controls and lifecycle only.
  // Forward bytes unchanged; never retain prompts, credentials or reasoning.
  const traceFile=process.env.MEMMY_REGRESSION_TRACE_FILE;
  const trace=entry=>traceFile?fs.appendFile(traceFile,JSON.stringify({at:new Date().toISOString(),...entry})+'\n'):Promise.resolve();
  let active=0,started=0,completed=0,cancelled=0;
  const activity=()=>fs.writeFile(join(root,'verification/activity.json'),JSON.stringify({active,started,completed,cancelled}));
  createServer(async(req,res)=>{
    let tracked=false,probeId,probeCase;const abort=new AbortController();
    res.on('close',()=>{if(!res.writableEnded)abort.abort();});
    try{
      const chunks=[];for await(const c of req)chunks.push(c);const bytes=Buffer.concat(chunks);
      let body,request;try{body=JSON.parse(bytes);request=JSON.parse(body.messages?.at(-1)?.content??'{}');}catch{}
      if(traceFile&&body?.model==='qwen3.8-max-0902'){
        const markers=(body.messages??[]).filter(m=>m.role==='user').flatMap(m=>{
          const content=typeof m.content==='string'?m.content:Array.isArray(m.content)?m.content.filter(p=>p.type==='text').map(p=>p.text??'').join('\n'):'';
          return [...content.matchAll(/MEMMY_REGRESSION_([A-Z0-9_]+)/g)].map(v=>v[1]);
        });
        probeCase=markers.at(-1);
        if(probeCase){
          probeId=globalThis.crypto.randomUUID();
          const controls=Object.fromEntries(['enable_thinking','thinking','reasoning','reasoning_effort','thinking_budget','chat_template_kwargs','max_tokens','max_completion_tokens'].filter(k=>body[k]!==undefined).map(k=>[k,body[k]]));
          await trace({event:'start',id:probeId,case:probeCase,model:body.model,stream:!!body.stream,controls});
        }
      }
      tracked=['plan-review-paragraphs','write-review-paragraph','check-review-paragraph-continuity'].includes(request?.task);
      if(!tracked&&body?.model==='qwen3.8-max-0902'){
        const latest=body.messages?.findLast(m=>m.role==='tool');
        if(latest){
          let result;try{result=JSON.parse(typeof latest.content==='string'?latest.content:latest.content.filter(c=>c.type==='text').map(c=>c.text).join('\n'));}catch{}
          const data=result?.data?.generation?result.data:result?.data?.result;
          const generation=data?.generation;
          await fs.appendFile(join(root,'verification/tool-result-shapes.jsonl'),JSON.stringify({at:new Date().toISOString(),parseable:!!result,keys:result?Object.keys(result):[],dataKeys:data?Object.keys(data):[],ok:result?.ok,persisted:data?.persisted,mode:generation?.mode,safeToResume:generation?.safeToResume,checkpointed:generation?.checkpointed,paragraphProgress:generation?.paragraphProgress?.map(p=>({outlineNodeId:p.outlineNodeId,saved:p.savedModelParagraphs,completed:p.completed,retryBudget:p.retryBudget}))})+'\n');
        }
      }
      if(tracked){active++;started++;await activity();}
      const target=upstream.replace(/\/$/,'')+req.url.replace(/^\/v1/,'');
      const response=await fetch(target,{method:req.method,headers:{'content-type':'application/json',...(req.headers.authorization?{authorization:req.headers.authorization}:{})},body:bytes,signal:abort.signal});
      res.writeHead(response.status,{'content-type':response.headers.get('content-type')??'application/json'});
      if(tracked){
        const output=Buffer.from(await response.arrayBuffer());const result=JSON.parse(output);
        await fs.appendFile(join(root,'verification/host-requests.jsonl'),JSON.stringify({at:new Date().toISOString(),task:request.task,sectionId:request.section?.outlineNodeId,paragraphId:request.paragraphId,status:response.status,model:result.model,enableThinking:body.enable_thinking,maxOutputTokens:body.max_completion_tokens??body.max_tokens,finishReason:result.choices?.[0]?.finish_reason,contentCharacters:result.choices?.[0]?.message?.content?.length,reasoningCharacters:result.choices?.[0]?.message?.reasoning_content?.length??0,usage:result.usage})+'\n');
        completed++;res.end(output);
      }else{for await(const chunk of response.body)res.write(chunk);res.end();}
      if(probeId)await trace({event:'complete',id:probeId,case:probeCase,status:response.status});
    }catch(e){if(probeId)await trace({event:abort.signal.aborted?'cancelled':'error',id:probeId,case:probeCase,errorName:e.name});if(tracked&&abort.signal.aborted)cancelled++;if(!res.headersSent)res.writeHead(502);res.end();}
    finally{if(tracked){active--;await activity();}}
  }).listen(modelPort,'127.0.0.1');
  console.log(JSON.stringify({registry:origin,modelRelay:`http://127.0.0.1:${modelPort}`,upstream,pluginVersion:manifest.version}));
}else if(phase==='proof'){
  const asar=await import('@electron/asar');
  const app=process.env.WRITING_INSTALLED_APP??'/Applications/Memmy Literature Test.app';
  const archive=join(app,'Contents/Resources/app.asar');
  const paths={
    'App/backend/dist/src/services/plugin-model-inference-service.js':'node_modules/@memmy/backend/dist/src/services/plugin-model-inference-service.js',
    'App/backend/dist/src/adapters/inbound/local-api/routes/plugin-mcp.js':'node_modules/@memmy/backend/dist/src/adapters/inbound/local-api/routes/plugin-mcp.js',
    'App/memmy-agent/dist/core/agent-runtime/task-plan-continuation.js':'dist/runtime/memmy-agent/dist/core/agent-runtime/task-plan-continuation.js'
  };
  const files=[];
  for(const [source,packaged] of Object.entries(paths)){
    const digest=b=>createHash('sha256').update(b).digest('hex');
    const sourceHash=digest(await fs.readFile(join(repo,source)));const installedHash=digest(asar.extractFile(archive,packaged));
    if(sourceHash!==installedHash)throw Error(`Installed code mismatch: ${packaged}`);
    files.push({source,packaged,sha256:installedHash});
  }
  const signature=spawnSync('/usr/bin/codesign',['--verify','--deep','--strict',app],{encoding:'utf8'});
  if(signature.status)throw Error(signature.stderr);
  const result={verifiedAt:new Date().toISOString(),installedApp:app,signatureVerified:true,edition:JSON.parse(asar.extractFile(archive,'dist/main/desktop-edition.json')),files};
  await fs.writeFile(join(root,'verification/installed-code-proof.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({signatureVerified:true,matchedFiles:files.length,installedApp:app}));
}else if(phase==='stop'){
  const state=JSON.parse(await fs.readFile(join(root,'verification/state.json'),'utf8'));
  const config=YAML.parse(await fs.readFile(configPath,'utf8'));
  const taskPath=join(data,'plugin-data/literature-review/tasks',state.taskId,'task.json');
  const snapshot=async()=>{
    const activity=JSON.parse(await fs.readFile(join(root,'verification/activity.json'),'utf8'));
    const task=JSON.parse(await fs.readFile(taskPath,'utf8'));
    const sections=Object.values(task.values.sectionGeneration.paragraphSections??{});
    return {attempts:sections.reduce((n,cp)=>n+cp.planAttempts+cp.continuityAttempts+cp.paragraphs.reduce((m,p)=>m+p.attempts+(p.validationRepairAttempts??0)+(p.continuityRepairAttempts??0),0),0),paragraphs:sections.flatMap(cp=>cp.paragraphs.filter(p=>p.markdown).map(p=>({id:p.id,markdown:p.markdown}))),activity};
  };
  let before;
  for(let i=0;i<1200;i++){before=await snapshot();if(!process.env.WRITING_STOP_REQUIRE_ACTIVE||before.activity.active>0)break;await new Promise(r=>setTimeout(r,200));}
  if(process.env.WRITING_STOP_REQUIRE_ACTIVE&&before.activity.active===0)throw Error('No active real writing request to cancel');
  if(process.env.WRITING_STOP_EXTERNAL){
    console.log(JSON.stringify({event:'ready-for-ui-stop',attemptsBefore:before.attempts,savedParagraphs:before.paragraphs.length}));
    let observed=false;
    const cancelledBefore=before.activity.cancelled;
    for(let i=0;i<1200;i++){
      const current=await snapshot();
      if(current.activity.cancelled>cancelledBefore){observed=true;break;}
      if(current.activity.active>0)before=current;
      await new Promise(r=>setTimeout(r,50));
    }
    if(!observed)throw Error('No ordinary UI stop observed');
  }else{
  const base=`http://127.0.0.1:${config.channels.websocket.port}`;
  const boot=await fetch(base+'/webui/bootstrap',{headers:{'X-Memmy-Agent-Auth':config.channels.websocket.tokenIssueSecret||config.channels.websocket.token}}).then(r=>r.json());
  const url=new URL(boot.ws_path,base);url.protocol='ws:';url.searchParams.set('token',boot.token);url.searchParams.set('client_id','installed-cancel-probe');url.searchParams.set('client_surface','gui');
  await new Promise((resolve,reject)=>{
    const socket=new WebSocket(url);const timer=setTimeout(()=>{socket.close();reject(Error('Stop acknowledgement timed out'));},30000);
    socket.addEventListener('message',message=>{const e=JSON.parse(String(message.data));if(e.event==='ready')socket.send(JSON.stringify({type:'stop',chat_id:state.chatId}));if(e.event==='stop_result'){clearTimeout(timer);socket.close();if(e.stopped>0)resolve();else reject(Error('No active Agent was stopped'));}});
  });
  }
  let after;
  for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,500));after=await snapshot();if(after.activity.active===0&&i>=1)break;}
  if(after.activity.active)throw Error('Request still active after Stop');
  const preserved=before.paragraphs.every(p=>after.paragraphs.some(q=>q.id===p.id&&q.markdown===p.markdown));
  const result={at:new Date().toISOString(),version:process.env.WRITING_PLUGIN_VERSION,buildLabel:process.env.WRITING_BUILD_LABEL,realRequestCancelled:after.activity.cancelled>before.activity.cancelled,attemptsBefore:before.attempts,attemptsAfter:after.attempts,refunded:before.attempts-after.attempts,savedParagraphs:after.paragraphs.length,preserved};
  await fs.appendFile(join(root,'verification/additional-stops.jsonl'),JSON.stringify(result)+'\n');
  console.log(JSON.stringify(result));
  if(!preserved)throw Error('Stop changed accepted prose');
  if(process.env.WRITING_ASSERT_CANCEL_REFUND&&(!result.realRequestCancelled||result.refunded!==1))throw Error('Cancelled stage attempt was not refunded');
}else if(phase==='check-stop'){
  const statePath=join(root,'verification/state.json');
  const state=JSON.parse(await fs.readFile(statePath,'utf8'));
  const taskPath=join(data,'plugin-data/literature-review/tasks',state.taskId,'task.json');
  const snapshot=async()=>{
    const task=JSON.parse(await fs.readFile(taskPath,'utf8'));
    const generation=task.values.sectionGeneration;
    const paragraphs=Object.values(generation.paragraphSections).flatMap(cp=>cp.paragraphs.filter(p=>p.markdown));
    return {activity:JSON.parse(await fs.readFile(join(root,'verification/activity.json'),'utf8')),paragraphs:paragraphs.length,completed:generation.completedOutlineNodeIds.length};
  };
  let before;
  for(let i=0;i<20;i++){before=await snapshot();if(before.activity.active===0)break;await new Promise(r=>setTimeout(r,1000));}
  if(before.activity.active!==0)throw Error('Model request did not cancel');
  await new Promise(r=>setTimeout(r,10000));const after=await snapshot();
  if(JSON.stringify(before)!==JSON.stringify(after))throw Error('Plugin continued after Stop');
  state.stopVerification={passed:true,stableSeconds:10,...after};
  await fs.writeFile(statePath,JSON.stringify(state,null,2));
  await fs.rename(join(root,'verification/host-requests.jsonl'),join(root,'verification/host-requests-before-stop.jsonl'));
  console.log(JSON.stringify(state.stopVerification));
}else if(phase==='install'){
  const runtime=JSON.parse(await fs.readFile(process.env.WRITING_API_RUNTIME??join(home,'.memmy/runtime.json'),'utf8'));
  async function api(path,method='GET',body){
    const r=await fetch(runtime.baseUrl+path,{method,headers:{'x-memmy-local-token':runtime.localToken,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(900000)});
    const result=await r.json();if(!r.ok||result.error)throw Error(JSON.stringify({status:r.status,error:result.error}));return result;
  }
  let plugin=(await api('/api/v1/plugins')).find(p=>p.id==='literature-review');
  const version=JSON.parse(await fs.readFile(join(pluginRoot,'plugin.json'),'utf8')).version;
  if(!plugin)plugin=await api('/api/v1/plugins/install','POST',{pluginId:'literature-review',version});
  else if(plugin.version!==version)plugin=await api('/api/v1/plugins/literature-review/update','POST',{version});
  if(plugin.state==='pending_approval')plugin=await api('/api/v1/plugins/literature-review/permissions','PUT',{permissions:plugin.manifest.permissions});
  if(plugin.state!=='active')plugin=await api('/api/v1/plugins/literature-review/enable','POST',{});
  const result={installedAt:new Date().toISOString(),id:plugin.id,version:plugin.version,state:plugin.state,artifactHash:plugin.artifactHash,lastError:plugin.lastError};
  await fs.writeFile(join(root,'verification/plugin-install.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}else if(phase==='launch'||phase==='launch-dev'){
  const development=phase==='launch-dev';
  const app=process.env.WRITING_INSTALLED_APP??'/Applications/Memmy Literature Test.app';
  let registryChild;
  try { await fetch(origin+'/api/v1/plugins',{signal:AbortSignal.timeout(1000)}); }
  catch {
    registryChild=spawn(process.execPath,[import.meta.filename,'serve'],{env:process.env,stdio:'inherit'});
    let ready=false;
    for(let i=0;i<30;i++){
      try{await fetch(origin+'/api/v1/plugins',{signal:AbortSignal.timeout(1000)});ready=true;break;}
      catch{await new Promise(r=>setTimeout(r,200));}
    }
    if(!ready){registryChild.kill('SIGTERM');throw Error('Test registry did not start');}
  }
  const child=spawn(development?'/bin/bash':join(app,'Contents/MacOS/Memmy'),development?[join(repo,'scripts/dev-start.sh')]:[],{
    cwd:repo,env:{...process.env,...(development?{}:{HOME:home,MEMMY_TEST_PROFILE_ROOT:root,MEMMY_ENABLE_SIGNED_TEST_PROFILE:'1'}),MEMMY_PLUGIN_REGISTRY_URL:origin},stdio:'inherit'
  });
  process.on('SIGINT',()=>child.kill('SIGTERM'));process.on('SIGTERM',()=>child.kill('SIGTERM'));
  child.on('exit',code=>{registryChild?.kill('SIGTERM');process.exit(code??1);});
}else throw Error('Expected prepare, serve, install or launch');
