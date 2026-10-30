import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import YAML from 'yaml';
import { createMemmyConfigWriter } from '../App/backend/src/infrastructure/memmy-config/index.js';
import { createPluginModelInferenceService } from '../App/backend/src/services/plugin-model-inference-service.js';
import { executeReviewTool } from '../../Literature-Review-Plugin/src/runtime/engine.js';
import { TaskRepository } from '../../Literature-Review-Plugin/src/task/index.js';
import type { ModelInferenceInput, ModelInferenceResult } from '../../Literature-Review-Plugin/src/contracts/plugin.js';

// Opt-in real configured-model replay. Credentials stay in the resolver and fetch headers;
// the journal records only wire controls, usage and request identifiers.
// Usage: WRITING_LIVE_ROOT=/tmp/my-run WRITING_LIVE_SOURCE=/path/to/task.json
//   node --import tsx scripts/test-literature-review-writing-live.ts interrupt
// Then run with the same WRITING_LIVE_ROOT and `resume` in a new process.
// `verify` replays the completed task and fails if any model call is needed.
// The source task and global model configuration are never modified.
const root = resolve(process.env.WRITING_LIVE_ROOT ?? '/tmp/literature-writing-live');
const phase = process.argv[2] ?? 'interrupt';
const configPath = resolve(process.env.MEMMY_CONFIG ?? join(homedir(), '.memmy/config.yaml'));
const cfg = YAML.parse(await readFile(configPath, 'utf8'));
const accountPreset = cfg.modelAssignments?.account?.agent?.candidates?.find((id: string) => cfg.modelPresets?.[id]?.model === 'qwen3.8-max-0902');
assert.ok(accountPreset, 'The configured qwen3.8-max-0902 preset is required');
const resolution = await createMemmyConfigWriter({ configPath }).resolveAssignedModel?.({ mode: 'account', activeAccountId: cfg.app?.userId ?? null, capability: 'agent', requestedPreset: accountPreset });
assert.ok(resolution?.ok, 'A configured real account model is required');
console.log(JSON.stringify({ selectedModel: { provider: resolution.context.provider, model: resolution.context.model, protocol: resolution.context.protocol } }));
assert.equal(resolution.context.model, 'qwen3.8-max-0902');
await mkdir(root, { recursive: true });
const repository = new TaskRepository(join(root, 'task-data'));
const statePath = join(root, 'state.json');
let state: any;
if (phase === 'interrupt') {
  const source = process.env.WRITING_LIVE_SOURCE;
  assert.ok(source, 'Set WRITING_LIVE_SOURCE to a real saved task.json');
  const original = JSON.parse(await readFile(source, 'utf8'));
  const task = await repository.create({ spec: original.spec });
  // Preserve the complete outline and original target length, using real saved evidence.
  for (const key of ['outline', 'evidenceUnits', 'evidencePacks']) task.values[key] = original.values[key];
  await repository.save(task);
  state = { taskId: task.taskId, sourceTaskId: original.taskId, spec: task.spec, model: { provider: resolution.context.provider, model: resolution.context.model }, startedAt: new Date().toISOString() };
  await writeFile(statePath, JSON.stringify(state, null, 2));
} else state = JSON.parse(await readFile(statePath, 'utf8'));
assert.deepEqual(state.model, { provider: resolution.context.provider, model: resolution.context.model }, 'Resume must use the same model');
console.log(JSON.stringify({ phase, taskId: state.taskId, model: resolution.context.model, root }));
let current: any;
const journal = async (entry: object) => {
  const line = JSON.stringify({ at: new Date().toISOString(), phase, ...entry });
  await appendFile(join(root, 'calls.jsonl'), line + '\n'); console.log(line);
};
const inference = createPluginModelInferenceService({ resolveModel: async () => resolution, fetch: async (url, init) => {
  const body = JSON.parse(String(init?.body));
  const controls = { model: body.model, enable_thinking: body.enable_thinking, thinking: body.thinking, max_tokens: body.max_tokens, max_completion_tokens: body.max_completion_tokens };
  const response = await fetch(url, init);
  // Inspect only nonsecret metadata; never persist headers or the response text here.
  const data = await response.clone().json().catch(() => ({}));
  await journal({ event: 'wire-response', ...current, controls, status: response.status, responseKeys: Object.keys(data), reasoningCharacters: data.choices?.[0]?.message?.reasoning_content?.length ?? 0, gatewayCode: data.code, gatewayMessage: data.message ?? data.msg, upstreamModel: data.model, finishReason: data.choices?.[0]?.finish_reason, contentCharacters: data.choices?.[0]?.message?.content?.length, usage: data.usage });
  return response;
} });
let interruptionInjected = false;
const modelInference = async (input: ModelInferenceInput): Promise<ModelInferenceResult> => {
  assert.notEqual(phase, 'verify', 'Completed replay must not request inference');
  const request = JSON.parse(input.messages.at(-1)!.content);
  current = { task: request.task, paragraphId: request.paragraphId, sectionId: request.section?.outlineNodeId, maxOutputTokens: input.maxOutputTokens, thinkingMode: input.thinkingMode };
  const disk = await repository.load(state.taskId);
  const checkpoints = (disk.values.sectionGeneration as any)?.paragraphSections ?? {};
  const saved = Object.values(checkpoints).flatMap((cp: any) => cp.paragraphs.filter((p: any) => p.markdown).map((p: any) => ({ sectionId: cp.outlineNodeId, id: p.id, markdown: p.markdown })));
  if (phase === 'interrupt' && request.task === 'write-review-paragraph' && saved.length && !interruptionInjected) {
    interruptionInjected = true;
    state.preservedParagraphs = saved;
    state.interruptedBefore = current;
    await writeFile(statePath, JSON.stringify(state, null, 2));
    await journal({ event: 'intentional-cancellation-after-durable-paragraph', ...current, saved: saved.length });
    throw Object.assign(new Error('Intentional live checkpoint cancellation'), { code: 'plugin_call_cancelled' });
  }
  if (phase === 'resume') assert.ok(!state.preservedParagraphs.some((p: any) => p.id === request.paragraphId), 'Resume must never regenerate a saved paragraph');
  assert.equal(input.thinkingMode, 'disabled');
  const started = Date.now();
  try {
    const result = await inference.invoke({ pluginId: 'literature-review', callId: `writing-live-${Date.now()}`, conversationId: 'writing-live-replay', service: 'model-inference', input }) as ModelInferenceResult;
    await journal({ event: 'model-success', ...current, durationMs: Date.now() - started, finishReason: result.finishReason, usage: result.usage });
    return result;
  } catch (error: any) {
    await journal({ event: 'model-error', ...current, durationMs: Date.now() - started, code: error.code, error: error.message });
    throw error;
  }
};
let complete = false;
for (let attempt = 0; attempt < (phase === 'interrupt' ? 6 : 60); attempt++) {
  try {
    const result = await executeReviewTool('review_generate_sections', { taskId: state.taskId }, `live-${phase}-${attempt}`, { repository: new TaskRepository(repository.root), modelInference });
    const generation = (result.data as any)?.generation;
    await journal({ event: 'tool-result', ok: result.ok, mode: generation?.mode, completed: generation?.completedOutlineNodeIds, exhausted: generation?.exhaustedFallbackOutlineNodeIds, progress: generation?.paragraphProgress, warnings: result.warnings });
    assert.ok(result.ok, result.summary);
    assert.equal(generation?.exhaustedFallbackOutlineNodeIds?.length ?? 0, 0, 'No exhausted fallback sections allowed');
    if (generation?.mode === 'host-model') { complete = true; break; }
  } catch (error: any) {
    if (phase === 'interrupt' && interruptionInjected && error.code === 'plugin_call_cancelled') break;
    throw error;
  }
}
const final = await repository.load(state.taskId);
if (phase === 'interrupt') {
  assert.ok(interruptionInjected, 'Must cancel only after real prose was persisted');
  console.log('INTERRUPTION_VERIFIED: restart this script with resume');
} else {
  assert.ok(complete, 'All original outline sections must complete');
  const generation = final.values.sectionGeneration as any;
  for (const saved of state.preservedParagraphs) assert.equal(generation.paragraphSections[saved.sectionId].paragraphs.find((p: any) => p.id === saved.id)?.markdown, saved.markdown, 'Saved prose must remain byte-identical');
  const calls = (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const responses = calls.filter(c => c.event === 'wire-response');
  assert.ok(responses.every(c => c.controls.enable_thinking === false || c.controls.thinking?.type === 'disabled'), 'Every actual request must carry the non-thinking switch');
  assert.ok(!calls.some(c => c.code === 'model_response_truncated'), 'No token-budget truncation allowed');
  assert.ok(responses.every(c => c.upstreamModel === resolution.context.model), 'The provider must return the explicitly selected model');
  assert.ok(responses.every(c => c.finishReason === 'stop'), 'Every real model response must finish normally');
  assert.ok(responses.every(c => c.reasoningCharacters === 0), 'No reasoning content may be returned');
  assert.ok(responses.every(c => c.usage?.completion_tokens_details?.reasoning_tokens === undefined || c.usage.completion_tokens_details.reasoning_tokens === 0), 'Any reported reasoning tokens must be zero');
  const sections = final.values.sections as any[];
  const report = { result: 'passed', model: state.model, sourceTaskId: state.sourceTaskId, taskId: state.taskId, originalTargetLength: state.spec.targetLength, sections: sections.length, continuityWarnings: Object.values(generation.paragraphSections).filter((cp: any)=>cp.continuityAcceptedWithWarnings).length, hanCharacters: (sections.map(s=>s.markdown).join('').match(/\p{Script=Han}/gu) ?? []).length, paragraphs: sections.reduce((n,s) => n+s.paragraphs.length,0), actualRequests: responses.length, nonThinkingRequests: responses.filter(c=>c.controls.enable_thinking === false || c.controls.thinking?.type === 'disabled').length, normalStops: responses.filter(c=>c.finishReason === 'stop').length, returnedReasoningCharacters: responses.reduce((n,c)=>n+c.reasoningCharacters,0), savedParagraphsUnchanged: state.preservedParagraphs.length, reasoningTokensReported: responses.map(c=>c.usage?.completion_tokens_details?.reasoning_tokens ?? null), finishedAt: new Date().toISOString() };
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(root, 'body.md'), sections.map(s => `## ${s.title ?? s.outlineNodeId}\n\n${s.markdown}`).join('\n\n'));
  console.log(JSON.stringify(report));
}
