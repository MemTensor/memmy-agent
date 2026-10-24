import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { NATIVE_APP_ACCESS_REQUEST, isNativeAppAccessResult,
  type NativeAppAccessDecision } from '@memmy/local-api-contracts';
import { getDataDir } from '../../config/paths.js';
import type { RequestContext } from '../../core/agent-runtime/tools/context.js';
import { openComputerUseEnvironment, resolveOpenComputerUseCommand } from './open-computer-use-binary.js';

const execFileAsync = promisify(execFile);

export type NativeAppIdentity = { platform: 'darwin' | 'win32'; appId: string; displayName: string };
export type ResolvedNativeApp = NativeAppIdentity & { runtimeSelector?: string };
export type NativeAppApproval = NativeAppIdentity & { allowedAt: string };

const APP_ID = /^[\w.!-]{1,256}$/;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_ENTRIES = 200;
const BLOCKED_MAC_IDS = new Set(['com.apple.Terminal', 'com.googlecode.iterm2', 'com.openai.codex']);
const BLOCKED_WINDOWS_IDS = new Set(['cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe',
  'wt', 'wt.exe', 'windowsterminal', 'windowsterminal.exe', 'chatgpt', 'chatgpt.exe',
  'applicationframehost', 'applicationframehost.exe',
  'microsoft.windowsterminal_8wekyb3d8bbwe!app', 'microsoft.windowsterminalpreview_8wekyb3d8bbwe!app']);

function validIdentity(value: unknown): value is NativeAppIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const app = value as Record<string, unknown>;
  return (app.platform === 'darwin' || app.platform === 'win32')
    && typeof app.appId === 'string' && APP_ID.test(app.appId)
    && typeof app.displayName === 'string' && app.displayName.trim().length > 0 && app.displayName.length <= 256;
}

export function isBlockedNativeApp(app: NativeAppIdentity): boolean {
  const id = app.appId.toLowerCase();
  return app.platform === 'darwin'
    ? [...BLOCKED_MAC_IDS].some(value => value.toLowerCase() === id)
    : BLOCKED_WINDOWS_IDS.has(id);
}

type WindowsAppCandidate = { app: ResolvedNativeApp; selectors: string[] };
function validWindowsAppName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Native metadata contains installed app names; window titles are never identity aliases. */
function windowsAppCandidates(listResult: unknown): WindowsAppCandidate[] | null | undefined {
  const metadata = (listResult as { _meta?: { memmyComputerUse?: Record<string, unknown> } })
    ?._meta?.memmyComputerUse;
  if (!metadata || !Object.hasOwn(metadata, 'runningApps')) return undefined;
  const discovery = metadata.runningApps;
  if (!discovery || typeof discovery !== 'object' || Array.isArray(discovery)) return null;
  const { version, apps } = discovery as Record<string, unknown>;
  if (version !== 1 || !Array.isArray(apps) || apps.length > 1024) return null;
  const candidates = new Map<string, WindowsAppCandidate>();
  const identities = new Map<string, string>();
  for (const raw of apps) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const { appId, displayName, processName, pid, aliases = [] } = raw as Record<string, unknown>;
    const app = { platform: 'win32' as const, appId, displayName };
    if (!validIdentity(app) || !validWindowsAppName(displayName)
      || typeof processName !== 'string' || !APP_ID.test(processName)
      || typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff
      || !Array.isArray(aliases) || aliases.length > 16 || !aliases.every(validWindowsAppName)) return null;
    const resolved = { ...app, runtimeSelector: String(pid) };
    const identity = JSON.stringify([app.appId.toLowerCase(), processName.toLowerCase()]);
    if (identities.has(resolved.runtimeSelector) && identities.get(resolved.runtimeSelector) !== identity) return null;
    identities.set(resolved.runtimeSelector, identity);
    // A shared UWP host does not identify the app whose window it owns. Also
    // prevent a package ID from hiding a protected terminal process.
    if (isBlockedNativeApp(resolved)
      || isBlockedNativeApp({ platform: 'win32', appId: processName, displayName })) continue;
    const candidate = { app: resolved, selectors: [app.appId, displayName, processName,
      `${processName}.exe`, ...aliases].map(value => value.toLocaleLowerCase()) };
    const previous = candidates.get(resolved.runtimeSelector);
    if (previous) previous.selectors.push(...candidate.selectors);
    else candidates.set(resolved.runtimeSelector, candidate);
  }
  return [...candidates.values()];
}

/** Resolve a tool's app argument to the native helper's own stable app identifier. */
export function resolveNativeAppIdentity(listResult: unknown, target: string,
  platform: 'darwin' | 'win32'): ResolvedNativeApp | null {
  const blocks = (listResult as { content?: unknown })?.content;
  if (!Array.isArray(blocks) || (listResult as { isError?: unknown })?.isError === true) return null;
  const wanted = target.trim().toLocaleLowerCase();
  if (!wanted || target.length > 256) return null;
  if (platform === 'win32') {
    const candidates = windowsAppCandidates(listResult);
    // Presence of the new native protocol is authoritative. A malformed
    // response must not downgrade to human-readable text or window titles.
    if (candidates !== undefined) {
      if (!candidates) return null;
      const matches = candidates.filter(({ app, selectors }) => app.runtimeSelector === wanted
        || selectors.includes(wanted));
      return matches.length === 1 ? matches[0].app : null;
    }
  }
  const wantedProcess = platform === 'win32' ? wanted.replace(/\.exe$/, '') : wanted;
  const matches: ResolvedNativeApp[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object' || typeof block.text !== 'string') continue;
    for (const raw of block.text.split(/\r?\n/)) {
      const line = raw.trim();
      let app: ResolvedNativeApp;
      if (platform === 'win32') {
        // The pinned Windows helper lists process name, PID, then window title.
        // Never send a title back to the model or use it to select an app.
        const match = /^(.+?) -- ([\w.!-]+) \[running, pid=(\d+), window=.*\]$/.exec(line);
        if (!match || Number(match[3]) <= 0 || !Number.isSafeInteger(Number(match[3]))) continue;
        app = { platform, displayName: match[1], appId: match[2], runtimeSelector: match[3] };
      } else {
        const divider = line.lastIndexOf(' — ');
        if (divider <= 0) continue;
        app = { platform, displayName: line.slice(0, divider),
          appId: line.slice(divider + 3).replace(/ \[[^\]]*\]$/, '') };
      }
      if (!validIdentity(app) || isBlockedNativeApp(app)) continue;
      if (app.displayName.toLocaleLowerCase() === wanted || app.appId.toLocaleLowerCase() === wantedProcess
        || app.runtimeSelector === wanted) matches.push(app);
    }
  }
  // Localized name aliases come from installed bundle metadata through the
  // read-only lookup, never from guessing the last segment of a bundle ID.
  const unique = new Map(matches.map(app => [app.runtimeSelector ?? app.appId.toLowerCase(), app]));
  return unique.size === 1 ? [...unique.values()][0] : null;
}

export type InstalledAppLookupFailure = 'not-found' | 'ambiguous' | 'blocked' | 'unavailable'
  | 'invalid-response' | 'lookup-failed';
export class InstalledAppIdentityLookupError extends Error {
  constructor(readonly code: InstalledAppLookupFailure) {
    super(`Computer Use installed app identity lookup: ${code}. The operation was not sent.`);
  }
}

/** Resolve an app the running list missed through the native helper's read-only
 * resolver, which also knows installed apps and running apps without a window. */
export async function resolveInstalledAppIdentity(target: string, platform: 'darwin' | 'win32',
  signal?: AbortSignal | null): Promise<ResolvedNativeApp> {
  signal?.throwIfAborted();
  if (!target.trim() || target.length > 256 || target.includes('\0'))
    throw new InstalledAppIdentityLookupError('not-found');
  let raw: unknown;
  try {
    const executable = resolveOpenComputerUseCommand('open-computer-use', { platform });
    const { stdout } = await execFileAsync(executable, ['resolve-app', '--query', target], {
      // Windows starts PowerShell and reads the Start menu for each lookup.
      timeout: platform === 'win32' ? 25_000 : 5000, maxBuffer: 16_384, signal: signal ?? undefined,
      ...(platform === 'win32' ? { env: { ...process.env, ...openComputerUseEnvironment('open-computer-use', null, 'win32') } } : {}),
    });
    signal?.throwIfAborted();
    try { raw = JSON.parse(stdout); }
    catch { throw new InstalledAppIdentityLookupError('invalid-response'); }
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof InstalledAppIdentityLookupError) throw error;
    throw new InstalledAppIdentityLookupError('lookup-failed');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new InstalledAppIdentityLookupError('invalid-response');
  const response = raw as { platform?: unknown; status?: unknown; app?: unknown; pid?: unknown };
  if (response.platform !== platform) throw new InstalledAppIdentityLookupError('invalid-response');
  if (response.status !== 'resolved') {
    if (response.app !== undefined || !['not-found', 'ambiguous', 'blocked', 'unavailable'].includes(String(response.status)))
      throw new InstalledAppIdentityLookupError('invalid-response');
    throw new InstalledAppIdentityLookupError(response.status as InstalledAppLookupFailure);
  }
  if (!response.app || typeof response.app !== 'object' || Array.isArray(response.app))
    throw new InstalledAppIdentityLookupError('invalid-response');
  const { appId, displayName } = response.app as Record<string, unknown>;
  const app = { platform, appId, displayName };
  if (!validIdentity(app)) throw new InstalledAppIdentityLookupError('invalid-response');
  if (isBlockedNativeApp(app)) throw new InstalledAppIdentityLookupError('blocked');
  if (response.pid === undefined) return app;
  if (platform !== 'win32' || typeof response.pid !== 'number' || !Number.isSafeInteger(response.pid)
    || response.pid <= 0 || response.pid > 0x7fffffff) throw new InstalledAppIdentityLookupError('invalid-response');
  return { ...app, runtimeSelector: String(response.pid) };
}

export class NativeAppApprovalStore {
  constructor(private readonly configuredPath?: string) {}
  get filePath(): string {
    return this.configuredPath ?? path.join(getDataDir(), 'computer-use', 'native-app-approvals.json');
  }
  list(): NativeAppApproval[] {
    try {
      if (fs.lstatSync(this.filePath).isSymbolicLink() || fs.statSync(this.filePath).size > MAX_FILE_BYTES) return [];
      const parsed: unknown = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
      const entries = (parsed as { entries?: unknown }).entries;
      if (!Array.isArray(entries) || entries.length > MAX_ENTRIES) return [];
      return entries.filter((entry): entry is NativeAppApproval => validIdentity(entry)
        && 'allowedAt' in entry && typeof entry.allowedAt === 'string'
        && !Number.isNaN(Date.parse(entry.allowedAt)) && !isBlockedNativeApp(entry));
    } catch { return []; }
  }
  isAllowed(app: NativeAppIdentity): boolean {
    return this.list().some(entry => entry.platform === app.platform
      && entry.appId.toLowerCase() === app.appId.toLowerCase());
  }
  allow(app: NativeAppIdentity): NativeAppApproval[] {
    if (!validIdentity(app) || isBlockedNativeApp(app)) throw new Error('Invalid native app approval identity');
    const entries = this.list().filter(entry => !(entry.platform === app.platform
      && entry.appId.toLowerCase() === app.appId.toLowerCase()));
    if (entries.length >= MAX_ENTRIES) throw new Error('Native app approval limit reached');
    entries.push({ platform: app.platform, appId: app.appId, displayName: app.displayName,
      allowedAt: new Date().toISOString() });
    return this.write(entries);
  }
  remove(platform: 'darwin' | 'win32', appId: string): NativeAppApproval[] {
    if (!APP_ID.test(appId) || !['darwin', 'win32'].includes(platform)) throw new Error('Invalid native app approval identity');
    return this.write(this.list().filter(entry => !(entry.platform === platform
      && entry.appId.toLowerCase() === appId.toLowerCase())));
  }
  private write(entries: NativeAppApproval[]): NativeAppApproval[] {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink()
      || fs.lstatSync(this.filePath, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error('Native app approval path cannot be a symbolic link');
    }
    entries.sort((a, b) => a.platform.localeCompare(b.platform) || a.displayName.localeCompare(b.displayName));
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, entries }), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, this.filePath);
      if (process.platform !== 'win32') fs.chmodSync(this.filePath, 0o600);
    } finally { fs.rmSync(temporary, { force: true }); }
    return entries;
  }
}

export class NativeAppApprovalDenied extends Error {
  constructor(message = 'Computer Use was not allowed to use this app. The operation was not sent.') { super(message); }
}

export function nativeAppTurnKey(context: RequestContext | null): string | null {
  if (!context || context.metadata.computerUseInteractive === false) return null;
  const messageId = context.messageId ?? context.metadata.message_id ?? context.metadata.messageId
    ?? context.metadata.turnId ?? context.metadata.turn_id;
  if (!messageId || ['system', 'cron'].includes(context.channel ?? '')) return null;
  return JSON.stringify([context.sessionKey, context.channel, context.chatId, messageId]);
}

export async function requestNativeAppAccess(app: NativeAppIdentity): Promise<NativeAppAccessDecision> {
  if (!process.send || !process.connected || process.env.MEMMY_DESKTOP_MANAGED_GATEWAY !== '1') return 'deny';
  const requestId = randomUUID();
  return new Promise(resolve => {
    const finish = (decision: NativeAppAccessDecision) => {
      clearTimeout(timer); process.removeListener('message', receive); resolve(decision);
    };
    const receive = (raw: unknown) => {
      if (isNativeAppAccessResult(raw) && raw.requestId === requestId) finish(raw.decision);
    };
    const timer = setTimeout(() => finish('deny'), 5 * 60_000);
    timer.unref?.();
    process.on('message', receive);
    try {
      process.send!({ type: NATIVE_APP_ACCESS_REQUEST, requestId, ...app }, error => { if (error) finish('deny'); });
    } catch { finish('deny'); }
  });
}

/** A one-time approval lasts only for the current user message, not future turns. */
export class NativeAppApprovalGate {
  private readonly turns = new Map<string, NativeAppAccessDecision>();
  constructor(private readonly store = new NativeAppApprovalStore(),
    private readonly ask: (app: NativeAppIdentity) => Promise<NativeAppAccessDecision> = requestNativeAppAccess) {}

  async authorize(app: NativeAppIdentity, context: RequestContext | null): Promise<void> {
    if (!validIdentity(app) || isBlockedNativeApp(app)) throw new NativeAppApprovalDenied();
    const turn = nativeAppTurnKey(context);
    if (!turn) throw new NativeAppApprovalDenied('Computer Use needs a current interactive user request for this app.');
    if (this.store.isAllowed(app)) return;
    const key = `${turn}:${app.platform}:${app.appId.toLowerCase()}`;
    let decision = this.turns.get(key);
    if (!decision) {
      try { decision = await this.ask(app); } catch { decision = 'deny'; }
      if (decision !== 'allow-once' && decision !== 'allow-always') decision = 'deny';
      if (decision === 'allow-always') {
        try { this.store.allow(app); } catch { decision = 'deny'; }
      }
      if (decision !== 'allow-always') this.turns.set(key, decision);
      if (this.turns.size > 256) this.turns.delete(this.turns.keys().next().value!);
    }
    if (decision === 'deny') throw new NativeAppApprovalDenied();
  }
}

export const nativeAppApprovalStore = new NativeAppApprovalStore();
export const nativeAppApprovalGate = new NativeAppApprovalGate(nativeAppApprovalStore);
