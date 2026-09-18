import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { bindScreenCaptureIpc, createDesktopScreenCapture } from '../src/main/desktop-screen-capture.js';
function fixture() {
  const image = { isEmpty: () => false, getSize: () => ({ width: 100, height: 80 }), toPNG: () => Buffer.from('png'), resize: vi.fn() };
  const deps = { getStatus: vi.fn(() => 'granted'), getSources: vi.fn(async () => [{ display_id: '7', thumbnail: image }]), getDisplays: () => [{ id: 7, bounds: { x: 0, y: 0, width: 100, height: 80 } }], getPrimaryDisplay: () => ({ id: 7, bounds: { x: 0, y: 0, width: 100, height: 80 } }), openSettings: vi.fn(async () => undefined) };
  return { deps, image, capture: createDesktopScreenCapture(deps) };
}
describe('passive desktop capture', () => {
  it('reads only screen sources; no windows, icons, audio or preview', async () => {
    const { capture, deps } = fixture();
    expect(await capture()).toMatchObject({ ok: true, displayId: '7', width: 100, height: 80 });
    expect(deps.getSources).toHaveBeenCalledWith({ types: ['screen'], thumbnailSize: { width: 1280, height: 1280 }, fetchWindowIcons: false });
    expect(deps.openSettings).not.toHaveBeenCalled();
  });
  it('requests first permission once and discards the onboarding capture', async () => {
    const { capture, deps } = fixture(); deps.getStatus.mockReturnValue('not-determined');
    expect(await capture()).toMatchObject({ ok: false, code: 'permission_required' });
    expect(await capture()).toMatchObject({ ok: false, code: 'permission_required' });
    expect(deps.getSources).toHaveBeenCalledOnce(); expect(deps.openSettings).not.toHaveBeenCalled();
    deps.getStatus.mockReturnValue('granted'); expect(await capture()).toMatchObject({ ok: true });
  });
  it('opens Settings once per denied period, without requesting AX access', async () => {
    const { capture, deps } = fixture(); deps.getStatus.mockReturnValue('denied');
    await capture(); await capture(); expect(deps.openSettings).toHaveBeenCalledOnce(); expect(deps.getSources).not.toHaveBeenCalled();
    deps.getStatus.mockReturnValue('granted'); await capture(); deps.getStatus.mockReturnValue('denied'); await capture(); expect(deps.openSettings).toHaveBeenCalledTimes(2);
  });
  it.each(['unknown', 'restricted'])('blocks %s permission without a screenshot or prompt', async status => {
    const { capture, deps } = fixture(); deps.getStatus.mockReturnValue(status);
    expect(await capture()).toMatchObject({ ok: false, code: 'unavailable' }); expect(deps.getSources).not.toHaveBeenCalled(); expect(deps.openSettings).not.toHaveBeenCalled();
  });
  it('never substitutes another display or accepts an empty image', async () => {
    const { capture, image, deps } = fixture();
    expect(await capture('999')).toMatchObject({ ok: false }); expect(deps.getSources).not.toHaveBeenCalled();
    image.isEmpty = () => true; expect(await capture('7')).toMatchObject({ ok: false });
  });
  it('discards an image if permission is revoked during capture', async () => {
    const { capture, deps } = fixture(); deps.getStatus.mockReturnValueOnce('granted').mockReturnValue('denied');
    expect(await capture()).toMatchObject({ ok: false, code: 'permission_required' });
  });
  it('shrinks oversized output before crossing IPC', async () => {
    const { capture, image } = fixture();
    image.toPNG = () => Buffer.alloc(950 * 1024);
    image.resize.mockReturnValue({ isEmpty: () => false, getSize: () => ({ width: 75, height: 60 }), toPNG: () => Buffer.from('small'), resize: vi.fn() });
    expect(await capture()).toMatchObject({ ok: true, width: 75, height: 60 }); expect(image.resize).toHaveBeenCalledOnce();
  });
});

function child() { return Object.assign(new EventEmitter(), { connected: true, send: vi.fn((_message: any, cb: any) => cb?.(null)) }); }
it('private IPC only handles its protocol and discards responses from an old generation', async () => {
  const process = child(); let live = true; let finish!: (value: any) => void;
  const handler = vi.fn(() => new Promise<any>(resolve => { finish = resolve; }));
  const dispose = bindScreenCaptureIpc(process as any, () => live, handler);
  process.emit('message', { type: 'memmy-agent:restart' }); expect(handler).not.toHaveBeenCalled();
  process.emit('message', { type: 'memmy:screen-capture:capabilities', requestId: 'hello', version: 1 });
  expect(process.send).toHaveBeenLastCalledWith(expect.objectContaining({ available: true }), expect.any(Function));
  process.emit('message', { type: 'memmy:screen-capture:request', requestId: 'one', displayId: '7' });
  await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
  live = false; finish({ ok: false, code: 'cancelled', message: 'stale' });
  await Promise.resolve(); await Promise.resolve(); expect(process.send).toHaveBeenCalledTimes(1);
  dispose(); expect(process.listenerCount('message')).toBe(0);
});
it('cancellation and child disconnect release pending jobs without sending images', async () => {
  const process = child(); const signals: AbortSignal[] = [];
  const handler = vi.fn((_id, signal) => { signals.push(signal); return new Promise<any>(() => {}); });
  const dispose = bindScreenCaptureIpc(process as any, () => true, handler);
  process.emit('message', { type: 'memmy:screen-capture:request', requestId: 'one' });
  await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
  process.emit('message', { type: 'memmy:screen-capture:cancel', requestId: 'one' }); expect(signals[0].aborted).toBe(true);
  process.emit('message', { type: 'memmy:screen-capture:request', requestId: 'two' });
  await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
  process.emit('disconnect'); expect(signals[1].aborted).toBe(true); expect(process.send).not.toHaveBeenCalled(); dispose();
});
