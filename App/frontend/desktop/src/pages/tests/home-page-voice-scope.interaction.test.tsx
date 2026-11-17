// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppProviders } from '../../app/providers.js';
import { AgentRuntimeBridge } from '../../app/agent-runtime-bridge.js';
import { agentActions, appActions } from '../../state/app-actions.js';
import { useAppState, type AppStateContextValue } from '../../state/app-state.js';
import { HomePage, agentChatScopeKey } from '../home-page.js';
import { mockBootstrap } from './fixtures/bootstrap.js';
import type { AsrRecorderOptions } from '../asr-recorder.js';

const capture = vi.hoisted(() => ({ recording: false, options: null as AsrRecorderOptions | null,
  start: vi.fn(async () => {}), cancel: vi.fn(), finish: vi.fn() }));
vi.mock('../asr-recorder.js', async original => {
  const module = await original<typeof import('../asr-recorder.js')>();
  return { ...module, useAsrRecorder: (_client: unknown, options: AsrRecorderOptions = {}) => {
    if (!options.voiceInput) return module.useAsrRecorder(_client as any, options);
    capture.options = options;
    return { isRecording: capture.recording, isStarting: false, isTranscribing: false,
      start: capture.start, cancel: capture.cancel, finishAndTranscribe: capture.finish };
  } };
});
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let app: AppStateContextValue;
function Observe() { app = useAppState(); return null; }
beforeEach(() => {
  capture.recording = false; capture.start.mockReset(); capture.finish.mockReset(); capture.cancel.mockReset();
  capture.start.mockImplementation(async () => { capture.recording = true; });
  capture.cancel.mockImplementation(() => { capture.recording = false; });
  window.localStorage.clear(); window.sessionStorage.clear();
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  act(() => root.render(<AppProviders><AgentRuntimeBridge><Observe /><HomePage /></AgentRuntimeBridge></AppProviders>));
  act(() => app.dispatch(appActions.bootstrapLoaded(mockBootstrap, '/main')));
  act(() => {
    app.dispatch(agentActions.historyLoading('websocket:voice-old', 'voice-old', 'voice-history'));
    app.dispatch(agentActions.historyLoaded({ schemaVersion: 1, sessionKey: 'websocket:voice-old',
      last_turn_closed: true, messages: [] }, 'voice-history'));
  });
});
afterEach(() => { act(() => root.unmount()); document.body.replaceChildren(); vi.restoreAllMocks(); });
function mic() { return document.querySelector<HTMLButtonElement>('button[aria-label="语音输入"]')!; }
function scope() { return agentChatScopeKey(app.state.agent.currentChatId, app.state.agent.newChatRequestId); }
async function startWithText() {
  await act(async () => mic().click());
  act(() => capture.options!.live!.onLine({ sentenceId: 1, text: '已有语音', startMs: 0, endMs: 500 }));
  expect(app.state.agent.composerDraftsByScope[scope()]).toBe('已有语音');
}

it('cancels capture on conversation changes and keeps the previous draft intact', async () => {
  await startWithText(); const previous = scope();
  act(() => app.dispatch(agentActions.newChatRequested()));
  const next = scope(); expect(next).not.toBe(previous); expect(capture.cancel).toHaveBeenCalledOnce();
  act(() => capture.options!.live!.onLine({ sentenceId: 1, text: '迟到的语音', startMs: 0, endMs: 900 }));
  expect(app.state.agent.composerDraftsByScope[previous]).toBe('已有语音');
  expect(app.state.agent.composerDraftsByScope[next] ?? '').toBe('');
});

it.each(['resolve', 'reject'])('ignores an old final result or error after a new capture starts: %s', async outcome => {
  await startWithText(); const previous = scope();
  let resolve!: (value: any) => void; let reject!: (error: Error) => void;
  capture.finish.mockImplementationOnce(() => new Promise((ok, fail) => { resolve = ok; reject = fail; }));
  await act(async () => mic().click());
  act(() => app.dispatch(agentActions.newChatRequested()));
  await startWithText(); const next = scope();
  await act(async () => { if (outcome === 'resolve') resolve({ text: '旧结果' }); else reject(new Error('旧错误')); });
  act(() => capture.options!.live!.onLine({ sentenceId: 1, text: '新会话继续录入', startMs: 0, endMs: 1200 }));
  expect(app.state.agent.composerDraftsByScope[previous]).toBe('已有语音');
  expect(app.state.agent.composerDraftsByScope[next]).toBe('新会话继续录入');
  expect(app.state.agent.operationErrorNotice).toBeNull();
});

it('ignores a second stop while the same final result is in flight', async () => {
  await startWithText();
  let complete!: (value: any) => void;
  capture.finish.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  await act(async () => { mic().click(); mic().click(); });
  expect(capture.finish).toHaveBeenCalledOnce();
  await act(async () => complete({ text: '最终文字' }));
  expect(app.state.agent.composerDraftsByScope[scope()]).toBe('最终文字');
  expect(app.state.agent.operationErrorNotice).toBeNull();
});
it('cancels capture when the entire draft is cleared and drops late revisions', async () => {
  await startWithText();
  const input = document.querySelector<HTMLTextAreaElement>('textarea')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(capture.cancel).toHaveBeenCalledOnce();
  act(() => capture.options!.live!.onLine({ sentenceId: 1, text: 'late result', startMs: 0, endMs: 1000 }));
  expect(app.state.agent.composerDraftsByScope[scope()] ?? '').toBe('');
});

it('keeps a voice failure in the existing composer error flow without changing connection state', async () => {
  await startWithText();
  const connectionStatus = app.state.agent.connectionStatus;
  capture.finish.mockRejectedValueOnce(new Error('转写失败'));
  await act(async () => mic().click());
  expect(app.state.agent.operationErrorNotice).toMatchObject({ source: 'send', scopeKey: scope() });
  expect(app.state.agent.connectionStatus).toBe(connectionStatus);
});
