import { expect, it, vi } from 'vitest';
import { OcuUserIntervened, OcuUserYielded, tookOverTargetDuringAction, withMacFocusGuard, type FocusSnapshot } from '../../../src/tools/computer-use/mac-focus-guard.js';

const snapshot = (name: string, pid: number, inputIdle: number): FocusSnapshot => ({
  name, pid, bundleId: name === 'Notes' ? 'com.apple.Notes' : 'com.example.Editor', inputIdle,
});

it('keeps another app in front while Computer Use acts in the background', async () => {
  const invoke = vi.fn(async () => 'done');
  const restore = vi.fn(async () => true);
  const read = vi.fn().mockResolvedValueOnce(snapshot('Editor', 10, 10))
    .mockResolvedValueOnce(snapshot('Editor', 10, 10.1));
  await expect(withMacFocusGuard('Notes', 'click', invoke, { snapshot: read, restore })).resolves.toBe('done');
  expect(restore).not.toHaveBeenCalled();
});

it('restores the previous app when an Agent action unexpectedly focuses its target', async () => {
  const restore = vi.fn(async () => true);
  const read = vi.fn().mockResolvedValueOnce(snapshot('Editor', 10, 10))
    .mockResolvedValueOnce(snapshot('Notes', 20, 10.1));
  await withMacFocusGuard('Notes', 'click', async () => 'done', { snapshot: read, restore });
  expect(restore).toHaveBeenCalledWith(10, 20);
});

it('restores the previous app even when a native action fails after changing focus', async () => {
  const restore = vi.fn(async () => true);
  const read = vi.fn().mockResolvedValueOnce(snapshot('Editor', 10, 10))
    .mockResolvedValueOnce(snapshot('Notes', 20, 10.1));
  const failure = new Error('native action failed');
  await expect(withMacFocusGuard('Notes', 'click', async () => { throw failure; },
    { snapshot: read, restore })).rejects.toBe(failure);
  expect(restore).toHaveBeenCalledWith(10, 20);
});

it('stops on user takeover and never replays an action', async () => {
  const invoke = vi.fn(async () => 'done');
  const read = vi.fn().mockResolvedValueOnce(snapshot('Editor', 10, 10))
    .mockResolvedValueOnce(snapshot('Notes', 20, 0));
  await expect(withMacFocusGuard('Notes', 'click', invoke, { snapshot: read, restore: vi.fn() }))
    .rejects.toBeInstanceOf(OcuUserIntervened);
  expect(invoke).toHaveBeenCalledOnce();
});

it('does not send an action while the user is actively using its target app', async () => {
  const invoke = vi.fn();
  await expect(withMacFocusGuard('Notes', 'type_text', invoke, {
    snapshot: async () => snapshot('Notes', 20, 0.1), restore: vi.fn(),
  })).rejects.toBeInstanceOf(OcuUserIntervened);
  expect(invoke).not.toHaveBeenCalled();
});

it('yields when physical input starts during an action in the already foreground target', async () => {
  const invoke = vi.fn(async () => 'done');
  const restore = vi.fn(async () => true);
  const read = vi.fn().mockResolvedValueOnce(snapshot('Notes', 20, 10))
    .mockResolvedValueOnce(snapshot('Notes', 20, 0.05));
  await expect(withMacFocusGuard('Notes', 'click', invoke, { snapshot: read, restore }))
    .rejects.toBeInstanceOf(OcuUserIntervened);
  expect(invoke).toHaveBeenCalledOnce();
  expect(restore).not.toHaveBeenCalled();
  expect(tookOverTargetDuringAction(snapshot('Notes', 20, 2), snapshot('Notes', 20, 0.05), 'Notes', 1)).toBe(true);
});

it('allows the Agent to continue in the foreground app after the user stops interacting', async () => {
  const invoke = vi.fn(async () => 'done');
  const restore = vi.fn(async () => true);
  const read = vi.fn().mockResolvedValueOnce(snapshot('Notes', 20, 6))
    .mockResolvedValueOnce(snapshot('Notes', 20, 6.1));
  await expect(withMacFocusGuard('Notes', 'click', invoke, { snapshot: read, restore }))
    .resolves.toBe('done');
  expect(invoke).toHaveBeenCalledOnce();
  expect(restore).not.toHaveBeenCalled();
});

it('allows an idle shared browser to remain in front while the Agent acts', async () => {
  const invoke = vi.fn(async () => 'done');
  const restore = vi.fn();
  const read = vi.fn().mockResolvedValueOnce({ pid: 30, name: 'Google Chrome for Testing',
    bundleId: 'com.google.chrome.for.testing', inputIdle: 20 })
    .mockResolvedValueOnce({ pid: 30, name: 'Google Chrome for Testing',
      bundleId: 'com.google.chrome.for.testing', inputIdle: 20.1 });
  await expect(withMacFocusGuard('com.google.chrome.for.testing', 'browser_click', invoke,
    { snapshot: read, restore })).resolves.toBe('done');
  expect(invoke).toHaveBeenCalledOnce();
  expect(restore).not.toHaveBeenCalled();
});

it('pauses the shared browser before acting after recent physical input', async () => {
  const invoke = vi.fn();
  await expect(withMacFocusGuard('com.google.chrome.for.testing', 'browser_click', invoke, {
    snapshot: async () => ({ pid: 30, name: 'Google Chrome for Testing',
      bundleId: 'com.google.chrome.for.testing', inputIdle: 0.1 }), restore: vi.fn(),
  })).rejects.toBeInstanceOf(OcuUserIntervened);
  expect(invoke).not.toHaveBeenCalled();
});

it('distinguishes a different foreground window of the same app when the action is window bound', async () => {
  const invoke = vi.fn(async () => 'done');
  const restore = vi.fn(async () => true);
  const read = vi.fn().mockResolvedValue({ ...snapshot('Notes', 20, 0), windowId: 51 });
  await expect(withMacFocusGuard('Notes', 'click', invoke, { snapshot: read, restore },
    { targetWindowId: 52, yieldOnUserInput: true })).resolves.toBe('done');
  expect(invoke).toHaveBeenCalledOnce();
  expect(restore).not.toHaveBeenCalled();
});

it('waits for same-window physical input to stop, then requests a new observation without sending stale coordinates', async () => {
  const invoke = vi.fn();
  const restore = vi.fn();
  const read = vi.fn().mockResolvedValueOnce({ ...snapshot('Notes', 20, 0.1), windowId: 52 })
    .mockResolvedValueOnce({ ...snapshot('Notes', 20, 5.1), windowId: 52 });
  await expect(withMacFocusGuard('Notes', 'click', invoke, { snapshot: read, restore },
    { targetWindowId: 52, yieldOnUserInput: true })).rejects.toMatchObject({ dispatched: false, timedOut: false });
  expect(invoke).not.toHaveBeenCalled();
  expect(restore).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledTimes(2);
});

it('releases a temporary yield as soon as the user moves to another window', async () => {
  const invoke = vi.fn();
  const read = vi.fn().mockResolvedValueOnce({ ...snapshot('Notes', 20, 0), windowId: 52 })
    .mockResolvedValueOnce({ ...snapshot('Notes', 20, 0), windowId: 51 });
  await expect(withMacFocusGuard('Notes', 'click', invoke, { snapshot: read, restore: vi.fn() },
    { targetWindowId: 52, yieldOnUserInput: true })).rejects.toBeInstanceOf(OcuUserYielded);
  expect(invoke).not.toHaveBeenCalled();
});

it('does not treat unresolved foreground window identity as proof of a different window', async () => {
  const invoke = vi.fn();
  const read = vi.fn().mockResolvedValue(snapshot('Notes', 20, 0));
  await expect(withMacFocusGuard('Notes', 'set_value', invoke, { snapshot: read, restore: vi.fn() },
    { targetWindowId: 52, yieldOnUserInput: true, maxWaitMs: 0 }))
    .rejects.toMatchObject({ dispatched: false, timedOut: true });
  expect(invoke).not.toHaveBeenCalled();
});

it('cancels a temporary yield promptly without sending or restoring any input', async () => {
  const controller = new AbortController();
  const invoke = vi.fn();
  const restore = vi.fn();
  const read = vi.fn().mockResolvedValue(snapshot('Notes', 20, 0));
  const pending = withMacFocusGuard('Notes', 'type_text', invoke, { snapshot: read, restore },
    { yieldOnUserInput: true, signal: controller.signal });
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  controller.abort();
  await rejected;
  expect(invoke).not.toHaveBeenCalled();
  expect(restore).not.toHaveBeenCalled();
});

it('marks an action already dispatched during takeover and never repeats it after the user leaves', async () => {
  const invoke = vi.fn(async () => 'done');
  const restore = vi.fn();
  const read = vi.fn().mockResolvedValueOnce(snapshot('Editor', 10, 10))
    .mockResolvedValueOnce(snapshot('Notes', 20, 0))
    .mockResolvedValueOnce(snapshot('Editor', 10, 0));
  await expect(withMacFocusGuard('Notes', 'click', invoke, { snapshot: read, restore },
    { yieldOnUserInput: true })).rejects.toMatchObject({ dispatched: true, timedOut: false });
  expect(invoke).toHaveBeenCalledOnce();
  expect(restore).not.toHaveBeenCalled();
});

it('restores the exact prior document when background input unexpectedly focuses another window of the same app', async () => {
  const restore = vi.fn(async () => true);
  const read = vi.fn().mockResolvedValueOnce({ ...snapshot('Notes', 20, 10), windowId: 51 })
    .mockResolvedValueOnce({ ...snapshot('Notes', 20, 10.1), windowId: 52 });
  await expect(withMacFocusGuard('Notes', 'click', async () => 'done', { snapshot: read, restore },
    { targetWindowId: 52 })).resolves.toBe('done');
  expect(restore).toHaveBeenCalledWith(20, 20, 51, 52);
});

it('keeps a click during focus cleanup recoverable and preserves the user choice', async () => {
  const invoke = vi.fn(async () => 'done');
  const restore = vi.fn(async () => false);
  const read = vi.fn().mockResolvedValueOnce(snapshot('Editor', 10, 10))
    .mockResolvedValueOnce(snapshot('Notes', 20, 10.1))
    .mockResolvedValueOnce(snapshot('Editor', 10, 0));
  await expect(withMacFocusGuard('Notes', 'click', invoke, { snapshot: read, restore },
    { yieldOnUserInput: true })).rejects.toMatchObject({ dispatched: true, timedOut: false });
  expect(invoke).toHaveBeenCalledOnce();
  expect(restore).toHaveBeenCalledOnce();
});

it('waits out the five-second physical-input debounce before requesting fresh state', async () => {
  const invoke = vi.fn();
  const read = vi.fn().mockResolvedValueOnce(snapshot('Notes', 20, 4))
    .mockResolvedValueOnce(snapshot('Notes', 20, 5.1));
  await expect(withMacFocusGuard('Notes', 'click', invoke,
    { snapshot: read, restore: vi.fn() }, { yieldOnUserInput: true }))
    .rejects.toMatchObject({ dispatched: false, timedOut: false });
  expect(invoke).not.toHaveBeenCalled();
});
