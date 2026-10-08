import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }));
import { BrowserAutofillVault } from '../src/main/browser-autofill-vault.js';

it('encrypts saved passwords and never returns them in the list', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-browser-vault-'));
  const cipher = { isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`sealed:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^sealed:/, '') };
  try {
    const vault = new BrowserAutofillVault(root, cipher);
    const summary = vault.saveCredential('https://example.com', 'alice', 'secret-password');
    expect(summary.credentials).toEqual([{ id: expect.any(String), origin: 'https://example.com', username: 'alice' }]);
    expect(JSON.stringify(summary)).not.toContain('secret-password');
    expect(fs.readFileSync(vault.filePath, 'utf8')).not.toContain('secret-password');
    expect(vault.credential(summary.credentials[0]!.id)).toEqual({ origin: 'https://example.com',
      username: 'alice', password: 'secret-password' });
    vault.saveContact({ name: 'Alice', email: 'alice@example.com', phone: '', address: '' });
    expect(fs.readFileSync(vault.filePath, 'utf8')).not.toContain('alice@example.com');
    expect(vault.contact()?.email).toBe('alice@example.com');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
