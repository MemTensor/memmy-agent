import { describe, expect, it } from 'vitest';
import { externalBrowserExtensionManagerCommand } from '../src/main/external-browser-extension-install.js';

describe('browser extension installation preparation', () => {
  it('opens only the selected browser extension page on macOS', () => {
    expect(externalBrowserExtensionManagerCommand('chrome', 'darwin')).toEqual({
      executable: '/usr/bin/open', args: ['-a', 'Google Chrome', 'chrome://extensions'], waitForExit: true,
    });
    expect(externalBrowserExtensionManagerCommand('edge', 'darwin')).toEqual({
      executable: '/usr/bin/open', args: ['-a', 'Microsoft Edge', 'edge://extensions'], waitForExit: true,
    });
  });

  it('finds the installed Windows executable without using a shell command', () => {
    const env = { PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)' };
    const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    expect(externalBrowserExtensionManagerCommand('chrome', 'win32', env, candidate => candidate === chrome)).toEqual({
      executable: chrome, args: ['chrome://extensions'], waitForExit: false,
    });
    expect(externalBrowserExtensionManagerCommand('edge', 'win32', env, candidate => candidate === edge)).toEqual({
      executable: edge, args: ['edge://extensions'], waitForExit: false,
    });
  });

  it('falls back when the browser is not installed or the platform is unsupported', () => {
    expect(externalBrowserExtensionManagerCommand('chrome', 'win32', { PROGRAMFILES: 'C:\\Program Files' }, () => false)).toBeNull();
    expect(externalBrowserExtensionManagerCommand('edge', 'linux')).toBeNull();
  });
});
