import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Computer Use stays on. This flag only skips the per-app prompt.
 * An explicit "always allow" still writes that one app into the approval list.
 * A blanket allow must not, so the approval gate receives allow-once and does not persist the app.
 */
export function nativeAppAccessDecision(input: {
  platform: string;
  appId: string;
  displayName: string;
  hostPlatform: string;
  allowAll: boolean;
}): 'ask' | 'deny' | 'allow-once' {
  if (input.platform !== input.hostPlatform || !input.appId || !input.displayName) return 'deny';
  return input.allowAll ? 'allow-once' : 'ask';
}

export class NativeAppAllowAll {
  readonly filePath: string;

  constructor(userDataDirectory: string) {
    this.filePath = path.join(userDataDirectory, 'computer-use', 'allow-all-apps.json');
  }

  isEnabled(): boolean {
    try {
      const file = fs.lstatSync(this.filePath);
      if (!file.isFile() || file.isSymbolicLink() || file.size > 4096) return false;
      const value: unknown = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const record = value as Record<string, unknown>;
      return record.version === 1 && record.enabled === true;
    } catch { return false; }
  }

  setEnabled(enabled: boolean): boolean {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink()
      || fs.lstatSync(this.filePath, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error('Unsafe native app allow-all path');
    }
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, enabled }), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.filePath);
      if (process.platform !== 'win32') fs.chmodSync(this.filePath, 0o600);
    } finally { fs.rmSync(temporary, { force: true }); }
    return enabled;
  }
}
