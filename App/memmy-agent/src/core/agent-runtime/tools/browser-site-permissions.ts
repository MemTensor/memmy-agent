import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext } from 'playwright';
import { parseBrowserTaskSitePermission, type BrowserTaskSitePermissionRequest } from '@memmy/local-api-contracts';
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
  private overrides = new WeakMap<BrowserContext, Map<string, Map<string, boolean>>>();

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
        && permissions.every(permission => typeof permission === 'string'))
        .map(([origin, permissions]) => [origin, (permissions as string[]).filter(permission => PERMISSIONS.has(permission))]);
      return Object.fromEntries(entries.slice(0, 200));
    } catch { return {}; }
  }

  async apply(context: BrowserContext): Promise<void> {
    const grants = this.read();
    for (const [origin, permissions] of this.overrides.get(context) ?? []) {
      const allowed = new Set(grants[origin] ?? []);
      for (const [permission, enabled] of permissions) {
        if (enabled) allowed.add(permission); else allowed.delete(permission);
      }
      grants[origin] = [...allowed];
    }
    const signature = JSON.stringify(grants);
    if (this.applied.get(context) === signature) return;
    this.applied.delete(context);
    await context.clearPermissions();
    for (const [origin, permissions] of Object.entries(grants)) {
      if (permissions.length) await context.grantPermissions(permissions, { origin });
    }
    this.applied.set(context, signature);
  }

  /** An explicit operation changes only this task context and this exact origin. */
  async setForContext(context: BrowserContext, input: BrowserTaskSitePermissionRequest,
    assertCurrent: () => void = () => undefined): Promise<void> {
    const request = parseBrowserTaskSitePermission(input);
    if (!request) throw new Error('Invalid browser site permission');
    assertCurrent();
    const previous = this.overrides.get(context);
    const updated = new Map([...(previous ?? [])].map(([origin, permissions]) => [origin, new Map(permissions)]));
    const permissions = updated.get(request.origin) ?? new Map<string, boolean>();
    permissions.set(request.permission, request.allow);
    updated.set(request.origin, permissions);
    this.overrides.set(context, updated);
    try {
      await this.apply(context);
      assertCurrent();
    } catch (error) {
      if (previous) this.overrides.set(context, previous); else this.overrides.delete(context);
      this.applied.delete(context);
      await this.apply(context).catch(() => undefined);
      throw error;
    }
  }

  clear(): void {
    fs.rmSync(this.filePath, { force: true });
    this.applied = new WeakMap();
    this.overrides = new WeakMap();
  }
}
