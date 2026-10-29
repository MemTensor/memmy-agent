import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import type { ExternalBrowserName } from './external-browser-extension-install.js';
import type { ExternalBrowserInstallation } from '@memmy/local-api-contracts';

/** Public key in extensions/memmy-browser/manifest.json. */
export const MEMMY_BROWSER_EXTENSION_ID = 'mhodbgbbgalbhehapffidmdegokpoaom';

const MAX_PREFS_BYTES = 8_000_000;

function dictionary(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

type BrowserFiles = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  readFile?: (path: string) => string;
  fileExists?: (path: string) => boolean;
};

function pathJoin(platform: NodeJS.Platform, ...parts: string[]): string {
  return (platform === 'win32' ? win32.join : join)(...parts);
}

function userDataDir(browser: ExternalBrowserName, platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv, home: string): string | null {
  if (platform === 'darwin') {
    const folder = browser === 'chrome' ? pathJoin(platform, 'Google', 'Chrome') : 'Microsoft Edge';
    return pathJoin(platform, home, 'Library', 'Application Support', folder);
  }
  if (platform === 'win32') {
    if (!env.LOCALAPPDATA) return null;
    return browser === 'chrome'
      ? pathJoin(platform, env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data')
      : pathJoin(platform, env.LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data');
  }
  const config = env.XDG_CONFIG_HOME || pathJoin(platform, home, '.config');
  return pathJoin(platform, config, browser === 'chrome' ? 'google-chrome' : 'microsoft-edge');
}

function isProfileName(name: string): boolean {
  return name === 'Default' || /^Profile \d+$/.test(name);
}

function profileNames(root: string, readFile: (path: string) => string,
  fileExists: (path: string) => boolean, platform: NodeJS.Platform): string[] {
  const localState = pathJoin(platform, root, 'Local State');
  if (fileExists(localState)) {
    try {
      const parsed = JSON.parse(readFile(localState)) as { profile?: { info_cache?: Record<string, unknown> } };
      const names = Object.keys(parsed.profile?.info_cache ?? {}).filter(isProfileName);
      if (names.length > 0) return names;
    } catch { /* Use the default profile when Local State cannot be read. */ }
  }
  return fileExists(pathJoin(platform, root, 'Default')) ? ['Default'] : [];
}

function extensionRecord(prefsPath: string, readFile: (path: string) => string,
  fileExists: (path: string) => boolean): Record<string, unknown> | null {
  if (!fileExists(prefsPath)) return null;
  try {
    const parsed = JSON.parse(readFile(prefsPath)) as {
      extensions?: { settings?: Record<string, Record<string, unknown>> };
    };
    const record = parsed.extensions?.settings?.[MEMMY_BROWSER_EXTENSION_ID];
    return dictionary(record) ? record : null;
  } catch {
    return null;
  }
}

function recordEnabled(record: Record<string, unknown> | null): boolean {
  if (!record) return false;
  // Modern Chromium removes this obsolete field. When present, only the old
  // enabled value is acceptable; absence alone never establishes installation.
  if (record.state !== undefined && record.state !== 1) return false;
  const reasons = record.disable_reasons;
  if (reasons !== undefined && !(Array.isArray(reasons) && reasons.length === 0) && reasons !== 0) return false;
  if (!Number.isInteger(record.location) || Number(record.location) < 1 || Number(record.location) > 10) return false;
  if (typeof record.path !== 'string' || !record.path.trim() || record.path.includes('\0')) return false;
  return true;
}

function manifestMatches(directory: string, unpacked: boolean, readFile: (path: string) => string,
  fileExists: (path: string) => boolean, platform: NodeJS.Platform): boolean {
  const manifestPath = pathJoin(platform, directory, 'manifest.json');
  if (!fileExists(manifestPath)) return false;
  try {
    const manifest: unknown = JSON.parse(readFile(manifestPath));
    if (!dictionary(manifest) || ![2, 3].includes(manifest.manifest_version as number)
      || typeof manifest.name !== 'string' || !manifest.name.trim()
      || typeof manifest.version !== 'string' || !/^\d+(?:\.\d+){0,3}$/.test(manifest.version)) return false;
    if (manifest.key === undefined) return !unpacked;
    if (typeof manifest.key !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(manifest.key)) return false;
    const digest = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16);
    const id = [...digest].flatMap(byte => [byte >> 4, byte & 15]
      .map(nibble => String.fromCharCode(97 + nibble))).join('');
    return id === MEMMY_BROWSER_EXTENSION_ID;
  } catch { return false; }
}

function recordInstalled(record: Record<string, unknown> | null, profileDir: string,
  readFile: (path: string) => string, fileExists: (path: string) => boolean, platform: NodeJS.Platform): boolean {
  if (!recordEnabled(record)) return false;
  const paths = platform === 'win32' ? win32 : posix;
  const unpacked = record!.location === 4 || record!.location === 8;
  const recordedPath = record!.path as string;
  let directory: string;
  if (paths.isAbsolute(recordedPath)) directory = paths.normalize(recordedPath);
  else {
    // Chromium resolves packed paths against this profile's Extensions folder,
    // not the working directory or browser user-data root.
    if (unpacked) return false;
    const parts = recordedPath.split(platform === 'win32' ? /[\\/]/ : /\//);
    if (parts.length !== 2 || parts[0] !== MEMMY_BROWSER_EXTENSION_ID
      || !/^\d+(?:\.\d+){0,3}(?:_\d+)?$/.test(parts[1]!)) return false;
    directory = pathJoin(platform, profileDir, 'Extensions', ...parts);
  }
  if (!unpacked && paths.basename(paths.dirname(directory)) !== MEMMY_BROWSER_EXTENSION_ID) return false;
  return fileExists(directory) && manifestMatches(directory, unpacked, readFile, fileExists, platform);
}

function profileHasExtension(profileDir: string, readFile: (path: string) => string,
  fileExists: (path: string) => boolean, platform: NodeJS.Platform): boolean {
  const secure = extensionRecord(pathJoin(platform, profileDir, 'Secure Preferences'), readFile, fileExists);
  const prefs = extensionRecord(pathJoin(platform, profileDir, 'Preferences'), readFile, fileExists);
  // Empty Secure Preferences entries are residue, not an authoritative install
  // or disable decision. Explicit secure metadata (including disable reasons)
  // still takes precedence over an older ordinary Preferences record.
  const record = secure && Object.keys(secure).length > 0 ? secure : prefs;
  return recordInstalled(record, profileDir, readFile, fileExists, platform);
}

function defaultReadFile(path: string): string {
  if (statSync(path).size > MAX_PREFS_BYTES) throw new Error('Browser preferences are too large');
  return readFileSync(path, 'utf8');
}

function strictFileExists(path: string): boolean {
  try { statSync(path); return true; }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
}

/** Browsers whose everyday profile has the Memmy extension installed and enabled. */
export function installedExternalBrowsers({
  platform = process.platform,
  env = process.env,
  home = homedir(),
  readFile = defaultReadFile,
  fileExists = existsSync,
}: BrowserFiles = {}): ExternalBrowserName[] {
  const installed: ExternalBrowserName[] = [];
  for (const browser of ['chrome', 'edge'] as const) {
    const root = userDataDir(browser, platform, env, home);
    if (!root || !fileExists(root)) continue;
    const names = profileNames(root, readFile, fileExists, platform);
    if (names.some(name => profileHasExtension(pathJoin(platform, root, name), readFile, fileExists, platform))) {
      installed.push(browser);
    }
  }
  return installed;
}

/** Preserve absent, disabled, and unreadable installations for settings and connection recovery. */
export function probeExternalBrowserInstallation({
  platform = process.platform, env = process.env, home = homedir(),
  readFile = defaultReadFile, fileExists = strictFileExists,
}: BrowserFiles = {}): Record<ExternalBrowserName, ExternalBrowserInstallation> {
  const unknown = (): ExternalBrowserInstallation => ({ installed: null, enabled: null });
  const result = { chrome: unknown(), edge: unknown() };
  if (platform !== 'darwin' && platform !== 'win32' && platform !== 'linux') return result;
  const readObject = (path: string): Record<string, unknown> => {
    const value: unknown = JSON.parse(readFile(path));
    if (!dictionary(value)) throw new Error('Browser metadata is not an object');
    return value;
  };
  const recordAt = (path: string): { present: boolean; record: Record<string, unknown> | null } => {
    if (!fileExists(path)) return { present: false, record: null };
    const value = readObject(path);
    if (value.extensions === undefined) return { present: true, record: null };
    if (!dictionary(value.extensions)) throw new Error('Invalid extension metadata');
    if (value.extensions.settings === undefined) return { present: true, record: null };
    if (!dictionary(value.extensions.settings)) throw new Error('Invalid extension settings');
    const record = value.extensions.settings[MEMMY_BROWSER_EXTENSION_ID];
    if (record === undefined) return { present: true, record: null };
    if (!dictionary(record)) throw new Error('Invalid extension record');
    return { present: true, record };
  };
  for (const browser of ['chrome', 'edge'] as const) {
    try {
      const root = userDataDir(browser, platform, env, home);
      if (!root) continue;
      if (!fileExists(root)) { result[browser] = { installed: false, enabled: false }; continue; }
      let incomplete = false;
      const localStatePath = pathJoin(platform, root, 'Local State');
      let names: string[] = [];
      if (fileExists(localStatePath)) {
        const value = readObject(localStatePath);
        if (!dictionary(value.profile) || !dictionary(value.profile.info_cache)) incomplete = true;
        else names = Object.keys(value.profile.info_cache).filter(isProfileName);
      } else incomplete = true;
      if (names.length === 0 && fileExists(pathJoin(platform, root, 'Default'))) names = ['Default'];
      let installed = false;
      let enabled = false;
      for (const name of names) {
        try {
          const profile = pathJoin(platform, root, name);
          const secure = recordAt(pathJoin(platform, profile, 'Secure Preferences'));
          const ordinary = recordAt(pathJoin(platform, profile, 'Preferences'));
          if (!secure.present && !ordinary.present) { incomplete = true; continue; }
          const record = secure.record && Object.keys(secure.record).length > 0 ? secure.record : ordinary.record;
          if (!record || Object.keys(record).length === 0) continue;
          // Installation is the validated payload, independent of Chromium's enable/disable decision.
          const payload = { ...record, state: 1, disable_reasons: [] };
          let unreadable = false;
          const checkedRead = (path: string) => {
            try { return readFile(path); } catch (error) { unreadable = true; throw error; }
          };
          if (!recordInstalled(payload, profile, checkedRead, fileExists, platform) || unreadable) {
            incomplete = true; continue;
          }
          installed = true;
          if (recordEnabled(record)) enabled = true;
          else if (!(typeof record.state === 'number' && record.state !== 1)
            && !(typeof record.disable_reasons === 'number' && record.disable_reasons > 0)
            && !(Array.isArray(record.disable_reasons) && record.disable_reasons.length > 0)) incomplete = true;
        } catch { incomplete = true; }
      }
      result[browser] = { installed: installed ? true : incomplete ? null : false,
        enabled: enabled ? true : incomplete ? null : false };
    } catch { /* A failed probe remains unknown, never "not installed". */ }
  }
  return result;
}
