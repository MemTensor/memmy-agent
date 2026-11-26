// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventCaptureSession, InstalledPlugin } from '@memmy/local-api-contracts';
import { ApiRequestError } from '../../api/http.js';
import { I18nProvider } from '../../i18n/i18n-provider.js';

const context = vi.hoisted(() => ({ clients: null as any, state: null as any }));
vi.mock('../providers.js', () => ({ useApiClients: () => ({ clients: context.clients }) }));
vi.mock('../../state/app-state.js', () => ({ useAppState: () => ({ state: context.state }) }));
import { TeachModeRecordingController } from '../teach-mode-recording-controller.js';

let node: HTMLDivElement, root: Root;
const id = 'ba1142db-f861-4dca-8bff-f602d492d8db';
const plugin = { id: 'teach-mode', version: '0.5.0', state: 'active', manifest: {
  name: 'Teach Mode', conversation: { recordingCapabilityId: 'recording', recordingSkillId: 'teach-mode-recording', creatorSkillId: 'teach-skill-creator' }
} } as InstalledPlugin;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  node = document.createElement('div'); document.body.appendChild(node); root = createRoot(node);
  context.state = { agent: { currentChatId: 'chat-a', currentSessionKey: null, newChatRequestId: 1 } };
  vi.stubGlobal('EventSource', undefined);
  vi.useFakeTimers();
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); delete (window as any).memmy; vi.unstubAllGlobals(); vi.useRealTimers(); });

function fixture() {
  let session: EventCaptureSession = { schemaVersion: 1, id, pluginId: 'teach-mode', conversationId: 'chat-a',
    goal: '演示操作', state: 'recording', startedAt: new Date(Date.now() - 12_000).toISOString(), endedAt: null,
    eventCount: 0, eventTypes: {}, applications: [], eventsSha256: null, availability: 'pending', limitations: [], error: null, ranges: [] };
  const invoke = vi.fn(async (_pluginId: string, _capability: string, input: any) => {
    if (input.input.action === 'stop' || input.input.action === 'cancel') session = { ...session,
      state: input.input.action === 'stop' ? 'ready' : 'cancelled', endedAt: new Date().toISOString() };
    return { callId: 'call', event: { type: 'result', output: input.input.action === 'status' ? { sessions: [session] } : session } };
  });
  context.clients = { plugins: { list: vi.fn(async () => [plugin]), invoke }, runtimeConfig: {} };
  return { invoke, render: () => act(async () => root.render(<I18nProvider language="zh-CN"><TeachModeRecordingController /></I18nProvider>)),
    // The in-window bar waits out the native panel hand-off before it appears.
    showFallback: () => act(async () => { vi.advanceTimersByTime(1_300); }) };
}

describe('Teach Mode floating recording control', () => {
  it('shows the compact control outside the conversation in browser previews', async () => {
    const f = fixture(); await f.render();
    await f.showFallback();
    expect(node.querySelector('.teach-recording-control')).not.toBeNull();
    expect(node.textContent).toMatch(/0:1[2-4]/);
    expect(node.querySelector('[aria-label="录制完成"]')).not.toBeNull();
    expect(node.querySelector('[aria-label="丢弃录制"]')).not.toBeNull();
    await act(async () => (node.querySelector('[aria-label="录制完成"]') as HTMLButtonElement).click());
    expect(f.invoke).toHaveBeenCalledWith('teach-mode', 'recording', expect.objectContaining({
      conversationId: 'chat-a', input: expect.objectContaining({ action: 'stop', session_id: id }) }));
    expect(node.querySelector('.teach-recording-control')).toBeNull();
  });

  it('sends native panel state and handles discard from the independent panel', async () => {
    const update = vi.fn(async () => undefined);
    let action: ((value: { id: string; action: 'stop' | 'cancel' }) => void) | undefined;
    let visibility: ((visible: boolean) => void) | undefined;
    (window as any).memmy = { updateTeachingRecordingControls: update,
      onTeachingRecordingControlAction: vi.fn((callback: typeof action) => { action = callback; return () => undefined; }),
      onTeachingRecordingControlsVisibility: vi.fn((callback: typeof visibility) => { visibility = callback; return () => undefined; }) };
    const f = fixture(); await f.render();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ id, state: 'recording' }));
    // Nothing inside the window while the native bar is on its way.
    expect(node.querySelector('.teach-recording-control')).toBeNull();
    await f.showFallback();
    expect(node.querySelector('.teach-recording-control')).not.toBeNull();
    await act(async () => visibility?.(true));
    expect(node.querySelector('.teach-recording-control')).toBeNull();
    await act(async () => action?.({ id, action: 'cancel' }));
    expect(f.invoke).toHaveBeenCalledWith('teach-mode', 'recording', expect.objectContaining({
      input: expect.objectContaining({ action: 'cancel', session_id: id }) }));
    expect(update).toHaveBeenLastCalledWith(null);
  });

  it('keeps the same recording visible after switching conversations', async () => {
    const f = fixture(); await f.render();
    context.state = { agent: { currentChatId: 'chat-b', currentSessionKey: null, newChatRequestId: 1 } };
    await f.render();
    await f.showFallback();
    expect(node.querySelector('.teach-recording-control')).not.toBeNull();
    expect(f.invoke).toHaveBeenLastCalledWith('teach-mode', 'recording', expect.objectContaining({ conversationId: 'chat-a' }));
  });
});

it.each(['plugin_unavailable', 'plugin_permission_denied'] as const)('withdraws the floating control and stops polling after %s', async code => {
  const f = fixture(); await f.render(); await f.showFallback();
  expect(node.querySelector('.teach-recording-control')).not.toBeNull();
  context.clients.plugins.list.mockResolvedValue([]);
  f.invoke.mockRejectedValue(new ApiRequestError('Plugin is not active', 409, code));
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(node.querySelector('.teach-recording-control')).toBeNull();
  expect(node.textContent).not.toContain('Plugin is not active');
  const requests = f.invoke.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(4500); });
  expect(f.invoke).toHaveBeenCalledTimes(requests);
});
