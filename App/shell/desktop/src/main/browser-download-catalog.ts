import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BrowserDownloadSettings } from './browser-download-settings.js';

export type BrowserDownloadEntry = {
  id: string;
  name: string;
  relativePath: string;
  url: string;
  downloadedAt: number;
  rootDirectory?: string;
  status?: 'started' | 'in_progress' | 'paused' | 'complete' | 'failed' | 'canceled';
  fileExists?: boolean;
  receivedBytes?: number;
  totalBytes?: number;
  canPause?: boolean;
  canResume?: boolean;
  canCancel?: boolean;
};

/** Reads downloads without accepting arbitrary file paths from the renderer. */
export class BrowserDownloadCatalog {
  readonly directory: string;
  readonly indexPath: string;
  private readonly settings: BrowserDownloadSettings;

  constructor(agentDataDirectory: string, source: 'agent' | 'webview' = 'agent') {
    const prefix = source === 'webview' ? 'webview-downloads' : 'downloads';
    this.directory = path.join(agentDataDirectory, 'browser-use', prefix);
    this.indexPath = path.join(agentDataDirectory, 'browser-use', `${prefix}.json`);
    this.settings = new BrowserDownloadSettings(agentDataDirectory);
  }

  /** Persists only terminal metadata; physical files are never copied or deleted here. */
  record(entry: BrowserDownloadEntry): void {
    const normalized = this.validRecord(entry);
    if (!normalized) throw new Error('Invalid browser download');
    const updated = [normalized, ...this.list().filter(previous => previous.id !== entry.id)].slice(0, 500);
    fs.mkdirSync(path.dirname(this.indexPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.indexPath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(updated), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.indexPath);
      if (process.platform !== 'win32') fs.chmodSync(this.indexPath, 0o600);
    } finally { fs.rmSync(temporary, { force: true }); }
  }

  clearHistory(): void {
    fs.rmSync(this.indexPath, { force: true });
  }

  /** Remove a finished download's index entry without touching its saved file. */
  removeRecord(id: string): boolean {
    if (typeof id !== 'string' || !/^[a-f\d-]{36}$/i.test(id)) return false;
    const entries = this.list();
    const remaining = entries.filter(entry => entry.id !== id);
    if (remaining.length === entries.length) return false;
    fs.mkdirSync(path.dirname(this.indexPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.indexPath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(remaining), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.indexPath);
      if (process.platform !== 'win32') fs.chmodSync(this.indexPath, 0o600);
    } finally { fs.rmSync(temporary, { force: true }); }
    return true;
  }

  list(): BrowserDownloadEntry[] {
    try {
      if (fs.statSync(this.indexPath).size > 1024 * 1024) return [];
      const raw = JSON.parse(fs.readFileSync(this.indexPath, 'utf8')) as unknown;
      if (!Array.isArray(raw)) return [];
      return raw.flatMap(entry => {
        const valid = this.validRecord(entry);
        return valid ? [{ ...valid, fileExists: this.pathFor(valid) !== null }] : [];
      }).slice(0, 500);
    } catch { return []; }
  }

  fileForId(id: string): string | null {
    if (typeof id !== 'string' || !/^[a-f\d-]{36}$/i.test(id)) return null;
    const entry = this.list().find(item => item.id === id);
    return entry ? this.pathFor(entry) : null;
  }

  private validRecord(value: unknown): BrowserDownloadEntry | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const entry = value as Record<string, unknown>;
    if (typeof entry.id !== 'string' || !/^[a-f\d-]{36}$/i.test(entry.id)
      || typeof entry.name !== 'string' || !entry.name || entry.name.length > 255
      || entry.name.includes('/') || entry.name.includes('\\')
      || typeof entry.relativePath !== 'string' || typeof entry.url !== 'string'
      || typeof entry.downloadedAt !== 'number' || !Number.isFinite(entry.downloadedAt)) return null;
    const status = entry.status ?? 'complete';
    if (!['complete', 'failed', 'canceled'].includes(String(status))) return null;
    if (entry.relativePath === '') {
      if (entry.rootDirectory !== undefined) return null;
      return { id: entry.id, name: entry.name, relativePath: '', url: entry.url,
        downloadedAt: entry.downloadedAt, status: status as BrowserDownloadEntry['status'],
        ...this.validProgress(entry) };
    }
    const rootDirectory = entry.rootDirectory;
    if (rootDirectory !== undefined && (typeof rootDirectory !== 'string' || !path.isAbsolute(rootDirectory)
      || !this.settings.read().approvedDirectories.includes(path.resolve(rootDirectory)))) return null;
    if (entry.relativePath !== path.join(entry.id, entry.name)
      && !(rootDirectory && entry.relativePath === entry.name)) return null;
    const directory = rootDirectory ?? this.directory;
    const target = path.resolve(directory, entry.relativePath);
    if (!target.startsWith(path.resolve(directory) + path.sep)) return null;
    return { id: entry.id, name: entry.name, relativePath: entry.relativePath, url: entry.url,
      downloadedAt: entry.downloadedAt, status: status as BrowserDownloadEntry['status'],
      ...(rootDirectory ? { rootDirectory } : {}), ...this.validProgress(entry) };
  }

  private validProgress(entry: Record<string, unknown>): Pick<BrowserDownloadEntry, 'receivedBytes' | 'totalBytes'> {
    const bytes = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    return {
      ...(bytes(entry.receivedBytes) ? { receivedBytes: entry.receivedBytes as number } : {}),
      ...(bytes(entry.totalBytes) ? { totalBytes: entry.totalBytes as number } : {}),
    };
  }

  private pathFor(value: unknown): string | null {
    const entry = this.validRecord(value);
    if (!entry || !entry.relativePath) return null;
    const directory = entry.rootDirectory ?? this.directory;
    const target = path.resolve(directory, entry.relativePath);
    try {
      if (!fs.lstatSync(target).isFile()) return null;
      const realDirectory = fs.realpathSync(directory);
      const realTarget = fs.realpathSync(target);
      return realTarget.startsWith(realDirectory + path.sep) ? target : null;
    }
    catch { return null; }
  }
}
