import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ComputerUseSurfaceMessage } from '@memmy/local-api-contracts';

export type BrowserVisitSource = 'agent' | 'other';
export type BrowserHistoryEntry = { id?: string; url: string; title: string; visitedAt: number;
  visitSource?: BrowserVisitSource };
type StoredBrowserHistoryEntry = BrowserHistoryEntry & { id: string };
export type BrowserHistoryQuery = { from: number; to: number; keyword: string; limit: number };
const MAX_HISTORY = 500;
const MAX_HISTORY_BYTES = 4 * 1024 * 1024;
const MAX_QUERY_DAYS = 30;
const VISIT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A history read must name a short time window and a search term. */
export function parseBrowserHistoryQuery(value: unknown, now = Date.now()): BrowserHistoryQuery | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['from', 'to', 'keyword', 'limit'].includes(key))
    || typeof input.from !== 'string' || typeof input.to !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(input.from)
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(input.to)
    || typeof input.keyword !== 'string' || input.keyword.trim().length < 2
    || input.keyword.length > 100 || !Number.isInteger(input.limit)
    || (input.limit as number) < 1 || (input.limit as number) > 50) return null;
  const from = Date.parse(input.from), to = Date.parse(input.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to || to > now
    || to - from > MAX_QUERY_DAYS * 24 * 60 * 60 * 1000) return null;
  return { from, to, keyword: input.keyword.trim().toLocaleLowerCase(), limit: input.limit as number };
}

function validEntry(value: unknown): value is BrowserHistoryEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.url !== 'string' || entry.url.length > 4096
    || typeof entry.title !== 'string' || entry.title.length > 256
    || typeof entry.visitedAt !== 'number' || !Number.isFinite(entry.visitedAt)
    || (entry.id !== undefined && (typeof entry.id !== 'string' || !VISIT_ID.test(entry.id)))
    || (entry.visitSource !== undefined && entry.visitSource !== 'agent' && entry.visitSource !== 'other')) return false;
  try { return ['http:', 'https:'].includes(new URL(entry.url).protocol); }
  catch { return false; }
}

/** The desktop keeps browser navigation history even when the sidebar is closed. */
export class BrowserHistoryStore {
  private entries: StoredBrowserHistoryEntry[] = [];
  private readonly lastVisitBySession = new Map<string, string>();
  private readonly lastSurfaceUrlBySession = new Map<string, string>();

  constructor(readonly filePath: string) {
    try {
      if (fs.statSync(filePath).size > MAX_HISTORY_BYTES) return;
      const saved = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
      if (Array.isArray(saved)) {
        const entries = saved.filter(validEntry).slice(0, MAX_HISTORY);
        this.entries = entries.map(entry => ({ ...entry, id: entry.id ?? randomUUID() }));
        if (entries.some(entry => !entry.id)) this.persist();
      }
    } catch { /* Missing or damaged history starts empty. */ }
  }

  list(): BrowserHistoryEntry[] { return this.entries.map(entry => ({ ...entry, visitSource: entry.visitSource ?? 'other' })); }

  query(query: BrowserHistoryQuery): BrowserHistoryEntry[] {
    return this.entries.filter(entry => entry.visitedAt >= query.from && entry.visitedAt <= query.to
      && `${entry.title} ${entry.url}`.toLocaleLowerCase().includes(query.keyword))
      .slice(0, query.limit).map(entry => ({ ...entry, visitSource: entry.visitSource ?? 'other' }));
  }

  /** Import only the old in-app sidebar list; this is never called for browser profiles or projected surfaces. */
  importLegacy(value: unknown): boolean {
    if (!Array.isArray(value) || value.length > MAX_HISTORY) return false;
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_HISTORY_BYTES
      || !value.every(validEntry)) return false;
    // The old sidebar index held only one item per URL. Import each old item
    // once without replacing newer visits already recorded by the host.
    const known = new Set(this.entries.map(entry => JSON.stringify([entry.url, entry.title, entry.visitedAt])));
    const legacyLatest = new Map<string, BrowserHistoryEntry>();
    for (const entry of value) {
      const previous = legacyLatest.get(entry.url);
      if (!previous || entry.visitedAt > previous.visitedAt) legacyLatest.set(entry.url, entry);
    }
    const additions: StoredBrowserHistoryEntry[] = [];
    for (const entry of legacyLatest.values()) {
      const key = JSON.stringify([entry.url, entry.title, entry.visitedAt]);
      if (known.has(key)) continue;
      known.add(key);
      additions.push({ ...entry, id: entry.id ?? randomUUID(), visitSource: entry.visitSource ?? 'other' });
    }
    const merged = [...this.entries, ...additions].sort((a, b) => b.visitedAt - a.visitedAt).slice(0, MAX_HISTORY);
    if (JSON.stringify(merged) === JSON.stringify(this.entries)) return true;
    const original = this.entries;
    this.entries = merged;
    try { this.persist(); }
    catch (error) { this.entries = original; throw error; }
    return true;
  }

  recordVisit(sessionKey: string, url: string, title: string, visitedAt = Date.now(),
    visitSource: BrowserVisitSource = 'other'): void {
    const candidate = { id: randomUUID(), url, title: title.slice(0, 256), visitedAt, visitSource };
    if (!validEntry(candidate)) return;
    this.lastVisitBySession.set(sessionKey, candidate.id);
    this.entries = [candidate, ...this.entries].slice(0, MAX_HISTORY);
    this.persist();
  }

  /** A late title or Agent provenance update belongs to the same navigation. */
  reviseLatestVisit(sessionKey: string, url: string, title: string,
    source?: BrowserVisitSource): void {
    const id = this.lastVisitBySession.get(sessionKey);
    const entry = this.entries.find(candidate => candidate.id === id && candidate.url === url);
    if (!entry) return;
    const nextTitle = title.slice(0, 256);
    if (entry.title === nextTitle && (source === undefined || entry.visitSource === source)) return;
    entry.title = nextTitle;
    if (source) entry.visitSource = source;
    this.persist();
  }

  finishSession(sessionKey: string): void {
    this.lastVisitBySession.delete(sessionKey);
    this.lastSurfaceUrlBySession.delete(sessionKey);
  }

  record(message: ComputerUseSurfaceMessage): void {
    if (message.surface !== 'browser') return;
    if (message.type.endsWith(':close')) {
      this.finishSession(message.sessionKey);
      return;
    }
    if (typeof message.url === 'string' && this.lastSurfaceUrlBySession.get(message.sessionKey) !== message.url) {
      this.lastSurfaceUrlBySession.set(message.sessionKey, message.url);
      this.recordVisit(message.sessionKey, message.url, message.title);
    }
  }

  remove(idOrLegacyUrl: string): boolean {
    if (typeof idOrLegacyUrl !== 'string' || idOrLegacyUrl.length > 4096) return false;
    const next = this.entries.filter(entry => entry.id !== idOrLegacyUrl
      && (VISIT_ID.test(idOrLegacyUrl) || entry.url !== idOrLegacyUrl));
    if (next.length === this.entries.length) return false;
    this.entries = next;
    this.persist();
    return true;
  }

  removeSelected(idsOrLegacyUrls: unknown): number {
    if (!Array.isArray(idsOrLegacyUrls) || !idsOrLegacyUrls.length || idsOrLegacyUrls.length > MAX_HISTORY
      || idsOrLegacyUrls.some(value => typeof value !== 'string' || value.length > 4096
        || (!VISIT_ID.test(value) && !/^https?:\/\//.test(value)))) return 0;
    const selected = new Set(idsOrLegacyUrls);
    const next = this.entries.filter(entry => !selected.has(entry.id) && !selected.has(entry.url));
    const removed = this.entries.length - next.length;
    if (!removed) return 0;
    const original = this.entries;
    this.entries = next;
    try { this.persist(); }
    catch (error) { this.entries = original; throw error; }
    return removed;
  }

  clear(): void {
    this.entries = [];
    this.lastVisitBySession.clear();
    this.lastSurfaceUrlBySession.clear();
    fs.rmSync(this.filePath, { force: true });
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(this.entries), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.filePath);
      if (process.platform !== 'win32') fs.chmodSync(this.filePath, 0o600);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
}
