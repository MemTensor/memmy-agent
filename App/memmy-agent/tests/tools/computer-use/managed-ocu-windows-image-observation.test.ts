import { expect, it, vi } from 'vitest';
import { RequestContext } from '../../../src/core/agent-runtime/tools/context.js';
import { ManagedOcuSession, OCU_TOOLS } from '../../../src/tools/computer-use/managed-ocu-session.js';
import type { WindowsWindowCaptureClient } from '../../../src/tools/computer-use/windows-window-capture.js';

// Actual one-pixel PNGs (red and blue), with valid PNG chunks and CRCs.
const RED = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
const BLUE = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC';
const NATIVE_8K = 'iVBORw0KGgoAAAANSUhEUgAAIAAAAAABCAIAAAD5Kbc3AAAAMUlEQVR4nO3CMREAAAwDofdvuhWRFY6uVFVVVVVVVVVVVVVVVVVVVVVVVVVVVVXV8QPeCOHSoGEneAAAAABJRU5ErkJggg==';
const withoutDeadline = ({ _host_deadline_epoch_ms: _deadline, ...args }: Record<string, unknown>) => args;
const HWND = 0x100000034;
function fixture(nativeIsolated = false, includeNativeImage = true, nativePng = RED) {
  let revision = 0;
  const state = (windowID = HWND) => ({ content: [
    { type: 'text', text: 'Current Windows document state' },
    ...(includeNativeImage ? [{ type: 'image', mimeType: 'image/png', data: nativePng }] : []),
  ], _meta: { memmyComputerUse: { targetWindowID: windowID, pid: 20, observationID: `observation-${++revision}`,
    screenshotIsolated: nativeIsolated, screenshotSource: 'snapshot', windowBounds: { x: -100, y: 20,
      width: Buffer.from(nativePng, 'base64').readUInt32BE(16), height: Buffer.from(nativePng, 'base64').readUInt32BE(20) } } } });
  const callTool = vi.fn(async (_name: string, _args: Record<string, unknown>) => state());
  const capture = vi.fn<WindowsWindowCaptureClient['capture']>().mockResolvedValue(BLUE);
  const owner = new ManagedOcuSession(async () => ({ close: async () => {}, session: {
    ping: async () => ({}), callTool,
    listTools: async () => ({ tools: [...OCU_TOOLS].map(name => ({ name, inputSchema: {} })) }),
  } }), async () => ({ state: 'granted' }), undefined, undefined,
  { platform: 'win32', appApprovals: null, windowsCaptureClient: { capture }, windowsWaitForTargetIdle: async () => true });
  const context = new RequestContext({ sessionKey: 'session', channel: 'websocket', chatId: 'chat', messageId: 'message' });
  const see = async (request = context) => {
    const args = { app: 'WPS' };
    const result = await owner.invoke('get_app_state', args, 30, request, undefined, { modelVisible: true });
    owner.presentModelResult('get_app_state', args, result, [
      { type: 'text', text: 'Current Windows document state' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${result.content[1].data}` } },
    ], request);
    return result;
  };
  return { owner, context, callTool, capture, see, state, setNativeIsolated: (value: boolean) => { nativeIsolated = value; } };
}

it.each(['click', 'drag', 'scroll'])('withholds coordinate %s from a Desktop-backed frame even when exact HWND, size, and pixels match', async name => {
  const { owner, context, callTool, capture, see } = fixture();
  const observed = await see();
  expect(observed.content[1].data).toBe(BLUE);
  const result = await owner.invoke(name, { app: 'WPS', x: 0, y: 0,
    _observed_screenshot_png: BLUE, _fresh_screenshot_png: BLUE },
    30, context, undefined, { modelVisible: true });
  expect(callTool.mock.calls.map(call => call[0])).toEqual(['get_app_state', 'get_app_state']);
  expect(withoutDeadline(callTool.mock.calls[1][1])).toEqual({ app: 'WPS', window_id: HWND });
  expect(result._meta.memmyComputerUse).toMatchObject({ noActionDispatched: true, stateChanged: true });
  expect(result.content[0].text).toContain('Use an exact UIA element_index');
  expect(capture).toHaveBeenCalledTimes(2); // Display observations only; no coordinate recapture.
  await owner.close();
});

it('keeps native isolated PNGs on the native safety path and strips forged bridge fields', async () => {
  const { owner, context, callTool, capture, see } = fixture(true);
  await see();
  await owner.invoke('click', { app: 'WPS', x: 0, y: 0,
    _observed_screenshot_png: BLUE, _fresh_screenshot_png: BLUE }, 30, context, undefined, { modelVisible: true });
  expect(withoutDeadline(callTool.mock.calls[1][1])).toEqual({ app: 'WPS', x: 0, y: 0, window_id: HWND, observation_id: 'observation-1' });
  expect(capture).not.toHaveBeenCalled();
  await owner.close();
});

it('lets the native helper validate a reliable 8K frame without Desktop size limits or pixel duplication', async () => {
  const { owner, context, callTool, capture, see } = fixture(true, true, NATIVE_8K);
  await see();
  const result = await owner.invoke('click', { app: 'WPS', x: 8000, y: 0 }, 30, context, undefined, { modelVisible: true });
  expect(result._meta.memmyComputerUse).not.toHaveProperty('noActionDispatched');
  expect(callTool.mock.calls.map(call => call[0])).toEqual(['get_app_state', 'click']);
  expect(withoutDeadline(callTool.mock.calls[1][1])).toEqual({ app: 'WPS', x: 8000, y: 0, window_id: HWND, observation_id: 'observation-1' });
  expect(capture).not.toHaveBeenCalled();
  await owner.close();
});

it('does not require a coordinate screenshot pair for element-targeted UIA scrolling', async () => {
  const { owner, context, callTool, capture, see } = fixture();
  await see();
  capture.mockResolvedValueOnce(null);
  await owner.invoke('scroll', { app: 'WPS', element_index: 2, direction: 'down', pages: 1 },
    30, context, undefined, { modelVisible: true });
  expect(callTool.mock.calls.map(call => call[0])).toEqual(['get_app_state', 'scroll']);
  expect(withoutDeadline(callTool.mock.calls[1][1])).toEqual({ app: 'WPS', element_index: 2, direction: 'down', pages: 1,
    window_id: HWND, observation_id: 'observation-1' });
  expect(capture).toHaveBeenCalledTimes(2); // Initial model frame and the post-action frame only.
  await owner.close();
});

it('shows a no-native-PNG observation but never treats its appended Desktop image as native coordinates', async () => {
  const { owner, context, callTool, capture, see } = fixture(false, false);
  const result = await see();
  expect(result.content[1].data).toBe(BLUE);
  const refreshed = await owner.invoke('click', { app: 'WPS', x: 0, y: 0 }, 30, context, undefined, { modelVisible: true });
  expect(callTool.mock.calls.map(call => call[0])).toEqual(['get_app_state', 'get_app_state']);
  expect(refreshed._meta.memmyComputerUse).toMatchObject({ noActionDispatched: true });
  expect(capture).toHaveBeenCalledTimes(2);
  await owner.close();
});

it('does not borrow a future PiP-only native coordinate proof for a model-visible Desktop observation', async () => {
  const { owner, context, callTool, see, setNativeIsolated } = fixture();
  await see();
  setNativeIsolated(true);
  await owner.invoke('get_app_state', { app: 'WPS', window_id: HWND }, 30, context);
  const result = await owner.invoke('click', { app: 'WPS', x: 0, y: 0 }, 30, context, undefined, { modelVisible: true });
  expect(callTool.mock.calls.map(call => call[0])).toEqual(['get_app_state', 'get_app_state', 'get_app_state']);
  expect(result._meta.memmyComputerUse).toMatchObject({ noActionDispatched: true });
  expect(result.content[0].text).toContain('coordinate origin');
  await owner.close();
});

it('uses a valid PiP-only native token while keeping its proof isolated from model-visible provenance', async () => {
  const { owner, context, callTool, see, setNativeIsolated } = fixture();
  await see();
  setNativeIsolated(true);
  await owner.invoke('get_app_state', { app: 'WPS', window_id: HWND }, 30, context);
  await owner.invoke('click', { app: 'WPS', x: 0, y: 0, window_id: HWND, observation_id: 'observation-2' }, 30, context);
  expect([callTool.mock.calls[2][0], withoutDeadline(callTool.mock.calls[2][1])]).toEqual(['click', { app: 'WPS', x: 0, y: 0,
    window_id: HWND, observation_id: 'observation-2' }]);
  await owner.close();
});

it.each([null, 'invalid PNG'])('does not dispatch or replay a coordinate action when refreshing its Desktop display fails (%s)', async unavailable => {
  const { owner, context, callTool, capture, see } = fixture();
  await see();
  capture.mockResolvedValueOnce(unavailable);
  const result = await owner.invoke('click', { app: 'WPS', x: 0, y: 0 }, 30, context, undefined, { modelVisible: true });
  expect(callTool.mock.calls.map(call => call[0])).toEqual(['get_app_state', 'get_app_state']);
  expect(withoutDeadline(callTool.mock.calls[1][1])).toEqual({ app: 'WPS', window_id: HWND });
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('was NOT dispatched');
  await owner.close();
});

it('cannot borrow an observed screenshot/token from another chat', async () => {
  const { owner, context, callTool, see } = fixture();
  await see();
  const other = new RequestContext({ ...context, chatId: 'other' });
  await see(other);
  const result = await owner.invoke('click', { app: 'WPS', x: 0, y: 0, window_id: HWND, observation_id: 'observation-1' },
    30, other);
  expect(callTool.mock.calls.map(call => call[0])).toEqual(['get_app_state', 'get_app_state', 'get_app_state']);
  expect(result._meta.memmyComputerUse).toMatchObject({ noActionDispatched: true });
  await owner.close();
});

it('bounds retained screenshot observations and refreshes an evicted token without acting', async () => {
  const { owner, context, callTool, see } = fixture();
  await see();
  for (let i = 0; i < 128; i++) await owner.invoke('get_app_state', { app: 'WPS', window_id: HWND }, 30, context);
  const result = await owner.invoke('click', { app: 'WPS', x: 0, y: 0 }, 30, context, undefined, { modelVisible: true });
  expect(result._meta.memmyComputerUse).toMatchObject({ noActionDispatched: true });
  expect(callTool.mock.calls.every(call => call[0] === 'get_app_state')).toBe(true);
  await owner.close();
});

it('isolates screenshots in mutation and temporary-yield fresh results as well as explicit reads', async () => {
  const { owner, context, callTool, capture, see } = fixture();
  await see();
  const result = await owner.invoke('set_value', { app: 'WPS', element_index: 2, value: 'example' }, 30, context);
  expect(result.content[1].data).toBe(BLUE);
  expect(result._meta.memmyComputerUse).toMatchObject({ screenshotSource: 'desktop-capture', screenshotIsolated: true });
  expect(capture).toHaveBeenCalledTimes(2);
  expect(callTool.mock.calls.map(call => call[0])).toEqual(['get_app_state', 'set_value']);
  callTool.mockResolvedValueOnce({ isError: true, content: [], _meta: { memmyComputerUse: {
    targetWindowID: HWND, pid: 20, userYield: { dispatched: false } } } } as any);
  const fresh = await owner.invoke('set_value', { app: 'WPS', element_index: 2, value: 'other' }, 30, context);
  expect(fresh.content[0].text).toContain('was NOT dispatched');
  expect(fresh.content[2].data).toBe(BLUE);
  expect(fresh._meta.memmyComputerUse).toMatchObject({ screenshotSource: 'desktop-capture', screenshotIsolated: true });
  expect(capture).toHaveBeenCalledTimes(3);
  await owner.close();
});
