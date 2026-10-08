import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext } from 'playwright';
import { getDataDir } from '../../../config/paths.js';

const PERMISSIONS = new Set(['camera', 'microphone', 'geolocation', 'notifications']);
type SitePermissionRecord = Record<string, string[]>;

function validOrigin(value: string): boolean {
  if (value.length > 320) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
  } catch { return false; }
}

/** Applies saved, per-origin Chromium grants to each Playwright context. */
export class BrowserSitePermissionStore {
  readonly filePath: string;
  private applied = new WeakMap<BrowserContext, string>();

  constructor(directory = path.join(getDataDir(), 'browser-use')) {
    this.filePath = path.join(directory, 'permissions.json');
  }

  read(): SitePermissionRecord {
    try {
      if (fs.statSync(this.filePath).size > 128 * 1024) return {};
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as unknown;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
      const entries = Object.entries(raw).filter(([origin, permissions]) =>
        validOrigin(origin) && Array.isArray(permissions)
        && permissions.every(permission => typeof permission === 'string' && PERMISSIONS.has(permission)));
      return Object.fromEntries(entries.slice(0, 200));
    } catch { return {}; }
  }

  async apply(context: BrowserContext): Promise<void> {
    const grants = this.read();
    const signature = JSON.stringify(grants);
    if (this.applied.get(context) === signature) return;
    await context.clearPermissions();
    for (const [origin, permissions] of Object.entries(grants)) {
      if (permissions.length) await context.grantPermissions(permissions, { origin });
    }
    this.applied.set(context, signature);
  }

  clear(): void {
    fs.rmSync(this.filePath, { force: true });
    this.applied = new WeakMap();
  }
}
