import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Session } from 'electron';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserWebviewExtensions, type BrowserExtensionInstallDetails } from '../src/main/browser-webview-extensions.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-webview-extension-'));
  roots.push(root);
  const selectedDirectory = path.join(root, 'chosen-extension');
  fs.mkdirSync(selectedDirectory);
  const directory = fs.realpathSync(selectedDirectory);
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'Selected extension', version: '1.0.0', permissions: ['storage'],
    host_permissions: ['https://example.com/*'],
    content_scripts: [{ matches: ['https://example.org/*'], js: ['content.js'] }],
  }));
  const loaded = new Map<string, { id: string; name: string; version: string; path: string }>();
  const id = 'a'.repeat(32);
  const host = {
    getAllExtensions: vi.fn(() => [...loaded.values()]),
    getExtension: vi.fn((key: string) => loaded.get(key) ?? null),
    loadExtension: vi.fn(async (selected: string) => {
      const extension = { id, name: 'Selected extension', version: '1.0.0', path: selected };
      loaded.set(id, extension);
      return extension;
    }),
    removeExtension: vi.fn((key: string) => { loaded.delete(key); }),
  };
  const session = { extensions: host } as unknown as Session;
  return { root, directory, host, session, loaded, id };
}

it('requires a native directory selection and affirmative confirmation before loading', async () => {
  const { root, directory, host, session } = fixture();
  const manager = new BrowserWebviewExtensions(session, root);
  const confirm = vi.fn(async (_details: BrowserExtensionInstallDetails) => false);
  expect(await manager.installFromUserSelection(async () => null, confirm)).toEqual({ status: 'cancelled' });
  expect(confirm).not.toHaveBeenCalled();
  expect(await manager.installFromUserSelection(async () => directory, confirm)).toEqual({ status: 'cancelled' });
  expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ name: 'Selected extension',
    directory, permissions: ['storage'], hostPermissions: ['https://example.com/*'],
    contentScriptMatches: ['https://example.org/*'] }));
  expect(host.loadExtension).not.toHaveBeenCalled();
  expect(fs.existsSync(manager.indexPath)).toBe(false);
});

it('persists only the approved unpacked directory, restores into its own session, and removes without deleting files', async () => {
  const first = fixture();
  const manager = new BrowserWebviewExtensions(first.session, first.root);
  const confirmed = vi.fn(async () => true);
  const result = await manager.installFromUserSelection(async () => first.directory, confirmed);
  expect(result).toMatchObject({ status: 'installed', extension: { id: first.id, loaded: true } });
  const snapshot = first.host.loadExtension.mock.calls[0]![0];
  expect(snapshot).toContain('webview-extension-snapshots');
  expect(snapshot).not.toBe(first.directory);
  expect(fs.readFileSync(path.join(snapshot, 'manifest.json'), 'utf8'))
    .toBe(fs.readFileSync(path.join(first.directory, 'manifest.json'), 'utf8'));
  expect(manager.list()).toMatchObject([{ id: first.id, directory: first.directory, loaded: true }]);
  expect(() => manager.remove('b'.repeat(32))).not.toThrow();
  expect(manager.remove('b'.repeat(32))).toBe(false);
  expect(manager.remove(first.id)).toBe(true);
  expect(first.host.removeExtension).toHaveBeenCalledWith(first.id);
  expect(manager.list()).toEqual([]);
  expect(fs.existsSync(path.join(first.directory, 'manifest.json'))).toBe(true);
  expect(fs.existsSync(snapshot)).toBe(false);

  await manager.installFromUserSelection(async () => first.directory, confirmed);
  const second = fixture();
  const restarted = new BrowserWebviewExtensions(second.session, first.root);
  expect(restarted.list()).toMatchObject([{ id: first.id, loaded: false }]);
  await restarted.restore();
  expect(second.host.loadExtension).toHaveBeenCalledWith(expect.stringContaining('webview-extension-snapshots'),
    { allowFileAccess: false });
  expect(restarted.list()).toMatchObject([{ id: first.id, loaded: true }]);
});

it('does not reload changed extension code until it is selected and approved again', async () => {
  const { root, directory, session, host, id } = fixture();
  const manager = new BrowserWebviewExtensions(session, root);
  await manager.installFromUserSelection(async () => directory, async () => true);
  host.removeExtension(id);
  fs.writeFileSync(path.join(directory, 'content.js'), 'new code');
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ manifest_version: 3,
    name: 'Selected extension', version: '1.0.0', host_permissions: ['https://changed.example/*'] }));
  const restarted = new BrowserWebviewExtensions(session, root);
  await restarted.restore();
  expect(host.loadExtension).toHaveBeenCalledTimes(2);
  expect(restarted.list()).toMatchObject([{ id, loaded: true, needsReapproval: true }]);
  const approvedSnapshot = host.loadExtension.mock.calls[1]![0];
  expect(fs.existsSync(path.join(approvedSnapshot, 'content.js'))).toBe(false);
  expect(await restarted.reapproveFromUserSelection(id, async () => directory, async () => false))
    .toEqual({ status: 'cancelled' });
  expect(restarted.list()).toMatchObject([{ id, loaded: true, needsReapproval: true }]);
  const confirm = vi.fn(async () => true);
  await restarted.reapproveFromUserSelection(id, async () => directory, confirm);
  expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ directory, name: 'Selected extension',
    hostPermissions: ['https://changed.example/*'] }));
  expect(host.loadExtension).toHaveBeenCalledTimes(3);
  expect(restarted.list()).toMatchObject([{ id, loaded: true, needsReapproval: false }]);
  expect(fs.existsSync(approvedSnapshot)).toBe(false);
});

it('refuses to restore a changed Memmy snapshot even when the source is unchanged', async () => {
  const { root, directory, session, host, id } = fixture();
  const manager = new BrowserWebviewExtensions(session, root);
  await manager.installFromUserSelection(async () => directory, async () => true);
  const snapshot = host.loadExtension.mock.calls[0]![0];
  host.removeExtension(id);
  fs.writeFileSync(path.join(snapshot, 'injected.js'), 'unapproved');
  await new BrowserWebviewExtensions(session, root).restore();
  expect(host.loadExtension).toHaveBeenCalledTimes(1);
  expect(manager.list()).toMatchObject([{ id, loaded: false, needsReapproval: true }]);
});

it('rejects a directory changed while the confirmation is open', async () => {
  const { root, directory, session, host } = fixture();
  const manager = new BrowserWebviewExtensions(session, root);
  await expect(manager.installFromUserSelection(async () => directory, async () => {
    fs.writeFileSync(path.join(directory, 'content.js'), 'changed during confirmation');
    return true;
  })).rejects.toThrow('Extension changed during approval');
  expect(host.loadExtension).not.toHaveBeenCalled();
});

it('rejects linked files in the selected tree before showing confirmation', async () => {
  const { root, directory, session, host } = fixture();
  const outside = path.join(root, 'outside.js');
  fs.writeFileSync(outside, 'outside');
  fs.symlinkSync(outside, path.join(directory, 'content.js'));
  const confirm = vi.fn(async () => true);
  await expect(new BrowserWebviewExtensions(session, root)
    .installFromUserSelection(async () => directory, confirm))
    .rejects.toThrow('symbolic link');
  expect(confirm).not.toHaveBeenCalled();
  expect(host.loadExtension).not.toHaveBeenCalled();
});

it('rejects an extension tree over the bounded byte limit before loading', async () => {
  const { root, directory, session, host } = fixture();
  fs.closeSync(fs.openSync(path.join(directory, 'oversized.bin'), 'w'));
  fs.truncateSync(path.join(directory, 'oversized.bin'), 100 * 1024 * 1024 + 1);
  await expect(new BrowserWebviewExtensions(session, root)
    .installFromUserSelection(async () => directory, async () => true))
    .rejects.toThrow('size limit');
  expect(host.loadExtension).not.toHaveBeenCalled();
});

it('does not discover another browser profile or remove extensions it did not register', async () => {
  const { root, session, host, loaded } = fixture();
  const externalId = 'b'.repeat(32);
  loaded.set(externalId, { id: externalId, name: 'Other extension', version: '1.0', path: '/other/profile/extension' });
  const manager = new BrowserWebviewExtensions(session, root);
  await manager.restore();
  expect(host.loadExtension).not.toHaveBeenCalled();
  expect(manager.list()).toEqual([]);
  expect(manager.remove(externalId)).toBe(false);
  expect(host.removeExtension).not.toHaveBeenCalled();
});

it('accepts Electron returning a canonicalized path for the approved snapshot', async () => {
  const { root, directory, session, host, loaded, id } = fixture();
  host.loadExtension.mockImplementation(async selected => {
    const extension = { id, name: 'Selected extension', version: '1.0.0', path: fs.realpathSync(selected) };
    loaded.set(id, extension);
    return extension;
  });
  const manager = new BrowserWebviewExtensions(session, root);
  await manager.installFromUserSelection(async () => directory, async () => true);
  expect(manager.list()).toMatchObject([{ id, loaded: true }]);
  expect(manager.remove(id)).toBe(true);
  expect(host.removeExtension).toHaveBeenCalledWith(id);
});

it('keeps a missing approved directory visible but refuses a symlinked manifest', async () => {
  const { root, directory, session, id, host } = fixture();
  const manager = new BrowserWebviewExtensions(session, root);
  await manager.installFromUserSelection(async () => directory, async () => true);
  host.removeExtension(id);
  fs.rmSync(directory, { recursive: true });
  await manager.restore();
  expect(manager.list()).toMatchObject([{ id, loaded: true, needsReapproval: true }]);
  expect(manager.remove(id)).toBe(true);

  const outside = path.join(root, 'outside.json');
  fs.writeFileSync(outside, JSON.stringify({ manifest_version: 3, name: 'Forged', version: '1' }));
  fs.mkdirSync(directory);
  fs.symlinkSync(outside, path.join(directory, 'manifest.json'));
  await expect(manager.installFromUserSelection(async () => directory, async () => true))
    .rejects.toThrow('Invalid extension manifest');
  expect(host.loadExtension).toHaveBeenCalledTimes(2);
});
