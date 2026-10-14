import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { createComputerUseOnboarding, bindComputerUseOnboardingIpc, type MemmySystemPermission, type PermissionPanelAction, type PermissionPanelState } from '../src/main/computer-use-onboarding.js';
import { MacPermissionRestartIntent } from '../src/main/mac-permission-quit.js';
import { DesktopOnboardingClient } from '../../../memmy-agent/src/tools/computer-use/desktop-onboarding-client.js';

const helper = '/Applications/Memmy.app/Contents/Resources/Memmy Computer Use.app';
const granted = { accessibility: 'granted', screenRecording: 'granted' } as const;
function fixture() {
  let act!: (action: PermissionPanelAction) => void;
  let state!: PermissionPanelState;
  const panel = { update: vi.fn((next: PermissionPanelState) => { state = next; }), close: vi.fn() };
  const guideFinished = vi.fn((_approved: boolean): void => {});
  const deps = { target: () => ({ app: 'com.example.Memmy', pid: 42 }),
    showPanel: vi.fn((initial: PermissionPanelState, action: typeof act) => { state = initial; act = action; return panel; }),
    openSettings: vi.fn().mockResolvedValue(undefined), copyPath: vi.fn(), reportError: vi.fn(),
    permissionGuideStarted: vi.fn((_permission: MemmySystemPermission): ((approved: boolean) => void) | undefined => guideFinished) };
  const controller = new AbortController();
  const controls = { check: vi.fn().mockResolvedValue(granted), signal: controller.signal, canContinue: true };
  return { deps, panel, guideFinished, guide: createComputerUseOnboarding(deps), controller, controls, action: (action: PermissionPanelAction) => act(action), state: () => state };
}

it('records the owned recording request before opening the exact screen privacy pane', async () => {
  const f = fixture();
  const pending = f.guide.guide('screenCaptureUnavailable', helper, f.controls);
  expect(f.deps.permissionGuideStarted).toHaveBeenCalledExactlyOnceWith('screenRecording');
  expect(f.deps.permissionGuideStarted.mock.invocationCallOrder[0]).toBeLessThan(f.deps.openSettings.mock.invocationCallOrder[0]);
  expect(f.deps.openSettings).toHaveBeenCalledExactlyOnceWith('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  f.action('returned'); f.action('copyPath'); f.action('accessibility');
  expect(f.deps.permissionGuideStarted).toHaveBeenCalledOnce();
  f.action('later'); expect(await pending).toBe(false);
  expect(f.guideFinished).toHaveBeenCalledExactlyOnceWith(false);
});

it('finishes a recording request as approved only after the functional permission check succeeds', async () => {
  const f = fixture();
  const pending = f.guide.guide('screenCaptureUnavailable', helper, f.controls);
  f.action('recheck'); await vi.waitFor(() => expect(f.state().busy).toBe(false));
  expect(f.guideFinished).not.toHaveBeenCalled();
  f.action('continue'); expect(await pending).toBe(true);
  expect(f.guideFinished).toHaveBeenCalledExactlyOnceWith(true);
});

it.each(['later', 'abort'] as const)('cancels the recording restart intent on %s', async (action) => {
  const f = fixture();
  const pending = f.guide.guide('screenCaptureUnavailable', helper, f.controls);
  const idle = f.guide.whenIdle();
  if (action === 'later') f.action('later'); else f.controller.abort();
  expect(await pending).toBe(false);
  expect(await idle).toEqual({ permission: 'screenRecording', approved: false, dismissedByUser: action === 'later' });
  expect(f.guideFinished).toHaveBeenCalledExactlyOnceWith(false);
});

it('does not create recording intent for a guide already cancelled before it starts', async () => {
  const f = fixture(); f.controller.abort();
  expect(await f.guide.guide('screenCaptureUnavailable', helper, f.controls)).toBe(false);
  expect(f.deps.permissionGuideStarted).not.toHaveBeenCalled();
  expect(f.deps.openSettings).not.toHaveBeenCalled();
});

it('clears the recording intent when opening Settings fails and cannot reapprove that failed request', async () => {
  const f = fixture(); const intent = new MacPermissionRestartIntent();
  f.deps.permissionGuideStarted.mockImplementation(() => {
    const token = intent.begin(); return approved => intent.finish(token, approved);
  });
  f.deps.openSettings.mockRejectedValue(new Error('settings unavailable'));
  const pending = f.guide.guide('screenCaptureUnavailable', helper, f.controls);
  await vi.waitFor(() => expect(f.deps.reportError).toHaveBeenCalledOnce());
  expect(intent.consume()).toBe(false);
  f.action('recheck'); await vi.waitFor(() => expect(f.state().busy).toBe(false));
  f.action('continue'); expect(await pending).toBe(true);
  expect(intent.consume()).toBe(false);
});

it('a delayed failure from an older Settings open cannot cancel the newer recording request', async () => {
  const f = fixture(); const intent = new MacPermissionRestartIntent();
  f.deps.permissionGuideStarted.mockImplementation(() => {
    const token = intent.begin(); return approved => intent.finish(token, approved);
  });
  let rejectOld!: (error: Error) => void;
  f.deps.openSettings.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
  const pending = f.guide.guide('screenCaptureUnavailable', helper, f.controls);
  f.action('screenRecording'); rejectOld(new Error('old open failed'));
  await vi.waitFor(() => expect(f.deps.reportError).toHaveBeenCalledOnce());
  expect(f.deps.permissionGuideStarted).toHaveBeenCalledTimes(2);
  expect(intent.consume()).toBe(true);
  f.action('later'); expect(await pending).toBe(false);
});

it('a late successful check after cancellation cannot approve the restart intent', async () => {
  const f = fixture(); let complete!: (status: typeof granted) => void;
  f.controls.check.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const pending = f.guide.guide('screenCaptureUnavailable', helper, f.controls);
  f.action('recheck'); f.controller.abort();
  expect(await pending).toBe(false); complete(granted); await Promise.resolve();
  expect(f.guideFinished).toHaveBeenCalledExactlyOnceWith(false);
});
it('presents only the permission needed for the current operation', async () => {
  const f = fixture(); const pending = f.guide.guide('accessibility', helper, f.controls);
  expect(f.state().permissions).toEqual({ accessibility: 'required', screenRecording: 'unknown', inputMonitoring: 'unknown' });
  expect(f.state().requiredPermission).toBe('accessibility');
  expect(f.state().showActions).toBe(false);
  expect(f.deps.permissionGuideStarted).toHaveBeenCalledExactlyOnceWith('accessibility');
  expect(f.deps.openSettings).toHaveBeenCalledExactlyOnceWith('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
  expect(await f.guide.guide('accessibility', helper, f.controls)).toBe(false);
  f.action('accessibility'); f.action('screenRecording');
  expect(f.deps.openSettings.mock.calls.map(call => call[0])).toEqual([
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  ]);
  expect(f.panel.close).not.toHaveBeenCalled(); expect(f.deps.showPanel).toHaveBeenCalledOnce();
  f.action('copyPath'); expect(f.deps.copyPath).toHaveBeenCalledExactlyOnceWith(helper);
  expect(f.state().message).toContain('已复制');
  f.action('later'); expect(await pending).toBe(false);
});
it('waits for the active accessibility card before another permission guide can open', async () => {
  const f = fixture();
  const accessibility = f.guide.guide('accessibility', helper, f.controls);
  const idle = f.guide.whenIdle();
  expect(f.deps.showPanel).toHaveBeenCalledOnce();
  expect(await f.guide.guide('screenCaptureUnavailable', helper, f.controls)).toBe(false);
  f.action('later');
  expect(await accessibility).toBe(false);
  expect(await idle).toEqual({ permission: 'accessibility', approved: false, dismissedByUser: true });
  expect(await f.guide.whenIdle()).toBeNull();
  const screen = f.guide.guide('screenCaptureUnavailable', helper, f.controls);
  expect(f.deps.showPanel).toHaveBeenCalledTimes(2);
  f.action('later');
  expect(await screen).toBe(false);
});
it('never captures on focus return and requires an explicit check and Continue before resolving', async () => {
  const f = fixture(); let settled = false;
  const pending = f.guide.guide('screenCaptureUnavailable', helper, f.controls).then(result => { settled = true; return result; });
  f.action('continue'); expect(f.controls.check).not.toHaveBeenCalled();
  f.action('returned'); f.action('returned'); f.action('returned');
  expect(f.controls.check).not.toHaveBeenCalled();
  expect(f.state().showActions).toBe(true);
  expect(f.state().permissions.screenRecording).toBe('unknown');
  f.action('recheck'); await vi.waitFor(() => expect(f.state().busy).toBe(false));
  expect(f.state().permissions).toEqual(granted); expect(settled).toBe(false);
  f.action('continue'); expect(await pending).toBe(true); expect(f.controls.check).toHaveBeenCalledTimes(2);
});
it('verifies and closes the guide once a passive reading shows the permission is on', async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    const observe = vi.fn().mockResolvedValueOnce({ accessibility: 'required', screenRecording: 'unknown' })
      .mockResolvedValueOnce(granted);
    const pending = f.guide.guide('accessibility', helper, { ...f.controls, observe });
    await vi.advanceTimersByTimeAsync(1800);
    expect(f.state().showActions).toBe(false);
    expect(f.controls.check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1800);
    await Promise.resolve();
    expect(f.controls.check).toHaveBeenCalledOnce();
    expect(f.panel.close).toHaveBeenCalledOnce();
    expect(await pending).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
it('does not let a switch reading hide a failed helper shutdown', async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    f.controls.check.mockResolvedValue({ accessibility: 'unknown', screenRecording: 'unknown', failure: 'helperPauseFailed' });
    const observe = vi.fn().mockResolvedValue(granted);
    const pending = f.guide.guide('accessibility', helper, { ...f.controls, observe });
    f.action('recheck'); await Promise.resolve(); await Promise.resolve();
    expect(f.state().permissions.failure).toBe('helperPauseFailed');
    await vi.advanceTimersByTimeAsync(1800);
    expect(f.state().permissions.failure).toBe('helperPauseFailed');
    f.action('later'); expect(await pending).toBe(false);
  } finally { vi.useRealTimers(); }
});
it('opens input monitoring with the same Memmy drag guide', async () => {
  const f = fixture(); const pending = f.guide.guide('inputMonitoring', helper, f.controls);
  expect(f.state().requiredPermission).toBe('inputMonitoring');
  expect(f.state().permissions.inputMonitoring).toBe('required');
  expect(f.deps.permissionGuideStarted).toHaveBeenCalledExactlyOnceWith('inputMonitoring');
  expect(f.deps.openSettings).toHaveBeenCalledExactlyOnceWith('x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent');
  f.action('later'); expect(await pending).toBe(false);
});
it('closes the History guide when passive input monitoring becomes granted', async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    const status = { ...granted, inputMonitoring: 'granted' } as const;
    f.controls.check.mockResolvedValue(status);
    const observe = vi.fn().mockResolvedValueOnce({ ...granted, inputMonitoring: 'required' })
      .mockResolvedValueOnce(status);
    const pending = f.guide.guide('inputMonitoring', helper, { ...f.controls, canContinue: false, observe });
    await vi.advanceTimersByTimeAsync(1800);
    expect(f.controls.check).not.toHaveBeenCalled();
    expect(f.panel.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1800);
    expect(await pending).toBe(true);
    expect(f.controls.check).toHaveBeenCalledOnce();
    expect(f.panel.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
it.each(['inputMonitoring', 'screenCaptureUnavailable'] as const)('keeps %s open when the first native reading is already granted', async reason => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    const status = { ...granted, inputMonitoring: 'granted' } as const;
    f.controls.check.mockResolvedValue(status);
    const observe = vi.fn().mockResolvedValue(status);
    const pending = f.guide.guide(reason, helper, { ...f.controls, canContinue: false, observe });
    await vi.advanceTimersByTimeAsync(3600);
    expect(observe).toHaveBeenCalledTimes(2);
    expect(f.state().showActions).toBe(true);
    expect(f.state().message).toContain('点击“完成”');
    expect(f.controls.check).not.toHaveBeenCalled();
    expect(f.panel.close).not.toHaveBeenCalled();
    f.action('returned');
    expect(f.controls.check).not.toHaveBeenCalled();
    f.action('continue');
    expect(await pending).toBe(true);
    expect(f.controls.check).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
it('does not treat an unavailable first observation as an off-to-on transition', async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    const observe = vi.fn().mockResolvedValueOnce({ accessibility: 'unknown', screenRecording: 'unknown', failure: 'unavailable' })
      .mockResolvedValue(granted);
    const pending = f.guide.guide('accessibility', helper, { ...f.controls, observe });
    await vi.advanceTimersByTimeAsync(5400);
    expect(f.state().permissions.accessibility).toBe('granted');
    expect(f.controls.check).not.toHaveBeenCalled();
    expect(f.panel.close).not.toHaveBeenCalled();
    f.action('later');
    expect(await pending).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
it('opens recording settings repeatedly without capturing, requesting access, or closing the guide', async () => {
  const f = fixture(); const pending = f.guide.guide('screenCaptureUnavailable', helper, f.controls);
  expect(f.state().requiredPermission).toBe('screenRecording');
  for (let n = 0; n < 3; n++) { f.action('returned'); f.action('screenRecording'); }
  expect(f.controls.check).not.toHaveBeenCalled();
  expect(f.deps.openSettings).toHaveBeenCalledTimes(4);
  expect(f.deps.openSettings).toHaveBeenLastCalledWith('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  expect(f.panel.close).not.toHaveBeenCalled();
  f.action('later'); expect(await pending).toBe(false);
});
it('reveals manual recovery if System Settings cannot open', async () => {
  const f = fixture(); f.deps.openSettings.mockRejectedValue(new Error('unavailable'));
  const pending = f.guide.guide('accessibility', helper, f.controls);
  await vi.waitFor(() => expect(f.state().showActions).toBe(true));
  expect(f.state().message).toContain('系统设置未能打开');
  expect(f.deps.reportError).toHaveBeenCalledOnce();
  f.action('later'); expect(await pending).toBe(false);
});
it('never treats unknown status or a revoked permission as approved', async () => {
  const f = fixture(); const pending = f.guide.guide('accessibility', helper, f.controls);
  f.action('recheck'); await vi.waitFor(() => expect(f.state().busy).toBe(false));
  f.controls.check.mockResolvedValue({ accessibility: 'unknown', screenRecording: 'granted' });
  f.action('continue'); await vi.waitFor(() => expect(f.state().busy).toBe(false));
  expect(f.panel.close).not.toHaveBeenCalled();
  f.controller.abort(); expect(await pending).toBe(false);
});
it('disables settings during a probe and on a failed helper pause, and ignores late results after cancellation', async () => {
  const f = fixture(); let finish!: (value: unknown) => void;
  f.controls.check.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.guide.guide('accessibility', helper, f.controls);
  f.action('recheck'); f.action('returned'); f.action('screenRecording');
  expect(f.controls.check).toHaveBeenCalledOnce(); expect(f.deps.openSettings).toHaveBeenCalledOnce();
  finish({ accessibility: 'unknown', screenRecording: 'unknown', failure: 'helperPauseFailed' });
  await vi.waitFor(() => expect(f.state().busy).toBe(false)); f.action('screenRecording');
  expect(f.deps.openSettings).toHaveBeenCalledOnce();
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
it('keeps passive status messages separate from the functional recheck', async () => {
  let controls: any;
  const child = Object.assign(new EventEmitter(), { connected: true, send: vi.fn((msg: any, cb: any) => { ipc.emit('message', msg); cb?.(null); }) });
  const ipc = Object.assign(new EventEmitter(), { ppid: 42, connected: true, send: vi.fn((msg: any, cb: any) => { child.emit('message', msg); cb?.(null); }) });
  const handler = { prepare: () => null, guide: vi.fn((_reason: unknown, _helper: unknown, value: unknown) => {
    controls = value; return new Promise<boolean>(resolve => (value as any).signal.addEventListener('abort', () => resolve(false)));
  }) };
  const dispose = bindComputerUseOnboardingIpc(child as any, () => true, handler);
  const nativeCheck = vi.fn().mockResolvedValue(granted);
  const passive = vi.fn().mockResolvedValue({ accessibility: 'required', screenRecording: 'unknown' });
  const abort = new AbortController();
  const waiting = new DesktopOnboardingClient(ipc as any).guide('accessibility', helper, abort.signal, nativeCheck, true, passive);
  await vi.waitFor(() => expect(handler.guide).toHaveBeenCalledOnce());
  expect(await controls.observe()).toEqual({ accessibility: 'required', screenRecording: 'unknown' });
  expect(passive).toHaveBeenCalledOnce(); expect(nativeCheck).not.toHaveBeenCalled();
  expect(await controls.check()).toEqual(granted);
  expect(nativeCheck).toHaveBeenCalledOnce();
  abort.abort(); expect(await waiting).toBe(false); dispose();
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
