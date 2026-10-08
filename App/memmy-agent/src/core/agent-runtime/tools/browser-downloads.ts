import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Download } from 'playwright';
import { BROWSER_DOWNLOAD_REQUEST, isBrowserDownloadResult } from '@memmy/local-api-contracts';
import { getDataDir } from '../../../config/paths.js';

export type BrowserDownloadEntry = {
  id: string;
  name: string;
  relativePath: string;
  url: string;
  downloadedAt: number;
  rootDirectory?: string;
};

const MAX_DOWNLOADS = 500;

function safeFileName(value: string): string {
  const name = path.basename(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 120);
  return name || 'download';
}

/** Persist browser downloads and a small local index independent of Playwright's temporary context. */
export class BrowserDownloadStore {
  readonly directory: string;
  readonly indexPath: string;
  readonly settingsPath: string;
  private pending: Promise<void> = Promise.resolve();
  private historyGeneration = 0;

  constructor(directory = path.join(getDataDir(), 'browser-use', 'downloads'),
    private readonly approveDownload: (pageUrl: string, name: string) => Promise<boolean> = async () => false,
    private readonly isBlocked: (pageUrl: string) => boolean = () => false) {
    this.directory = directory;
    this.indexPath = path.join(path.dirname(directory), 'downloads.json');
    this.settingsPath = path.join(path.dirname(directory), 'download-settings.json');
  }

  private selectedDirectory(): string {
    try {
      const raw = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8')) as Record<string, unknown>;
      if (typeof raw.directory === 'string' && path.isAbsolute(raw.directory)
        && raw.directory.length <= 4096 && !raw.directory.includes('\0')
        && Array.isArray(raw.approvedDirectories)
        && raw.approvedDirectories.includes(raw.directory)
        && fs.statSync(raw.directory).isDirectory()) return path.resolve(raw.directory);
    } catch { /* Use the managed directory when no custom folder is selected. */ }
    return this.directory;
  }

  private askBeforeDownload(): boolean {
    try {
      const raw = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8')) as Record<string, unknown>;
      return raw.askBeforeDownload === true;
    } catch { return false; }
  }

  private requestSavePath(name: string, url: string): Promise<string | null> {
    if (!process.send || !process.connected) return Promise.resolve(null);
    const requestId = randomUUID();
    return new Promise(resolve => {
      const cleanup = () => { clearTimeout(timeout); process.removeListener('message', onMessage); };
      const onMessage = (value: unknown) => {
        if (!isBrowserDownloadResult(value) || value.requestId !== requestId) return;
        cleanup(); resolve(value.filePath);
      };
      const timeout = setTimeout(() => { cleanup(); resolve(null); }, 55_000);
      timeout.unref?.();
      process.on('message', onMessage);
      try {
        process.send!({ type: BROWSER_DOWNLOAD_REQUEST, requestId, name, url: url.slice(0, 4096) }, error => {
          if (error) { cleanup(); resolve(null); }
        });
      } catch { cleanup(); resolve(null); }
    });
  }

  list(): BrowserDownloadEntry[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexPath, 'utf8')) as unknown;
      if (!Array.isArray(raw)) return [];
      return raw.filter((entry): entry is BrowserDownloadEntry => Boolean(entry
        && typeof entry === 'object' && typeof entry.id === 'string'
        && typeof entry.name === 'string' && typeof entry.relativePath === 'string'
        && typeof entry.url === 'string' && typeof entry.downloadedAt === 'number'))
        .slice(0, MAX_DOWNLOADS);
    } catch { return []; }
  }

  async save(download: Pick<Download, 'suggestedFilename' | 'url' | 'saveAs'>,
    pageUrl: string): Promise<BrowserDownloadEntry> {
    const generation = this.historyGeneration;
    const id = randomUUID();
    const name = safeFileName(download.suggestedFilename());
    if (!await this.approveDownload(pageUrl, name)) throw new Error('Browser download was not approved');
    const askBeforeDownload = this.askBeforeDownload();
    const selected = askBeforeDownload ? await this.requestSavePath(name, download.url()) : null;
    if (askBeforeDownload && !selected) throw new Error('Browser download canceled');
    if (selected && (!path.isAbsolute(selected) || selected.length > 4096
      || !path.basename(selected) || path.basename(selected).length > 255))
      throw new Error('Invalid browser download destination');
    const rootDirectory = selected ? path.dirname(selected) : this.selectedDirectory();
    if (this.isBlocked(pageUrl)) throw new Error('Browser download was blocked by site policy');
    const actualName = selected ? path.basename(selected) : name;
    const relativePath = selected ? actualName : path.join(id, name);
    const targetDirectory = selected ? null : path.join(rootDirectory, id);
    const target = selected ?? path.join(targetDirectory!, name);
    if (targetDirectory) fs.mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
    try { await download.saveAs(target); }
    catch (error) {
      if (targetDirectory) fs.rmSync(targetDirectory, { recursive: true, force: true });
      throw error;
    }
    const entry: BrowserDownloadEntry = { id, name: actualName, relativePath, url: download.url(), downloadedAt: Date.now(),
      ...(rootDirectory !== this.directory || selected ? { rootDirectory } : {}) };
    const record = this.pending.then(() => {
      if (generation !== this.historyGeneration) return;
      this.writeIndex([entry, ...this.list()].slice(0, MAX_DOWNLOADS));
    });
    this.pending = record.catch(() => undefined);
    await record;
    return entry;
  }

  clearHistory(): Promise<void> {
    this.historyGeneration += 1;
    const next = this.pending.then(() => { fs.rmSync(this.indexPath, { force: true }); });
    this.pending = next.catch(() => undefined);
    return next;
  }

  private writeIndex(entries: BrowserDownloadEntry[]): void {
    const directory = path.dirname(this.indexPath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.indexPath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(entries), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.indexPath);
      if (process.platform !== 'win32') fs.chmodSync(this.indexPath, 0o600);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
}
