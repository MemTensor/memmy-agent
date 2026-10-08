import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { NATIVE_APP_ACCESS_REQUEST, isNativeAppAccessResult,
  type NativeAppAccessDecision } from '@memmy/local-api-contracts';
import { getDataDir } from '../../config/paths.js';
import type { RequestContext } from '../../core/agent-runtime/tools/context.js';

export type NativeAppIdentity = { platform: 'darwin' | 'win32'; appId: string; displayName: string };
export type ResolvedNativeApp = NativeAppIdentity & { runtimeSelector?: string };
export type NativeAppApproval = NativeAppIdentity & { allowedAt: string };

const APP_ID = /^[\w.!-]{1,256}$/;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_ENTRIES = 200;
const BLOCKED_MAC_IDS = new Set(['com.apple.Terminal', 'com.googlecode.iterm2', 'com.openai.codex',
  'cn.memtensor.memmy']);
const BLOCKED_WINDOWS_IDS = new Set(['cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe',
  'wt', 'wt.exe', 'windowsterminal', 'windowsterminal.exe', 'chatgpt', 'chatgpt.exe',
  'memmy', 'memmy.exe']);

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

/** Resolve a tool's app argument to the native helper's own stable app identifier. */
export function resolveNativeAppIdentity(listResult: unknown, target: string,
  platform: 'darwin' | 'win32'): ResolvedNativeApp | null {
  const blocks = (listResult as { content?: unknown })?.content;
  if (!Array.isArray(blocks) || (listResult as { isError?: unknown })?.isError === true) return null;
  const wanted = target.trim().toLocaleLowerCase();
  if (!wanted || target.length > 256) return null;
  const wantedProcess = platform === 'win32' ? wanted.replace(/\.exe$/, '') : wanted;
  const matches: ResolvedNativeApp[] = [];
  const bundleNameMatches: ResolvedNativeApp[] = [];
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
      if (!validIdentity(app)) continue;
      if (app.displayName.toLocaleLowerCase() === wanted || app.appId.toLocaleLowerCase() === wantedProcess
        || app.runtimeSelector === wanted) matches.push(app);
      else if (platform === 'darwin' && app.appId.toLocaleLowerCase().split('.').at(-1) === wanted) {
        // A localized app may be shown as 计算器 while the model knows it as Calculator.
        // The helper's exact bundle ID still anchors the approval and action.
        bundleNameMatches.push(app);
      }
    }
  }
  const unique = new Map((matches.length ? matches : bundleNameMatches)
    .map(app => [app.runtimeSelector ?? app.appId.toLowerCase(), app]));
  return unique.size === 1 ? [...unique.values()][0] : null;
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

function turnKey(context: RequestContext | null): string | null {
  if (!context || context.metadata.computerUseInteractive === false) return null;
  const messageId = context.messageId ?? context.metadata.message_id ?? context.metadata.messageId
    ?? context.metadata.turnId ?? context.metadata.turn_id;
  if (!messageId || ['system', 'cron'].includes(context.channel ?? '')) return null;
  return JSON.stringify([context.sessionKey, context.channel, context.chatId, messageId]);
}

async function requestDecision(app: NativeAppIdentity): Promise<NativeAppAccessDecision> {
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
    private readonly ask: (app: NativeAppIdentity) => Promise<NativeAppAccessDecision> = requestDecision) {}

  async authorize(app: NativeAppIdentity, context: RequestContext | null): Promise<void> {
    if (!validIdentity(app) || isBlockedNativeApp(app)) throw new NativeAppApprovalDenied();
    const turn = turnKey(context);
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
