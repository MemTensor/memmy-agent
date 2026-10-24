import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Clock3, RotateCw, Settings2, Trash2 } from 'lucide-react';
import { useTranslation } from '../i18n/use-translation.js';
import { BrowserAgentSettings } from './browser-agent-settings.js';
import './browser-panel.css';

export const MEMMY_BROWSER_OPEN_EVENT = 'memmy:open-browser-url';
export const MEMMY_BROWSER_NEW_TAB_EVENT = 'memmy:new-browser-tab';
export const MEMMY_BROWSER_MOUNTED_EVENT = 'memmy:browser-mounted';
let browserPanelMountCount = 0;
export function hasMountedBrowserPanel(): boolean { return browserPanelMountCount > 0; }
let pendingBrowserUrl: string | null = null;
export type BrowserTabOwner = { scopeKey?: string; sourceGuestId?: number };
export type PendingBrowserTab = BrowserTabOwner & { url: string };
const pendingNewBrowserTabs: PendingBrowserTab[] = [];

export function requestBrowserOpen(url: string): void {
  pendingBrowserUrl = url;
  window.dispatchEvent(new CustomEvent(MEMMY_BROWSER_OPEN_EVENT, { detail: { url } }));
}
export function requestBrowserNewTab(url: string, owner: BrowserTabOwner = {}): void {
  const request = { ...owner, url };
  pendingNewBrowserTabs.push(request);
  // Opening another tab must not navigate the currently visible webview.
  window.dispatchEvent(new CustomEvent(MEMMY_BROWSER_OPEN_EVENT, { detail: { ...owner, newTab: true } }));
  window.dispatchEvent(new CustomEvent(MEMMY_BROWSER_NEW_TAB_EVENT, { detail: request }));
}
export function takePendingBrowserNewTab(): PendingBrowserTab | null {
  return pendingNewBrowserTabs.shift() ?? null;
}
export function hasPendingBrowserOpen(scopeKey?: string): boolean {
  return pendingBrowserUrl !== null || pendingNewBrowserTabs.some(request => scopeKey === undefined
    || request.scopeKey === scopeKey || (!request.scopeKey && request.sourceGuestId === undefined));
}

const HISTORY_KEY = 'memmy.browser.history.v1';
const MAX_LEGACY_HISTORY_BYTES = 4 * 1024 * 1024;
const LAST_URL_KEY = 'memmy.browser.last-url.v1';
const PREFERENCES_KEY = 'memmy.browser.preferences.v1';
export type BrowserPreferences = { webLinks: 'memmy' | 'system'; localLinks: 'memmy' | 'system'; showFullUrl: boolean };
export type BrowserHistoryEntry = { id?: string; url: string; title: string; visitedAt: number;
  visitSource?: 'agent' | 'other' };
type BrowserDataCategory = 'cookies' | 'siteData' | 'cache' | 'downloadHistory' | 'browsingHistory';
const BROWSER_DATA_CATEGORIES: BrowserDataCategory[] = ['cookies', 'siteData', 'cache', 'downloadHistory', 'browsingHistory'];
const DEFAULT_PREFERENCES: BrowserPreferences = { webLinks: 'system', localLinks: 'memmy', showFullUrl: false,
};

function safeStorage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; }
  catch { return null; }
}
function writeStorage(key: string, value: unknown): void {
  try { safeStorage()?.setItem(key, JSON.stringify(value)); }
  catch { /* Browsing works without renderer storage. */ }
}
/** Upgrade the former renderer-only list through the trusted desktop IPC boundary. */
export async function migrateLegacyBrowserHistory(
  storage: Pick<Storage, 'getItem' | 'removeItem'> | null = safeStorage(),
  importEntries = window.memmy?.importLegacyBrowserHistory,
): Promise<boolean> {
  try {
    const raw = storage?.getItem(HISTORY_KEY);
    if (raw == null) return true;
    if (!importEntries || new TextEncoder().encode(raw).byteLength > MAX_LEGACY_HISTORY_BYTES) return false;
    const entries = JSON.parse(raw) as unknown;
    if (!Array.isArray(entries) || entries.length > 500) return false;
    if (!await importEntries(entries)) return false;
    if (storage?.getItem(HISTORY_KEY) === raw) storage.removeItem(HISTORY_KEY);
    return true;
  } catch { return false; }
}
export function readBrowserPreferences(storage: Pick<Storage, 'getItem'> | null = safeStorage()): BrowserPreferences {
  try {
    const value = JSON.parse(storage?.getItem(PREFERENCES_KEY) ?? 'null') as Partial<BrowserPreferences> | null;
    return {
      webLinks: value?.webLinks === 'memmy' ? 'memmy' : 'system',
      localLinks: value?.localLinks === 'system' ? 'system' : 'memmy',
      showFullUrl: value?.showFullUrl === true,
    };
  } catch { return { ...DEFAULT_PREFERENCES }; }
}
export function normalizeBrowserAddress(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  try {
    const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(value);
    const local = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(value);
    const url = new URL(hasScheme ? value : `${local ? 'http' : 'https'}://${value}`);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
}
export function isBlankBrowserUrl(url: string): boolean {
  const value = url.trim();
  if (!value) return true;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'about:') return false;
    return parsed.pathname.replace(/^\/+|\/+$/g, '') === 'blank' || parsed.hostname === 'blank';
  } catch {
    return /^about:blank(?:[/?#]|$)/i.test(value);
  }
}
function displayAddress(url: string, full: boolean): string {
  if (isBlankBrowserUrl(url)) return '';
  if (full) return url;
  try { return new URL(url).host; }
  catch { return url; }
}
function visiblePageTitle(title: string): string {
  return isBlankBrowserUrl(title) ? '' : title;
}
type BrowserWebview = HTMLElement & {
  getWebContentsId(): number;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
};

function readLastUrl(): string {
  try {
    const url = safeStorage()?.getItem(LAST_URL_KEY) ?? '';
    return normalizeBrowserAddress(url) === url ? url : '';
  } catch { return ''; }
}

/** A live Electron webview is shared by the sidebar and Agent browser controls. */
export function BrowserPanel({ hidden = false, active = true, initialAddress,
  onTabReady, onNavigation }: { hidden?: boolean; active?: boolean; initialAddress?: string;
    onTabReady?: (tabId: number) => void;
    onNavigation?: (url: string, title: string) => void } = {}) {
  const { t } = useTranslation();
  const initialUrl = useRef(initialAddress === undefined ? readLastUrl() : initialAddress);
  const activeRef = useRef(active);
  activeRef.current = active;
  const onTabReadyRef = useRef(onTabReady);
  onTabReadyRef.current = onTabReady;
  const onNavigationRef = useRef(onNavigation);
  onNavigationRef.current = onNavigation;
  const webviewRef = useRef<BrowserWebview | null>(null);
  const historyMigration = useRef<Promise<boolean> | null>(null);
  const webviewReady = useRef(false);
  const pendingNavigation = useRef<string | null>(null);
  const [pageUrl, setPageUrl] = useState(initialUrl.current);
  const [pageTitle, setPageTitle] = useState('');
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [address, setAddress] = useState(displayAddress(initialUrl.current, readBrowserPreferences().showFullUrl));
  const [section, setSection] = useState<'browser' | 'settings' | 'clearData' | 'history'>('browser');
  const [preferences, setPreferences] = useState(readBrowserPreferences);
  const [history, setHistory] = useState<BrowserHistoryEntry[]>([]);
  const [selectedHistoryIds, setSelectedHistoryIds] = useState<string[]>([]);
  const [historySource, setHistorySource] = useState<'all' | 'agent' | 'other'>('all');
  const [clearCategories, setClearCategories] = useState<BrowserDataCategory[]>(BROWSER_DATA_CATEGORIES);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [opening, setOpening] = useState(false);
  const addressFocused = useRef(false);
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;

  useEffect(() => {
    browserPanelMountCount++;
    historyMigration.current = migrateLegacyBrowserHistory();
    window.dispatchEvent(new Event(MEMMY_BROWSER_MOUNTED_EVENT));
    return () => { browserPanelMountCount--; };
  }, []);

  useEffect(() => {
    if (!opening) return;
    const timeout = window.setTimeout(() => {
      setOpening(false);
      setError(t("browser.error.timeout"));
    }, 90_000);
    return () => window.clearTimeout(timeout);
  }, [opening]);

  useEffect(() => {
    if (section !== 'history' || !window.memmy?.getBrowserHistory) return;
    let active = true;
    void (historyMigration.current ?? migrateLegacyBrowserHistory()).then(() => window.memmy!.getBrowserHistory!()).then(entries => {
      if (active) setHistory(entries);
    }).catch(() => { if (active) setError(t('browser.error.unavailable')); });
    return () => { active = false; };
  }, [section, t]);

  useEffect(() => {
    const view = webviewRef.current;
    if (!view || !window.memmy) return;
    const updateNavigation = () => {
      const url = view.getURL();
      const title = visiblePageTitle(view.getTitle());
      setPageUrl(url);
      setPageTitle(title);
      onNavigationRef.current?.(url, title);
      setCanGoBack(view.canGoBack());
      setCanGoForward(view.canGoForward());
      if (!addressFocused.current) setAddress(displayAddress(url, preferencesRef.current.showFullUrl));
      if (/^https?:\/\//.test(url)) {
        try { safeStorage()?.setItem(LAST_URL_KEY, url); } catch { /* Browsing works without storage. */ }
      }
    };
    const ready = () => {
      webviewReady.current = true;
      const tabId = view.getWebContentsId?.();
      if (Number.isSafeInteger(tabId) && tabId > 0) {
        onTabReadyRef.current?.(tabId);
        if (activeRef.current) window.memmy?.selectEmbeddedBrowserTab?.(tabId);
      }
      if (pendingNavigation.current) {
        const url = pendingNavigation.current;
        pendingNavigation.current = null;
        void view.loadURL(url).catch(() => setError(t('browser.error.navigationFailed')));
      }
      updateNavigation();
    };
    const start = () => setOpening(true);
    const stop = () => { setOpening(false); updateNavigation(); };
    const failed = (event: Event) => {
      const details = event as Event & { errorCode?: number; isMainFrame?: boolean };
      if (details.isMainFrame !== false && details.errorCode !== -3) {
        setOpening(false);
        setError(t('browser.error.navigationFailed'));
      }
    };
    view.addEventListener('dom-ready', ready);
    view.addEventListener('did-start-loading', start);
    view.addEventListener('did-stop-loading', stop);
    view.addEventListener('did-navigate', updateNavigation);
    view.addEventListener('did-navigate-in-page', updateNavigation);
    view.addEventListener('page-title-updated', updateNavigation);
    view.addEventListener('did-fail-load', failed);
    return () => {
      webviewReady.current = false;
      view.removeEventListener('dom-ready', ready);
      view.removeEventListener('did-start-loading', start);
      view.removeEventListener('did-stop-loading', stop);
      view.removeEventListener('did-navigate', updateNavigation);
      view.removeEventListener('did-navigate-in-page', updateNavigation);
      view.removeEventListener('page-title-updated', updateNavigation);
      view.removeEventListener('did-fail-load', failed);
    };
  }, []);

  useEffect(() => {
    if (!active || !webviewReady.current) return;
    const tabId = webviewRef.current?.getWebContentsId?.();
    if (Number.isSafeInteger(tabId) && tabId! > 0) window.memmy?.selectEmbeddedBrowserTab?.(tabId!);
  }, [active]);

  useEffect(() => {
    if (!active || !pendingBrowserUrl) return;
    const target = pendingBrowserUrl;
    pendingBrowserUrl = null;
    void navigate(target);
  }, [active]);
  useEffect(() => {
    if (!active) return;
    const openFromLink = (event: Event) => {
      const target = (event as CustomEvent<{ url?: string }>).detail?.url;
      if (target) { pendingBrowserUrl = null; void navigate(target); }
    };
    window.addEventListener(MEMMY_BROWSER_OPEN_EVENT, openFromLink);
    return () => window.removeEventListener(MEMMY_BROWSER_OPEN_EVENT, openFromLink);
  }, [active]);

  function navigate(input: string): void {
    const url = normalizeBrowserAddress(input);
    if (!url) { setError(t("browser.error.address")); return; }
    if (!window.memmy) { setError(t('browser.error.desktopRequired')); return; }
    setError('');
    setSection('browser');
    setPageUrl(url);
    setPageTitle('');
    setAddress(displayAddress(url, preferences.showFullUrl));
    setOpening(true);
    const view = webviewRef.current;
    if (!view || !webviewReady.current) { pendingNavigation.current = url; return; }
    void (async () => {
      const tabId = view.getWebContentsId?.();
      if (Number.isSafeInteger(tabId) && tabId > 0) {
        const mark = window.memmy?.markEmbeddedBrowserUserNavigation?.(tabId);
        if (mark) await mark.catch(() => undefined);
      }
      await view.loadURL(url);
    })().catch(() => { setOpening(false); setError(t('browser.error.navigationFailed')); });
  }
  function navigateByToolbar(action: (view: BrowserWebview) => void): void {
    const view = webviewRef.current;
    if (!view) return;
    const tabId = view.getWebContentsId?.();
    const mark = Number.isSafeInteger(tabId) && tabId > 0
      ? window.memmy?.markEmbeddedBrowserUserNavigation?.(tabId) : null;
    void (mark ?? Promise.resolve()).catch(() => undefined).then(() => action(view))
      .catch(() => setError(t('browser.error.navigationFailed')));
  }
  function submitAddress(event: FormEvent): void { event.preventDefault(); void navigate(address); }
  function savePreferences(next: BrowserPreferences): void {
    setPreferences(next);
    writeStorage(PREFERENCES_KEY, next);
    if (!addressFocused.current) setAddress(displayAddress(pageUrl, next.showFullUrl));
  }
  async function clearBrowsingData(categories: BrowserDataCategory[]): Promise<void> {
    try {
      if (!window.memmy?.clearBrowserData) throw new Error('Browser data service unavailable');
      if (categories.includes('browsingHistory')) await (historyMigration.current ?? migrateLegacyBrowserHistory());
      await window.memmy.clearBrowserData(categories);
      if (categories.includes('browsingHistory')) {
        safeStorage()?.removeItem(HISTORY_KEY);
        safeStorage()?.removeItem(LAST_URL_KEY);
        setHistory([]);
        setSelectedHistoryIds([]);
        webviewRef.current?.loadURL('about:blank').catch(() => undefined);
        setPageUrl(''); setPageTitle(''); setCanGoBack(false); setCanGoForward(false);
        setAddress('');
      }
      setSection('settings');
      setError('');
    } catch { setError(t("browser.error.clear")); }
  }
  const visibleHistory = history.filter(entry =>
    (historySource === 'all' || (entry.visitSource ?? 'other') === historySource)
    && `${entry.title} ${entry.url}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  return (
    <div className="memmy-browser-panel" aria-label={t("browser.title")}
      aria-hidden={hidden} style={hidden ? {
        position: 'fixed', left: -10_000, top: 0, width: 800, height: 600,
        opacity: 0, pointerEvents: 'none',
      } : undefined}>
      <div className="memmy-browser-toolbar">
        <button type="button" aria-label={t("browser.back")} disabled={!canGoBack} onClick={() => navigateByToolbar(view => view.goBack())}><ArrowLeft size={16} /></button>
        <button type="button" aria-label={t("browser.forward")} disabled={!canGoForward} onClick={() => navigateByToolbar(view => view.goForward())}><ArrowRight size={16} /></button>
        <button type="button" aria-label={t("browser.reload")} disabled={!pageUrl} onClick={() => navigateByToolbar(view => view.reload())}><RotateCw size={16} /></button>
        <form onSubmit={submitAddress}><input aria-label={t("browser.address")} value={address} autoComplete="off" spellCheck={false}
          onFocus={event => {
            addressFocused.current = true;
            if (isBlankBrowserUrl(pageUrl)) { setAddress(''); return; }
            setAddress(pageUrl || address);
            event.currentTarget.select();
          }}
          onBlur={() => { addressFocused.current = false; setAddress(displayAddress(pageUrl || address, preferences.showFullUrl)); }}
          onChange={event => setAddress(event.target.value)} placeholder={t("browser.addressPlaceholder")} /></form>
        <button type="button" aria-label={t("browser.history")} title={t("browser.history")} onClick={() => setSection(section === 'history' ? 'browser' : 'history')}><Clock3 size={16} /></button>
        <button type="button" aria-label={t("browser.settings")} title={t("browser.settings")} onClick={() => setSection(section === 'settings' ? 'browser' : 'settings')}><Settings2 size={16} /></button>
      </div>
      {error ? <div className="memmy-browser-error" role="alert">{error}</div> : null}
      <div className="memmy-browser-content">
        {/* Serialize this Electron attribute as a string: React drops unknown boolean attributes.
            The main-process handler still denies native popups and routes valid URLs to Memmy tabs. */}
        <webview ref={webviewRef} className="memmy-browser-webview" src={initialUrl.current || 'about:blank'}
          allowpopups={"true" as unknown as boolean}
          partition="persist:memmy-browser" style={section === 'browser'
            ? { display: 'flex' }
            : { position: 'fixed', left: -10_000, top: 0, width: 800, height: 600,
              opacity: 0, pointerEvents: 'none' }} />
        {section === 'browser' && opening ? <div className="memmy-browser-loading">{t("browser.opening")}</div> : null}
        {section === 'settings' && !hidden && active ? (
          <div className="memmy-browser-settings">
            <h2>{t("browser.title")}</h2><p>{t("browser.settings.description")}</p>
            <h3>{t("browser.settings.general")}</h3>
            <label>{t("browser.settings.webLinks")}
              <select value={preferences.webLinks} onChange={event => savePreferences({ ...preferences, webLinks: event.target.value as BrowserPreferences['webLinks'] })}>
                <option value="system">{t("browser.settings.systemBrowser")}</option><option value="memmy">Memmy</option>
              </select>
            </label>
            <label>{t("browser.settings.localLinks")}
              <select value={preferences.localLinks} onChange={event => savePreferences({ ...preferences, localLinks: event.target.value as BrowserPreferences['localLinks'] })}>
                <option value="memmy">Memmy</option><option value="system">{t("browser.settings.systemBrowser")}</option>
              </select>
            </label>
            <label>{t("browser.settings.fullUrl")}
              <input type="checkbox" checked={preferences.showFullUrl} onChange={event => savePreferences({ ...preferences, showFullUrl: event.target.checked })} />
            </label>
            <div className="memmy-browser-settings-row"><span>{t("browser.settings.browsingData")}</span><button type="button" onClick={() => setSection('clearData')}><Trash2 size={14} /> {t("browser.settings.clearData")}</button></div>
            <div className="memmy-browser-settings-row"><span>{t("browser.history")}</span><button type="button" onClick={() => setSection('history')}>{t("browser.settings.manage")}</button></div>
            <BrowserAgentSettings />
          </div>
        ) : null}
        {section === 'clearData' ? (
          <div className="memmy-browser-settings">
            <h2>{t('browser.settings.clearData')}</h2>
            {BROWSER_DATA_CATEGORIES.map(category => <label className="memmy-browser-check" key={category}>
              <input type="checkbox" checked={clearCategories.includes(category)} onChange={event => setClearCategories(current =>
                event.target.checked ? [...current, category] : current.filter(item => item !== category))} />
              <span>{t(`browser.clear.${category}`)}</span>
            </label>)}
            <button type="button" className="memmy-browser-page-action" disabled={!clearCategories.length} onClick={() => void clearBrowsingData(clearCategories)}>
              {t('browser.clear.selected')}
            </button>
          </div>
        ) : null}
        {section === 'history' ? (
          <div className="memmy-browser-history">
            <h2>{t("browser.history")}</h2>
            <input aria-label={t("browser.history.search")} value={query} onChange={event => setQuery(event.target.value)} placeholder={t("browser.history.search")} />
            <div className="memmy-browser-history-toolbar">
            <select aria-label={t('browser.history.source')} value={historySource} onChange={event => setHistorySource(event.target.value as typeof historySource)}>
              <option value="all">{t('browser.history.source.all')}</option>
              <option value="agent">{t('browser.history.source.agent')}</option>
              <option value="other">{t('browser.history.source.other')}</option>
            </select>
            <button type="button" disabled={!selectedHistoryIds.length} onClick={() => {
              void (async () => {
                if (!window.memmy?.removeSelectedBrowserHistory
                  || await window.memmy.removeSelectedBrowserHistory(selectedHistoryIds) !== selectedHistoryIds.length) {
                  setError(t('browser.error.deleteHistory')); return;
                }
                const selected = new Set(selectedHistoryIds);
                setHistory(current => current.filter(item => !selected.has(item.id ?? item.url)));
                setSelectedHistoryIds([]);
              })().catch(() => setError(t('browser.error.deleteHistory')));
            }}>{t('browser.history.removeSelected')}</button>
            </div>
            <div className="memmy-browser-history-list">
            {visibleHistory.length ? visibleHistory.map(entry => (
              <div className="memmy-browser-history-entry" key={entry.id ?? entry.url}>
                <input className="memmy-browser-history-entry__check" type="checkbox" aria-label={t('browser.history.select', { title: entry.title })}
                  checked={selectedHistoryIds.includes(entry.id ?? entry.url)} onChange={event => setSelectedHistoryIds(current =>
                    event.target.checked ? [...current, entry.id ?? entry.url] : current.filter(id => id !== (entry.id ?? entry.url)))} />
                <button type="button" className="memmy-browser-history-entry__main" onClick={() => void navigate(entry.url)} title={entry.url}>
                  <strong>{entry.title}</strong>
                  <span>{entry.url}</span>
                </button>
                <span className="memmy-browser-history-entry__source">{t(`browser.history.source.${entry.visitSource ?? 'other'}`)}</span>
                <button type="button" className="memmy-browser-history-entry__delete" aria-label={t("browser.history.delete", { title: entry.title })} onClick={() => {
                  void (async () => {
                    const id = entry.id ?? entry.url;
                    if (!window.memmy?.removeBrowserHistory || !await window.memmy.removeBrowserHistory(id)) {
                      setError(t('browser.error.deleteHistory')); return;
                    }
                    const updated = history.filter(item => (item.id ?? item.url) !== id);
                    setHistory(updated);
                    setSelectedHistoryIds(current => current.filter(selectedId => selectedId !== id));
                  })().catch(() => setError(t('browser.error.deleteHistory')));
                }}><Trash2 size={14} /></button>
              </div>
            )) : <p>{t("browser.history.empty")}</p>}
            </div>
          </div>
        ) : null}
      </div>
      {section === 'browser' && pageTitle ? <span className="memmy-browser-status" title={pageUrl}>{pageTitle}</span> : null}
    </div>
  );
}
