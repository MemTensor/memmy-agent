import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type BrowserAccessRecord = { origin: string; decision: 'allow' | 'deny' };

export class BrowserAccessStore {
  readonly filePath: string;
  constructor(agentDataDirectory: string) {
    this.filePath = path.join(agentDataDirectory, 'browser-use', 'access.json');
  }
  list(): BrowserAccessRecord[] {
    try {
      if (fs.statSync(this.filePath).size > 128 * 1024) return [];
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as unknown;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
      return Object.entries(raw).filter(([origin, decision]) => {
        try { const url = new URL(origin); return ['http:', 'https:'].includes(url.protocol)
          && url.origin === origin && (decision === 'allow' || decision === 'deny'); }
        catch { return false; }
      }).slice(0, 200).map(([origin, decision]) => ({ origin, decision: decision as 'allow' | 'deny' }));
    } catch { return []; }
  }
  set(origin: string, decision: 'allow' | 'deny' | 'ask'): BrowserAccessRecord[] {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin || origin.length > 320
      || !['allow', 'deny', 'ask'].includes(decision)) throw new Error('Invalid browser access decision');
    const entries = this.list().filter(entry => entry.origin !== origin);
    if (decision !== 'ask') entries.push({ origin, decision });
    if (entries.length > 200) throw new Error('Browser access decision limit reached');
    entries.sort((a, b) => a.origin.localeCompare(b.origin));
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(entries.map(entry => [entry.origin, entry.decision]))),
        { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.filePath);
      if (process.platform !== 'win32') fs.chmodSync(this.filePath, 0o600);
    } finally { fs.rmSync(temporary, { force: true }); }
    return entries;
  }
}
