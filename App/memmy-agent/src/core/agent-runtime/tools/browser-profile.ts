import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrowserContext } from 'playwright';
import { getDataDir } from '../../../config/paths.js';

const MAX_PROFILE_BYTES = 32 * 1024 * 1024;

/** A local Chromium storage state shared by user and Agent browser sessions. */
export class BrowserProfileStore {
  readonly directory: string;
  readonly statePath: string;
  private pending: Promise<void> = Promise.resolve();

  constructor(directory = path.join(getDataDir(), 'browser-use')) {
    this.directory = directory;
    this.statePath = path.join(directory, 'storage-state.json');
  }

  load(): string | undefined {
    try {
      const stat = fs.lstatSync(this.statePath);
      if (!stat.isFile() || stat.size > MAX_PROFILE_BYTES) return undefined;
      const state = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as unknown;
      if (!state || typeof state !== 'object' || Array.isArray(state)) return undefined;
      const record = state as Record<string, unknown>;
      if (!Array.isArray(record.cookies) || !Array.isArray(record.origins)) return undefined;
      return this.statePath;
    } catch { return undefined; }
  }

  save(context: Pick<BrowserContext, 'storageState'>): Promise<void> {
    const write = async () => {
      const state = await context.storageState({ indexedDB: true });
      const contents = JSON.stringify(state);
      if (Buffer.byteLength(contents) > MAX_PROFILE_BYTES) throw new Error('Browser profile is too large');
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const temporary = path.join(this.directory, `storage-state-${randomUUID()}.tmp`);
      try {
        fs.writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, this.statePath);
        if (process.platform !== 'win32') fs.chmodSync(this.statePath, 0o600);
      } finally {
        try { fs.rmSync(temporary, { force: true }); } catch { /* Cleanup only. */ }
      }
    };
    const next = this.pending.then(write);
    this.pending = next.catch(() => undefined);
    return next;
  }

  clear(): Promise<void> {
    const remove = async () => { fs.rmSync(this.statePath, { force: true }); };
    const next = this.pending.then(remove);
    this.pending = next.catch(() => undefined);
    return next;
  }
}
