import type { BrowserScope, BrowserToolName } from "./browser.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeBrowserCdpReadCall, normalizeBrowserCdpWriteCall, normalizeBrowserCdpEventQuery,
  normalizeBrowserCdpCommandOptions, parseBrowserCdpTargetApproval, parseBrowserTaskSitePermission,
  type BrowserTaskSitePermissionRequest,
  type BrowserCdpTarget, type ComputerUseSurfaceAction } from "@memmy/local-api-contracts";
import { emitComputerUseSurface } from "../../../tools/computer-use/surface-preview.js";
import { type ExternalBrowserClaim, type ExternalBrowserTabStatus, type ExternalBrowserPlaywrightEvent } from "./external-browser-bridge.js";
import { formatExternalBrowserTabReference, parseExternalBrowserTabReference } from './external-browser-tab-reference.js';
import { callExternalBrowserTool, emitExternalBrowserFrame, externalBrowserTargetId,
  EMBEDDED_BROWSER_SCREENSHOT_UNSUPPORTED } from "./external-browser-tools.js";
import { BrowserUseSitePolicyReader } from './browser-use-site-policy-store.js';
import { closeExternalBrowserPlaywrightScope, closeAllExternalBrowserPlaywright } from './external-browser-playwright.js';
import type { BrowserCommandBridge } from './external-browser-tools.js';
import { publicBrowserAuthResult } from '../../../utils/browser-auth-privacy.js';

export type ClaimedBrowserBridge = {
  refresh?(): Promise<ExternalBrowserClaim | null>;
  listClaims(): ExternalBrowserClaim[];
  listConnected?(): Array<'chrome' | 'edge'>;
  listTabStatuses?(): ExternalBrowserTabStatus[];
  refreshTabs?(browser?: 'chrome' | 'edge'): Promise<void>;
  waitForConnection?(browser: 'chrome' | 'edge', timeoutMs: number, signal?: AbortSignal): Promise<boolean>;
  openBrowserTab?(browser: 'chrome' | 'edge', url: string,
    source?: Pick<ExternalBrowserClaim, 'connectionId' | 'tabId'>): Promise<ExternalBrowserClaim>;
  getClaim(identity: Pick<ExternalBrowserClaim, 'connectionId' | 'tabId'>): ExternalBrowserClaim | null;
  command(claim: Pick<ExternalBrowserClaim, 'connectionId' | 'tabId'>,
    command: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  subscribePlaywright?(identity: Pick<ExternalBrowserClaim, 'connectionId' | 'tabId'>,
    listener: (event: ExternalBrowserPlaywrightEvent) => void): () => void;
};

type Binding = {
  scope: BrowserScope;
  identity: Pick<ExternalBrowserClaim, "connectionId" | "tabId">;
  browser: ExternalBrowserClaim['browser'];
  targetId: string;
  title: string;
  allowedOrigins: Set<string>;
  outputDir: string;
  agentCreated: boolean;
  retainedUnseen: boolean;
  disposition: 'deliverable' | 'handoff' | null;
  sitePermissions: boolean;
  usedInTurn: boolean;
  turnRevision: number;
  activityRevision: number;
  inFlight: number;
  lastUsed: number;
};

/** Every tab a chat has worked with; `current` is the target when a call names no tab. */
type ChatTabs = { tabs: Map<string, Binding>; current: string | null };

// Shared by the in-app and Chrome/Edge routers so a chat continues the surface it used last.
let useSequence = 0;

const TAB_IN_USE_MESSAGE = 'Browser tab is already in use by another chat that is still working. Wait for that task to finish or choose another tab.';

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

/**
 * Routes Agent browser calls to the tabs each chat works with. A chat may use several tabs and
 * switch between them at any time; another chat can take a tab over once this chat is idle.
 */
export class ExternalBrowserSessionRouter {
  private readonly chats = new Map<string, ChatTabs>();

  constructor(
    private readonly bridge: ClaimedBrowserBridge,
    private readonly authorizeNavigation: (url: string, allowed: Set<string>) => Promise<boolean>,
    private readonly targetKind: 'external' | 'embedded' = 'external',
    private readonly sitePolicy = new BrowserUseSitePolicyReader(),
  ) {}

  /** Whether the chat has a current tab that calls without a tab reference continue. */
  hasBinding(scope: BrowserScope): boolean { return this.currentBinding(scope) !== null; }

  lastUsed(scope: BrowserScope): number { return this.currentBinding(scope)?.lastUsed ?? 0; }

  currentBrowser(scope: BrowserScope): Binding['browser'] | null { return this.currentBinding(scope)?.browser ?? null; }

  private currentBinding(scope: BrowserScope): Binding | null {
    const chat = this.chats.get(scopeKey(scope));
    return chat?.current ? chat.tabs.get(chat.current) ?? null : null;
  }

  private bindingFor(scope: BrowserScope,
    identity: Pick<ExternalBrowserClaim, 'connectionId' | 'tabId'>): Binding | null {
    return this.chats.get(scopeKey(scope))?.tabs.get(claimKey(identity)) ?? null;
  }

  private otherOwner(key: string, claim: Pick<ExternalBrowserClaim, 'connectionId' | 'tabId'>) {
    for (const [ownerKey, chat] of this.chats) {
      const binding = ownerKey === key ? undefined : chat.tabs.get(claimKey(claim));
      if (binding) return { key: ownerKey, binding };
    }
    return null;
  }

  private busy(binding: Binding): boolean { return binding.inFlight > 0 || binding.usedInTurn; }

  private touch(key: string, binding: Binding): void {
    const chat = this.chats.get(key);
    if (!chat) return;
    chat.current = claimKey(binding.identity);
    binding.lastUsed = ++useSequence;
    binding.usedInTurn = true;
  }

  private controllableClaims(): ExternalBrowserClaim[] {
    const statuses = new Map((this.bridge.listTabStatuses?.() ?? []).map(tab => [claimKey(tab), tab.status]));
    return this.bridge.listClaims().filter(claim => !statuses.has(claimKey(claim))
      || statuses.get(claimKey(claim)) === 'ready');
  }

  private assertClaimAvailable(scope: BrowserScope, claim: ExternalBrowserClaim): void {
    const owner = this.otherOwner(scopeKey(scope), claim);
    if (owner && this.busy(owner.binding)) throw new Error(TAB_IN_USE_MESSAGE);
  }

  async listTabs(scope: BrowserScope, browser?: 'chrome' | 'edge') {
    let pageDiscoveryStatus: 'ready' | 'unresponsive' = 'ready';
    try { await this.bridge.refreshTabs?.(browser); }
    catch (error) {
      // Keep a slow/half-open bridge distinct from an absent extension. Do not
      // disconnect a shared client and cancel another chat's work to rescan it.
      if (!(error instanceof Error) || !['Browser extension page refresh timed out', 'External browser disconnected']
        .includes(error.message)) throw error;
      pageDiscoveryStatus = 'unresponsive';
    }
    const key = scopeKey(scope);
    const chat = this.chats.get(key);
    const claims = this.controllableClaims().filter(claim => claim.browser !== 'memmy'
      && (!browser || claim.browser === browser));
    return {
      pageDiscoveryStatus,
      connectedBrowsers: (this.bridge.listConnected?.() ?? [])
        .filter(name => !browser || name === browser),
      tabStatuses: (this.bridge.listTabStatuses?.() ?? [])
        .filter(tab => !browser || tab.browser === browser)
        .map(({ connectionId: _connectionId, ...tab }) => tab),
      tabs: (pageDiscoveryStatus === 'ready' ? claims : []).map(claim => {
        const owner = this.otherOwner(key, claim);
        return { browser: claim.browser, tabId: claim.tabId,
          title: claim.title, url: claim.url, active: claim.active === true,
          inUseByCurrentChat: Boolean(chat?.tabs.has(claimKey(claim))),
          available: !owner || !this.busy(owner.binding),
          tabMention: formatExternalBrowserTabReference({ ...claim, browser: claim.browser as 'chrome' | 'edge' }) };
      }),
    };
  }

  waitForConnection(browser: 'chrome' | 'edge', timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    return this.bridge.waitForConnection?.(browser, timeoutMs, signal)
      ?? Promise.resolve((this.bridge.listConnected?.() ?? []).includes(browser));
  }

  async selectBrowser(scope: BrowserScope, browser: 'chrome' | 'edge', mention?: string,
    assertCurrent: () => void = () => undefined): Promise<ExternalBrowserClaim> {
    assertCurrent();
    if (mention !== undefined) {
      const reference = parseExternalBrowserTabReference(mention);
      if (!reference || reference.browser !== browser) throw new Error('Invalid or mismatched external browser tab reference');
      const claim = this.bridge.getClaim(reference);
      if (!claim || claim.browser !== reference.browser || claim.title !== reference.title || claim.url !== reference.url) {
        throw new Error('The referenced browser tab changed or disconnected. Use browser_list_tabs for the intended browser again.');
      }
      this.assertClaimAvailable(scope, claim);
      const live = await this.bridge.command(claim, 'tabState') as { title?: string; url?: string };
      assertCurrent();
      if (live.url !== reference.url || live.title !== reference.title || this.bridge.getClaim(reference) !== claim) {
        throw new Error('The referenced browser page changed. Use browser_list_tabs for the intended browser again.');
      }
      return this.selectClaim(scope, claim);
    }
    const key = scopeKey(scope);
    const existing = this.latestIn(key, browser);
    if (existing) {
      let claim = this.bridge.getClaim(existing.identity);
      if (!claim && this.targetKind === 'external') {
        await this.bridge.refreshTabs?.(browser).catch(() => undefined);
        assertCurrent();
        if (this.bindingFor(scope, existing.identity) !== existing) throw new Error(this.changedMessage());
        claim = this.bridge.getClaim(existing.identity);
      }
      if (!claim) throw new Error(this.disconnectedMessage());
      this.touch(key, existing);
      return claim;
    }
    await this.bridge.refreshTabs?.(browser);
    assertCurrent();
    const claims = this.controllableClaims().filter(claim => claim.browser === browser);
    const active = claims.filter(claim => claim.active === true);
    const candidate = claims.length === 1 ? claims[0] : active.length === 1 ? active[0] : null;
    if (candidate) return this.selectClaim(scope, candidate);
    if (claims.length > 1) throw new Error(`Several ${browser} tabs are available. Resolve the user-requested title or URL with browser_list_tabs and pass its tabMention.`);
    const statuses = (this.bridge.listTabStatuses?.() ?? []).filter(tab => tab.browser === browser);
    const reason = statuses.find(tab => tab.status === 'attach_failed' || tab.status === 'user_detached')?.reason;
    throw new Error(`${browser} has no controllable web page through the Memmy extension.${reason ? ` ${reason}` : ' Open the requested ordinary web page and check the extension connection.'}`);
  }

  private latestIn(key: string, browser: Binding['browser']): Binding | null {
    return [...(this.chats.get(key)?.tabs.values() ?? [])].filter(binding => binding.browser === browser)
      .reduce<Binding | null>((latest, binding) => !latest || binding.lastUsed > latest.lastUsed ? binding : latest, null);
  }

  /** Opens a background Chrome/Edge tab beside the one this chat used last there and makes it the current tab. */
  async openTab(scope: BrowserScope, browser: 'chrome' | 'edge', url: string,
    assertCurrent: () => void = () => undefined): Promise<ExternalBrowserClaim> {
    if (this.targetKind !== 'external' || !this.bridge.openBrowserTab) throw new Error('Opening Chrome/Edge tabs is unavailable');
    let target: URL;
    try { target = new URL(url); } catch { throw new Error('newTab requires an http(s) URL'); }
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('newTab requires an http(s) URL');
    if (this.sitePolicy.decision(target.href, 'access') === 'block') throw new Error('Browser site is blocked by policy');
    const source = this.latestIn(scopeKey(scope), browser);
    assertCurrent();
    const claim = await this.bridge.openBrowserTab(browser, target.href,
      source && this.bridge.getClaim(source.identity) ? source.identity : undefined);
    assertCurrent();
    return this.selectClaim(scope, claim);
  }

  private disconnectedMessage(): string {
    return this.targetKind === 'embedded'
      ? 'The Memmy in-app browser tab bound to this chat was closed or replaced. Use browser_list_tabs to resolve the tab the user intends to operate; another tab will not be selected automatically.'
      : 'The Chrome/Edge browser tab this chat was using is disconnected. Use browser_list_tabs and pass the intended tabMention; another tab will not be selected automatically.';
  }

  private changedMessage(): string {
    return this.targetKind === 'embedded'
      ? 'The Memmy in-app browser tab bound to this chat changed or its request ended. Use browser_list_tabs to resolve the tab the user intends to operate in the current request.'
      : 'The Chrome/Edge browser tab this chat was using changed. Use browser_list_tabs and pass the intended tabMention.';
  }

  private assertBinding(scope: BrowserScope, binding: Binding, turnRevision: number): void {
    if (this.bindingFor(scope, binding.identity) !== binding
      || binding.turnRevision !== turnRevision) {
      throw new Error(this.changedMessage());
    }
  }

  private async withBinding<T>(scope: BrowserScope,
    identity: Pick<ExternalBrowserClaim, 'connectionId' | 'tabId'>,
    operation: (binding: Binding, turnRevision: number) => Promise<T>): Promise<T> {
    const binding = this.bindingFor(scope, identity);
    if (!binding) throw new Error(this.changedMessage());
    const turnRevision = binding.turnRevision;
    binding.activityRevision += 1;
    binding.inFlight += 1;
    try {
      const result = await operation(binding, turnRevision);
      this.assertBinding(scope, binding, turnRevision);
      return result;
    } finally { binding.inFlight -= 1; }
  }

  private scopedBridge(scope: BrowserScope, binding: Binding,
    turnRevision = binding.turnRevision): BrowserCommandBridge {
    return {
      getClaim: identity => this.bridge.getClaim(identity),
      command: async (...args: Parameters<ClaimedBrowserBridge['command']>) => {
        this.assertBinding(scope, binding, turnRevision);
        const result = await this.bridge.command(...args);
        this.assertBinding(scope, binding, turnRevision);
        return result;
      },
      isFrameAllowed: url => this.sitePolicy.decision(url, 'access') !== 'block',
      ...(this.bridge.subscribePlaywright ? {
        subscribePlaywright: (identity: Pick<ExternalBrowserClaim, 'connectionId' | 'tabId'>,
          listener: (event: ExternalBrowserPlaywrightEvent) => void) => {
          this.assertBinding(scope, binding, turnRevision);
          if (claimKey(identity) !== claimKey(binding.identity)) throw new Error(this.changedMessage());
          return this.bridge.subscribePlaywright!(identity, event => {
            try { this.assertBinding(scope, binding, turnRevision); listener(event); }
            catch { /* Events from a released task must not enter another executor. */ }
          });
        },
      } : {}),
    };
  }

  /** Makes the claim this chat's current tab; tabs the chat used before stay available with their own grants. */
  selectClaim(scope: BrowserScope, claim: ExternalBrowserClaim,
    options: { allowedOrigins?: Set<string>; agentCreated?: boolean } = {}): ExternalBrowserClaim {
    const key = scopeKey(scope);
    if (!this.bridge.getClaim(claim)) {
      throw new Error(this.targetKind === 'embedded'
        ? 'The referenced Memmy in-app browser tab is no longer open. Use browser_list_tabs to resolve the tab the user intends to operate.'
        : 'The selected Chrome/Edge browser tab is no longer connected. Reconnect the browser extension before continuing.');
    }
    const existing = this.bindingFor(scope, claim);
    if (existing) {
      this.touch(key, existing);
      return claim;
    }
    const owner = this.otherOwner(key, claim);
    if (owner) {
      if (this.busy(owner.binding)) throw new Error(TAB_IN_USE_MESSAGE);
      this.release(owner.key, owner.binding);
    }
    for (const binding of [...(this.chats.get(key)?.tabs.values() ?? [])]) {
      if (!this.bridge.getClaim(binding.identity)) this.release(key, binding);
    }
    const chat = this.chats.get(key) ?? { tabs: new Map<string, Binding>(), current: null };
    this.chats.set(key, chat);
    const binding: Binding = { scope: { ...scope },
      identity: { connectionId: claim.connectionId, tabId: claim.tabId },
      browser: claim.browser, targetId: externalBrowserTargetId(claim), title: claim.title,
      allowedOrigins: options.allowedOrigins ?? new Set(),
      outputDir: fs.mkdtempSync(path.join(os.tmpdir(), "memmy-external-browser-session-")),
      agentCreated: options.agentCreated === true, retainedUnseen: false, disposition: null, sitePermissions: false,
      usedInTurn: true, turnRevision: 0, activityRevision: 0, inFlight: 0, lastUsed: 0 };
    chat.tabs.set(claimKey(claim), binding);
    this.touch(key, binding);
    return claim;
  }

  /** Continues the current tab. Without one, only the in-app router adopts the tab the user has selected. */
  select(scope: BrowserScope, hasInternalSession: boolean, initialAllowedOrigins?: Set<string>): ExternalBrowserClaim | null {
    const key = scopeKey(scope);
    const current = this.currentBinding(scope);
    if (current) {
      const claim = this.bridge.getClaim(current.identity);
      if (!claim) throw new Error(this.disconnectedMessage());
      this.touch(key, current);
      return claim;
    }
    if (hasInternalSession || this.targetKind === 'external') return null;
    const available = this.bridge.listClaims().filter(claim => {
      const owner = this.otherOwner(key, claim);
      return !owner || !this.busy(owner.binding);
    });
    if (available.length === 0) return null;
    return this.selectClaim(scope, preferredClaim(available), { allowedOrigins: initialAllowedOrigins });
  }

  markTab(scope: BrowserScope, disposition: 'deliverable' | 'handoff',
    expectedClaim?: Pick<ExternalBrowserClaim, 'connectionId' | 'tabId'>): void {
    if (!this.chats.has(scopeKey(scope))) throw new Error('Browser tab is not bound to this chat');
    const binding = expectedClaim ? this.bindingFor(scope, expectedClaim) : this.currentBinding(scope);
    if (!binding) throw new Error(this.changedMessage());
    binding.disposition = disposition;
  }

  async call(scope: BrowserScope, claim: ExternalBrowserClaim,
    name: BrowserToolName, params: Record<string, any>, abortSignal?: AbortSignal | null): Promise<Array<Record<string, any>>> {
    if (claim.browser === 'memmy' && name === 'browser_take_screenshot') {
      throw new Error(EMBEDDED_BROWSER_SCREENSHOT_UNSUPPORTED);
    }
    return this.withBinding(scope, claim, async (binding, turnRevision) => {
      await this.authorizeCurrent(scope, claim);
      this.assertBinding(scope, binding, turnRevision);
      const scopedBridge = this.scopedBridge(scope, binding, turnRevision);
      const content = await callExternalBrowserTool(scopedBridge, claim, scope, name, params,
        url => this.authorizePage(binding, url), abortSignal);
      this.assertBinding(scope, binding, turnRevision);
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
    });
  }

  async requestAuth(scope: BrowserScope, claim: ExternalBrowserClaim,
    args: Record<string, unknown>, signal?: AbortSignal | null): Promise<string> {
    return this.withBinding(scope, claim, async (binding, revision) => {
      await this.authorizeCurrent(scope, claim);
      const result = await this.scopedBridge(scope, binding, revision)
        .command(claim, 'authRequest', args, signal ?? undefined);
      if (!result || typeof result !== 'object' || typeof (result as { status?: unknown }).status !== 'string') {
        throw new Error('Invalid browser auth response');
      }
      return publicBrowserAuthResult(result);
    });
  }

  async setDownloadDestination(scope: BrowserScope, claim: ExternalBrowserClaim,
    filePath: string | null, destinationId: string, signal?: AbortSignal | null): Promise<unknown> {
    if (claim.browser !== 'memmy') throw new Error('Download destination is available for in-app browser tabs');
    return this.withBinding(scope, claim, async (binding, revision) => {
      // Revoke this request's private destination without asking for page access
      // again. The bridge still binds cleanup to the original task and tab.
      if (filePath !== null) await this.authorizeCurrent(scope, claim);
      return this.scopedBridge(scope, binding, revision)
        .command(claim, 'setDownloadDestination', { filePath, destinationId }, signal ?? undefined);
    });
  }

  async setSitePermission(scope: BrowserScope, claim: ExternalBrowserClaim,
    input: BrowserTaskSitePermissionRequest, signal?: AbortSignal | null): Promise<string> {
    const request = parseBrowserTaskSitePermission(input);
    if (!request) throw new Error('Invalid browser site permission');
    return this.withBinding(scope, claim, async (binding, revision) => {
      const current = () => {
        this.assertBinding(scope, binding, revision);
        if (signal?.aborted) throw new Error('Browser site permission operation cancelled');
        const latest = this.bridge.getClaim(binding.identity);
        if (!latest || latest.browser !== binding.browser || new URL(latest.url).origin !== request.origin) {
          throw new Error('Browser site permission origin changed');
        }
        return latest;
      };
      current();
      if (request.allow) await this.authorizeCurrent(scope, claim);
      const latest = current();
      if (claim.browser !== 'memmy') {
        return JSON.stringify({ status: 'requires_browser_ui', browser: claim.browser, ...request,
          tabMention: formatExternalBrowserTabReference({ ...latest, browser: claim.browser }),
          agentAction: 'Select this task tab, then use Computer Use on this browser to complete its normal permission prompt or change this exact site permission in the browser site controls. Continue the task and verify the page result.' });
      }
      binding.sitePermissions = true;
      const result = await this.scopedBridge(scope, binding, revision)
        .command(claim, 'setSitePermission', request, signal ?? undefined);
      current();
      return JSON.stringify(result);
    });
  }

  async waitDownloadDestination(scope: BrowserScope, claim: ExternalBrowserClaim,
    destinationId: string, signal?: AbortSignal | null): Promise<unknown> {
    if (claim.browser !== 'memmy') throw new Error('Download destination is available for in-app browser tabs');
    return this.withBinding(scope, claim, async (binding, revision) => {
      return this.scopedBridge(scope, binding, revision)
        .command(claim, 'waitDownloadDestination', { destinationId }, signal ?? undefined);
    });
  }

  /** Selects the bound Chrome/Edge tab in its window without raising the browser over other apps. */
  async activate(scope: BrowserScope, claim: ExternalBrowserClaim, signal?: AbortSignal | null): Promise<string> {
    if (claim.browser === 'memmy') throw new Error('Tab selection is available for Chrome/Edge tabs');
    return this.withBinding(scope, claim, async (binding, revision) => {
      await this.authorizeCurrent(scope, claim);
      const bridge = this.scopedBridge(scope, binding, revision);
      await bridge.command(claim, 'activate', {}, signal ?? undefined);
      await emitExternalBrowserFrame(bridge, claim, scope);
      const latest = this.bridge.getClaim(binding.identity) ?? claim;
      return JSON.stringify({ selected: true, browser: latest.browser, title: latest.title, url: latest.url });
    });
  }

  private async authorizePage(binding: Binding, url: string): Promise<boolean> {
    if (this.sitePolicy.decision(url, 'access') === 'block') return false;
    return this.authorizeNavigation(url, binding.allowedOrigins);
  }

  async authorizeCurrent(scope: BrowserScope, claim: ExternalBrowserClaim): Promise<void> {
    return this.withBinding(scope, claim, async (binding, turnRevision) => {
      const liveClaim = this.bridge.getClaim(binding.identity);
      if (!liveClaim) throw new Error(this.disconnectedMessage());
      if (this.sitePolicy.decision(liveClaim.url, 'access') === 'block') {
        throw new Error('Browser site is blocked by policy');
      }
      binding.usedInTurn = true;
      const currentOrigin = new URL(liveClaim.url).origin;
      const previouslyAllowed = binding.allowedOrigins.has(currentOrigin);
      // The approval gate revalidates saved rules and revocations, including
      // cached temporary grants. The origin Set alone is not an approval.
      if (!await this.authorizeNavigation(liveClaim.url, binding.allowedOrigins)) {
        throw new Error(`Access to ${currentOrigin} was not approved`);
      }
      this.assertBinding(scope, binding, turnRevision);
      const approvedClaim = this.bridge.getClaim(binding.identity);
      if (!approvedClaim) throw new Error(this.disconnectedMessage());
      if (new URL(approvedClaim.url).origin !== currentOrigin) throw new Error(this.changedMessage());
      if (!previouslyAllowed || !binding.allowedOrigins.has(currentOrigin)) {
        await this.scopedBridge(scope, binding, turnRevision).command(claim, 'allowOrigin', { origin: currentOrigin });
      }
      // This tracks the approved page for navigation/file binding only. The
      // approval gate revalidates it on every call, including global revocation.
      binding.allowedOrigins.add(currentOrigin);
    });
  }

  /** The visible decision binds one claimed tab, origin, target and file snapshot. */
  async upload(scope: BrowserScope, claim: ExternalBrowserClaim, params: Record<string, any>,
    authorize: (url: string, files: string[], signal?: AbortSignal) => Promise<boolean>,
    abortSignal?: AbortSignal | null): Promise<Array<Record<string, any>>> {
    const binding = this.bindingFor(scope, claim);
    if (!binding || claim.browser === 'memmy') {
      throw new Error('External browser session changed');
    }
    const turnRevision = binding.turnRevision;
    const assertCurrent = () => {
      if (abortSignal?.aborted || this.bindingFor(scope, binding.identity) !== binding) {
        throw new Error('Browser upload cancelled');
      }
      this.assertBinding(scope, binding, turnRevision);
    };
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
    assertCurrent();
    await this.authorizeCurrent(scope, claim);
    assertCurrent();
    const initial = await this.bridge.command(claim, 'tabState', {}, abortSignal ?? undefined) as { url?: string; origin?: string };
    assertCurrent();
    if (!initial?.url || !initial.origin || new URL(initial.url).origin !== initial.origin
      || !binding.allowedOrigins.has(initial.origin)) throw new Error('External browser upload site changed');
    const stamps = files.map(file => {
      const info = fs.lstatSync(file);
      return { path: file, realPath: fs.realpathSync(file), dev: info.dev, ino: info.ino,
        size: info.size, mtimeMs: info.mtimeMs };
    });
    if (!await authorize(initial.url, files, abortSignal ?? undefined)) throw new Error('Browser upload was not approved');
    assertCurrent();
    const current = await this.bridge.command(claim, 'tabState', {}, abortSignal ?? undefined) as { url?: string; origin?: string };
    assertCurrent();
    if (current?.url !== initial.url || current?.origin !== initial.origin
      || this.bridge.getClaim(binding.identity)?.connectionId !== claim.connectionId) {
      throw new Error('External browser upload site changed after approval');
    }
    const temporary = fs.mkdtempSync(path.join(binding.outputDir, 'approved-upload-'));
    fs.chmodSync(temporary, 0o700);
    try {
      const staged: string[] = [];
      for (const [index, stamp] of stamps.entries()) {
        assertCurrent();
        if (fs.realpathSync(stamp.path) !== stamp.realPath) {
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
              assertCurrent();
              const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
              if (!bytesRead) break;
              assertCurrent();
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
      assertCurrent();
      const final = await this.bridge.command(claim, 'tabState', {}, abortSignal ?? undefined) as { url?: string; origin?: string };
      assertCurrent();
      if (final?.url !== initial.url || final?.origin !== initial.origin) {
        throw new Error('External browser upload site changed after approval');
      }
      if (this.sitePolicy.decision(initial.url, 'uploads') === 'block') {
        throw new Error('Browser upload was blocked by site policy');
      }
      assertCurrent();
      const result = await this.call(scope, claim, 'browser_file_upload',
        { target, paths: staged, approvedOrigin: initial.origin }, abortSignal);
      assertCurrent();
      return result;
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }

  async cdp(scope: BrowserScope, claim: ExternalBrowserClaim, operation: 'cdpCall' | 'cdpEvents' | 'cdpWrite',
    input: Record<string, unknown>, approve: (url: string, name: string, signal?: AbortSignal) => Promise<boolean>,
    signal?: AbortSignal | null): Promise<string> {
    if (claim.browser === 'memmy' && input.method === 'Page.captureScreenshot') {
      throw new Error(EMBEDDED_BROWSER_SCREENSHOT_UNSUPPORTED);
    }
    return this.withBinding(scope, claim, async (binding, turnRevision) => {
      const bridge = this.scopedBridge(scope, binding, turnRevision);
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
      if (!currentClaim) throw new Error(this.disconnectedMessage());
      if (this.sitePolicy.decision(currentClaim.url, 'access') === 'block') {
        throw new Error('Browser site is blocked by policy');
      }
      const initialUrl = currentClaim.url;
      const initialOrigin = new URL(initialUrl).origin;
      await this.authorizeCurrent(scope, currentClaim);
      let approvedTarget: ReturnType<typeof parseBrowserCdpTargetApproval> = null;
      if (claim.browser !== 'memmy') {
        binding.allowedOrigins.add(initialOrigin);
        const state = await bridge.command(claim, 'tabState', {}, signal ?? undefined) as { url?: string; origin?: string };
        if (state.url !== initialUrl || state.origin !== initialOrigin
          || !binding.allowedOrigins.has(initialOrigin)) throw new Error('Browser tab changed before CDP approval');
        if (!await approve(initialUrl, actionName, signal ?? undefined)) throw new Error('Browser CDP operation was not approved');
        const after = await bridge.command(claim, 'tabState', {}, signal ?? undefined) as { url?: string; origin?: string };
        if (after.url !== initialUrl || after.origin !== initialOrigin) throw new Error('Browser tab changed after CDP approval');
        const target = (args as { target?: BrowserCdpTarget }).target;
        if (target) {
          approvedTarget = parseBrowserCdpTargetApproval(await bridge.command(claim, 'cdpTarget',
            { target, approvedOrigin: initialOrigin }, signal ?? undefined));
          if (!approvedTarget
            || ('sessionId' in target && target.sessionId !== approvedTarget.sessionId)
            || ('targetId' in target && target.targetId !== approvedTarget.targetId)) {
            throw new Error('Browser CDP child target approval is unavailable');
          }
          if (this.sitePolicy.decision(approvedTarget.url, 'access') === 'block'
            || this.sitePolicy.decision(approvedTarget.url, 'fullCdp') === 'block'
            || !await this.authorizePage(binding, approvedTarget.url)
            || (approvedTarget.origin !== initialOrigin
              && !await approve(approvedTarget.url, actionName, signal ?? undefined))) {
            throw new Error('Browser CDP child target site was not approved');
          }
        }
      }
      for (const target of [...new Set(targetUrls)]) {
        let destination: URL;
        try { destination = new URL(target); }
        catch { throw new Error('Invalid CDP destination URL'); }
        if (!['http:', 'https:'].includes(destination.protocol) || destination.href.length > 4096) {
          throw new Error('Invalid CDP destination URL');
        }
        if (destination.origin === initialOrigin) continue;
        if (!await this.authorizePage(binding, destination.href)) {
          throw new Error('CDP destination site was not approved');
        }
        binding.allowedOrigins.add(destination.origin);
        if (claim.browser !== 'memmy') {
          if (!await approve(destination.href, actionName, signal ?? undefined)) {
            throw new Error('CDP destination debug access was not approved');
          }
          await bridge.command(claim, 'allowOrigin', { origin: destination.origin }, signal ?? undefined);
        }
      }
      if (signal?.aborted || this.bindingFor(scope, binding.identity) !== binding
        || (approvedTarget && (this.sitePolicy.decision(approvedTarget.url, 'access') === 'block'
          || this.sitePolicy.decision(approvedTarget.url, 'fullCdp') === 'block'))
        || this.sitePolicy.decision(initialUrl, 'fullCdp') === 'block'
        || targetUrls.some(url => this.sitePolicy.decision(url, 'access') === 'block'
          || this.sitePolicy.decision(url, 'fullCdp') === 'block')) {
        throw new Error('Browser CDP operation is blocked');
      }
      const result = await bridge.command(claim, operation,
        claim.browser === 'memmy' ? args : { ...args, approvedOrigin: initialOrigin,
          ...(approvedTarget ? { approvedTarget } : {}) }, signal ?? undefined);
      if (signal?.aborted || this.bindingFor(scope, binding.identity) !== binding
        || (approvedTarget && (this.sitePolicy.decision(approvedTarget.url, 'access') === 'block'
          || this.sitePolicy.decision(approvedTarget.url, 'fullCdp') === 'block'))
        || this.sitePolicy.decision(initialUrl, 'fullCdp') === 'block'
        || targetUrls.some(url => this.sitePolicy.decision(url, 'access') === 'block'
          || this.sitePolicy.decision(url, 'fullCdp') === 'block')) {
        throw new Error('Browser CDP operation is no longer approved');
      }
      if (claim.browser !== 'memmy') {
        const afterRead = await bridge.command(claim, 'tabState', {}, signal ?? undefined) as {
          url?: string; origin?: string };
        if (afterRead.url !== initialUrl || afterRead.origin !== initialOrigin) {
          throw new Error('Browser CDP site changed while reading');
        }
      }
      const output = JSON.stringify(result ?? {});
      if (output.length > 1_000_000) throw new Error('Browser CDP response exceeds size limit');
      return output;
    });
  }

  async handleSurfaceAction(action: ComputerUseSurfaceAction): Promise<boolean> {
    if (action.surface !== "browser" || !action.targetId.startsWith(`${this.targetKind}:`)) return false;
    const scope = { sessionKey: action.sessionKey, channel: action.channel, chatId: action.chatId };
    const binding = [...(this.chats.get(scopeKey(scope))?.tabs.values() ?? [])]
      .find(candidate => candidate.targetId === action.targetId);
    if (!binding) return true;
    try {
      return await this.withBinding(scope, binding.identity, async (binding, turnRevision) => {
        if (this.targetKind === 'embedded') await this.bridge.refresh?.().catch(() => null);
        this.assertBinding(scope, binding, turnRevision);
        const claim = this.bridge.getClaim(binding.identity);
        if (!claim || externalBrowserTargetId(claim) !== action.targetId) return true;
        if ((action.action === 'fill-credential' || action.action === 'fill-contact')
          && (!action.autofill || new URL(claim.url).origin !== action.autofill.origin)) return true;
        if (this.sitePolicy.decision(claim.url, 'access') === 'block') return true;
        await this.authorizeCurrent(scope, claim);
        const bridge = this.scopedBridge(scope, binding, turnRevision);
        if (action.action === "navigate") {
          const url = new URL(action.url!);
          if (!["http:", "https:"].includes(url.protocol)) return true;
          if (url.origin !== new URL(claim.url).origin) {
            if (!await this.authorizePage(binding, url.href)) return true;
            await bridge.command(claim, "allowOrigin", { origin: url.origin });
          }
          await bridge.command(claim, "navigate", { url: url.href });
        } else if (action.action === "click") {
          const size = await bridge.command(claim, "viewport") as { width: number; height: number };
          if (!Number.isFinite(size.width) || !Number.isFinite(size.height)) return true;
          await bridge.command(claim, "click", { x: Math.round(action.x! * size.width), y: Math.round(action.y! * size.height) });
        } else if (action.action === "scroll") {
          await bridge.command(claim, "scroll", { deltaY: action.deltaY });
        } else if (action.action === "key") {
          await bridge.command(claim, "pressKey", { key: action.key });
        } else if (action.action === "fill-credential" || action.action === "fill-contact") {
          if (!action.autofill || new URL(claim.url).origin !== action.autofill.origin) return true;
          await bridge.command(claim,
            action.action === "fill-credential" ? "fillCredential" : "fillContact", action.autofill);
        } else if (["open", "back", "forward", "reload"].includes(action.action)) {
          await bridge.command(claim, action.action);
        }
        if (action.action !== "open") await emitExternalBrowserFrame(bridge, claim, scope);
        return true;
      });
    } catch { /* A stale surface action must not interrupt the Agent. */ }
    return true;
  }

  closeSurfacesForTurn(scope: BrowserScope): void {
    for (const binding of this.chats.get(scopeKey(scope))?.tabs.values() ?? []) {
      const claim = this.bridge.getClaim(binding.identity);
      emitComputerUseSurface({ surface: "browser", ...binding.scope,
        targetId: binding.targetId, title: claim?.title || binding.title || "Browser",
        close: true, presentationOnly: true });
    }
  }

  /** Releases the chat's tabs to other chats and closes Agent-created in-app tabs nobody kept. */
  async finishTurn(scope: BrowserScope): Promise<void> {
    const key = scopeKey(scope);
    const chat = this.chats.get(key);
    // Revoke each pending tool before cleanup yields. A permission prompt can
    // complete after the turn ends, before Playwright has even created a scope.
    const ending = [...(chat?.tabs.values() ?? [])].map(binding => {
      const usedInTurn = binding.usedInTurn;
      binding.usedInTurn = false;
      binding.turnRevision += 1;
      return { binding, usedInTurn, turnRevision: binding.turnRevision,
        activityRevision: binding.activityRevision, lastUsed: binding.lastUsed };
    });
    // Sent before cleanup yields, so the end reaches the desktop ahead of a next turn's grant.
    const endedPermissions = ending.filter(({ binding }) => binding.sitePermissions)
      .map(({ binding }) => this.endSitePermissions(binding));
    this.closeSurfacesForTurn(scope);
    await closeExternalBrowserPlaywrightScope(scope);
    if (!chat) return;
    let freshTabInventory = false;
    if (this.targetKind === 'embedded' && this.bridge.refresh) {
      try { await this.bridge.refresh(); freshTabInventory = true; }
      catch { /* Without fresh visibility evidence, keep the normal close policy. */ }
    }
    const closing: Binding[] = [];
    for (const { binding, usedInTurn, turnRevision, activityRevision, lastUsed } of ending) {
      // The next turn may start while the old relay is cleaning up. Its use of
      // this same tab, or a replacement binding, belongs to the new owner.
      if (this.bindingFor(scope, binding.identity) !== binding
        || binding.turnRevision !== turnRevision || binding.activityRevision !== activityRevision
        || binding.lastUsed !== lastUsed || binding.usedInTurn) continue;
      if (!binding.agentCreated || !usedInTurn) continue;
      if (binding.disposition) binding.disposition = null;
      else if (this.targetKind === 'embedded' && freshTabInventory && !binding.retainedUnseen
        && this.bridge.getClaim(binding.identity)?.everSelected === false) {
        // A background page may finish before its owner visits the chat. Give
        // that page one chance to be seen, like an explicit handoff.
        binding.retainedUnseen = true;
      } else closing.push(binding);
    }
    await Promise.allSettled([...endedPermissions, ...closing.map(async binding => {
      try {
        const claim = this.bridge.getClaim(binding.identity);
        if (claim) await this.bridge.command(claim, 'closeTab');
      } finally { this.release(key, binding); }
    })]);
  }

  /** In-app device choices last only for the task that made them on this tab. */
  private async endSitePermissions(binding: Binding): Promise<void> {
    binding.sitePermissions = false;
    try { await this.bridge.command(binding.identity, 'endSitePermissions'); }
    catch { /* A closed tab or stopped desktop has already ended its choices. */ }
  }

  private release(key: string, binding: Binding): void {
    const chat = this.chats.get(key);
    const tabKey = claimKey(binding.identity);
    if (!chat || chat.tabs.get(tabKey) !== binding) return;
    if (binding.sitePermissions) void this.endSitePermissions(binding);
    chat.tabs.delete(tabKey);
    if (chat.current === tabKey) chat.current = null;
    if (chat.tabs.size === 0) this.chats.delete(key);
    fs.rmSync(binding.outputDir, { recursive: true, force: true });
    const claim = this.bridge.getClaim(binding.identity);
    emitComputerUseSurface({ surface: "browser", ...binding.scope,
      targetId: binding.targetId, title: claim?.title || binding.title || "Browser", close: true });
  }

  closeSession(scope: BrowserScope): void {
    void closeExternalBrowserPlaywrightScope(scope);
    const key = scopeKey(scope);
    for (const binding of [...(this.chats.get(key)?.tabs.values() ?? [])]) this.release(key, binding);
  }

  closeChat(channel: string, chatId: string): void {
    for (const chat of [...this.chats.values()]) {
      const scope = chat.tabs.values().next().value?.scope;
      if (scope?.channel === channel && scope.chatId === chatId) this.closeSession(scope);
    }
  }

  closeAll(): void {
    void closeAllExternalBrowserPlaywright();
    for (const key of [...this.chats.keys()]) {
      for (const binding of [...(this.chats.get(key)?.tabs.values() ?? [])]) this.release(key, binding);
    }
  }
}
