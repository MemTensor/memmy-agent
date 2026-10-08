import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BROWSER_CAPABILITY_REQUEST, isBrowserCapabilityResult,
  type BrowserCapabilityKind } from '@memmy/local-api-contracts';
import { BrowserUseSitePolicyReader } from './browser-use-site-policy-store.js';

function publicName(value: string): string {
  const name = path.basename(value.replace(/\\/g, '/'));
  const clean = name.replace(/[\x00-\x1f/\\]/g, '_').slice(0, 120);
  return clean && clean !== '.' && clean !== '..' ? clean : 'unnamed file';
}

/** An affirmative desktop decision applies to this operation only. */
export class BrowserCapabilityApproval {
  constructor(private readonly sitePolicy = new BrowserUseSitePolicyReader()) {}
  blocked(capability: BrowserCapabilityKind, pageUrl: string): boolean {
    return this.sitePolicy.decision(pageUrl, capability === 'download' ? 'downloads'
      : capability === 'upload' ? 'uploads' : 'fullCdp') === 'block';
  }
  async authorize(capability: BrowserCapabilityKind, pageUrl: string, pathsOrNames: string[],
    signal?: AbortSignal): Promise<boolean> {
    let origin: string;
    try {
      const url = new URL(pageUrl);
      if (!['http:', 'https:'].includes(url.protocol)) return false;
      origin = url.origin;
    } catch { return false; }
    if (!pathsOrNames.length || pathsOrNames.length > 20 || signal?.aborted) return false;
    const policy = this.sitePolicy.decision(pageUrl, capability === 'download' ? 'downloads'
      : capability === 'upload' ? 'uploads' : 'fullCdp');
    if (policy === 'block') return false;
    if (policy === 'allow') return true;
    if (!process.send || !process.connected) return false;
    const names = pathsOrNames.map(publicName);
    const requestId = randomUUID();
    return new Promise<boolean>(resolve => {
      const cleanup = () => { clearTimeout(timeout); process.removeListener('message', onMessage);
        signal?.removeEventListener('abort', onAbort); };
      const onAbort = () => { cleanup(); resolve(false); };
      const onMessage = (value: unknown) => {
        if (!isBrowserCapabilityResult(value) || value.requestId !== requestId) return;
        cleanup(); resolve(value.approved && !this.blocked(capability, pageUrl));
      };
      const timeout = setTimeout(() => { cleanup(); resolve(false); }, 5 * 60_000);
      timeout.unref?.();
      process.on('message', onMessage);
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        process.send!({ type: BROWSER_CAPABILITY_REQUEST, requestId, capability, origin, names }, error => {
          if (error) { cleanup(); resolve(false); }
        });
      } catch { cleanup(); resolve(false); }
    });
  }
}
