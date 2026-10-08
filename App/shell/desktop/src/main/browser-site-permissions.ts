import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Only permission types enforced by both Electron session permission handlers.
// USB/HID/serial need separate device selection and device-permission handling.
export const BROWSER_SITE_PERMISSIONS = ['camera', 'microphone', 'geolocation', 'notifications',
  'clipboard-read', 'clipboard-write', 'idle-detection', 'midi', 'midiSysex', 'pointerLock'] as const;
export type BrowserSitePermission = typeof BROWSER_SITE_PERMISSIONS[number];
export type BrowserSiteGrants = { origin: string; permissions: BrowserSitePermission[] };

function validOrigin(origin: string): boolean {
  if (origin.length > 320) return false;
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === origin;
  } catch { return false; }
}

/** Edits explicit website grants used by the Agent and embedded browser. */
export class BrowserSitePermissions {
  readonly filePath: string;

  constructor(agentDataDirectory: string) {
    this.filePath = path.join(agentDataDirectory, 'browser-use', 'permissions.json');
  }

  list(): BrowserSiteGrants[] {
    try {
      if (fs.statSync(this.filePath).size > 128 * 1024) return [];
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as unknown;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
      return Object.entries(raw).filter(([origin, permissions]) =>
        validOrigin(origin) && Array.isArray(permissions)
        && permissions.every(permission => BROWSER_SITE_PERMISSIONS.includes(permission)))
        .slice(0, 200).map(([origin, permissions]) => ({
          origin, permissions: permissions as BrowserSitePermission[],
        }));
    } catch { return []; }
  }

  set(origin: string, permission: BrowserSitePermission, allowed: boolean): BrowserSiteGrants[] {
    if (!validOrigin(origin) || !BROWSER_SITE_PERMISSIONS.includes(permission)
      || typeof allowed !== 'boolean') throw new Error('Invalid browser site permission');
    const records = this.list();
    const existing = records.find(record => record.origin === origin);
    if (!existing && records.length >= 200) throw new Error('Browser site permission limit reached');
    const next = new Set(existing?.permissions ?? []);
    if (allowed) next.add(permission);
    else next.delete(permission);
    const updated = records.filter(record => record.origin !== origin);
    if (next.size) updated.push({ origin, permissions: [...next] });
    updated.sort((a, b) => a.origin.localeCompare(b.origin));
    this.write(updated);
    return updated;
  }

  private write(records: BrowserSiteGrants[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary,
        JSON.stringify(Object.fromEntries(records.map(record => [record.origin, record.permissions]))),
        { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.filePath);
      if (process.platform !== 'win32') fs.chmodSync(this.filePath, 0o600);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
}
