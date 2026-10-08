import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Session } from 'electron';

type ExtensionHost = Pick<Session['extensions'], 'getExtension' | 'loadExtension' | 'removeExtension'>;
type SavedExtension = { id: string; sourceDirectory: string; snapshotDirectory: string;
  name: string; version: string; fingerprint: string };
export type BrowserWebviewExtension = { id: string; directory: string; name: string; version: string;
  loaded: boolean; needsReapproval: boolean };
export type BrowserExtensionInstallDetails = { directory: string; name: string; version: string;
  permissions: string[]; hostPermissions: string[]; optionalPermissions: string[];
  optionalHostPermissions: string[]; contentScriptMatches: string[] };
export type BrowserExtensionInstallResult = { status: 'cancelled' } | { status: 'installed'; extension: BrowserWebviewExtension };

const MAX_INDEX_BYTES = 256 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_EXTENSION_BYTES = 100 * 1024 * 1024;
const MAX_EXTENSION_FILES = 2000;
const MAX_EXTENSION_ENTRIES = 4000;
const MAX_INSTALLED_EXTENSIONS = 20;
const EXTENSION_ID = /^[a-p]{32}$/;
const FINGERPRINT = /^[a-f\d]{64}$/;

function sameDirectory(first: string | undefined, second: string): boolean {
  if (!first) return false;
  try { return fs.realpathSync(first) === fs.realpathSync(second); }
  catch { return false; }
}

/** Manages unpacked extensions only in Memmy's persistent embedded-browser partition. */
export class BrowserWebviewExtensions {
  readonly indexPath: string;
  readonly snapshotRoot: string;
  private readonly host: ExtensionHost;

  constructor(browserSession: Session, agentDataDirectory: string) {
    this.host = browserSession.extensions;
    this.indexPath = path.join(agentDataDirectory, 'browser-use', 'webview-extensions.json');
    this.snapshotRoot = path.join(agentDataDirectory, 'browser-use', 'webview-extension-snapshots');
  }

  private read(): SavedExtension[] {
    try {
      if (fs.statSync(this.indexPath).size > MAX_INDEX_BYTES) return [];
      const parsed = JSON.parse(fs.readFileSync(this.indexPath, 'utf8')) as unknown;
      if (!Array.isArray(parsed)) return [];
      const seen = new Set<string>();
      return parsed.flatMap(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
        const item = value as Record<string, unknown>;
        if (typeof item.id !== 'string' || !EXTENSION_ID.test(item.id)
          || typeof item.sourceDirectory !== 'string' || !path.isAbsolute(item.sourceDirectory)
          || item.sourceDirectory.length > 4096
          || typeof item.snapshotDirectory !== 'string'
          || path.dirname(item.snapshotDirectory) !== this.snapshotRoot
          || !/^[a-f\d-]{36}$/i.test(path.basename(item.snapshotDirectory))
          || typeof item.name !== 'string' || !item.name || item.name.length > 256
          || typeof item.version !== 'string' || !item.version || item.version.length > 128
          || typeof item.fingerprint !== 'string' || !FINGERPRINT.test(item.fingerprint)
          || seen.has(item.sourceDirectory)) return [];
        seen.add(item.sourceDirectory);
        return [{ id: item.id, sourceDirectory: item.sourceDirectory,
          snapshotDirectory: item.snapshotDirectory, name: item.name,
          version: item.version, fingerprint: item.fingerprint }];
      }).slice(0, MAX_INSTALLED_EXTENSIONS);
    } catch { return []; }
  }

  private write(entries: SavedExtension[]): void {
    fs.mkdirSync(path.dirname(this.indexPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.indexPath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(entries), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.indexPath);
      if (process.platform !== 'win32') fs.chmodSync(this.indexPath, 0o600);
    } finally { fs.rmSync(temporary, { force: true }); }
  }

  private selectedManifest(directory: string): BrowserExtensionInstallDetails {
    if (!path.isAbsolute(directory)) throw new Error('Invalid extension directory');
    const canonical = fs.realpathSync(directory);
    if (!fs.lstatSync(canonical).isDirectory()) throw new Error('Invalid extension directory');
    const manifestPath = path.join(canonical, 'manifest.json');
    const stat = fs.lstatSync(manifestPath);
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) throw new Error('Invalid extension manifest');
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid extension manifest');
    const manifest = parsed as Record<string, unknown>;
    if ((manifest.manifest_version !== 2 && manifest.manifest_version !== 3)
      || typeof manifest.name !== 'string' || !manifest.name || manifest.name.length > 256
      || typeof manifest.version !== 'string' || !manifest.version || manifest.version.length > 128)
      throw new Error('Invalid extension manifest');
    const strings = (value: unknown): string[] => {
      if (value === undefined) return [];
      if (!Array.isArray(value) || value.length > 100
        || value.some(item => typeof item !== 'string' || item.length > 512))
        throw new Error('Invalid extension manifest');
      return value;
    };
    const contentScripts = manifest.content_scripts === undefined ? [] : manifest.content_scripts;
    if (!Array.isArray(contentScripts) || contentScripts.length > 100) throw new Error('Invalid extension manifest');
    const contentScriptMatches = contentScripts.flatMap(script => {
      if (!script || typeof script !== 'object' || Array.isArray(script)) throw new Error('Invalid extension manifest');
      return strings((script as Record<string, unknown>).matches);
    });
    if (contentScriptMatches.length > 100) throw new Error('Invalid extension manifest');
    const details = { directory: canonical, name: manifest.name, version: manifest.version,
      permissions: strings(manifest.permissions), hostPermissions: strings(manifest.host_permissions),
      optionalPermissions: strings(manifest.optional_permissions),
      optionalHostPermissions: strings(manifest.optional_host_permissions), contentScriptMatches };
    if ([details.directory, ...details.permissions, ...details.hostPermissions, ...details.optionalPermissions,
      ...details.optionalHostPermissions, ...details.contentScriptMatches].join('\n').length > 8192)
      throw new Error('Extension permission summary exceeds the display limit');
    return details;
  }

  /** Hashes all extension code and assets; links and unbounded trees cannot be approved. */
  private fingerprint(directory: string): string {
    const digest = createHash('sha256');
    let files = 0;
    let entries = 0;
    let bytes = 0;
    const walk = (current: string, relative: string, depth: number): void => {
      if (depth > 32 || relative.length > 4096) throw new Error('Extension directory is too deep');
      if (!fs.lstatSync(current).isDirectory()) throw new Error('Extension directory contains a symbolic link');
      for (const entry of fs.readdirSync(current, { withFileTypes: true })
        .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        if (++entries > MAX_EXTENSION_ENTRIES) throw new Error('Extension directory exceeds the file limit');
        const child = path.join(current, entry.name);
        const childRelative = path.join(relative, entry.name);
        if (entry.isSymbolicLink()) throw new Error('Extension directory contains a symbolic link');
        if (entry.isDirectory()) {
          digest.update(`directory\0${childRelative}\0`);
          walk(child, childRelative, depth + 1);
        } else if (entry.isFile()) {
          const descriptor = fs.openSync(child, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
          try {
            const stat = fs.fstatSync(descriptor);
            if (!stat.isFile() || ++files > MAX_EXTENSION_FILES || (bytes += stat.size) > MAX_EXTENSION_BYTES)
              throw new Error('Extension directory exceeds the size limit');
            const content = fs.readFileSync(descriptor);
            if (content.length !== stat.size) throw new Error('Extension changed during approval');
            digest.update(`file\0${childRelative}\0${stat.size}\0`);
            digest.update(content);
          } finally { fs.closeSync(descriptor); }
        } else throw new Error('Extension directory contains an unsupported file');
      }
    };
    walk(directory, '', 0);
    return digest.digest('hex');
  }

  /** Copies the approved bytes into Memmy-owned storage before Electron executes them. */
  private copyApprovedSnapshot(sourceDirectory: string, approvedFingerprint: string): string {
    fs.mkdirSync(this.snapshotRoot, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(this.snapshotRoot, 0o700);
    const temporary = fs.mkdtempSync(path.join(this.snapshotRoot, '.pending-'));
    const destination = path.join(this.snapshotRoot, randomUUID());
    let files = 0;
    let entries = 0;
    let bytes = 0;
    const copy = (source: string, target: string, depth: number): void => {
      if (depth > 32) throw new Error('Extension directory is too deep');
      if (!fs.lstatSync(source).isDirectory()) throw new Error('Extension directory contains a symbolic link');
      for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        if (++entries > MAX_EXTENSION_ENTRIES) throw new Error('Extension directory exceeds the file limit');
        const from = path.join(source, entry.name);
        const to = path.join(target, entry.name);
        if (entry.isSymbolicLink()) throw new Error('Extension directory contains a symbolic link');
        if (entry.isDirectory()) {
          fs.mkdirSync(to, { mode: 0o700 });
          copy(from, to, depth + 1);
        } else if (entry.isFile()) {
          if (++files > MAX_EXTENSION_FILES) throw new Error('Extension directory exceeds the file limit');
          const descriptor = fs.openSync(from, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
          try {
            const stat = fs.fstatSync(descriptor);
            if (!stat.isFile() || (bytes += stat.size) > MAX_EXTENSION_BYTES)
              throw new Error('Extension directory exceeds the size limit');
            const content = fs.readFileSync(descriptor);
            if (content.length !== stat.size) throw new Error('Extension changed during approval');
            fs.writeFileSync(to, content, { flag: 'wx', mode: 0o600 });
          } finally { fs.closeSync(descriptor); }
        } else throw new Error('Extension directory contains an unsupported file');
      }
    };
    try {
      copy(sourceDirectory, temporary, 0);
      if (this.fingerprint(sourceDirectory) !== approvedFingerprint
        || this.fingerprint(temporary) !== approvedFingerprint) {
        throw new Error('Extension changed during approval');
      }
      fs.renameSync(temporary, destination);
      return destination;
    } catch (error) {
      fs.rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
  }

  private snapshotIsApproved(item: SavedExtension): boolean {
    try {
      if (!fs.lstatSync(item.snapshotDirectory).isDirectory()) return false;
      this.selectedManifest(item.snapshotDirectory);
      return this.fingerprint(item.snapshotDirectory) === item.fingerprint;
    } catch { return false; }
  }

  /** Restores only immutable approved copies, never the original selected directory. */
  async restore(): Promise<void> {
    for (const item of this.read()) {
      try {
        if (!this.snapshotIsApproved(item)) continue;
        const extension = await this.host.loadExtension(item.snapshotDirectory, { allowFileAccess: false });
        if (extension.id !== item.id || !sameDirectory(extension.path, item.snapshotDirectory)) {
          if (!sameDirectory(this.host.getExtension(extension.id)?.path, item.snapshotDirectory)) continue;
          this.host.removeExtension(extension.id);
        }
      } catch { /* Keep missing or invalid snapshots visible for removal or reapproval. */ }
    }
  }

  list(): BrowserWebviewExtension[] {
    return this.read().map(item => {
      const loaded = this.host.getExtension(item.id);
      const snapshotApproved = this.snapshotIsApproved(item);
      if (!snapshotApproved && sameDirectory(loaded?.path, item.snapshotDirectory)) {
        try { this.host.removeExtension(item.id); }
        catch { /* Still report the snapshot as unapproved. */ }
      }
      let sourceMatches = false;
      try { sourceMatches = fs.realpathSync(item.sourceDirectory) === item.sourceDirectory
        && this.fingerprint(item.sourceDirectory) === item.fingerprint; }
      catch { /* A missing or changed source requires a new selection. */ }
      return { id: item.id, directory: item.sourceDirectory, name: item.name, version: item.version,
        loaded: snapshotApproved && sameDirectory(loaded?.path, item.snapshotDirectory),
        needsReapproval: !snapshotApproved || !sourceMatches };
    });
  }

  /** The caller supplies trusted native chooser and confirmation dialogs; no renderer path is accepted. */
  async installFromUserSelection(
    selectDirectory: () => Promise<string | null>,
    confirm: (details: BrowserExtensionInstallDetails) => Promise<boolean>,
  ): Promise<BrowserExtensionInstallResult> {
    const selected = await selectDirectory();
    if (selected === null) return { status: 'cancelled' };
    const details = this.selectedManifest(selected);
    const fingerprint = this.fingerprint(details.directory);
    const saved = this.read();
    if (saved.length >= MAX_INSTALLED_EXTENSIONS) throw new Error('Extension limit reached');
    if (saved.some(item => item.sourceDirectory === details.directory)) {
      throw new Error('Extension already installed');
    }
    if (!await confirm(details)) return { status: 'cancelled' };
    if (this.fingerprint(details.directory) !== fingerprint) throw new Error('Extension changed during approval');
    const snapshotDirectory = this.copyApprovedSnapshot(details.directory, fingerprint);
    let loadedId: string | null = null;
    try {
      const extension = await this.host.loadExtension(snapshotDirectory, { allowFileAccess: false });
      loadedId = extension.id;
      if (!EXTENSION_ID.test(extension.id) || !sameDirectory(extension.path, snapshotDirectory)
        || saved.some(item => item.id === extension.id)) throw new Error('Unexpected extension identity');
      const entry: SavedExtension = { id: extension.id, sourceDirectory: details.directory,
        snapshotDirectory, name: extension.name, version: extension.version, fingerprint };
      this.write([...saved, entry]);
      return { status: 'installed', extension: { id: entry.id, directory: entry.sourceDirectory,
        name: entry.name, version: entry.version, loaded: true, needsReapproval: false } };
    }
    catch {
      if (loadedId && sameDirectory(this.host.getExtension(loadedId)?.path, snapshotDirectory)) this.host.removeExtension(loadedId);
      fs.rmSync(snapshotDirectory, { recursive: true, force: true });
      throw new Error('Could not install browser extension');
    }
  }

  /** Reapproval requires selecting the same directory again and reviewing its current permissions. */
  async reapproveFromUserSelection(
    id: string,
    selectDirectory: () => Promise<string | null>,
    confirm: (details: BrowserExtensionInstallDetails) => Promise<boolean>,
  ): Promise<BrowserExtensionInstallResult> {
    const saved = this.read();
    const prior = saved.find(item => item.id === id);
    if (!prior) throw new Error('Extension is not registered');
    const selected = await selectDirectory();
    if (selected === null) return { status: 'cancelled' };
    const details = this.selectedManifest(selected);
    if (details.directory !== prior.sourceDirectory) throw new Error('Select the same extension directory');
    const fingerprint = this.fingerprint(details.directory);
    if (!await confirm(details)) return { status: 'cancelled' };
    if (this.fingerprint(details.directory) !== fingerprint) throw new Error('Extension changed during approval');
    const snapshotDirectory = this.copyApprovedSnapshot(details.directory, fingerprint);
    const oldLoaded = sameDirectory(this.host.getExtension(id)?.path, prior.snapshotDirectory);
    let loadedId: string | null = null;
    try {
      if (oldLoaded) this.host.removeExtension(id);
      const extension = await this.host.loadExtension(snapshotDirectory, { allowFileAccess: false });
      loadedId = extension.id;
      if (!EXTENSION_ID.test(extension.id) || !sameDirectory(extension.path, snapshotDirectory)
        || saved.some(item => item.id === extension.id && item.id !== id))
        throw new Error('Unexpected extension identity');
      const replacement: SavedExtension = { id: extension.id, sourceDirectory: details.directory,
        snapshotDirectory, name: extension.name, version: extension.version, fingerprint };
      this.write(saved.map(item => item.id === id ? replacement : item));
      try { fs.rmSync(prior.snapshotDirectory, { recursive: true, force: true }); }
      catch { /* Orphaned approved bytes can be removed on maintenance. */ }
      return { status: 'installed', extension: { id: replacement.id, directory: replacement.sourceDirectory,
        name: replacement.name, version: replacement.version, loaded: true, needsReapproval: false } };
    }
    catch {
      if (loadedId && sameDirectory(this.host.getExtension(loadedId)?.path, snapshotDirectory)) this.host.removeExtension(loadedId);
      fs.rmSync(snapshotDirectory, { recursive: true, force: true });
      if (oldLoaded && this.snapshotIsApproved(prior)) {
        try { await this.host.loadExtension(prior.snapshotDirectory, { allowFileAccess: false }); }
        catch { /* Preserve the registered prior snapshot for retry on next startup. */ }
      }
      throw new Error('Could not update browser extension');
    }
  }

  /** Removes only an extension registered for this embedded-browser partition. */
  remove(id: string): boolean {
    if (!EXTENSION_ID.test(id)) return false;
    const saved = this.read();
    const entry = saved.find(item => item.id === id);
    if (!entry) return false;
    this.write(saved.filter(item => item.id !== id));
    try {
      if (sameDirectory(this.host.getExtension(id)?.path, entry.snapshotDirectory)) this.host.removeExtension(id);
    } catch (error) {
      this.write(saved);
      throw error;
    }
    try { fs.rmSync(entry.snapshotDirectory, { recursive: true, force: true }); }
    catch { /* Unloaded copies can be removed during later maintenance. */ }
    return true;
  }
}
