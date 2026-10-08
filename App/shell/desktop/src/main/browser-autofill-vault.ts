import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';

export type BrowserContactProfile = { name: string; email: string; phone: string; address: string };
export type BrowserCredentialSummary = { id: string; origin: string; username: string };
export type BrowserAutofillSummary = { available: boolean; credentials: BrowserCredentialSummary[]; contactSaved: boolean };
type StoredCredential = BrowserCredentialSummary & { encryptedPassword: string };
type StoredVault = { credentials: StoredCredential[]; encryptedContact: string | null };
type Cipher = Pick<typeof safeStorage, 'isEncryptionAvailable' | 'encryptString' | 'decryptString'>;

function normalizedOrigin(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value || value.length > 320)
    throw new Error('Invalid credential origin');
  return url.origin;
}

/** Saved credentials are encrypted by the OS key store and never returned in renderer lists. */
export class BrowserAutofillVault {
  readonly filePath: string;
  constructor(agentDataDirectory: string, private readonly cipher: Cipher = safeStorage) {
    this.filePath = path.join(agentDataDirectory, 'browser-use', 'autofill.json');
  }
  private read(): StoredVault {
    try {
      if (fs.statSync(this.filePath).size > 1024 * 1024) throw new Error('oversized vault');
      const value = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as StoredVault;
      if (!value || !Array.isArray(value.credentials)) throw new Error('invalid vault');
      return { credentials: value.credentials.filter(entry => {
        try { return typeof entry.id === 'string' && /^[a-f\d-]{36}$/i.test(entry.id)
          && typeof entry.username === 'string' && entry.username.length <= 256
          && typeof entry.encryptedPassword === 'string' && entry.encryptedPassword.length <= 8192
          && normalizedOrigin(entry.origin) === entry.origin; }
        catch { return false; }
      }).slice(0, 200), encryptedContact: typeof value.encryptedContact === 'string' ? value.encryptedContact : null };
    } catch { return { credentials: [], encryptedContact: null }; }
  }
  private write(value: StoredVault): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.filePath);
      if (process.platform !== 'win32') fs.chmodSync(this.filePath, 0o600);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  summary(): BrowserAutofillSummary {
    const value = this.read();
    return { available: this.cipher.isEncryptionAvailable(),
      credentials: value.credentials.map(({ id, origin, username }) => ({ id, origin, username })),
      contactSaved: Boolean(value.encryptedContact) };
  }
  saveCredential(origin: string, username: string, password: string): BrowserAutofillSummary {
    if (!this.cipher.isEncryptionAvailable()) throw new Error('OS encryption is unavailable');
    const normalized = normalizedOrigin(origin);
    if (!username.trim() || username.length > 256 || !password || password.length > 4096)
      throw new Error('Invalid browser credential');
    const value = this.read();
    const credentials = value.credentials.filter(entry => entry.origin !== normalized || entry.username !== username.trim());
    if (credentials.length >= 200) throw new Error('Browser credential limit reached');
    credentials.push({ id: randomUUID(), origin: normalized, username: username.trim(),
      encryptedPassword: this.cipher.encryptString(password).toString('base64') });
    this.write({ ...value, credentials });
    return this.summary();
  }
  credential(id: string): { origin: string; username: string; password: string } | null {
    if (!this.cipher.isEncryptionAvailable() || !/^[a-f\d-]{36}$/i.test(id)) return null;
    const entry = this.read().credentials.find(item => item.id === id);
    if (!entry) return null;
    return { origin: entry.origin, username: entry.username,
      password: this.cipher.decryptString(Buffer.from(entry.encryptedPassword, 'base64')) };
  }
  deleteCredential(id: string): BrowserAutofillSummary {
    if (!/^[a-f\d-]{36}$/i.test(id)) throw new Error('Invalid credential id');
    const value = this.read();
    this.write({ ...value, credentials: value.credentials.filter(entry => entry.id !== id) });
    return this.summary();
  }
  saveContact(profile: BrowserContactProfile): BrowserAutofillSummary {
    if (!this.cipher.isEncryptionAvailable()) throw new Error('OS encryption is unavailable');
    const fields = Object.values(profile);
    if (Object.keys(profile).length !== 4 || !['name', 'email', 'phone', 'address'].every(key =>
      Object.prototype.hasOwnProperty.call(profile, key)) || fields.some(field => typeof field !== 'string' || field.length > 1024))
      throw new Error('Invalid contact field');
    const value = this.read();
    this.write({ ...value, encryptedContact: this.cipher.encryptString(JSON.stringify(profile)).toString('base64') });
    return this.summary();
  }
  contact(): BrowserContactProfile | null {
    if (!this.cipher.isEncryptionAvailable()) return null;
    const encrypted = this.read().encryptedContact;
    if (!encrypted) return null;
    const value = JSON.parse(this.cipher.decryptString(Buffer.from(encrypted, 'base64'))) as BrowserContactProfile;
    return value && ['name', 'email', 'phone', 'address'].every(key => typeof value[key as keyof BrowserContactProfile] === 'string')
      ? value : null;
  }
  deleteContact(): BrowserAutofillSummary {
    const value = this.read();
    this.write({ ...value, encryptedContact: null });
    return this.summary();
  }
}
