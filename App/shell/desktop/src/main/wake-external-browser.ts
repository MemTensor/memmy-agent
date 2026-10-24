import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { externalBrowserExtensionManagerCommand, type ExternalBrowserName } from './external-browser-extension-install.js';

export function wakeExternalBrowserCommand(browser: ExternalBrowserName, platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env, fileExists: (path: string) => boolean = existsSync) {
  const installed = externalBrowserExtensionManagerCommand(browser, platform, env, fileExists);
  if (!installed) return null;
  // Opening the application revives a dormant browser profile. No page URL,
  // profile flag, extension reload, or developer-mode change is requested.
  return { ...installed, args: platform === 'darwin' ? installed.args.slice(0, 2) : [] };
}

/** User-requested recovery of an installed extension whose browser has no live handshake. */
export async function wakeExternalBrowser(browser: ExternalBrowserName, {
  platform = process.platform, env = process.env, fileExists = existsSync, launch = spawn,
}: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; fileExists?: (path: string) => boolean;
  launch?: typeof spawn } = {}): Promise<'woken' | 'unavailable' | 'failed'> {
  if (browser !== 'chrome' && browser !== 'edge') return 'unavailable';
  const command = wakeExternalBrowserCommand(browser, platform, env, fileExists);
  if (!command) return 'unavailable';
  return new Promise(resolve => {
    let settled = false;
    const finish = (result: 'woken' | 'failed') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish('failed'), 8_000);
    try {
      const child = launch(command.executable, command.args, { stdio: 'ignore', windowsHide: true,
        detached: !command.waitForExit });
      child.once('error', () => finish('failed'));
      if (command.waitForExit) child.once('close', code => finish(code === 0 ? 'woken' : 'failed'));
      else child.once('spawn', () => { child.unref(); finish('woken'); });
    } catch { finish('failed'); }
  });
}
