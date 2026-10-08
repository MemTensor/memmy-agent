import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Clock3, Download, RotateCw, Settings2, Trash2 } from 'lucide-react';
import { BrowserAutofill } from './browser-autofill.js';
import { BrowserExtensions, type BrowserExtensionActions } from './browser-extensions.js';
import { BrowserUseSitePolicies } from './browser-use-site-policies.js';
import { useTranslation } from '../i18n/use-translation.js';
import './browser-panel.css';

export const MEMMY_BROWSER_OPEN_EVENT = 'memmy:open-browser-url';
export const MEMMY_BROWSER_NEW_TAB_EVENT = 'memmy:new-browser-tab';
export const MEMMY_BROWSER_MOUNTED_EVENT = 'memmy:browser-mounted';
let browserPanelMountCount = 0;
export function hasMountedBrowserPanel(): boolean { return browserPanelMountCount > 0; }
let pendingBrowserUrl: string | null = null;
let pendingNewBrowserUrl: string | null = null;

export function requestBrowserOpen(url: string): void {
  pendingBrowserUrl = url;
  window.dispatchEvent(new CustomEvent(MEMMY_BROWSER_OPEN_EVENT, { detail: { url } }));
}
export function requestBrowserNewTab(url: string): void {
  pendingNewBrowserUrl = url;
  window.dispatchEvent(new Event(MEMMY_BROWSER_OPEN_EVENT));
  window.dispatchEvent(new CustomEvent(MEMMY_BROWSER_NEW_TAB_EVENT, { detail: { url } }));
}
export function takePendingBrowserNewTab(): string | null {
  const url = pendingNewBrowserUrl;
  pendingNewBrowserUrl = null;
  return url;
}
export function hasPendingBrowserOpen(): boolean {
  return pendingBrowserUrl !== null || pendingNewBrowserUrl !== null;
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
const browserExtensionActions: BrowserExtensionActions = {
  list: () => window.memmy?.getBrowserWebviewExtensions?.() ?? Promise.reject(new Error('Unavailable')),
  install: () => window.memmy?.installBrowserWebviewExtension?.() ?? Promise.reject(new Error('Unavailable')),
  reapprove: id => window.memmy?.reapproveBrowserWebviewExtension?.(id) ?? Promise.reject(new Error('Unavailable')),
  remove: id => window.memmy?.removeBrowserWebviewExtension?.(id) ?? Promise.reject(new Error('Unavailable')),
};
export type BrowserDownloadEntry = MemmyBrowserDownloadEntry;
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
function displayAddress(url: string, full: boolean): string {
  if (!url || url === 'about:blank') return '';
  if (full) return url;
  try { return new URL(url).host; }
  catch { return url; }
}
function siteOrigin(url: string | undefined): string | null {
  try {
    const parsed = new URL(url ?? '');
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch { return null; }
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
  const [webviewTabId, setWebviewTabId] = useState<number | null>(null);
  const historyMigration = useRef<Promise<boolean> | null>(null);
  const webviewReady = useRef(false);
  const pendingNavigation = useRef<string | null>(null);
  const [pageUrl, setPageUrl] = useState(initialUrl.current);
  const [pageTitle, setPageTitle] = useState('');
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [address, setAddress] = useState(displayAddress(initialUrl.current, readBrowserPreferences().showFullUrl));
  const [section, setSection] = useState<'browser' | 'settings' | 'clearData' | 'history' | 'downloads' | 'passwords' | 'contact' | 'extensions' | 'sitePolicies'>('browser');
  const [preferences, setPreferences] = useState(readBrowserPreferences);
  const [history, setHistory] = useState<BrowserHistoryEntry[]>([]);
  const [selectedHistoryIds, setSelectedHistoryIds] = useState<string[]>([]);
  const [historySource, setHistorySource] = useState<'all' | 'agent' | 'other'>('all');
  const [clearCategories, setClearCategories] = useState<BrowserDataCategory[]>(BROWSER_DATA_CATEGORIES);
  const [downloads, setDownloads] = useState<BrowserDownloadEntry[]>([]);
  const [downloadDirectory, setDownloadDirectory] = useState<string | null>(null);
  const [askBeforeDownload, setAskBeforeDownload] = useState(false);
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
    if (section !== 'downloads') return;
    let active = true;
    let receivedUpdate = false;
    const unsubscribe = window.memmy?.onBrowserDownloadsUpdate?.(entries => {
      if (active) { receivedUpdate = true; setDownloads(entries); }
    });
    void window.memmy?.getBrowserDownloads?.().then(entries => {
      if (active && !receivedUpdate) setDownloads(entries);
    }).catch(() => { if (active) setError(t("browser.error.downloads")); });
    return () => { active = false; unsubscribe?.(); };
  }, [section]);

  useEffect(() => {
    if (section !== 'settings') return;
    let active = true;
    void window.memmy?.getBrowserDownloadSettings?.().then(settings => {
      if (active) { setDownloadDirectory(settings.directory); setAskBeforeDownload(settings.askBeforeDownload); }
    }).catch(() => { if (active) setError(t("browser.error.downloadLocation")); });
    return () => { active = false; };
  }, [section]);

  useEffect(() => {
    const view = webviewRef.current;
    if (!view || !window.memmy) return;
    const updateNavigation = () => {
      const url = view.getURL();
      setPageUrl(url);
      setPageTitle(view.getTitle());
      onNavigationRef.current?.(url, view.getTitle());
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
        setWebviewTabId(tabId);
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
      if (categories.includes('downloadHistory')) setDownloads([]);
      setSection('settings');
      setError('');
    } catch { setError(t("browser.error.clear")); }
  }
  async function chooseDownloadDirectory(reset = false): Promise<void> {
    try {
      const action = reset ? window.memmy?.resetBrowserDownloadDirectory : window.memmy?.chooseBrowserDownloadDirectory;
      if (!action) throw new Error('Download settings unavailable');
      setDownloadDirectory((await action()).directory);
      setError('');
    } catch { setError(t("browser.error.setDownloadLocation")); }
  }
  async function changeAskBeforeDownload(enabled: boolean): Promise<void> {
    try {
      if (!window.memmy?.setBrowserAskBeforeDownload) throw new Error('Download settings unavailable');
      const settings = await window.memmy.setBrowserAskBeforeDownload(enabled);
      setAskBeforeDownload(settings.askBeforeDownload); setError('');
    } catch { setError(t("browser.error.setDownloadLocation")); }
  }

  const visibleHistory = history.filter(entry =>
    (historySource === 'all' || (entry.visitSource ?? 'other') === historySource)
    && `${entry.title} ${entry.url}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  const currentOrigin = siteOrigin(pageUrl);
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
        <form onSubmit={submitAddress}><input aria-label={t("browser.address")} value={address}
          onFocus={event => { addressFocused.current = true; setAddress(pageUrl || address); event.currentTarget.select(); }}
          onBlur={() => { addressFocused.current = false; setAddress(displayAddress(pageUrl || address, preferences.showFullUrl)); }}
          onChange={event => setAddress(event.target.value)} placeholder={t("browser.addressPlaceholder")} /></form>
        <button type="button" aria-label={t("browser.history")} title={t("browser.history")} onClick={() => setSection(section === 'history' ? 'browser' : 'history')}><Clock3 size={16} /></button>
        <button type="button" aria-label={t("browser.downloads")} title={t("browser.downloads")} onClick={() => setSection(section === 'downloads' ? 'browser' : 'downloads')}><Download size={16} /></button>
        <button type="button" aria-label={t("browser.settings")} title={t("browser.settings")} onClick={() => setSection(section === 'settings' ? 'browser' : 'settings')}><Settings2 size={16} /></button>
      </div>
      {error ? <div className="memmy-browser-error" role="alert">{error}</div> : null}
      <div className="memmy-browser-content">
        <webview ref={webviewRef} className="memmy-browser-webview" src={initialUrl.current || 'about:blank'}
          partition="persist:memmy-browser" style={section === 'browser'
            ? { display: 'flex' }
            : { position: 'fixed', left: -10_000, top: 0, width: 800, height: 600,
              opacity: 0, pointerEvents: 'none' }} />
        {section === 'browser' && opening ? <div className="memmy-browser-loading">{t("browser.opening")}</div> : null}
        {section === 'settings' ? (
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
            <div className="memmy-browser-settings-row"><span>{t("browser.downloads")}</span><button type="button" onClick={() => setSection('downloads')}>{t("browser.settings.manage")}</button></div>
            <div className="memmy-browser-settings-row"><span>{t('browser.extensions.title')}</span><button type="button" onClick={() => setSection('extensions')}>{t('browser.settings.manage')}</button></div>
            <div className="memmy-browser-settings-row"><span>{t('browser.policy.title')}</span><button type="button" onClick={() => setSection('sitePolicies')}>{t('browser.settings.manage')}</button></div>
            <div className="memmy-browser-settings-row"><span>{t('browser.autofill.passwords')}</span><button type="button" onClick={() => setSection('passwords')}>{t('browser.settings.manage')}</button></div>
            <div className="memmy-browser-settings-row"><span>{t('browser.autofill.contact')}</span><button type="button" onClick={() => setSection('contact')}>{t('browser.settings.manage')}</button></div>
            <div className="memmy-browser-settings-row"><span>{t("browser.settings.downloadLocation")}<br /><small title={downloadDirectory ?? undefined}>{downloadDirectory ?? t("browser.settings.defaultLocation")}</small></span>
              <span className="memmy-browser-settings-actions"><button type="button" onClick={() => void chooseDownloadDirectory()}>{t("browser.settings.changeLocation")}</button>
                {downloadDirectory ? <button type="button" onClick={() => void chooseDownloadDirectory(true)}>{t("browser.settings.resetLocation")}</button> : null}</span></div>
            <label>{t("browser.settings.askBeforeDownload")}
              <input type="checkbox" checked={askBeforeDownload} onChange={event => void changeAskBeforeDownload(event.target.checked)} />
            </label>
          </div>
        ) : null}
        {section === 'passwords' || section === 'contact' ? <BrowserAutofill
          section={section} origin={currentOrigin} sessionKey={null}
          tabId={active && webviewReady.current ? webviewTabId : null} /> : null}
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
        {section === 'downloads' ? (
          <div className="memmy-browser-history">
            <h2>{t("browser.downloads")}</h2>
            {downloads.length ? <div className="memmy-browser-history-list">{downloads.map(entry => {
              const status = entry.status ?? 'complete';
              const active = status === 'started' || status === 'in_progress' || status === 'paused';
              const progress = entry.totalBytes && entry.totalBytes > 0
                ? Math.min(100, Math.round((entry.receivedBytes ?? 0) / entry.totalBytes * 100)) : null;
              const statusLabel = status === 'complete' && entry.fileExists === false
                ? t('browser.downloads.deleted')
                : t(`browser.downloads.status.${status}`);
              return (
              <div className="memmy-browser-history-entry memmy-browser-download-entry" key={entry.id}>
                {status === 'complete' && entry.fileExists !== false ? <button type="button" className="memmy-browser-history-entry__main" onClick={() => {
                  void window.memmy?.revealBrowserDownload?.(entry.id).then(found => {
                    if (!found) setError(t("browser.downloads.missing"));
                  }).catch(() => setError(t("browser.downloads.revealFailed")));
                }} title={entry.url}><strong>{entry.name}</strong><span>{entry.url}</span></button>
                  : <div className="memmy-browser-history-entry__main" title={entry.url}><strong>{entry.name}</strong><span>{entry.url}</span></div>}
                <div className="memmy-browser-download-entry__meta">
                  <span className="memmy-browser-history-entry__source">{statusLabel}</span>
                  {active && progress !== null ? <progress value={progress} max={100} aria-label={t('browser.downloads.progress', { name: entry.name })} /> : null}
                  {active && progress !== null ? <span className="memmy-browser-download-entry__percent">{progress}%</span> : null}
                  {active && entry.canPause ? <button type="button" aria-label={t('browser.downloads.pause', { name: entry.name })}
                    onClick={() => { void window.memmy?.controlBrowserDownload?.(entry.id, 'pause').then(ok => {
                      if (!ok) setError(t('browser.error.controlDownload'));
                    }).catch(() => setError(t('browser.error.controlDownload'))); }}>{t('browser.downloads.pauseButton')}</button> : null}
                  {active && entry.canResume ? <button type="button" aria-label={t('browser.downloads.resume', { name: entry.name })}
                    onClick={() => { void window.memmy?.controlBrowserDownload?.(entry.id, 'resume').then(ok => {
                      if (!ok) setError(t('browser.error.controlDownload'));
                    }).catch(() => setError(t('browser.error.controlDownload'))); }}>{t('browser.downloads.resumeButton')}</button> : null}
                  {active && entry.canCancel ? <button type="button" aria-label={t('browser.downloads.cancel', { name: entry.name })}
                    onClick={() => { void window.memmy?.controlBrowserDownload?.(entry.id, 'cancel').then(ok => {
                      if (!ok) setError(t('browser.error.controlDownload'));
                    }).catch(() => setError(t('browser.error.controlDownload'))); }}>{t('browser.downloads.cancelButton')}</button> : null}
                  {!active ? <button type="button" className="memmy-browser-history-entry__delete" aria-label={t('browser.downloads.removeRecord', { name: entry.name })} onClick={() => {
                    void (async () => {
                      if (!window.memmy?.removeBrowserDownloadRecord || !await window.memmy.removeBrowserDownloadRecord(entry.id)) {
                        setError(t('browser.error.removeDownloadRecord')); return;
                      }
                      setDownloads(current => current.filter(item => item.id !== entry.id));
                    })().catch(() => setError(t('browser.error.removeDownloadRecord')));
                  }}><Trash2 size={14} /></button> : null}
                </div>
              </div>
            ); })}</div> : <p>{t("browser.downloads.empty")}</p>}
          </div>
        ) : null}
        {section === 'extensions' ? <BrowserExtensions actions={browserExtensionActions} labels={{
          title: t('browser.extensions.title'), description: t('browser.extensions.description'),
          permissionNotice: t('browser.extensions.permissionNotice'), install: t('browser.extensions.install'),
          empty: t('browser.extensions.empty'), loaded: t('browser.extensions.loaded'),
          unavailable: t('browser.extensions.unavailable'), needsReapproval: t('browser.extensions.needsReapproval'),
          reapprove: t('browser.extensions.reapprove'), remove: t('browser.extensions.remove'),
          loadFailed: t('browser.extensions.loadFailed'), actionFailed: t('browser.extensions.actionFailed'),
        }} /> : null}
        {section === 'sitePolicies' ? <BrowserUseSitePolicies /> : null}
      </div>
      {section === 'browser' && pageTitle ? <span className="memmy-browser-status" title={pageUrl}>{pageTitle}</span> : null}
    </div>
  );
}
