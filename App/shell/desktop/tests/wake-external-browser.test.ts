import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { wakeExternalBrowser, wakeExternalBrowserCommand } from '../src/main/wake-external-browser.js';

describe('requested browser connection recovery', () => {
  it.each(['chrome', 'edge'] as const)('wakes %s on macOS without selecting a page or changing a profile', browser => {
    expect(wakeExternalBrowserCommand(browser, 'darwin')).toEqual({ executable: '/usr/bin/open',
      args: ['-a', browser === 'chrome' ? 'Google Chrome' : 'Microsoft Edge'], waitForExit: true });
  });

  it.each(['chrome', 'edge'] as const)('wakes %s on Windows from its installed binary without a shell or URL', browser => {
    const binary = browser === 'chrome' ? 'chrome.exe' : 'msedge.exe';
    const executable = `C:\\Users\\Fixture\\AppData\\Local\\${browser === 'chrome' ? 'Google\\Chrome' : 'Microsoft\\Edge'}\\Application\\${binary}`;
    expect(wakeExternalBrowserCommand(browser, 'win32', { LOCALAPPDATA: 'C:\\Users\\Fixture\\AppData\\Local' }, p => p === executable))
      .toEqual({ executable, args: [], waitForExit: false });
  });

  it('returns unavailable for unsupported platforms or a missing Windows binary', async () => {
    const launch = vi.fn();
    expect(await wakeExternalBrowser('chrome', { platform: 'linux', launch: launch as typeof spawn })).toBe('unavailable');
    expect(await wakeExternalBrowser('edge', { platform: 'win32', env: {}, launch: launch as typeof spawn })).toBe('unavailable');
    expect(launch).not.toHaveBeenCalled();
  });

  it('waits for the macOS open result and bounds an unresponsive launcher', async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter();
      const launch = vi.fn(() => child) as unknown as typeof spawn;
      const first = wakeExternalBrowser('chrome', { platform: 'darwin', launch });
      child.emit('close', 1);
      await expect(first).resolves.toBe('failed');
      const timeout = wakeExternalBrowser('chrome', { platform: 'darwin', launch });
      await vi.advanceTimersByTimeAsync(8_000);
      await expect(timeout).resolves.toBe('failed');
      const success = wakeExternalBrowser('edge', { platform: 'darwin', launch });
      child.emit('close', 0);
      await expect(success).resolves.toBe('woken');
    } finally { vi.useRealTimers(); }
  });

  it('treats Windows spawn as a wake request rather than a connected extension', async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    const launch = vi.fn(() => child) as unknown as typeof spawn;
    const result = wakeExternalBrowser('chrome', { platform: 'win32', env: { PROGRAMFILES: 'C:\\Program Files' },
      fileExists: () => true, launch });
    child.emit('spawn');
    await expect(result).resolves.toBe('woken');
    expect(child.unref).toHaveBeenCalledOnce();
  });
});
