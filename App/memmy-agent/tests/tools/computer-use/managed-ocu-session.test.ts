import { describe, expect, it, vi } from 'vitest';
import { ManagedOcuSession, OCU_TOOLS, OcuBlocked, OcuUncertain } from '../../../src/tools/computer-use/managed-ocu-session.js';
import { RequestContext } from '../../../src/core/agent-runtime/tools/context.js';
import { NativeAppApprovalDenied, NativeAppApprovalGate, NativeAppApprovalStore }
  from '../../../src/tools/computer-use/native-app-approvals.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const turn = (id: string) => new RequestContext({ messageId: id, sessionKey: 'chat' });
function fixture() {
  const sessions: any[] = [];
  const connect = vi.fn(async () => {
    const session = { ping: vi.fn().mockResolvedValue({}), listTools: vi.fn().mockResolvedValue({ tools: [...OCU_TOOLS].map(name => ({ name, inputSchema: {} })) }), callTool: vi.fn().mockResolvedValue({ content: [] }) };
    const connection = { session, close: vi.fn().mockResolvedValue(undefined) };
    sessions.push(connection); return connection;
  });
  const doctor = vi.fn().mockResolvedValue({ state: 'granted' });
  const owner = new ManagedOcuSession(connect, doctor);
  return { sessions, connect, doctor, owner };
}
describe('Memmy Computer Use connection owner', () => {
  it('asks in Memmy before dispatching an action and guides only after a native permission error', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'memmy-ocu-consent-'));
    try {
      let approve!: (value: 'allow-once') => void;
      const ask = vi.fn(() => new Promise<'allow-once'>(resolve => { approve = resolve; }));
      const gate = new NativeAppApprovalGate(new NativeAppApprovalStore(join(directory, 'approvals.json')), ask);
      const { sessions, connect, doctor } = fixture();
      const guide = vi.fn().mockResolvedValue(false);
      const owner = new ManagedOcuSession(connect, doctor, guide, undefined,
        { appApprovals: gate, platform: 'darwin' });
      await owner.initialize();
      sessions[0].session.callTool.mockImplementation((name: string) => name === 'list_apps'
        ? { content: [{ type: 'text', text: '计算器 — com.apple.calculator [running]' }] }
        : { isError: true, content: [{ type: 'text', text: 'Accessibility permission is required.' }] });
      const action = owner.invoke('click', { app: '计算器', element_index: 42 }, 30, turn('consent'));
      await vi.waitFor(() => expect(ask).toHaveBeenCalledOnce());
      expect(doctor).not.toHaveBeenCalled();
      expect(guide).not.toHaveBeenCalled();
      expect(sessions[0].session.callTool.mock.calls.map((call: any[]) => call[0])).toEqual(['list_apps']);
      approve('allow-once');
      await expect(action).resolves.toMatchObject({ isError: true });
      expect(sessions[0].session.callTool.mock.calls.map((call: any[]) => call[0])).toEqual(['list_apps', 'click']);
      expect(doctor).not.toHaveBeenCalled();
      expect(guide).toHaveBeenCalledOnce();
      await owner.close();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('does not dispatch an app action until its stable identity is approved', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'memmy-ocu-gate-'));
    try {
      let approve!: (value: 'allow-once') => void;
      const ask = vi.fn(() => new Promise<'allow-once'>(resolve => { approve = resolve; }));
      const gate = new NativeAppApprovalGate(new NativeAppApprovalStore(join(directory, 'approvals.json')), ask);
      const { sessions, connect, doctor } = fixture();
      const owner = new ManagedOcuSession(connect, doctor, undefined, undefined,
        { appApprovals: gate, platform: 'darwin' });
      await owner.initialize();
      sessions[0].session.callTool.mockImplementation((name: string) => name === 'list_apps'
        ? { content: [{ type: 'text', text: '计算器 — com.apple.calculator [running]' }] }
        : { content: [{ type: 'text', text: 'done' }] });
      const action = owner.invoke('click', { app: '计算器', element_index: 42 }, 30, turn('approved'));
      await vi.waitFor(() => expect(ask).toHaveBeenCalledOnce());
      expect(sessions[0].session.callTool.mock.calls.map((call: any[]) => call[0])).toEqual(['list_apps']);
      approve('allow-once');
      await action;
      expect(sessions[0].session.callTool.mock.calls[1]).toEqual(['click',
        { app: 'com.apple.calculator', element_index: 42 }, 30]);
      await owner.close();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('uses the Windows helper PID after approving its stable process identity', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'memmy-ocu-gate-'));
    try {
      const ask = vi.fn().mockResolvedValue('allow-once');
      const gate = new NativeAppApprovalGate(new NativeAppApprovalStore(join(directory, 'approvals.json')), ask);
      const { sessions, connect, doctor } = fixture();
      const owner = new ManagedOcuSession(connect, doctor, undefined, undefined,
        { appApprovals: gate, platform: 'win32' });
      await owner.initialize();
      sessions[0].session.callTool.mockImplementation((name: string) => name === 'list_apps'
        ? { content: [{ type: 'text', text: 'notepad -- notepad [running, pid=4812, window=Untitled - Notepad]' }] }
        : { content: [{ type: 'text', text: 'done' }] });
      await owner.invoke('click', { app: 'notepad', element_index: 2 }, 30, turn('win'));
      expect(ask).toHaveBeenCalledWith({ platform: 'win32', appId: 'notepad', displayName: 'notepad' });
      expect(sessions[0].session.callTool.mock.calls[1]).toEqual(['click',
        { app: '4812', element_index: 2 }, 30]);
      await owner.close();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('rejects ambiguous or denied apps without sending the requested action', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'memmy-ocu-gate-'));
    try {
      const ask = vi.fn().mockResolvedValue('deny');
      const gate = new NativeAppApprovalGate(new NativeAppApprovalStore(join(directory, 'approvals.json')), ask);
      const { sessions, connect, doctor } = fixture();
      const owner = new ManagedOcuSession(connect, doctor, undefined, undefined,
        { appApprovals: gate, platform: 'darwin' });
      await owner.initialize();
      sessions[0].session.callTool.mockResolvedValue({ content: [{ type: 'text', text:
        '计算器 — com.apple.calculator [running]' }] });
      await expect(owner.invoke('type_text', { app: '计算器', text: 'private' }, 30, turn('deny')))
        .rejects.toBeInstanceOf(NativeAppApprovalDenied);
      expect(sessions[0].session.callTool.mock.calls.map((call: any[]) => call[0])).toEqual(['list_apps']);
      await expect(owner.invoke('type_text', { app: 'Unknown', text: 'private' }, 30, turn('unknown')))
        .rejects.toBeInstanceOf(NativeAppApprovalDenied);
      expect(ask).toHaveBeenCalledOnce();
      await owner.close();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('discovers tools and lists apps without invoking doctor', async () => {
    const { owner, doctor } = fixture();
    await owner.initialize(); await owner.listTools();
    await owner.invoke('list_apps', {}, 30, null);
    expect(doctor).not.toHaveBeenCalled(); await owner.close();
  });
  it('blocks another operation in the same message after native denial; retries on a new message', async () => {
    const { owner, sessions, doctor, connect } = fixture();
    await owner.initialize();
    sessions[0].session.callTool.mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: 'Accessibility permission is required.' }] });
    await expect(owner.invoke('get_app_state', { app: 'WeChat' }, 30, turn('1'))).resolves.toMatchObject({ isError: true });
    await expect(owner.invoke('click', {}, 30, turn('1'))).rejects.toBeInstanceOf(OcuBlocked);
    expect(sessions[0].session.callTool).toHaveBeenCalledOnce(); expect(connect).toHaveBeenCalledTimes(1);
    await owner.invoke('get_app_state', { app: 'WeChat' }, 30, turn('2'));
    expect(connect).toHaveBeenCalledTimes(2); expect(sessions[0].close).toHaveBeenCalledOnce(); expect(doctor).not.toHaveBeenCalled();
    await owner.close();
  });
  it('recovers a dead proxy before dispatch and never replays a lost action response', async () => {
    const { owner, sessions, connect, doctor } = fixture();
    await owner.initialize(); sessions[0].session.ping.mockRejectedValue(new Error('closed'));
    await owner.invoke('click', {}, 30, turn('1'));
    expect(connect).toHaveBeenCalledTimes(2); expect(sessions[0].session.callTool).not.toHaveBeenCalled();
    sessions[1].session.callTool.mockRejectedValue(new Error('response lost'));
    await expect(owner.invoke('type_text', { text: 'one' }, 30, turn('2'))).rejects.toBeInstanceOf(OcuUncertain);
    await expect(owner.invoke('type_text', { text: 'one' }, 30, turn('2'))).rejects.toBeInstanceOf(OcuBlocked);
    expect(sessions[1].session.callTool).toHaveBeenCalledTimes(2);
    await owner.invoke('get_app_state', {}, 30, turn('3'));
    expect(connect).toHaveBeenCalledTimes(3); expect(doctor).not.toHaveBeenCalled(); await owner.close();
  });
  it('rejects permission-free execution without a user context', async () => {
    const { owner, doctor, connect } = fixture();
    await expect(owner.invoke('click', {}, 30, null)).rejects.toBeInstanceOf(OcuBlocked);
    expect(doctor).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled();
  });
  it('cannot revive a removed configuration', async () => {
    const { owner, connect } = fixture(); await owner.close();
    await expect(owner.invoke('click', {}, 30, turn('1'))).rejects.toBeInstanceOf(OcuBlocked);
    expect(connect).not.toHaveBeenCalled();
  });
  it('serializes operations across simultaneous chat requests', async () => {
    const { owner, sessions } = fixture(); await owner.initialize();
    let finish!: () => void;
    sessions[0].session.callTool.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ content: [] }); }));
    const first = owner.invoke('click', {}, 30, turn('1'));
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const second = owner.invoke('type_text', {}, 30, turn('2'));
    await Promise.resolve(); expect(sessions[0].session.callTool).toHaveBeenCalledTimes(1);
    finish(); await Promise.all([first, second]); expect(sessions[0].session.callTool).toHaveBeenCalledTimes(2); await owner.close();
  });
  it('rejects unsupported native tools but does not block an action for an unrelated probe state', async () => {
    const { owner, doctor, sessions } = fixture(); doctor.mockResolvedValue({ state: 'unknown' });
    await expect(owner.invoke('get_screen_state', {}, 30, turn('1'))).rejects.toBeInstanceOf(OcuBlocked);
    await expect(owner.invoke('click', {}, 30, turn('2'))).resolves.toEqual({ content: [] });
    expect(sessions[0].session.callTool).toHaveBeenCalledOnce(); expect(doctor).not.toHaveBeenCalled(); await owner.close();
  });
});

it('never repeats a denied action within one user message', async () => {
  const { owner, doctor, sessions } = fixture(); await owner.initialize();
  sessions[0].session.callTool.mockResolvedValue({ isError: true, content: [{ type: 'text', text: 'Accessibility permission is required.' }] });
  const results = await Promise.allSettled([owner.invoke('click', {}, 30, turn('a')), owner.invoke('click', {}, 30, turn('a'))]);
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
  expect(sessions[0].session.callTool).toHaveBeenCalledOnce(); expect(doctor).not.toHaveBeenCalled(); await owner.close();
});

it('pauses the helper for the guide while keeping permission-free app discovery available', async () => {
  const { connect, sessions, doctor } = fixture();
  const events: string[] = [];
  const owner = new ManagedOcuSession(connect, doctor, async () => { events.push('guide'); }, async () => {
    expect(sessions[0].close).toHaveBeenCalledOnce(); events.push('stopped');
  });
  await owner.initialize();
  sessions[0].session.callTool.mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: 'Accessibility permission is required.' }] });
  await expect(owner.invoke('click', { app: 'Notes' }, 30, turn('1'))).resolves.toMatchObject({ isError: true });
  expect(events).toEqual(['stopped', 'guide']);
  await owner.listTools();
  await expect(owner.invoke('list_apps', {}, 30, turn('1'))).resolves.toEqual({ content: [] });
  expect(connect).toHaveBeenCalledTimes(2);
  await expect(owner.invoke('click', { app: 'Notes' }, 30, turn('1'))).rejects.toBeInstanceOf(OcuBlocked);
  await owner.invoke('click', { app: 'Notes' }, 30, turn('2'));
  expect(connect).toHaveBeenCalledTimes(2); expect(sessions[1].session.callTool).toHaveBeenCalledTimes(2);
  await owner.close();
});
it('stops a background app agent started by passive permission observation when guidance ends', async () => {
  const { connect, sessions, doctor } = fixture();
  const passive = vi.fn().mockResolvedValue({ state: 'missing', permission: 'accessibility' });
  const stop = vi.fn().mockResolvedValue(undefined);
  const guide = vi.fn(async (_status, _signal, _check, _canContinue, observe) => {
    expect(await observe()).toMatchObject({ state: 'missing' });
  });
  const owner = new ManagedOcuSession(connect, doctor, guide, stop, { passivePermissionStatus: passive });
  await owner.initialize();
  sessions[0].session.callTool.mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: 'Accessibility permission is required.' }] });
  await owner.invoke('click', { app: 'Notes' }, 30, turn('status-only'));
  expect(passive).toHaveBeenCalledOnce(); expect(stop).toHaveBeenCalledTimes(2);
  await owner.close();
});

it('does not open authorization guidance when the helper cannot be safely stopped', async () => {
  const { connect, doctor, sessions } = fixture();
  const guide = vi.fn();
  const owner = new ManagedOcuSession(connect, doctor, guide, async () => { throw new Error('wrong app'); });
  await owner.initialize();
  sessions[0].session.callTool.mockResolvedValue({ isError: true, content: [{ type: 'text', text: 'Accessibility permission is required.' }] });
  await expect(owner.invoke('click', {}, 30, turn('1'))).rejects.toMatchObject({ status: { state: 'unknown', reason: 'helperPauseFailed' } });
  expect(guide).not.toHaveBeenCalled(); await owner.close();
});

it('reports a failed pause accurately when permission is revoked after preflight', async () => {
  const { connect, sessions, doctor } = fixture(); const guide = vi.fn();
  const owner = new ManagedOcuSession(connect, doctor, guide, async () => { throw new Error('wrong app'); });
  await owner.initialize();
  sessions[0].session.callTool.mockResolvedValue({ isError: true, content: [{ type: 'text', text: 'Accessibility permission is required.' }] });
  await expect(owner.invoke('click', {}, 30, turn('1'))).rejects.toMatchObject({ status: { reason: 'helperPauseFailed' } });
  expect(guide).not.toHaveBeenCalled(); await owner.close();
});

it('records a native permission failure before releasing a queued operation', async () => {
  const { owner, sessions, doctor } = fixture(); await owner.initialize();
  sessions[0].session.callTool.mockResolvedValue({ isError: true, content: [{ type: 'text', text: 'Accessibility permission is required.' }] });
  const results = await Promise.allSettled([owner.invoke('click', {}, 30, turn('a')), owner.invoke('type_text', {}, 30, turn('a'))]);
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
  expect(sessions[0].session.callTool).toHaveBeenCalledOnce(); expect(doctor).not.toHaveBeenCalled(); await owner.close();
});

it('does not retain a connection removed while discovering its tools', async () => {
  let finish!: (value: any) => void;
  const close = vi.fn().mockResolvedValue(undefined);
  const owner = new ManagedOcuSession(async () => ({ close, session: { listTools: () => new Promise(resolve => { finish = resolve; }) } }), async () => ({ state: 'granted' }));
  const opening = owner.initialize();
  await vi.waitFor(() => expect(finish).toBeTypeOf('function')); await owner.close();
  finish({ tools: [...OCU_TOOLS].map(name => ({ name, inputSchema: {} })) });
  await expect(opening).rejects.toThrow('removed'); expect(close).toHaveBeenCalledOnce();
});

it.each([false, true])('compares schema content across restarts instead of JSON key order (changed=%s)', async changed => {
  const { owner, connect, sessions, doctor } = fixture();
  const originalConnect = connect.getMockImplementation()!;
  let generation = 0;
  connect.mockImplementation(async () => {
    const connection = await originalConnect();
    const schema = generation++ === 0
      ? { type: 'object', properties: { app: { type: 'string', description: 'Target app' } }, required: ['app'] }
      : { required: ['app'], properties: { app: { description: 'Target app', type: changed ? 'integer' : 'string' } }, type: 'object' };
    connection.session.listTools.mockResolvedValue({ tools: [...OCU_TOOLS].map(name => ({ name, inputSchema: schema })) });
    return connection;
  });
  try {
    await owner.initialize();
    sessions[0].session.ping.mockRejectedValue(new Error('helper restarted after authorization'));
    const action = owner.invoke('get_app_state', { app: 'Notes' }, 30, turn('after-restart'));
    if (changed) {
      await expect(action).rejects.toBeInstanceOf(OcuBlocked);
      expect(sessions[1].close).toHaveBeenCalledOnce();
      expect(sessions[1].session.callTool).not.toHaveBeenCalled();
      expect(doctor).not.toHaveBeenCalled();
    } else {
      await expect(action).resolves.toEqual({ content: [] });
      expect(doctor).not.toHaveBeenCalled();
      expect(sessions[1].session.callTool).toHaveBeenCalledExactlyOnceWith('get_app_state', { app: 'Notes' }, 30);
    }
    expect(sessions[0].session.callTool).not.toHaveBeenCalled();
  } finally { await owner.close(); }
});

it('guides Screen Recording only when an image is explicitly required, without replaying the call', async () => {
  const { connect, sessions } = fixture();
  const probe = vi.fn().mockResolvedValueOnce({ state: 'missing', permission: 'screenRecording' })
    .mockResolvedValueOnce({ state: 'granted' });
  const stopped = vi.fn();
  const guide = vi.fn(async (status, _signal, check, canContinue) => {
    expect(status).toMatchObject({ permission: 'screenRecording' });
    expect(canContinue).toBe(false);
    expect(await check()).toMatchObject({ permission: 'screenRecording' });
    expect(await check()).toEqual({ state: 'granted' });
    return true;
  });
  const owner = new ManagedOcuSession(connect, probe, guide, stopped);
  await owner.initialize();
  sessions[0].session.callTool.mockResolvedValueOnce({ isError: true,
    content: [{ type: 'text', text: 'Screen Recording permission is required.' }] });
  await expect(owner.invoke('get_app_state', { app: 'Notion', require_screenshot: true }, 30, turn('screen')))
    .resolves.toMatchObject({ isError: true });
  expect(sessions.flatMap(s => s.session.callTool.mock.calls)).toEqual([
    ['get_app_state', { app: 'Notion', require_screenshot: true }, 30],
  ]);
  expect(probe.mock.calls.every(call => call[2] === true)).toBe(true);
  expect(guide).toHaveBeenCalledOnce();
  await expect(owner.invoke('get_app_state', { app: 'Notion', require_screenshot: true }, 30, turn('screen')))
    .rejects.toBeInstanceOf(OcuBlocked);
  await owner.close();
});

it('never resumes an already dispatched action after a permission error, even if the guide returns approval', async () => {
  const { connect, doctor, sessions } = fixture();
  const guide = vi.fn(async (_status, _signal, _check, canContinue) => { expect(canContinue).toBe(false); return true; });
  const owner = new ManagedOcuSession(connect, doctor, guide, async () => {});
  await owner.initialize();
  sessions[0].session.callTool.mockResolvedValue({ isError: true, content: [{ type: 'text', text: 'Accessibility permission is required.' }] });
  await owner.invoke('click', {}, 30, turn('1'));
  expect(sessions.flatMap(s => s.session.callTool.mock.calls)).toHaveLength(1);
  expect(connect).toHaveBeenCalledOnce(); await owner.close();
});

it('closes a pending guide on cancellation and never sends the target afterward', async () => {
  const { connect, doctor, sessions } = fixture();
  let shown = false;
  const owner = new ManagedOcuSession(connect, doctor, async (_status, signal) => new Promise<boolean>(resolve => {
    shown = true; signal!.addEventListener('abort', () => resolve(false), { once: true });
  }), async () => {});
  await owner.initialize();
  sessions[0].session.callTool.mockResolvedValueOnce({ isError: true,
    content: [{ type: 'text', text: 'Accessibility permission is required.' }] });
  const waiting = owner.invoke('click', {}, 30, turn('1'));
  await vi.waitFor(() => expect(shown).toBe(true)); await owner.close();
  await expect(waiting).resolves.toMatchObject({ isError: true });
  expect(sessions.flatMap(s => s.session.callTool.mock.calls)).toHaveLength(1);
});
