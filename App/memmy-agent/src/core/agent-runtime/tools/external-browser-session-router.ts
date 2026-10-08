import type { BrowserScope, BrowserToolName } from "./browser.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeBrowserCdpReadCall, normalizeBrowserCdpWriteCall, normalizeBrowserCdpEventQuery,
  normalizeBrowserCdpCommandOptions,
  type ComputerUseSurfaceAction } from "@memmy/local-api-contracts";
import { emitComputerUseSurface } from "../../../tools/computer-use/surface-preview.js";
import { type ExternalBrowserClaim } from "./external-browser-bridge.js";
import { callExternalBrowserTool, emitExternalBrowserFrame, externalBrowserTargetId } from "./external-browser-tools.js";
import { BrowserUseSitePolicyReader } from './browser-use-site-policy-store.js';

export type ClaimedBrowserBridge = {
  refresh?(): Promise<ExternalBrowserClaim | null>;
  listClaims(): ExternalBrowserClaim[];
  getClaim(identity: Pick<ExternalBrowserClaim, 'connectionId' | 'tabId'>): ExternalBrowserClaim | null;
  command(claim: Pick<ExternalBrowserClaim, 'connectionId' | 'tabId'>,
    command: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
};

type Binding = {
  scope: BrowserScope;
  identity: Pick<ExternalBrowserClaim, "connectionId" | "tabId">;
  allowedOrigins: Set<string>;
  outputDir: string;
  agentCreated: boolean;
  disposition: 'deliverable' | 'handoff' | null;
  usedInTurn: boolean;
};

function scopeKey(scope: BrowserScope): string {
  return JSON.stringify([scope.sessionKey, scope.channel, scope.chatId]);
}

function claimKey(claim: Pick<ExternalBrowserClaim, "connectionId" | "tabId">): string {
  return `${claim.connectionId}:${claim.tabId}`;
}

function preferredClaim(available: ExternalBrowserClaim[]): ExternalBrowserClaim {
  const active = available.filter(claim => claim.active === true);
  const pool = active.length > 0 ? active : available;
  return pool.reduce((best, claim) => claim.claimedAt >= best.claimedAt ? claim : best);
}

/** Keeps each user-claimed external tab bound to one Agent chat until that chat closes. */
export class ExternalBrowserSessionRouter {
  private readonly bindings = new Map<string, Binding>();

  constructor(
    private readonly bridge: ClaimedBrowserBridge,
    private readonly authorizeNavigation: (url: string, allowed: Set<string>) => Promise<boolean>,
    private readonly targetKind: 'external' | 'embedded' = 'external',
    private readonly sitePolicy = new BrowserUseSitePolicyReader(),
  ) {}

  hasBinding(scope: BrowserScope): boolean { return this.bindings.has(scopeKey(scope)); }

  selectClaim(scope: BrowserScope, claim: ExternalBrowserClaim,
    options: { allowedOrigins?: Set<string>; agentCreated?: boolean } = {}): ExternalBrowserClaim {
    const key = scopeKey(scope);
    const existing = this.bindings.get(key);
    if (existing) {
      if (claimKey(existing.identity) !== claimKey(claim)) throw new Error('Browser tab already bound to this chat');
      return claim;
    }
    if ([...this.bindings.values()].some(binding => claimKey(binding.identity) === claimKey(claim))) {
      throw new Error('Browser tab is already in use by another chat');
    }
    this.bindings.set(key, { scope: { ...scope },
      identity: { connectionId: claim.connectionId, tabId: claim.tabId },
      allowedOrigins: options.allowedOrigins ?? (claim.browser === 'memmy' ? new Set() : new Set([new URL(claim.url).origin])),
      outputDir: fs.mkdtempSync(path.join(os.tmpdir(), "memmy-external-browser-session-")),
      agentCreated: options.agentCreated === true, disposition: null,
      usedInTurn: options.agentCreated === true });
    return claim;
  }

  select(scope: BrowserScope, hasInternalSession: boolean, initialAllowedOrigins?: Set<string>): ExternalBrowserClaim | null {
    const key = scopeKey(scope);
    const existing = this.bindings.get(key);
    if (existing) {
      const claim = this.bridge.getClaim(existing.identity);
      if (!claim) throw new Error("The connected external browser tab was disconnected. Reconnect it before continuing.");
      return claim;
    }
    if (hasInternalSession) return null;
    const owned = new Set([...this.bindings.values()].map(binding => claimKey(binding.identity)));
    const available = this.bridge.listClaims().filter(claim => !owned.has(claimKey(claim)));
    if (available.length === 0) return null;
    return this.selectClaim(scope, preferredClaim(available), { allowedOrigins: initialAllowedOrigins });
  }

  markTab(scope: BrowserScope, disposition: 'deliverable' | 'handoff'): void {
    const binding = this.bindings.get(scopeKey(scope));
    if (!binding) throw new Error('Browser tab is not bound to this chat');
    binding.disposition = disposition;
  }

  async call(scope: BrowserScope, claim: ExternalBrowserClaim,
    name: BrowserToolName, params: Record<string, any>, abortSignal?: AbortSignal | null): Promise<Array<Record<string, any>>> {
    await this.authorizeCurrent(scope, claim);
    const binding = this.bindings.get(scopeKey(scope))!;
    const content = await callExternalBrowserTool(this.bridge, claim, scope, name, params,
      url => this.authorizePage(claim, binding, url), abortSignal);
    if (name === "browser_take_screenshot") {
      const filename = typeof params.filename === "string" && params.filename.trim()
        ? params.filename.trim()
        : `page-${Date.now()}.${params.type === "jpeg" ? "jpeg" : "png"}`;
      if (path.isAbsolute(filename) || filename.split(/[\\/]/).includes("..")) {
        throw new Error("Screenshot filename must stay within the browser output directory");
      }
      const destination = path.resolve(binding.outputDir, filename);
      if (!destination.startsWith(`${binding.outputDir}${path.sep}`)) {
        throw new Error("Screenshot filename must stay within the browser output directory");
      }
      const image = content.find(item => item.type === "image" && typeof item.data === "string");
      if (!image) throw new Error("External browser screenshot was not returned");
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, Buffer.from(image.data, "base64"));
      content[0] = { type: "text", text: `Screenshot saved to ${destination}` };
    }
    return content;
  }

  private async authorizePage(claim: ExternalBrowserClaim, binding: Binding, url: string): Promise<boolean> {
    if (this.sitePolicy.decision(url, 'access') === 'block') return false;
    if (claim.browser !== 'memmy') {
      binding.allowedOrigins.add(new URL(url).origin);
      return true;
    }
    return this.authorizeNavigation(url, binding.allowedOrigins);
  }

  async authorizeCurrent(scope: BrowserScope, claim: ExternalBrowserClaim): Promise<void> {
    const binding = this.bindings.get(scopeKey(scope));
    if (!binding || claimKey(binding.identity) !== claimKey(claim)) throw new Error("External browser session changed");
    const liveClaim = this.bridge.getClaim(binding.identity);
    if (!liveClaim || this.sitePolicy.decision(liveClaim.url, 'access') === 'block') {
      throw new Error('Browser site is blocked by policy');
    }
    binding.usedInTurn = true;
    if (claim.browser !== 'memmy') {
      try { binding.allowedOrigins.add(new URL(liveClaim.url).origin); }
      catch { throw new Error('Browser site is blocked by policy'); }
    } else {
      const currentOrigin = new URL(claim.url).origin;
      if (!binding.allowedOrigins.has(currentOrigin)) {
        if (!await this.authorizeNavigation(claim.url, binding.allowedOrigins)) {
          throw new Error(`Access to ${currentOrigin} was not approved`);
        }
        await this.bridge.command(claim, 'allowOrigin', { origin: currentOrigin });
      }
    }
  }

  /** The visible decision binds one claimed tab, origin, target and file snapshot. */
  async upload(scope: BrowserScope, claim: ExternalBrowserClaim, params: Record<string, any>,
    authorize: (url: string, files: string[], signal?: AbortSignal) => Promise<boolean>,
    abortSignal?: AbortSignal | null): Promise<Array<Record<string, any>>> {
    const binding = this.bindings.get(scopeKey(scope));
    if (!binding || claimKey(binding.identity) !== claimKey(claim) || claim.browser === 'memmy') {
      throw new Error('External browser session changed');
    }
    if (this.sitePolicy.decision(claim.url, 'access') === 'block') {
      throw new Error('Browser site is blocked by policy');
    }
    const files = params.paths as string[];
    if (!Array.isArray(files) || files.length < 1 || files.length > 20
      || files.some(file => typeof file !== 'string' || !path.isAbsolute(file))) {
      throw new Error('External browser upload requires approved absolute files');
    }
    const target = params.target ?? params.ref;
    if (typeof target !== 'string' || !target || target.length > 500) {
      throw new Error('External browser upload requires a file input target');
    }
    if (abortSignal?.aborted) throw new Error('Browser upload cancelled');
    const initial = await this.bridge.command(claim, 'tabState', {}, abortSignal ?? undefined) as { url?: string; origin?: string };
    if (initial?.origin && initial.url && new URL(initial.url).origin === initial.origin) {
      binding.allowedOrigins.add(initial.origin);
    }
    if (!initial?.url || !initial.origin || new URL(initial.url).origin !== initial.origin
      || !binding.allowedOrigins.has(initial.origin)) throw new Error('External browser upload site changed');
    const stamps = files.map(file => {
      const info = fs.lstatSync(file);
      return { path: file, realPath: fs.realpathSync(file), dev: info.dev, ino: info.ino,
        size: info.size, mtimeMs: info.mtimeMs };
    });
    if (!await authorize(initial.url, files, abortSignal ?? undefined)) throw new Error('Browser upload was not approved');
    if (abortSignal?.aborted || !this.bindings.has(scopeKey(scope))) throw new Error('Browser upload cancelled');
    const current = await this.bridge.command(claim, 'tabState', {}, abortSignal ?? undefined) as { url?: string; origin?: string };
    if (current?.url !== initial.url || current?.origin !== initial.origin
      || this.bridge.getClaim(binding.identity)?.connectionId !== claim.connectionId) {
      throw new Error('External browser upload site changed after approval');
    }
    const temporary = fs.mkdtempSync(path.join(binding.outputDir, 'approved-upload-'));
    fs.chmodSync(temporary, 0o700);
    try {
      const staged: string[] = [];
      for (const [index, stamp] of stamps.entries()) {
        if (abortSignal?.aborted || fs.realpathSync(stamp.path) !== stamp.realPath) {
          throw new Error('Browser upload file changed after approval');
        }
        const directory = path.join(temporary, String(index));
        fs.mkdirSync(directory, { mode: 0o700 });
        const destination = path.join(directory, path.basename(stamp.path));
        const source = await fs.promises.open(stamp.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        try {
          const before = await source.stat();
          if (!before.isFile() || before.dev !== stamp.dev || before.ino !== stamp.ino
            || before.size !== stamp.size || before.mtimeMs !== stamp.mtimeMs) {
            throw new Error('Browser upload file changed after approval');
          }
          const output = await fs.promises.open(destination, 'wx', 0o600);
          try {
            const buffer = Buffer.allocUnsafe(1024 * 1024);
            while (true) {
              if (abortSignal?.aborted) throw new Error('Browser upload cancelled');
              const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
              if (!bytesRead) break;
              let written = 0;
              while (written < bytesRead) written += (await output.write(buffer, written, bytesRead - written)).bytesWritten;
            }
          } finally { await output.close().catch(() => undefined); }
          const after = await source.stat();
          if (after.size !== stamp.size || after.mtimeMs !== stamp.mtimeMs) {
            throw new Error('Browser upload file changed during staging');
          }
        } finally { await source.close().catch(() => undefined); }
        staged.push(destination);
      }
      if (abortSignal?.aborted) throw new Error('Browser upload cancelled');
      const final = await this.bridge.command(claim, 'tabState', {}, abortSignal ?? undefined) as { url?: string; origin?: string };
      if (final?.url !== initial.url || final?.origin !== initial.origin) {
        throw new Error('External browser upload site changed after approval');
      }
      if (this.sitePolicy.decision(initial.url, 'uploads') === 'block') {
        throw new Error('Browser upload was blocked by site policy');
      }
      return await this.call(scope, claim, 'browser_file_upload',
        { target, paths: staged, approvedOrigin: initial.origin }, abortSignal);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }

  async cdp(scope: BrowserScope, claim: ExternalBrowserClaim, operation: 'cdpCall' | 'cdpEvents' | 'cdpWrite',
    input: Record<string, unknown>, approve: (url: string, name: string, signal?: AbortSignal) => Promise<boolean>,
    signal?: AbortSignal | null): Promise<string> {
    const binding = this.bindings.get(scopeKey(scope));
    if (!binding || claimKey(binding.identity) !== claimKey(claim)) throw new Error('Browser tab changed');
    const normalized = operation === 'cdpCall'
      ? normalizeBrowserCdpReadCall(input.method, input.params ?? {})
      : operation === 'cdpWrite'
        ? normalizeBrowserCdpWriteCall(input.method, input.params ?? {})
      : normalizeBrowserCdpEventQuery(input);
    const targetUrls = operation === 'cdpWrite'
      ? (normalized as ReturnType<typeof normalizeBrowserCdpWriteCall>).targetUrls : [];
    const options = operation === 'cdpEvents' ? {} : normalizeBrowserCdpCommandOptions(input);
    const args = operation === 'cdpWrite'
      ? { method: (normalized as { method: string }).method,
        params: (normalized as { params: Record<string, unknown> }).params, ...options }
      : operation === 'cdpCall' ? { ...normalized, ...options } : normalized;
    const actionName = operation === 'cdpEvents' ? 'readEvents' : (args as { method: string }).method;
    const currentClaim = this.bridge.getClaim(binding.identity);
    if (!currentClaim || this.sitePolicy.decision(currentClaim.url, 'access') === 'block') {
      throw new Error('Browser site is blocked by policy');
    }
    const initialUrl = currentClaim.url;
    const initialOrigin = new URL(initialUrl).origin;
    if (claim.browser === 'memmy' && !binding.allowedOrigins.has(initialOrigin)) {
      if (!await this.authorizeNavigation(initialUrl, binding.allowedOrigins)) {
        throw new Error('Browser site was not approved');
      }
      await this.bridge.command(claim, 'allowOrigin', { origin: initialOrigin }, signal ?? undefined);
    }
    if (claim.browser !== 'memmy') {
      binding.allowedOrigins.add(initialOrigin);
      const state = await this.bridge.command(claim, 'tabState', {}, signal ?? undefined) as { url?: string; origin?: string };
      if (state.url !== initialUrl || state.origin !== initialOrigin
        || !binding.allowedOrigins.has(initialOrigin)) throw new Error('Browser tab changed before CDP approval');
      if (!await approve(initialUrl, actionName, signal ?? undefined)) throw new Error('Browser CDP operation was not approved');
      const after = await this.bridge.command(claim, 'tabState', {}, signal ?? undefined) as { url?: string; origin?: string };
      if (after.url !== initialUrl || after.origin !== initialOrigin) throw new Error('Browser tab changed after CDP approval');
    }
    for (const target of [...new Set(targetUrls)]) {
      let destination: URL;
      try { destination = new URL(target); }
      catch { throw new Error('Invalid CDP destination URL'); }
      if (!['http:', 'https:'].includes(destination.protocol) || destination.href.length > 4096) {
        throw new Error('Invalid CDP destination URL');
      }
      if (destination.origin === initialOrigin) continue;
      if (!await this.authorizePage(claim, binding, destination.href)) {
        throw new Error('CDP destination site was not approved');
      }
      binding.allowedOrigins.add(destination.origin);
      if (claim.browser !== 'memmy') {
        if (!await approve(destination.href, actionName, signal ?? undefined)) {
          throw new Error('CDP destination debug access was not approved');
        }
        await this.bridge.command(claim, 'allowOrigin', { origin: destination.origin }, signal ?? undefined);
      }
    }
    if (signal?.aborted || !this.bindings.has(scopeKey(scope))
      || this.sitePolicy.decision(initialUrl, 'fullCdp') === 'block'
      || targetUrls.some(url => this.sitePolicy.decision(url, 'access') === 'block'
        || this.sitePolicy.decision(url, 'fullCdp') === 'block')) {
      throw new Error('Browser CDP operation is blocked');
    }
    const result = await this.bridge.command(claim, operation,
      claim.browser === 'memmy' ? args : { ...args, approvedOrigin: initialOrigin }, signal ?? undefined);
    if (signal?.aborted || !this.bindings.has(scopeKey(scope))
      || this.sitePolicy.decision(initialUrl, 'fullCdp') === 'block'
      || targetUrls.some(url => this.sitePolicy.decision(url, 'access') === 'block'
        || this.sitePolicy.decision(url, 'fullCdp') === 'block')) {
      throw new Error('Browser CDP operation is no longer approved');
    }
    if (claim.browser !== 'memmy') {
      const afterRead = await this.bridge.command(claim, 'tabState', {}, signal ?? undefined) as {
        url?: string; origin?: string };
      if (afterRead.url !== initialUrl || afterRead.origin !== initialOrigin) {
        throw new Error('Browser CDP site changed while reading');
      }
    }
    const output = JSON.stringify(result ?? {});
    if (output.length > 1_000_000) throw new Error('Browser CDP response exceeds size limit');
    return output;
  }

  async handleSurfaceAction(action: ComputerUseSurfaceAction): Promise<boolean> {
    if (action.surface !== "browser" || !action.targetId.startsWith(`${this.targetKind}:`)) return false;
    const scope = { sessionKey: action.sessionKey, channel: action.channel, chatId: action.chatId };
    const binding = this.bindings.get(scopeKey(scope));
    if (!binding) return true;
    if (this.targetKind === 'embedded') await this.bridge.refresh?.().catch(() => null);
    const claim = this.bridge.getClaim(binding.identity);
    if (!claim || externalBrowserTargetId(claim) !== action.targetId) return true;
    try {
      if (this.sitePolicy.decision(claim.url, 'access') === 'block') return true;
      if (claim.browser === 'memmy') {
        const currentOrigin = new URL(claim.url).origin;
        if (!binding.allowedOrigins.has(currentOrigin)) {
          if (!await this.authorizeNavigation(claim.url, binding.allowedOrigins)) return true;
          await this.bridge.command(claim, 'allowOrigin', { origin: currentOrigin });
        }
      }
      if (action.action === "navigate") {
        const url = new URL(action.url!);
        if (!["http:", "https:"].includes(url.protocol)) return true;
        if (url.origin !== new URL(claim.url).origin) {
          if (!await this.authorizePage(claim, binding, url.href)) return true;
          await this.bridge.command(claim, "allowOrigin", { origin: url.origin });
        }
        await this.bridge.command(claim, "navigate", { url: url.href });
      } else if (action.action === "click") {
        const size = await this.bridge.command(claim, "viewport") as { width: number; height: number };
        if (!Number.isFinite(size.width) || !Number.isFinite(size.height)) return true;
        await this.bridge.command(claim, "click", { x: Math.round(action.x! * size.width), y: Math.round(action.y! * size.height) });
      } else if (action.action === "scroll") {
        await this.bridge.command(claim, "scroll", { deltaY: action.deltaY });
      } else if (action.action === "key") {
        await this.bridge.command(claim, "pressKey", { key: action.key });
      } else if (action.action === "fill-credential" || action.action === "fill-contact") {
        if (!action.autofill || new URL(claim.url).origin !== action.autofill.origin) return true;
        await this.bridge.command(claim,
          action.action === "fill-credential" ? "fillCredential" : "fillContact", action.autofill);
      } else if (["open", "back", "forward", "reload"].includes(action.action)) {
        await this.bridge.command(claim, action.action);
      }
      if (action.action !== "open") await emitExternalBrowserFrame(this.bridge, claim, scope);
    } catch { /* A stale surface action must not interrupt the Agent. */ }
    return true;
  }

  closeSurfacesForTurn(scope: BrowserScope): void {
    const binding = this.bindings.get(scopeKey(scope));
    if (!binding) return;
    const claim = this.bridge.getClaim(binding.identity);
    if (!claim) return;
    emitComputerUseSurface({ surface: "browser", ...binding.scope,
      targetId: externalBrowserTargetId(claim), title: claim.title || "Browser",
      close: true, presentationOnly: true });
  }

  async finishTurn(scope: BrowserScope): Promise<void> {
    const binding = this.bindings.get(scopeKey(scope));
    if (!binding) return;
    this.closeSurfacesForTurn(scope);
    if (!binding.agentCreated || !binding.usedInTurn) return;
    binding.usedInTurn = false;
    if (binding.disposition) {
      binding.disposition = null;
      return;
    }
    try {
      const claim = this.bridge.getClaim(binding.identity);
      if (claim) await this.bridge.command(claim, 'closeTab');
    } finally {
      this.closeSession(scope);
    }
  }

  closeSession(scope: BrowserScope): void {
    const binding = this.bindings.get(scopeKey(scope));
    if (!binding) return;
    this.bindings.delete(scopeKey(scope));
    fs.rmSync(binding.outputDir, { recursive: true, force: true });
    const claim = this.bridge.getClaim(binding.identity);
    if (!claim) return;
    emitComputerUseSurface({ surface: "browser", ...binding.scope,
      targetId: externalBrowserTargetId(claim), title: claim.title || "Browser", close: true });
  }

  closeChat(channel: string, chatId: string): void {
    for (const binding of [...this.bindings.values()]) {
      if (binding.scope.channel === channel && binding.scope.chatId === chatId) this.closeSession(binding.scope);
    }
  }

  closeAll(): void {
    for (const binding of [...this.bindings.values()]) this.closeSession(binding.scope);
  }
}
