import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, win32 } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Readable, Writable } from 'node:stream';
import type { ExternalBrowserName } from './external-browser-extension-install.js';

type Reply = { id: number; result?: Record<string, unknown>; error?: { message?: string } };
type Pending = { resolve: (reply: Reply) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout };

class BrowserPipe {
  private readonly write: Writable;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = '';
  private readonly decoder = new StringDecoder('utf8');
  private closed = false;

  constructor(readonly child: ChildProcess) {
    this.write = child.stdio[3] as Writable;
    const read = child.stdio[4] as Readable;
    read.on('data', (chunk: Buffer) => this.receive(this.decoder.write(chunk)));
    child.stderr?.on('data', () => undefined);
    child.on('error', error => this.failAll(error));
    child.on('exit', () => this.failAll(new Error('Browser exited')));
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 8_000_000) {
      this.failAll(new Error('Browser response exceeded limit'));
      return;
    }
    let end: number;
    while ((end = this.buffer.indexOf('\0')) >= 0) {
      const raw = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      let reply: Reply;
      try { reply = JSON.parse(raw) as Reply; } catch { continue; }
      const pending = this.pending.get(reply.id);
      if (!pending) continue;
      this.pending.delete(reply.id);
      clearTimeout(pending.timeout);
      if (reply.error) pending.reject(new Error(reply.error.message || 'Browser command failed'));
      else pending.resolve(reply);
    }
  }

  private failAll(error: Error): void {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  command(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error('Browser connection closed'));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Browser did not respond'));
      }, 15_000);
      this.pending.set(id, { resolve: reply => resolve(reply.result || {}), reject, timeout });
      this.write.write(JSON.stringify({ id, method, params }) + '\0', error => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  close(): void {
    if (!this.closed) void this.command('Browser.close').catch(() => undefined);
    setTimeout(() => { if (this.child.exitCode === null) this.child.kill(); }, 2_000).unref();
  }
}

export function managedBrowserExecutable(browser: ExternalBrowserName,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  fileExists: (path: string) => boolean = existsSync): string | null {
  if (platform === 'darwin') {
    const name = browser === 'chrome' ? 'Google Chrome' : 'Microsoft Edge';
    const binary = browser === 'chrome' ? 'Google Chrome' : 'Microsoft Edge';
    return [`/Applications/${name}.app/Contents/MacOS/${binary}`,
      join(homedir(), 'Applications', `${name}.app`, 'Contents', 'MacOS', binary)].find(fileExists) || null;
  }
  if (platform !== 'win32') return null;
  const product = browser === 'chrome' ? ['Google', 'Chrome'] : ['Microsoft', 'Edge'];
  const binary = browser === 'chrome' ? 'chrome.exe' : 'msedge.exe';
  const roots = [environment.PROGRAMFILES, environment['PROGRAMFILES(X86)'], environment.LOCALAPPDATA]
    .filter((root): root is string => Boolean(root));
  return roots.map(root => win32.join(root, ...product, 'Application', binary)).find(fileExists) || null;
}

export class ManagedBrowserExtensionInstaller {
  private readonly sessions = new Map<ExternalBrowserName, BrowserPipe>();

  async install(browser: ExternalBrowserName, extensionDirectory: string, profileRoot: string):
    Promise<'installed' | 'browser-not-found' | 'failed'> {
    const executable = managedBrowserExecutable(browser);
    if (!executable) return 'browser-not-found';
    let session = this.sessions.get(browser);
    if (!session || session.child.exitCode !== null || session.child.killed) {
      try {
        const profile = join(profileRoot, browser);
        mkdirSync(profile, { recursive: true, mode: 0o700 });
        const child = spawn(executable, [
          `--user-data-dir=${profile}`,
          '--remote-debugging-pipe',
          '--enable-unsafe-extension-debugging',
          // Edge 116 supports unpacked extensions via startup flags but lacks
          // the Extensions CDP domain. This profile belongs only to Memmy.
          ...(browser === 'edge' ? [
            `--load-extension=${extensionDirectory}`,
            `--disable-extensions-except=${extensionDirectory}`,
          ] : []),
          '--no-first-run',
          '--no-default-browser-check',
          'about:blank',
        ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: false });
        session = new BrowserPipe(child);
        this.sessions.set(browser, session);
      } catch { return 'failed'; }
    }
    try {
      await session.command('Browser.getVersion');
      let loaded: Record<string, unknown>;
      try {
        loaded = await session.command('Extensions.loadUnpacked', { path: extensionDirectory });
      } catch (error) {
        if (browser !== 'edge' || !String(error).includes("'Extensions.loadUnpacked' wasn't found")) throw error;
        // The startup flag is only accepted as installed after its own MV3
        // worker appears in this isolated browser's DevTools target list.
        const manifest = JSON.parse(readFileSync(join(extensionDirectory, 'manifest.json'), 'utf8')) as {
          key?: string; background?: { service_worker?: string };
        };
        if (!manifest.key || !manifest.background?.service_worker) throw error;
        const digest = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16);
        const id = [...digest].flatMap(byte => [byte >> 4, byte & 15]
          .map(nibble => String.fromCharCode(97 + nibble))).join('');
        const expected = `chrome-extension://${id}/${manifest.background.service_worker}`;
        for (let attempt = 0; attempt < 10; attempt++) {
          const targets = await session.command('Target.getTargets');
          const infos = Array.isArray(targets.targetInfos) ? targets.targetInfos : [];
          if (infos.some(info => typeof info === 'object' && info !== null
            && (info as { type?: string; url?: string }).type === 'service_worker'
            && (info as { url?: string }).url === expected)) return 'installed';
          await new Promise(resolve => setTimeout(resolve, 300));
        }
        throw new Error('Edge did not start the Memmy extension worker');
      }
      const id = loaded.id;
      if (typeof id !== 'string' || !id) throw new Error('Browser did not install the extension');
      const listing = await session.command('Extensions.getExtensions');
      const extensions = Array.isArray(listing.extensions) ? listing.extensions : [];
      if (!extensions.some(item => typeof item === 'object' && item !== null
        && (item as { id?: string; enabled?: boolean }).id === id
        && (item as { enabled?: boolean }).enabled === true)) {
        throw new Error('Browser did not enable the extension');
      }
      return 'installed';
    } catch {
      session.close();
      this.sessions.delete(browser);
      return 'failed';
    }
  }

  close(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }
}
