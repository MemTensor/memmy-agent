import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BROWSER_ACCESS_REQUEST, isBrowserAccessResult,
  type BrowserAccessResult } from '@memmy/local-api-contracts';
import { getDataDir } from '../../../config/paths.js';
import { BrowserUseSitePolicyReader } from './browser-use-site-policy-store.js';

export class BrowserAccessApproval {
  readonly filePath: string;
  private readonly pendingDecisions = new Map<string, Promise<BrowserAccessResult['decision']>>();
  constructor(filePath = path.join(getDataDir(), 'browser-use', 'access.json'),
    private readonly sitePolicy = new BrowserUseSitePolicyReader()) {
    this.filePath = filePath;
  }
  clear(): void { fs.rmSync(this.filePath, { force: true }); }

  private savedDecision(origin: string): 'allow' | 'deny' | null {
    try {
      if (fs.statSync(this.filePath).size > 128 * 1024) return null;
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Record<string, unknown>;
      return raw[origin] === 'allow' || raw[origin] === 'deny' ? raw[origin] : null;
    } catch { return null; }
  }

  async authorize(url: string, allowedForSession: Set<string>): Promise<boolean> {
    let origin: string;
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) return true;
      origin = parsed.origin;
    } catch { return false; }
    const policy = this.sitePolicy.resolve(url, 'access');
    if (policy.decision === 'block') return false;
    if (policy.decision === 'allow') return true;
    const saved = policy.matched ? null : this.savedDecision(origin);
    if (saved === 'deny') return false;
    if (saved === 'allow' || allowedForSession.has(origin)) return true;
    let pending = this.pendingDecisions.get(origin);
    if (!pending) {
      pending = this.requestDecision(origin, url);
      this.pendingDecisions.set(origin, pending);
      void pending.finally(() => {
        if (this.pendingDecisions.get(origin) === pending) this.pendingDecisions.delete(origin);
      });
    }
    const decision = await pending;
    if (this.sitePolicy.decision(url, 'access') === 'block') return false;
    if (decision === 'allow-once') allowedForSession.add(origin);
    return decision !== 'deny';
  }

  private requestDecision(origin: string, url: string): Promise<BrowserAccessResult['decision']> {
    if (!process.send || !process.connected) return Promise.resolve('deny');
    const requestId = randomUUID();
    return new Promise<BrowserAccessResult['decision']>(resolve => {
      const cleanup = () => { clearTimeout(timeout); process.removeListener('message', onMessage); };
      const onMessage = (value: unknown) => {
        if (!isBrowserAccessResult(value) || value.requestId !== requestId) return;
        cleanup(); resolve(value.decision);
      };
      const timeout = setTimeout(() => { cleanup(); resolve('deny'); }, 5 * 60_000);
      timeout.unref?.();
      process.on('message', onMessage);
      try {
        process.send!({ type: BROWSER_ACCESS_REQUEST, requestId, origin,
          url: url.length <= 4096 ? url : origin }, error => {
          if (error) { cleanup(); resolve('deny'); }
        });
      } catch { cleanup(); resolve('deny'); }
    });
  }
}
