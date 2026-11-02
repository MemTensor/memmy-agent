import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import YAML from 'yaml';
import { TaskRepository } from '../../Literature-Review-Plugin/src/task/index.js';

// Uses the already-running desktop Agent's real websocket protocol. It sends
// user instructions, observes persisted progress, and stops via the ordinary
// Stop control. No plugin engine or model service is called by this driver.
const root = resolve(process.env.WRITING_RUNTIME_ROOT ?? '/tmp/literature-writing-runtime-20261022');
const phase = process.argv[2] ?? 'start';
await mkdir(root, { recursive: true });
const config = YAML.parse(await readFile(process.env.MEMMY_CONFIG ?? join(homedir(), '.memmy/config.yaml'), 'utf8'));
const selectedPreset = Object.entries(config.modelPresets).find(([, p]: any) => p.model === 'qwen3.8-max-0902')?.[0];
assert.ok(selectedPreset);
const dataRoot = process.env.WRITING_RUNTIME_DATA_ROOT ?? join(homedir(), 'Library/Application Support/Memmy/plugin-data/literature-review');
const repository = new TaskRepository(dataRoot);
let state: any;
if (phase === 'start') {
  const source = process.env.WRITING_LIVE_SOURCE;
  assert.ok(source, 'Set WRITING_LIVE_SOURCE to an existing real corpus task.json');
  const raw = await readFile(source, 'utf8');
  const original = JSON.parse(raw);
  const chatId = randomUUID();
  const task = await repository.create({ spec: original.spec, conversationId: chatId });
  for (const key of ['outline', 'evidenceUnits', 'evidencePacks']) task.values[key] = original.values[key];
  await repository.save(task);
  state = { taskId: task.taskId, sourceTaskId: original.taskId, source, sourceHash: createHash('sha256').update(raw).digest('hex'), chatId, model: 'qwen3.8-max-0902', startedAt: new Date().toISOString() };
  await writeFile(join(root, 'state.json'), JSON.stringify(state, null, 2));
} else state = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'));
const wsConfig = config.channels.websocket;
const gateway = `http://127.0.0.1:${wsConfig.port}`;
const bootResponse = await fetch(gateway + '/webui/bootstrap', { headers: { 'X-Memmy-Agent-Auth': wsConfig.tokenIssueSecret || wsConfig.token } });
assert.equal(bootResponse.status, 200);
const boot = await bootResponse.json() as any;
assert.ok(boot.tool_names.some((n: string) => n.includes('review_generate_sections')));
const url = new URL(boot.ws_path, gateway); url.protocol = 'ws:';
url.searchParams.set('token', boot.token); url.searchParams.set('client_id', 'writing-runtime-validation'); url.searchParams.set('client_surface', 'gui');
const socket = new WebSocket(url);
let done = false;
let stopped = false;
let stopAcknowledged = false;
let ended = false;
const events: any[] = [];
const log = async (event: object) => {
  const safe = { at: new Date().toISOString(), phase, ...event };
  await appendFile(join(root, 'events.jsonl'), JSON.stringify(safe) + '\n');
  console.log(JSON.stringify(safe));
};
const prompt = phase === 'start'
  ? `$literature-review 这是正文生成与中断续跑的真实运行时验收任务。请继续现有任务 ${state.taskId}，标题为《智能体自进化研究综述：机制、方法与开放挑战》。真实论文证据、证据映射和完整12节大纲已经就绪，保持15000字目标。先用 review_get_status 检查，然后仅推进正文生成，直到全部12节完成；不要重新检索、改大纲或做图表、摘要和渲染。请使用已注册的文献综述插件工具，让插件实际生成正文；不要通过 exec、源码修改或手写正文替代工具。当前会话模型必须保持 qwen3.8-max-0902。正常的分批或局部修复应依照检查点继续，仅在真实阻塞时停止。`
  : `继续同一文献综述任务 ${state.taskId} 的正文生成。这是已授权验收任务的后续续跑，请根据当前已保存状态继续。请先检查任务状态和检查点，只续跑未完成段落，保留已保存的正文；使用文献综述插件工具完成全部12节，不要重新检索或修改大纲，不要做图表、摘要、渲染。保持 qwen3.8-max-0902。正常的分批或局部修复应继续，直到正文完成或遇到真实阻塞。`;
socket.addEventListener('message', (message) => {
  const event = JSON.parse(String(message.data));
  if (event.event === 'ready') {
    socket.send(JSON.stringify({ type: 'message', chat_id: state.chatId, content: prompt + (process.env.WRITING_RUNTIME_RESUME_NOTE ? '\n' + process.env.WRITING_RUNTIME_RESUME_NOTE : ''), webui: true, language: 'zh-CN', client_request_id: randomUUID(), model_preset: selectedPreset, ...(phase === 'start' ? { target: { kind: 'standalone' } } : {}) }));
    return;
  }
  if (event.chat_id && event.chat_id !== state.chatId) return;
  // Never dump private skill contents, authentication, or live reasoning text.
  const safe = { event: event.event, turnId: event.turn_id, text: ['message','error'].includes(event.event) ? String(event.text ?? event.content ?? event.detail ?? '').slice(0, 4000) : undefined,
    reason: event.reason, kind: event.kind, stopped: event.stopped, toolEvents: event.tool_events?.map((e: any) => ({ type: e.type, name: e.name ?? e.toolName, status: e.status })), model: event.model_selection?.model };
  if (!['delta','reasoning_delta','reasoning_end','stream_end','session_updated'].includes(event.event)) { events.push(safe); void log(safe); }
  if (event.event === 'error') ended = true;
  if (event.event === 'stop_result') { stopAcknowledged = event.stopped > 0; ended = true; }
  if (event.event === 'turn_end') ended = true;
});
socket.addEventListener('error', () => { void log({ event: 'socket-error' }); });
let lastSignature = '';
for (let tick = 0; tick < 2400 && !done; tick++) {
  await new Promise(r => setTimeout(r, 1000));
  const task = await repository.load(state.taskId);
  const generation = task.values.sectionGeneration as any;
  const checkpoints = Object.values(generation?.paragraphSections ?? {}) as any[];
  const paragraphs = checkpoints.flatMap(cp => cp.paragraphs.filter((p: any) => p.markdown).map((p: any) => ({ sectionId: cp.outlineNodeId, id: p.id, markdown: p.markdown, generationAttempts: p.attempts, continuityRepairAttempts: p.continuityRepairAttempts ?? 0 })));
  const signature = JSON.stringify({ saved: paragraphs.length, completed: generation?.completedOutlineNodeIds?.length ?? 0, mode: generation?.mode });
  if (signature !== lastSignature) { await log({ event: 'disk-progress', taskId: state.taskId, ...JSON.parse(signature) }); lastSignature = signature; }
  if (phase === 'start' && paragraphs.length && !stopped) {
    stopped = true; state.preservedParagraphs = paragraphs;
    try { state.stopDispatchActivity = JSON.parse(await readFile(join(root, 'activity.json'), 'utf8')); } catch { /* Optional transparent relay instrumentation. */ }
    await writeFile(join(root, 'state.json'), JSON.stringify(state, null, 2));
    socket.send(JSON.stringify({ type: 'stop', chat_id: state.chatId }));
    await log({ event: 'ordinary-stop-sent', savedParagraphs: paragraphs.length });
  }
  if (phase === 'start' && stopped && ended) { assert.ok(stopAcknowledged, 'Runtime must acknowledge ordinary stop'); done = true; }
  if (phase === 'resume' && generation?.mode === 'host-model' && generation.completedOutlineNodeIds.length === 12) {
    // Let the Agent receive the final tool response and finish its own turn.
    if (!ended) continue;
    const afterSource = await readFile(state.source, 'utf8');
    assert.equal(createHash('sha256').update(afterSource).digest('hex'), state.sourceHash);
    const preserved = [...new Map([...state.preservedParagraphs, ...(state.additionalPreservedParagraphs ?? [])].map((p: any) => [p.id, p])).values()];
    const checks = preserved.map((p: any) => {
      const current = checkpoints.find(cp=>cp.outlineNodeId === p.sectionId)?.paragraphs.find((q: any)=>q.id===p.id);
      return { id: p.id, unchanged: current?.markdown === p.markdown, generationAttemptsUnchanged: current?.attempts === p.generationAttempts,
        laterContinuityRepairs: (current?.continuityRepairAttempts ?? 0) - (p.continuityRepairAttempts ?? 0) };
    });
    assert.ok(checks.every((p: any)=>p.generationAttemptsUnchanged && (p.unchanged || p.laterContinuityRepairs > 0)), 'Resume must reuse accepted paragraphs; any later edits must belong to an explicit continuity repair');
    const hostCalls = (await readFile(join(root, 'host-requests.jsonl'), 'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.ok(hostCalls.length > 0);
    assert.ok(hostCalls.every(c=>c.model==='qwen3.8-max-0902' && c.enableThinking===false && c.finishReason==='stop' && c.reasoningCharacters===0), 'Actual runtime Host requests must disable thinking and finish normally');
    assert.ok(hostCalls.every(c=>c.usage?.completion_tokens_details?.reasoning_tokens === undefined || c.usage.completion_tokens_details.reasoning_tokens===0));
    assert.ok(hostCalls[0].paragraphId !== state.preservedParagraphs[0].id, 'First resumed request must target an unfinished paragraph');
    const batches = generation.batches;
    assert.ok(batches.filter((b: any)=>b.status==='completed').every((b: any)=>b.model?.model==='qwen3.8-max-0902'));
    assert.ok(!JSON.stringify(generation).includes('model_response_truncated'));
    const report = { result: 'passed', runtime: process.env.WRITING_RUNTIME_LABEL ?? 'running /Applications/Memmy.app Agent + installed plugin via websocket/MCP/command Host', taskId: state.taskId, chatId: state.chatId, model: state.model, sections: generation.completedOutlineNodeIds.length, resumedHostRequests: hostCalls.length, nonThinkingRequests: hostCalls.filter(c=>c.enableThinking===false).length, normalStops: hostCalls.filter(c=>c.finishReason==='stop').length, returnedReasoningCharacters: hostCalls.reduce((n,c)=>n+c.reasoningCharacters,0), reasoningTokenCountersReported: hostCalls.filter(c=>c.usage?.completion_tokens_details?.reasoning_tokens!==undefined).length, stopVerification: state.stopVerification, paragraphs: paragraphs.length, savedParagraphChecks: checks, sourceUnchanged: true, continuityWarnings: checkpoints.filter(cp=>cp.continuityAcceptedWithWarnings).length, batches: batches.map((b:any)=>({status:b.status,model:b.model,usage:b.usage,error:b.error})), finishedAt:new Date().toISOString() };
    await writeFile(join(root,'report.json'),JSON.stringify(report,null,2));
    await writeFile(join(root,'body.md'),(task.values.sections as any[]).map(s=>`## ${s.outlineNodeId}\n\n${s.markdown}`).join('\n\n'));
    await log({event:'runtime-verification-passed',sections:12,paragraphs:paragraphs.length});done=true;
  }
  if (ended && !stopped && !done) { await log({event:'agent-turn-ended-before-completion',progress:JSON.parse(signature)});break; }
}
socket.close();
assert.ok(done, 'Runtime stopped before verification completed; inspect events and persisted checkpoints');
