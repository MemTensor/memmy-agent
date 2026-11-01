// Real installed Agent drives all model/tool work. This driver sends ordinary
// user messages/Stop, observes safe events, wire controls and Office artifacts.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import YAML from 'yaml';
const root=resolve(process.env.WRITING_INSTALLED_PROFILE??'/private/tmp/memmy-literature-installed-20261022');
const out=join(root,'verification/other-regression');await fs.mkdir(out,{recursive:true});
const config=YAML.parse(await fs.readFile(join(root,'home/.memmy/config.yaml'),'utf8'));
const preset=Object.entries(config.modelPresets).find(([,p])=>p.model==='qwen3.8-max-0902')?.[0];assert.ok(preset);
const wire=join(root,'verification/other-regression-wire.jsonl');
const configHash=createHash('sha256').update(await fs.readFile(join(root,'home/.memmy/config.yaml'))).digest('hex');
const officeRoot=join(root,'app-data/Memmy/plugin-data/office/tasks');
const records=[];
const runStarted=Date.now();
const log=async event=>{const e={at:new Date().toISOString(),...event};await fs.appendFile(join(out,'events.jsonl'),JSON.stringify(e)+'\n');console.log(JSON.stringify(e));};
async function lines(path){try{return(await fs.readFile(path,'utf8')).trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));}catch(e){if(e.code==='ENOENT')return[];throw e;}}
async function files(){try{const names=await fs.readdir(officeRoot);return(await Promise.all(names.map(async n=>{const d=join(officeRoot,n,'execution');try{return(await fs.readdir(d)).map(f=>join(d,f));}catch{return[];}}))).flat();}catch{return[];}}
async function turn(label,prompt,{chatId=randomUUID(),existing=false,stopWhen,expectText,expectTools=[]}={}){
 const base=`http://127.0.0.1:${config.channels.websocket.port}`;
 const r=await fetch(base+'/webui/bootstrap',{headers:{'X-Memmy-Agent-Auth':config.channels.websocket.tokenIssueSecret||config.channels.websocket.token}});assert.equal(r.status,200);const boot=await r.json();
 if(expectTools.length)for(const name of expectTools)assert.ok(boot.tool_names.some(t=>t.includes(name)),`Registered ${name}`);
 const u=new URL(boot.ws_path,base);u.protocol='ws:';u.searchParams.set('token',boot.token);u.searchParams.set('client_id','other-regression');u.searchParams.set('client_surface','gui');
 const socket=new WebSocket(u);let ended=false,stopSent=false,stopAck=false,reasoningCharacters=0,deltaCharacters=0;let finalText='';const tools=[],errors=[];
 const started=Date.now();
 socket.addEventListener('message',m=>{
  const e=JSON.parse(String(m.data));
  if(e.event==='ready'){socket.send(JSON.stringify({type:'attach',chat_id:chatId}));return;}
  if(e.event==='attached'){socket.send(JSON.stringify({type:'message',chat_id:chatId,content:`MEMMY_REGRESSION_${label}\n${prompt}`,webui:true,language:'zh-CN',client_request_id:randomUUID(),model_preset:preset,...(existing?{}:{target:{kind:'standalone'}})}));return;}
  if(e.chat_id&&e.chat_id!==chatId)return;
  if(e.event==='reasoning_delta'){reasoningCharacters+=String(e.text??e.delta??e.content??'').length;return;}
  if(e.event==='delta'){deltaCharacters+=String(e.text??e.delta??e.content??'').length;return;}
  if(e.event==='stream_end'&&e.text)finalText+=e.text;
  if(e.event==='message'&&e.kind!=='progress')finalText+=String(e.text??e.content??'');
  for(const t of e.tool_events??[])tools.push({name:t.name,status:t.status,phase:t.phase,detail:typeof t.detail==='string'?t.detail.slice(0,250):undefined});
  if(e.event==='error'){errors.push(String(e.text??e.detail??e.content??'unknown'));ended=true;}
  if(e.event==='turn_end')ended=true;
  if(e.event==='stop_result'){stopAck=e.stopped>0;ended=true;}
  if(!['stream_end','session_updated','reasoning_end'].includes(e.event))void log({case:label,event:e.event,kind:e.kind,stopped:e.stopped,reason:e.reason,toolNames:e.tool_events?.map(t=>t.name)});
 });
 try{
  while(!ended&&Date.now()-started<240000){
   if(stopWhen&&!stopSent&&await stopWhen({label,started,tools,deltaCharacters,reasoningCharacters})){socket.send(JSON.stringify({type:'stop',chat_id:chatId}));stopSent=true;await log({case:label,event:'ordinary-stop-sent'});}
   await new Promise(r=>setTimeout(r,100));
  }
  assert.ok(ended,`${label} timed out`);assert.deepEqual(errors,[],`${label} runtime errors`);
  if(stopWhen){assert.ok(stopSent);assert.ok(stopAck,`${label} stop acknowledged`);}
  else{if(expectText)assert.match(finalText,expectText);for(const name of expectTools)assert.ok(tools.some(t=>t.name?.includes(name)),`${label} executed ${name}`);}
  const result={case:label,chatId,passed:true,stopSent,stopAcknowledged:stopAck,reasoningCharacters,deltaCharacters,tools,finalText,elapsedMs:Date.now()-started};records.push(result);await fs.writeFile(join(out,label+'.json'),JSON.stringify(result,null,2));return result;
 }finally{socket.close();}
}
if(process.argv[2]==='stream-stop'){
 const stopped=await turn('CHAT_STREAM_STOP','这是普通聊天流式停止回归，不调用工具。请从1到5000逐行输出编号，每行一句关于四季的短句，持续写到5000行。',{stopWhen:async({deltaCharacters})=>deltaCharacters>50});
 await new Promise(r=>setTimeout(r,1500));
 await turn('CHAT_STREAM_RECOVERY','流式停止测试已结束，不要继续编号，不调用工具，只回复“流式停止后恢复正常”。',{chatId:stopped.chatId,existing:true,expectText:/流式停止后恢复正常/});
 const traces=(await lines(wire)).filter(e=>Date.parse(e.at)>=runStarted);
 assert.ok(traces.some(e=>e.case==='CHAT_STREAM_STOP'&&e.event==='cancelled'));
 const starts=traces.filter(e=>e.event==='start'&&e.stream);
 assert.ok(starts.some(e=>e.case==='CHAT_STREAM_RECOVERY'));
 for(const entry of starts)assert.deepEqual(entry.controls,{max_completion_tokens:131072});
 await fs.writeFile(join(out,'stream-stop-report.json'),JSON.stringify({result:'passed',finishedAt:new Date().toISOString(),cases:records,wire:traces},null,2));
 await log({event:'stream-stop-regression-passed',cases:records.length});process.exit(0);
}
const defaultChat=await turn('CHAT_DEFAULT','这是普通聊天回归，请不要调用任何工具。请心算 137×29，只回答“普通聊天通过：3973”。',{expectText:/3973/});
await turn('CHAT_STOP','这是普通聊天停止回归，请不要调用工具。从1到5000逐行输出编号，每行写一句关于四季的短句，持续输出直到5000行。',{stopWhen:async({label,started})=>(await lines(wire)).some(e=>Date.parse(e.at)>=started&&e.case===label&&e.event==='start'&&e.stream)});
await new Promise(r=>setTimeout(r,1200));
await turn('CHAT_RECOVERY','停止测试已结束。不要继续上一个长回答，不调用工具，只回答“停止后聊天恢复正常”。',{chatId:records.at(-1).chatId,existing:true,expectText:/停止后聊天恢复正常/});
await turn('OFFICE_NORMAL','这是 Office 插件回归。请实际使用 office_create 创建一个名为 regression-normal.xlsx 的工作簿，工作表“回归”，两行数据 [["项目","结果"],["普通模型调用",3973]]。然后使用 office_inspect 读取该文件并确认数字3973。只做创建和结构检查，不渲染、不交付文件、不调用文献综述工具。最后汇报检查结果。',{expectText:/3973/,expectTools:['office_create','office_inspect']});
const beforeFiles=new Set(await files());
await turn('OFFICE_STOP',`这是已授权的 Office 停止回归。请调用 office_execute，执行以下完整代码（这是测试用等待，不要省略等待，不要改用其他工具）：\nawait fs.writeFile(path.join(workspace,'regression-started.txt'),'started');\nawait new Promise(resolve=>setTimeout(resolve,45000));\nconst book=new ExcelJS.Workbook();book.addWorksheet('回归').addRow(['不应生成']);await book.xlsx.writeFile(path.join(workspace,'regression-after-stop.xlsx'));return {files:['regression-after-stop.xlsx']};\n调用后等待工具结果。我会使用普通停止按钮中断它，不要自行取消，也不渲染交付。`,{expectTools:['office_execute'],stopWhen:async()=>{const f=(await files()).find(f=>!beforeFiles.has(f)&&f.endsWith('/regression-started.txt'));if(f){await fs.writeFile(join(out,'office-stop-marker.json'),JSON.stringify({path:f,observedAt:new Date().toISOString()}));return true;}return false;}});
await turn('OFFICE_RECOVERY','Office 停止测试已结束。请调用 office_status 检查插件，再用 office_create 创建 regression-recovery.xlsx，工作表“恢复”，数据 [["状态","停止后恢复正常"]]；用 office_inspect 核对。不要继续刚才的等待任务，不渲染不交付文件。',{chatId:records.at(-1).chatId,existing:true,expectTools:['office_status','office_create','office_inspect'],expectText:/恢复/});
const marker=JSON.parse(await fs.readFile(join(out,'office-stop-marker.json'),'utf8'));
const waitMs=Math.max(0,Date.parse(marker.observedAt)+47000-Date.now());if(waitMs)await new Promise(r=>setTimeout(r,waitMs));
assert.ok(!(await files()).some(f=>f.endsWith('/regression-after-stop.xlsx')),'Cancelled Office child must never write its delayed output');
const traces=(await lines(wire)).filter(e=>Date.parse(e.at)>=runStarted);
const chatStart=traces.find(e=>e.case==='CHAT_DEFAULT'&&e.event==='start'&&e.stream);assert.ok(chatStart);
for(const c of ['CHAT_DEFAULT','CHAT_STOP','CHAT_RECOVERY','OFFICE_NORMAL','OFFICE_STOP','OFFICE_RECOVERY']){
 const starts=traces.filter(e=>e.case===c&&e.event==='start'&&e.stream);assert.ok(starts.length,`${c} real model requests observed`);
 for(const s of starts)assert.deepEqual(s.controls,chatStart.controls,`${c} preserves ordinary thinking/token controls`);
}
assert.ok(traces.some(e=>e.case==='CHAT_STOP'&&e.event==='cancelled'),'Real ordinary chat model request cancelled');
assert.equal(createHash('sha256').update(await fs.readFile(join(root,'home/.memmy/config.yaml'))).digest('hex'),configHash,'No default model configuration changed');
const report={result:'passed',finishedAt:new Date().toISOString(),runtime:process.env.WRITING_INSTALLED_APP??'/Applications/Memmy Literature Test.app',model:'qwen3.8-max-0902',cases:records,ordinaryWireControls:chatStart.controls,defaultConfigUnchanged:true,officeCancelledChildDelayedOutputAbsent:true,officeStopObservationWindowSeconds:47,wire:traces};
await fs.writeFile(join(out,'report.json'),JSON.stringify(report,null,2));await log({event:'all-regressions-passed',cases:records.length,wireRequests:traces.filter(e=>e.event==='start').length});
