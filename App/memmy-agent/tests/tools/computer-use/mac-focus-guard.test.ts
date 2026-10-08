import { expect, it, vi } from 'vitest';
import { OcuUserIntervened, tookOverTargetDuringAction, withMacFocusGuard, type FocusSnapshot } from '../../../src/tools/computer-use/mac-focus-guard.js';

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

it('keeps acting when the target was already in front and input arrives during the action', async () => {
  const invoke = vi.fn(async () => 'done');
  const restore = vi.fn(async () => true);
  const read = vi.fn().mockResolvedValueOnce(snapshot('Notes', 20, 2))
    .mockResolvedValueOnce(snapshot('Notes', 20, 0.05));
  await expect(withMacFocusGuard('Notes', 'click', invoke, { snapshot: read, restore }))
    .resolves.toBe('done');
  expect(invoke).toHaveBeenCalledOnce();
  expect(restore).not.toHaveBeenCalled();
  expect(tookOverTargetDuringAction(snapshot('Notes', 20, 2), snapshot('Notes', 20, 0.05), 'Notes', 1)).toBe(false);
});

it('allows the Agent to continue in the foreground app after the user stops interacting', async () => {
  const invoke = vi.fn(async () => 'done');
  const restore = vi.fn(async () => true);
  const read = vi.fn().mockResolvedValueOnce(snapshot('Notes', 20, 2))
    .mockResolvedValueOnce(snapshot('Notes', 20, 2.1));
  await expect(withMacFocusGuard('Notes', 'click', invoke, { snapshot: read, restore }))
    .resolves.toBe('done');
  expect(invoke).toHaveBeenCalledOnce();
  expect(restore).not.toHaveBeenCalled();
});

it('does not mutate the shared browser while the user has its window in front', async () => {
  const invoke = vi.fn();
  await expect(withMacFocusGuard('com.google.chrome.for.testing', 'browser_click', invoke, {
    snapshot: async () => ({ pid: 30, name: 'Google Chrome for Testing',
      bundleId: 'com.google.chrome.for.testing', inputIdle: 20 }), restore: vi.fn(),
  }, { blockWhenTargetForeground: true })).rejects.toBeInstanceOf(OcuUserIntervened);
  expect(invoke).not.toHaveBeenCalled();
});
