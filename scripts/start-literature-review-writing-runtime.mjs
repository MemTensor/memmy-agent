import fs from 'node:fs/promises';
import {openSync} from 'node:fs';
import {spawn} from 'node:child_process';
import YAML from 'yaml';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
// Boot the real runtime stack against an already-prepared isolated profile.
// It must contain a private config.yaml and an app.sqlite snapshot; never point
// this test launcher at the user's normal profile. No model or tool outputs are mocked.
if (!process.env.WRITING_RUNTIME_PROFILE) throw new Error('Set WRITING_RUNTIME_PROFILE to the isolated profile directory');
const root=resolve(process.env.WRITING_RUNTIME_PROFILE);
const repo=resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config=YAML.parse(await fs.readFile(root+'/config.yaml','utf8'));
process.env.MEMMY_CONFIG=root+'/config.yaml';process.env.MEMMY_HOME=root;
process.env.MEMMY_AGENT_DATA_DIR=root;process.env.MEMMY_AGENT_WORKSPACE=root+'/workspace';process.env.MEMMY_AGENT_TASKS_DIR=root+'/tasks';
process.env.MEMMY_MEMORY_LAYER_URL=config.memmyMemory.storage.endpoint||'http://127.0.0.1:18960';
process.env.MEMMY_MEMORY_LAYER_TOKEN=config.memmyMemory.storage.token||'';
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  let body, request;
  try { body=JSON.parse(String(init?.body)); request=JSON.parse(body.messages?.at(-1)?.content ?? '{}'); } catch {}
  const tracked=body?.model==='qwen3.8-max-0902' && ['plan-review-paragraphs','write-review-paragraph','check-review-paragraph-continuity'].includes(request?.task);
  const response=await nativeFetch(input,init);
  if(tracked){
    const result=await response.clone().json().catch(()=>({}));
    const entry={at:new Date().toISOString(),task:request.task,sectionId:request.section?.outlineNodeId,paragraphId:request.paragraphId,status:response.status,model:result.model,enableThinking:body.enable_thinking,maxOutputTokens:body.max_completion_tokens??body.max_tokens,finishReason:result.choices?.[0]?.finish_reason,contentCharacters:result.choices?.[0]?.message?.content?.length,reasoningCharacters:result.choices?.[0]?.message?.reasoning_content?.length??0,usage:result.usage};
    await fs.appendFile(root+'/verification/host-requests.jsonl',JSON.stringify(entry)+'\n');
  }
  return response;
};
const {createLocalBackend}=await import(pathToFileURL(join(repo,'App/backend/dist/src/index.js')).href);
const backend=await createLocalBackend({databasePath:root+'/app.sqlite',memmyConfigPath:root+'/config.yaml',runtimeConfigPath:root+'/runtime.json',memoryBaseUrl:process.env.MEMMY_MEMORY_LAYER_URL,skipAgentMcpReload:true});
await fs.mkdir(root+'/workspace',{recursive:true});
const output=openSync(root+'/agent.log','a',0o600);
const child=spawn(process.execPath,[join(repo,'App/memmy-agent/dist/main.js'),'gateway','--config',root+'/config.yaml','--workspace',root+'/workspace','--host','127.0.0.1','--port',String(config.gateway.port)],{env:process.env,stdio:['ignore',output,output]});
console.log(JSON.stringify({event:'real-runtime-started',backend:backend.runtimeConfig.baseUrl,gatewayPid:child.pid,configPath:root+'/config.yaml',pluginDataRoot:root+'/plugin-data/literature-review'}));
const close=async()=>{child.kill('SIGTERM');await backend.close();process.exit(0);};
process.on('SIGTERM',close);process.on('SIGINT',close);
child.on('exit',(code)=>{console.log(JSON.stringify({event:'gateway-exited',code}));});
