import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type BrowserDownloadSettingsValue = {
  directory: string | null;
  approvedDirectories: string[];
  askBeforeDownload: boolean;
};

function validDirectory(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096
    && path.isAbsolute(value) && !value.includes('\0');
}

/** A directory is added only after the main process's native folder picker returns it. */
export class BrowserDownloadSettings {
  readonly filePath: string;

  constructor(agentDataDirectory: string) {
    this.filePath = path.join(agentDataDirectory, 'browser-use', 'download-settings.json');
  }

  read(): BrowserDownloadSettingsValue {
    try {
      if (fs.statSync(this.filePath).size > 64 * 1024) throw new Error('oversized settings');
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Record<string, unknown>;
      const approvedDirectories = Array.isArray(parsed.approvedDirectories)
        ? [...new Set(parsed.approvedDirectories.filter(validDirectory).map(value => path.resolve(value)))].slice(-20)
        : [];
      const directory = validDirectory(parsed.directory) ? path.resolve(parsed.directory) : null;
      return { directory: directory && approvedDirectories.includes(directory) ? directory : null,
        approvedDirectories, askBeforeDownload: parsed.askBeforeDownload === true };
    } catch { return { directory: null, approvedDirectories: [], askBeforeDownload: false }; }
  }

  select(directory: string | null): BrowserDownloadSettingsValue {
    if (directory !== null && (!validDirectory(directory) || !fs.statSync(directory).isDirectory())) {
      throw new Error('Invalid browser download directory');
    }
    const previous = this.read();
    const selected = directory === null ? null : path.resolve(directory);
    const approvedDirectories = selected
      ? [...new Set([...previous.approvedDirectories, selected])].slice(-20)
      : previous.approvedDirectories;
    const next = { directory: selected, approvedDirectories, askBeforeDownload: previous.askBeforeDownload };
    this.write(next);
    return next;
  }

  setAskBeforeDownload(askBeforeDownload: boolean): BrowserDownloadSettingsValue {
    if (typeof askBeforeDownload !== 'boolean') throw new Error('Invalid download preference');
    const next = { ...this.read(), askBeforeDownload };
    this.write(next);
    return next;
  }

  remember(directory: string): void {
    if (!validDirectory(directory) || !fs.statSync(directory).isDirectory()) throw new Error('Invalid download directory');
    const value = this.read();
    const approvedDirectories = [...new Set([...value.approvedDirectories, path.resolve(directory)])].slice(-20);
    this.write({ ...value, approvedDirectories });
  }

  private write(next: BrowserDownloadSettingsValue): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.filePath);
      if (process.platform !== 'win32') fs.chmodSync(this.filePath, 0o600);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
}
