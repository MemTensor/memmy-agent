import { describe, expect, it, vi } from 'vitest';
import { ManagedOcuSession, OCU_TOOLS, OcuBlocked, OcuUncertain } from '../../../src/tools/computer-use/managed-ocu-session.js';
import { RequestContext } from '../../../src/core/agent-runtime/tools/context.js';
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
describe('original npm OCU connection owner', () => {
  it('discovers tools and lists apps without invoking doctor', async () => {
    const { owner, doctor } = fixture();
    await owner.initialize(); await owner.listTools();
    await owner.invoke('list_apps', {}, 30, null);
    expect(doctor).not.toHaveBeenCalled(); await owner.close();
  });
  it('blocks the target and same message; reopens only for a new message', async () => {
    const { owner, sessions, doctor, connect } = fixture();
    doctor.mockResolvedValueOnce({ state: 'missing', permission: 'accessibility' });
    await expect(owner.invoke('get_app_state', { app: 'WeChat' }, 30, turn('1'))).rejects.toBeInstanceOf(OcuBlocked);
    await expect(owner.invoke('click', {}, 30, turn('1'))).rejects.toBeInstanceOf(OcuBlocked);
    expect(sessions[0].session.callTool).not.toHaveBeenCalled(); expect(connect).toHaveBeenCalledTimes(1);
    await owner.invoke('get_app_state', { app: 'WeChat' }, 30, turn('2'));
    expect(connect).toHaveBeenCalledTimes(2); expect(sessions[0].close).toHaveBeenCalledOnce(); expect(doctor).toHaveBeenCalledTimes(2);
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
    expect(connect).toHaveBeenCalledTimes(3); expect(doctor).toHaveBeenCalledTimes(3); await owner.close();
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
  it('fails closed on unsupported native tools and unknown checks', async () => {
    const { owner, doctor, sessions } = fixture(); doctor.mockResolvedValue({ state: 'unknown' });
    await expect(owner.invoke('get_screen_state', {}, 30, turn('1'))).rejects.toBeInstanceOf(OcuBlocked);
    await expect(owner.invoke('click', {}, 30, turn('2'))).rejects.toBeInstanceOf(OcuBlocked);
    expect(sessions[0].session.callTool).not.toHaveBeenCalled(); await owner.close();
  });
});

it('coalesces concurrent denied messages rather than reopening onboarding per task', async () => {
  const { owner, doctor } = fixture(); doctor.mockResolvedValue({ state: 'missing', permission: 'accessibility' });
  const results = await Promise.allSettled([owner.invoke('click', {}, 30, turn('a')), owner.invoke('click', {}, 30, turn('b'))]);
  expect(results.every(result => result.status === 'rejected')).toBe(true);
  expect(doctor).toHaveBeenCalledOnce(); await owner.close();
});

it('records a native permission failure before releasing a queued operation', async () => {
  const { owner, sessions, doctor } = fixture(); await owner.initialize();
  sessions[0].session.callTool.mockResolvedValue({ isError: true, content: [{ type: 'text', text: 'Accessibility permission is required.' }] });
  const results = await Promise.allSettled([owner.invoke('click', {}, 30, turn('a')), owner.invoke('type_text', {}, 30, turn('b'))]);
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
  expect(sessions[0].session.callTool).toHaveBeenCalledOnce(); expect(doctor).toHaveBeenCalledOnce(); await owner.close();
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

it('rechecks permissions after a helper restart during doctor, before sending the target', async () => {
  const { owner, sessions, doctor, connect } = fixture(); await owner.initialize();
  doctor.mockImplementationOnce(async () => { sessions[0].session.ping.mockRejectedValue(new Error('helper quit')); return { state: 'granted' }; });
  await owner.invoke('get_app_state', { app: 'WeChat' }, 30, turn('a'));
  expect(connect).toHaveBeenCalledTimes(2); expect(doctor).toHaveBeenCalledTimes(2);
  expect(sessions[0].session.callTool).not.toHaveBeenCalled(); expect(sessions[1].session.callTool).toHaveBeenCalledOnce(); await owner.close();
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
      expect(doctor).toHaveBeenCalledOnce();
      expect(sessions[1].session.callTool).toHaveBeenCalledExactlyOnceWith('get_app_state', { app: 'Notes' }, 30);
    }
    expect(sessions[0].session.callTool).not.toHaveBeenCalled();
  } finally { await owner.close(); }
});
