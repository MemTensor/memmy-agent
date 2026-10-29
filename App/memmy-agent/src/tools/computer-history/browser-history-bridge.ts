import { browserHistoryApplication, type BrowserHistoryCaptureIntent, type BrowserHistoryTrustedContext } from "./browser-semantic-history.js";
import { sanitizeBrowserUrl } from "./browser-privacy.js";
import { evaluateObservation } from "./mac/observation-settings.js";

export const BROWSER_HISTORY_CONFIG_TTL_MS = 1_500;
export const BROWSER_HISTORY_INTENT_REFRESH_MS = 500;

export interface BrowserHistoryConfiguration {
  enabled: boolean;
  generation: string | null;
  expiresAt: number;
  captureText: boolean;
}

/** Browser metadata comes from the authenticated extension, never its DOM event payload. */
export type BrowserHistoryConfigurationContext = Pick<BrowserHistoryTrustedContext,
  "browser" | "tabId" | "windowId" | "url" | "frameUrl" | "ancestorOrigins" | "documentId" | "privateBrowsing" | "protected">;

export function browserHistoryConfiguration(intent: BrowserHistoryCaptureIntent,
  context: BrowserHistoryConfigurationContext, now = Date.now(), platform: NodeJS.Platform = process.platform): BrowserHistoryConfiguration {
  const disabled = { enabled: false, generation: null, expiresAt: now, captureText: false };
  if (!intent.enabled || !intent.settings || !intent.generation || !Number.isFinite(now)
    || !["chrome", "edge"].includes(context.browser) || !Number.isSafeInteger(context.tabId) || context.tabId < 0
    || !Number.isSafeInteger(context.windowId) || context.windowId < 0
    || !/^[A-Za-z0-9._:-]{1,200}$/u.test(context.documentId) || context.privateBrowsing !== false || context.protected !== false) return disabled;
  const topUrl = sanitizeBrowserUrl(context.url), frameUrl = sanitizeBrowserUrl(context.frameUrl ?? context.url);
  const ancestors = (context.ancestorOrigins ?? []).map(origin => sanitizeBrowserUrl(origin));
  if (!topUrl || !frameUrl || !ancestors.every(Boolean)) return disabled;
  try {
    const bundleId = browserHistoryApplication(context.browser, platform).bundleId;
    if (![topUrl, frameUrl, ...ancestors].every(url => evaluateObservation(intent.settings!, {
      bundleId, browser: true, url, privateBrowsing: false, privateBrowsingUnknown: false,
    }).observe)) return disabled;
  } catch { return disabled; }
  return { enabled: true, generation: intent.generation, expiresAt: now + BROWSER_HISTORY_CONFIG_TTL_MS,
    captureText: intent.captureText === true };
}

export interface BrowserHistoryService {
  getBrowserCaptureIntent(): BrowserHistoryCaptureIntent;
  ingestBrowserSemanticEvent(payload: unknown, context: BrowserHistoryTrustedContext): boolean;
}

export interface BrowserHistoryTransport {
  setBrowserHistoryIntentProvider(provider: () => BrowserHistoryCaptureIntent): () => void;
  subscribeBrowserHistory(listener: (payload: unknown, context: BrowserHistoryTrustedContext) => void): () => void;
  refreshBrowserHistoryIntent(): void;
}

/** A passive recording bridge exists independently of any Agent chat or debugger attachment. */
export function connectBrowserHistoryBridge(service: BrowserHistoryService, transport: BrowserHistoryTransport,
  options: { refreshMs?: number; setInterval?: typeof setInterval; clearInterval?: typeof clearInterval } = {}) {
  let closed = false;
  const getIntent = (): BrowserHistoryCaptureIntent => {
    if (!closed) {
      try { return service.getBrowserCaptureIntent(); } catch { /* Fail closed when History settings are unavailable. */ }
    }
    return { enabled: false, generation: null, settings: null, captureText: false };
  };
  const removeProvider = transport.setBrowserHistoryIntentProvider(getIntent);
  const unsubscribe = transport.subscribeBrowserHistory((payload, context) => {
    if (closed) return;
    const intent = getIntent();
    if (!browserHistoryConfiguration(intent, context).enabled) return;
    // The service repeats generation, document, policy, redaction, actor and deduplication checks at append time.
    try { service.ingestBrowserSemanticEvent(payload, context); } catch { /* An optional browser event cannot stop native capture. */ }
  });
  const refresh = () => { if (!closed) transport.refreshBrowserHistoryIntent(); };
  const clear = options.clearInterval ?? clearInterval;
  const timer = (options.setInterval ?? setInterval)(refresh,
    Math.max(100, Math.min(BROWSER_HISTORY_INTENT_REFRESH_MS, options.refreshMs ?? BROWSER_HISTORY_INTENT_REFRESH_MS)));
  timer.unref?.();
  refresh();
  return {
    refresh,
    close() {
      if (closed) return;
      closed = true;
      clear(timer);
      unsubscribe();
      removeProvider();
      transport.refreshBrowserHistoryIntent();
    },
  };
}
