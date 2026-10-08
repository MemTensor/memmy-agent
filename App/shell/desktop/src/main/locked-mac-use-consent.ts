import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Separate from installing the system component or approving a target app. */
export class LockedMacUseConsent {
  readonly filePath: string;

  constructor(userDataDirectory: string) {
    this.filePath = path.join(userDataDirectory, 'computer-use', 'locked-mac-consent.json');
  }

  isGranted(): boolean {
    try {
      const file = fs.lstatSync(this.filePath);
      if (!file.isFile() || file.size > 4096) return false;
      const value: unknown = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const record = value as Record<string, unknown>;
      return record.version === 1 && record.granted === true
        && typeof record.grantedAt === 'string' && !Number.isNaN(Date.parse(record.grantedAt));
    } catch { return false; }
  }

  setGranted(granted: boolean): void {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink()
      || fs.lstatSync(this.filePath, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error('Unsafe locked Mac consent path');
    }
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, granted,
        grantedAt: granted ? new Date().toISOString() : null }), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.filePath);
      fs.chmodSync(this.filePath, 0o600);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
}
