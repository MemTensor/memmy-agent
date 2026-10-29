import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { revealNativeWindow } from '../../../src/tools/computer-use/mac-focus-guard.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.mocked(execFile).mockClear(); });

it('does not launch a Mac window reveal when its surface closes while resolving the helper', async () => {
  vi.spyOn(fs, 'existsSync').mockReturnValue(true);
  const controller = new AbortController();
  const revealing = revealNativeWindow(20, 52, controller.signal);
  controller.abort();
  await expect(revealing).rejects.toMatchObject({ name: 'AbortError' });
  expect(execFile).not.toHaveBeenCalled();
});

it('does not resolve or launch a helper for an already ended Mac surface', async () => {
  const exists = vi.spyOn(fs, 'existsSync');
  const controller = new AbortController();
  controller.abort();
  await expect(revealNativeWindow(20, 52, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(exists).not.toHaveBeenCalled();
  expect(execFile).not.toHaveBeenCalled();
});
