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
