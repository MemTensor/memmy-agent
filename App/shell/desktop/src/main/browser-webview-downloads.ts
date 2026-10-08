import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DownloadItem, Session } from 'electron';
import { BrowserDownloadCatalog, type BrowserDownloadEntry } from './browser-download-catalog.js';
import { BrowserDownloadSettings } from './browser-download-settings.js';

export type BrowserDownloadAction = 'pause' | 'resume' | 'cancel';
type LiveDownload = { id: string; name: string; url: string; startedAt: number; item: DownloadItem;
  status: 'started' | 'in_progress' | 'paused'; cancelRequested: boolean;
  updated: (event: Electron.Event, state: 'progressing' | 'interrupted') => void;
  done: (event: Electron.Event, state: 'completed' | 'cancelled' | 'interrupted') => void };

function safeFilename(value: string): string {
  const name = path.win32.basename(path.posix.basename(value)).replace(/[\x00-\x1f]/g, '').trim();
  return name && name !== '.' && name !== '..' ? name.slice(0, 255) : 'download';
}

function availablePath(directory: string, name: string): string {
  const parsed = path.parse(name);
  let candidate = path.join(directory, name);
  for (let suffix = 2; fs.existsSync(candidate); suffix++) {
    candidate = path.join(directory, `${parsed.name} (${suffix})${parsed.ext}`);
  }
  return candidate;
}

function itemValue(item: DownloadItem, method: 'getReceivedBytes' | 'getTotalBytes'): number {
  try {
    const value = item[method]();
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch { return 0; }
}

/** Controls only live DownloadItems belonging to the embedded browser partition. */
export class BrowserWebviewDownloads {
  private readonly catalog: BrowserDownloadCatalog;
  private readonly settings: BrowserDownloadSettings;
  private readonly live = new Map<string, LiveDownload>();
  private updateTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly browserSession: Session, agentDataDirectory: string,
    private readonly onChange: (entries: BrowserDownloadEntry[]) => void = () => undefined) {
    this.catalog = new BrowserDownloadCatalog(agentDataDirectory, 'webview');
    this.settings = new BrowserDownloadSettings(agentDataDirectory);
    browserSession.on('will-download', this.onDownload);
  }

  private readonly onDownload = (_event: Electron.Event, item: DownloadItem): void => {
    const id = randomUUID();
    const name = safeFilename(item.getFilename());
    const preference = this.settings.read();
    if (preference.askBeforeDownload) {
      fs.mkdirSync(this.catalog.directory, { recursive: true, mode: 0o700 });
      item.setSaveDialogOptions({ defaultPath: path.join(preference.directory ?? this.catalog.directory, name) });
    } else if (preference.directory) {
      item.setSavePath(availablePath(preference.directory, name));
    } else {
      const folder = path.join(this.catalog.directory, id);
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      item.setSavePath(path.join(folder, name));
    }
    const live: LiveDownload = {
      id, name, url: item.getURL(), startedAt: Date.now(), item, status: 'started', cancelRequested: false,
      updated: (_updatedEvent, state) => {
        live.status = state === 'interrupted' || item.isPaused() ? 'paused' : 'in_progress';
        this.publish(false);
      },
      done: (_doneEvent, state) => {
        item.removeListener('updated', live.updated);
        this.live.delete(id);
        this.recordTerminal(live, state);
        this.publish(true);
      },
    };
    this.live.set(id, live);
    item.on('updated', live.updated);
    item.once('done', live.done);
    this.publish(true);
  };

  private recordTerminal(live: LiveDownload, state: 'completed' | 'cancelled' | 'interrupted'): void {
    const status = state === 'completed' ? 'complete' : state === 'cancelled' ? 'canceled' : 'failed';
    const saved = live.item.getSavePath();
    const name = saved && path.isAbsolute(saved) ? safeFilename(path.basename(saved)) : live.name;
    const entry: BrowserDownloadEntry = { id: live.id, name, relativePath: '', url: live.url,
      downloadedAt: Date.now(), status, receivedBytes: itemValue(live.item, 'getReceivedBytes'),
      totalBytes: itemValue(live.item, 'getTotalBytes') };
    if (saved && path.isAbsolute(saved)) {
      const defaultFolder = path.join(this.catalog.directory, live.id);
      if (path.dirname(saved) === defaultFolder) entry.relativePath = path.join(live.id, name);
      else {
        try {
          this.settings.remember(path.dirname(saved));
          entry.relativePath = name;
          entry.rootDirectory = path.dirname(saved);
        } catch { /* Keep the terminal record without a revealable path. */ }
      }
    }
    try { this.catalog.record(entry); }
    catch {
      try { this.catalog.record({ ...entry, relativePath: '', rootDirectory: undefined }); }
      catch { /* Disk failure leaves this result unavailable after restart. */ }
    }
  }

  private snapshot(live: LiveDownload): BrowserDownloadEntry {
    const { item } = live;
    return { id: live.id, name: live.name, relativePath: '', url: live.url,
      downloadedAt: live.startedAt, status: live.status, fileExists: false,
      receivedBytes: itemValue(item, 'getReceivedBytes'), totalBytes: itemValue(item, 'getTotalBytes'),
      canPause: !live.cancelRequested && (live.status === 'in_progress' || live.status === 'started'),
      canResume: !live.cancelRequested && live.status === 'paused' && item.canResume(),
      canCancel: !live.cancelRequested };
  }

  list(): BrowserDownloadEntry[] {
    return [...this.live.values()].map(entry => this.snapshot(entry))
      .concat(this.catalog.list()).sort((a, b) => b.downloadedAt - a.downloadedAt);
  }

  control(id: string, action: BrowserDownloadAction): boolean {
    if (typeof id !== 'string' || !/^[a-f\d-]{36}$/i.test(id)) return false;
    const live = this.live.get(id);
    if (!live || live.cancelRequested) return false;
    if (action === 'pause') {
      if (live.status !== 'started' && live.status !== 'in_progress') return false;
      live.item.pause();
      live.status = 'paused';
    } else if (action === 'resume') {
      if (live.status !== 'paused' || !live.item.canResume()) return false;
      live.item.resume();
      live.status = 'in_progress';
    } else if (action === 'cancel') {
      live.cancelRequested = true;
      live.item.cancel();
    } else return false;
    this.publish(true);
    return true;
  }

  private publish(immediate: boolean): void {
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = null;
    if (immediate) { this.notify(); return; }
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null;
      this.notify();
    }, 150);
    this.updateTimer.unref?.();
  }

  private notify(): void {
    try { this.onChange(this.list()); }
    catch { /* Renderer updates cannot interrupt a browser download. */ }
  }

  dispose(): void {
    this.browserSession.removeListener('will-download', this.onDownload);
    if (this.updateTimer) clearTimeout(this.updateTimer);
    this.updateTimer = null;
    for (const live of this.live.values()) {
      live.item.removeListener('updated', live.updated);
      live.item.removeListener('done', live.done);
    }
    this.live.clear();
  }
}

/** Legacy attachment entrypoint for callers that only need persistence. */
export function attachBrowserWebviewDownloads(browserSession: Session, agentDataDirectory: string): () => void {
  const manager = new BrowserWebviewDownloads(browserSession, agentDataDirectory);
  return () => manager.dispose();
}
