import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { createComputerUseOnboarding, bindComputerUseOnboardingIpc, type PermissionPanelAction, type PermissionPanelState } from '../src/main/computer-use-onboarding.js';
import { DesktopOnboardingClient } from '../../../memmy-agent/src/tools/computer-use/desktop-onboarding-client.js';

const helper = '/Applications/Memmy.app/Contents/Resources/Open Computer Use.app';
const granted = { accessibility: 'granted', screenRecording: 'granted' } as const;
function fixture() {
  let act!: (action: PermissionPanelAction) => void;
  let state!: PermissionPanelState;
  const panel = { update: vi.fn((next: PermissionPanelState) => { state = next; }), close: vi.fn() };
  const deps = { target: () => ({ app: 'com.example.Memmy', pid: 42 }),
    showPanel: vi.fn((initial: PermissionPanelState, action: typeof act) => { state = initial; act = action; return panel; }),
    openSettings: vi.fn().mockResolvedValue(undefined), copyPath: vi.fn(), reportError: vi.fn() };
  const controller = new AbortController();
  const controls = { check: vi.fn().mockResolvedValue(granted), signal: controller.signal, canContinue: true };
  return { deps, panel, guide: createComputerUseOnboarding(deps), controller, controls, action: (action: PermissionPanelAction) => act(action), state: () => state };
}
it('presents both permissions together and keeps one panel open across both Settings links', async () => {
  const f = fixture(); const pending = f.guide.guide('accessibility', helper, f.controls);
  expect(f.state().permissions).toEqual({ accessibility: 'required', screenRecording: 'unknown' });
  expect(f.deps.openSettings).not.toHaveBeenCalled();
  expect(await f.guide.guide('accessibility', helper, f.controls)).toBe(false);
  f.action('accessibility'); f.action('screenRecording');
  expect(f.deps.openSettings.mock.calls.map(call => call[0])).toEqual([
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  ]);
  expect(f.panel.close).not.toHaveBeenCalled(); expect(f.deps.showPanel).toHaveBeenCalledOnce();
  f.action('copyPath'); expect(f.deps.copyPath).toHaveBeenCalledExactlyOnceWith(helper);
  f.action('later'); expect(await pending).toBe(false);
});
it('never captures on focus return and requires an explicit check and Continue before resolving', async () => {
  const f = fixture(); let settled = false;
  const pending = f.guide.guide('screenCaptureUnavailable', helper, f.controls).then(result => { settled = true; return result; });
  f.action('continue'); expect(f.controls.check).not.toHaveBeenCalled();
  f.action('returned'); f.action('returned'); f.action('returned');
  expect(f.controls.check).not.toHaveBeenCalled();
  expect(f.state().permissions.screenRecording).toBe('unknown');
  f.action('recheck'); await vi.waitFor(() => expect(f.state().busy).toBe(false));
  expect(f.state().permissions).toEqual(granted); expect(settled).toBe(false);
  f.action('continue'); expect(await pending).toBe(true); expect(f.controls.check).toHaveBeenCalledTimes(2);
});
it('opens recording settings repeatedly without capturing, requesting access, or closing the guide', async () => {
  const f = fixture(); const pending = f.guide.guide('accessibility', helper, f.controls);
  for (let n = 0; n < 3; n++) { f.action('returned'); f.action('screenRecording'); }
  expect(f.controls.check).not.toHaveBeenCalled();
  expect(f.deps.openSettings).toHaveBeenCalledTimes(3);
  expect(f.deps.openSettings).toHaveBeenLastCalledWith('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  expect(f.panel.close).not.toHaveBeenCalled();
  f.action('later'); expect(await pending).toBe(false);
});
it('never treats unknown status or a revoked permission as approved', async () => {
  const f = fixture(); const pending = f.guide.guide('accessibility', helper, f.controls);
  f.action('recheck'); await vi.waitFor(() => expect(f.state().busy).toBe(false));
  f.controls.check.mockResolvedValue({ accessibility: 'granted', screenRecording: 'unknown' });
  f.action('continue'); await vi.waitFor(() => expect(f.state().busy).toBe(false));
  expect(f.panel.close).not.toHaveBeenCalled();
  f.controller.abort(); expect(await pending).toBe(false);
});
it('disables settings during a probe and on a failed helper pause, and ignores late results after cancellation', async () => {
  const f = fixture(); let finish!: (value: unknown) => void;
  f.controls.check.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.guide.guide('accessibility', helper, f.controls);
  f.action('recheck'); f.action('returned'); f.action('screenRecording');
  expect(f.controls.check).toHaveBeenCalledOnce(); expect(f.deps.openSettings).not.toHaveBeenCalled();
  finish({ accessibility: 'unknown', screenRecording: 'unknown', failure: 'helperPauseFailed' });
  await vi.waitFor(() => expect(f.state().busy).toBe(false)); f.action('screenRecording');
  expect(f.deps.openSettings).not.toHaveBeenCalled();
  f.action('recheck'); f.action('later'); expect(await pending).toBe(false);
  const count = f.panel.update.mock.calls.length; finish(granted); await Promise.resolve();
  expect(f.panel.update).toHaveBeenCalledTimes(count);
});
it('exchanges real client/host check messages and releases the pending task only after Continue', async () => {
  const f = fixture();
  const child = Object.assign(new EventEmitter(), { connected: true, send: vi.fn((msg: any, cb: any) => { ipc.emit('message', msg); cb?.(null); }) });
  const ipc = Object.assign(new EventEmitter(), { ppid: 42, connected: true, send: vi.fn((msg: any, cb: any) => { child.emit('message', msg); cb?.(null); }) });
  const client = new DesktopOnboardingClient(ipc as any);
  const dispose = bindComputerUseOnboardingIpc(child as any, () => true, f.guide);
  const nativeCheck = vi.fn().mockResolvedValue(granted);
  const waiting = client.guide('accessibility', helper, null, nativeCheck, true);
  await vi.waitFor(() => expect(f.deps.showPanel).toHaveBeenCalledOnce());
  f.action('returned'); expect(nativeCheck).not.toHaveBeenCalled();
  f.action('recheck'); await vi.waitFor(() => expect(f.state().permissions).toEqual(granted));
  f.action('continue'); expect(await waiting).toBe(true); expect(nativeCheck).toHaveBeenCalledTimes(2);
  dispose(); expect(ipc.listenerCount('message')).toBe(0); expect(child.listenerCount('message')).toBe(0);
});
it('cancels the panel when the pending tool or gateway is cancelled', async () => {
  const f = fixture(); const abort = new AbortController();
  const child = Object.assign(new EventEmitter(), { connected: true, send: (msg: any, cb: any) => { ipc.emit('message', msg); cb?.(null); } });
  const ipc = Object.assign(new EventEmitter(), { ppid: 42, connected: true, send: (msg: any, cb: any) => { child.emit('message', msg); cb?.(null); } });
  const client = new DesktopOnboardingClient(ipc as any);
  const dispose = bindComputerUseOnboardingIpc(child as any, () => true, f.guide);
  const waiting = client.guide('accessibility', helper, abort.signal, async () => granted, true);
  await vi.waitFor(() => expect(f.deps.showPanel).toHaveBeenCalledOnce());
  abort.abort(); expect(await waiting).toBe(false); expect(f.panel.close).toHaveBeenCalledOnce(); dispose();
});
it('rejects untrusted guide fields and cleans up pending checks on disconnect', async () => {
  const child = Object.assign(new EventEmitter(), { connected: true, send: vi.fn((_msg: any, cb: any) => cb?.(null)) });
  let live = true; let controls: any;
  const handler = { prepare: vi.fn(() => ({ app: 'com.example.Memmy', pid: 42 })), guide: vi.fn((_reason, _app, next) => { controls = next; return new Promise<boolean>(resolve => next.signal.addEventListener('abort', () => resolve(false))); }) };
  bindComputerUseOnboardingIpc(child as any, () => live, handler);
  const request = { type: 'memmy:computer-use-onboarding:guide', requestId: 'request-1', helperApp: helper, reason: 'accessibility', canContinue: true };
  child.emit('message', { ...request, url: 'https://bad' }); child.emit('message', { ...request, helperApp: '/Applications/Other.app' });
  expect(handler.guide).not.toHaveBeenCalled(); child.emit('message', request);
  await vi.waitFor(() => expect(handler.guide).toHaveBeenCalledOnce());
  const check = controls.check(); const message = child.send.mock.calls.at(-1)![0];
  child.emit('message', { type: 'memmy:computer-use-onboarding:check:result', requestId: message.requestId, guideId: 'wrong', status: granted });
  live = false; child.emit('disconnect'); expect(await check).toMatchObject({ failure: 'unavailable' });
  expect(child.listenerCount('message')).toBe(0);
});
