import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

export type ExternalBrowserName = 'chrome' | 'edge';
export type ExternalBrowserInstallPreparation = {
  status: 'browser-opened' | 'browser-not-found' | 'browser-launch-failed' | 'extension-missing'
    | 'managed-installed' | 'managed-install-failed';
  directory: string | null;
};

type LaunchCommand = { executable: string; args: string[]; waitForExit: boolean };

/** Opens only the browser's own extensions page; it never changes a browser profile or policy. */
export function externalBrowserExtensionManagerCommand(
  browser: ExternalBrowserName,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv = process.env,
  fileExists: (path: string) => boolean = existsSync,
): LaunchCommand | null {
  const url = browser === 'chrome' ? 'chrome://extensions' : 'edge://extensions';
  if (platform === 'darwin') {
    return { executable: '/usr/bin/open', args: ['-a', browser === 'chrome' ? 'Google Chrome' : 'Microsoft Edge', url], waitForExit: true };
  }
  if (platform !== 'win32') return null;

  const product = browser === 'chrome' ? ['Google', 'Chrome'] : ['Microsoft', 'Edge'];
  const binary = browser === 'chrome' ? 'chrome.exe' : 'msedge.exe';
  const roots = [environment.PROGRAMFILES, environment['PROGRAMFILES(X86)'], environment.LOCALAPPDATA]
    .filter((value): value is string => Boolean(value));
  const executable = roots.map(root => win32.join(root, ...product, 'Application', binary)).find(fileExists);
  return executable ? { executable, args: [url], waitForExit: false } : null;
}

export async function launchExternalBrowserExtensionManager(
  browser: ExternalBrowserName,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  fileExists: (path: string) => boolean = existsSync,
): Promise<'opened' | 'not-found' | 'failed'> {
  const command = externalBrowserExtensionManagerCommand(browser, platform, environment, fileExists);
  if (!command) return 'not-found';
  return new Promise(resolve => {
    let settled = false;
    const timeout = setTimeout(() => finish('failed'), 8_000);
    const finish = (result: 'opened' | 'failed') => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command.executable, command.args, { stdio: 'ignore', windowsHide: true,
        detached: !command.waitForExit });
    } catch {
      finish('failed');
      return;
    }
    child.once('error', () => finish('failed'));
    if (command.waitForExit) child.once('close', code => finish(code === 0 ? 'opened' : 'failed'));
    else child.once('spawn', () => { child.unref(); finish('opened'); });
  });
}
