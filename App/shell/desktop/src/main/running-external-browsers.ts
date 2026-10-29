import { execFile } from 'node:child_process';
import type { ExternalBrowserName } from './external-browser-extension-install.js';

export type BrowserProcessExecFile = (file: string, args: string[],
  options: { encoding: 'utf8'; timeout: number; maxBuffer: number; windowsHide: boolean },
  callback: (error: Error | null, stdout: string, stderr: string) => void) => unknown;

const browsers = ['chrome', 'edge'] as const;
const windowsQuery = "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $session = [System.Diagnostics.Process]::GetCurrentProcess().SessionId; $filter = \"(Name = 'chrome.exe' OR Name = 'msedge.exe') AND SessionId = \" + $session; $items = @(Get-CimInstance Win32_Process -Filter $filter | Select-Object Name, ExecutablePath, CommandLine); ConvertTo-Json -InputObject $items -Compress";

function macBrowsers(stdout: string): ExternalBrowserName[] | null {
  const found = new Set<ExternalBrowserName>();
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^\s*\d+\s+(.+?)\s*$/.exec(line);
    if (!match) return null;
    const executable = match[1]!;
    if (executable === 'Google Chrome' || (executable.startsWith('/') && executable.endsWith('/Google Chrome.app/Contents/MacOS/Google Chrome'))) found.add('chrome');
    if (executable === 'Microsoft Edge' || (executable.startsWith('/') && executable.endsWith('/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'))) found.add('edge');
  }
  return browsers.filter(browser => found.has(browser));
}

function windowsBrowsers(stdout: string): ExternalBrowserName[] | null {
  try {
    const rows: unknown = JSON.parse(stdout.trim().replace(/^\uFEFF/, ''));
    if (!Array.isArray(rows)) return null;
    const found = new Set<ExternalBrowserName>();
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
      const { Name, ExecutablePath, CommandLine } = row as Record<string, unknown>;
      if (typeof Name !== 'string') return null;
      const name = Name.toLowerCase();
      const browser = name === 'chrome.exe' ? 'chrome' : name === 'msedge.exe' ? 'edge' : null;
      if (!browser) continue;
      if (ExecutablePath !== null && ExecutablePath !== undefined && typeof ExecutablePath !== 'string') return null;
      if (CommandLine !== null && CommandLine !== undefined && typeof CommandLine !== 'string') return null;
      // Access to these fields can be denied for another user's process. The
      // exact OS executable name still identifies a browser; never match prose
      // in arbitrary process arguments. Exclude known renderer/utility children.
      if (typeof ExecutablePath === 'string' && ExecutablePath.split(/[\\/]/).at(-1)?.toLowerCase() !== name) continue;
      if (typeof CommandLine === 'string' && /(?:^|\s)--type(?:=|\s|$)/.test(CommandLine)) continue;
      found.add(browser);
    }
    return browsers.filter(browser => found.has(browser));
  } catch { return null; }
}

/** Read-only process inventory. A failed probe is unknown, never "closed". */
export function runningExternalBrowsers({ platform = process.platform,
  userId = process.getuid?.(),
  run = execFile as BrowserProcessExecFile,
}: { platform?: NodeJS.Platform; userId?: number; run?: BrowserProcessExecFile } = {}): Promise<ExternalBrowserName[] | null> {
  if (platform !== 'darwin' && platform !== 'win32') return Promise.resolve(null);
  if (platform === 'darwin' && (!Number.isSafeInteger(userId) || Number(userId) < 0)) return Promise.resolve(null);
  const file = platform === 'darwin' ? '/bin/ps' : 'powershell.exe';
  const args = platform === 'darwin' ? ['-U', String(userId), '-o', 'pid=,comm=', '-ww']
    : ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsQuery];
  return new Promise(resolve => {
    try {
      run(file, args, { encoding: 'utf8', timeout: 3_000, maxBuffer: 1_048_576, windowsHide: true }, (error, stdout) => {
        if (error || typeof stdout !== 'string') { resolve(null); return; }
        resolve(platform === 'darwin' ? macBrowsers(stdout) : windowsBrowsers(stdout));
      });
    } catch { resolve(null); }
  });
}
