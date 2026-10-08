import { normalizeBrowserCdpReadCall, normalizeBrowserCdpWriteCall, normalizeBrowserCdpEventQuery,
  type EmbeddedBrowserRequest } from '@memmy/local-api-contracts';
import type { EmbeddedBrowserDriver, ApprovedBrowserCdpRead } from './embedded-browser-driver.js';

type Driver = Pick<EmbeddedBrowserDriver, 'uploadOrigin' | 'handle'>;

/** Keep the visible Debug/CDP decision bound to one selected webview and current origin. */
export async function runApprovedEmbeddedCdpRead(request: EmbeddedBrowserRequest, driver: Driver,
  approve: (origin: string, method: string) => Promise<boolean>,
  isCurrentChild: () => boolean, isAllowed: (origin: string) => boolean,
  approvalTimeoutMs = 5 * 60_000): Promise<unknown> {
  return runApprovedEmbeddedCdpOperation(request, driver, approve, isCurrentChild,
    isAllowed, 'read', approvalTimeoutMs);
}

export async function runApprovedEmbeddedCdpWrite(request: EmbeddedBrowserRequest, driver: Driver,
  approve: (origin: string, method: string) => Promise<boolean>,
  isCurrentChild: () => boolean, isAllowed: (origin: string) => boolean,
  approvalTimeoutMs = 5 * 60_000): Promise<unknown> {
  return runApprovedEmbeddedCdpOperation(request, driver, approve, isCurrentChild,
    isAllowed, 'write', approvalTimeoutMs);
}

async function runApprovedEmbeddedCdpOperation(request: EmbeddedBrowserRequest, driver: Driver,
  approve: (origin: string, method: string) => Promise<boolean>,
  isCurrentChild: () => boolean, isAllowed: (origin: string) => boolean,
  mode: 'read' | 'write', approvalTimeoutMs: number): Promise<unknown> {
  if ((mode === 'read' && request.command !== 'cdpCall' && request.command !== 'cdpEvents')
    || (mode === 'write' && request.command !== 'cdpWrite')
    || !Number.isSafeInteger(request.tabId) || !isCurrentChild()) {
    throw new Error('Invalid browser CDP operation');
  }
  const write = request.command === 'cdpWrite'
    ? normalizeBrowserCdpWriteCall(request.args.method, request.args.params ?? {}) : null;
  const method = write
    ? write.method
    : request.command === 'cdpCall'
    ? normalizeBrowserCdpReadCall(request.args.method, request.args.params ?? {}).method
    : (normalizeBrowserCdpEventQuery(request.args), 'readEvents');
  const origin = driver.uploadOrigin(request.tabId!);
  if (!isAllowed(origin)) throw new Error('Browser CDP operation is blocked by site policy');
  const deadline = Date.now() + approvalTimeoutMs;
  const askBeforeDeadline = async (site: string): Promise<boolean> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    return Promise.race([
      approve(site, method),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), remaining); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
  };
  const stillValid = () => Date.now() < deadline && isCurrentChild() && isAllowed(origin)
    && driver.uploadOrigin(request.tabId!) === origin;
  if (!await askBeforeDeadline(origin) || !stillValid()) throw new Error('Browser CDP operation was not approved');
  const targetOrigins = [...new Set((write?.targetUrls ?? []).map(target => {
    const url = new URL(target);
    if (!['http:', 'https:'].includes(url.protocol) || url.href.length > 4096) {
      throw new Error('Invalid CDP destination URL');
    }
    return url.origin;
  }))].filter(target => target !== origin);
  for (const target of targetOrigins) {
    if (!isAllowed(target) || !await askBeforeDeadline(target) || !stillValid() || !isAllowed(target)) {
      throw new Error('CDP destination site was not approved');
    }
  }
  const grant: ApprovedBrowserCdpRead = { origin, isCurrentChild,
    isAllowed: () => isAllowed(origin) && targetOrigins.every(target => isAllowed(target)), mode };
  return driver.handle(request, undefined, grant);
}
