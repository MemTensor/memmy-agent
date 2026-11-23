import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { publicBrowserAuthResult } from "../../../utils/browser-auth-privacy.js";
import os from "node:os";
import path from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { BROWSER_EXTENSION_SETTINGS_LINK, BROWSER_PROFILE_CLEAR_RESULT, isBrowserProfileClearRequest,
  isComputerUseSurfaceAction, parseBrowserTaskSitePermission,
  type ComputerUseSurfaceAction, type ExternalBrowserState, type ExternalBrowserRecovery } from '@memmy/local-api-contracts';
import type { BrowserToolsConfig } from "../../../config/schema.js";
import { Tool, type ToolExecutionContext } from "./base.js";
import {
  classifyBrowserNavigateTarget,
  createBrowserPreview,
  type BrowserNavigateTarget,
  type BrowserPreviewLease,
} from "./browser-preview.js";
import { RequestContext, RequestContextStore } from "./context.js";
import {
  connectInMemoryMcpServer,
  convertMcpToolContent,
  normalizeSchemaForOpenAI,
  type InMemoryMcpConnection,
} from "./mcp.js";
import {
  BROWSER_PREPARATION_ATTEMPT_ID_ENV,
  configurePlaywrightBrowsersPath,
  readBrowserPreparationState,
  resolveManagedChromium,
  type BrowserPreparationState,
} from "./browser-setup.js";
import { waitForBrowserPreparation } from "./browser-preparation-wait.js";
import { emitComputerUseSurface } from "../../../tools/computer-use/surface-preview.js";
import { captureBackgroundBrowserPage, setAgentBrowserPageVisible } from "./browser-window-visibility.js";
import { OcuUserIntervened, withMacFocusGuard } from "../../../tools/computer-use/mac-focus-guard.js";
import { BrowserProfileStore } from './browser-profile.js';
import { BrowserDownloadStore } from './browser-downloads.js';
import { BrowserSitePermissionStore } from './browser-site-permissions.js';
import { BrowserAccessApproval } from './browser-access-approval.js';
import { BrowserCapabilityApproval } from './browser-capability-approval.js';
import { externalBrowserBridge } from './external-browser-bridge.js';
import { EmbeddedBrowserBridge } from './embedded-browser-bridge.js';
import { ExternalBrowserSessionRouter } from './external-browser-session-router.js';
import { EMBEDDED_BROWSER_SCREENSHOT_UNSUPPORTED } from './external-browser-tools.js';
import { formatExternalBrowserTabReference, parseExternalBrowserTabReference } from './external-browser-tab-reference.js';
import type { ExternalBrowserClaim } from './external-browser-bridge.js';

type ManagedDownloadDestination = { filePath: string; state: 'pending' | 'started' | 'cancelled';
  outcome: Promise<string | null>; settle: (error: string | null) => void };

type TargetBrowser = 'memmy' | 'chrome' | 'edge';
const targetBrowserParameter = { type: 'string', enum: ['memmy', 'chrome', 'edge'],
  description: 'Browser to act in, chosen from what the task needs: chrome or edge when it depends on the user\'s own browser (signed-in sessions, open tabs, or the user named it), memmy for pages the Agent works on by itself. For Chrome or Edge, use browser_list_tabs with this value, then pass the matching tabMention on the first action there, or open one with newTab. With this value and no tabMention, an action continues the tab this chat last used in that browser. Set it whenever you move between Memmy, Chrome and Edge; one chat may use all of them. When omitted, a call continues the tab this chat used last; before any tab, it uses the in-app browser and never takes over a Chrome/Edge page by itself. The runtime uses the installed extension for Chrome/Edge; the user need not specify an implementation.' };

export const BROWSER_TOOL_NAMES = [
  "browser_navigate",
  "browser_snapshot",
  "browser_find",
  "browser_click",
  "browser_type",
  "browser_select_option",
  "browser_press_key",
  "browser_wait_for",
  "browser_console_messages",
  "browser_network_requests",
  "browser_take_screenshot",
  "browser_resize",
  "browser_file_upload",
] as const;

export type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number];
export type BrowserCapability = "unknown" | "preparing" | "ready" | "disabled" | "unavailable";
export type BrowserScope = {
  sessionKey: string;
  channel: string;
  chatId: string;
};
export type BrowserLocalPreviewContext = {
  workspace: string;
  readonlyRoots: readonly string[];
};

type BrowserToolDefinition = {
  name: BrowserToolName;
  description: string;
  inputSchema: Record<string, any>;
  annotations?: Record<string, any>;
};

type PlaywrightMcpConfig = Record<string, any>;

type PlaywrightRuntime = {
  chromium: typeof import("playwright").chromium;
  executablePath: string;
  createConnection: (
    config?: PlaywrightMcpConfig,
    contextGetter?: () => Promise<BrowserContext>,
  ) => Promise<any>;
};

export type BrowserRuntimeLoader = () => Promise<PlaywrightRuntime>;
export type BrowserPreparationStateLoader = () => BrowserPreparationState | null;

export const BROWSER_COMPONENT_PREPARING_MESSAGE = "浏览器组件正在准备";

type BrowserSession = {
  key: string;
  scope: BrowserScope;
  context: BrowserContext;
  connection: InMemoryMcpConnection;
  outputDir: string;
  preview: BrowserPreviewLease | null;
  lastUsedAt: number;
  pendingCalls: number;
  closed: boolean;
  visible: boolean;
  mutex: AsyncMutex;
  allowedOrigins: Set<string>;
};

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

async function defaultRuntimeLoader(): Promise<PlaywrightRuntime> {
  configurePlaywrightBrowsersPath();
  // @playwright/mcp 0.0.78 ships a declaration with a monorepo-relative
  // Playwright import. Keep the runtime import non-literal so that declaration
  // does not pull this package's existing dist output back into the build.
  const mcpModule = "@playwright/mcp";
  const [{ chromium, executablePath }, mcp] = await Promise.all([
    resolveManagedChromium(),
    import(mcpModule) as Promise<{
      createConnection: PlaywrightRuntime["createConnection"];
    }>,
  ]);
  return {
    chromium,
    executablePath,
    createConnection: mcp.createConnection,
  };
}

function browserScopeKey(scope: BrowserScope): string {
  return JSON.stringify([scope.sessionKey, scope.channel, scope.chatId]);
}

function removeSchemaProperty(schema: any, propertyName: string): any {
  if (Array.isArray(schema)) {
    return schema.map((value) => removeSchemaProperty(value, propertyName));
  }
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value)
          .filter(([name]) => name !== propertyName)
          .map(([name, item]) => [name, removeSchemaProperty(item, propertyName)]),
      );
      continue;
    }
    if (key === "required" && Array.isArray(value)) {
      out[key] = value.filter((name) => name !== propertyName);
      continue;
    }
    out[key] = removeSchemaProperty(value, propertyName);
  }
  return out;
}

function narrowBrowserToolDefinition(tool: any): BrowserToolDefinition {
  const inputSchema = removeSchemaProperty(
    normalizeSchemaForOpenAI(tool.inputSchema ?? {
      type: "object",
      properties: {},
      required: [],
    }),
    "filename",
  );
  const definition: BrowserToolDefinition = {
    name: tool.name,
    description: tool.description || tool.name,
    inputSchema,
    annotations: tool.annotations,
  };
  definition.inputSchema.properties ??= {};
  definition.inputSchema.properties.tabMention = { type: 'string',
    description: 'Exact plugin://browser@memmy tab reference supplied by the user or returned by browser_list_tabs. When the user names a tab by title or URL, find its unique matching reference in browser_list_tabs and pass it internally; do not ask the user to copy it. Ask which tab only when the match is ambiguous. A chat can work with several tabs at once: pass a reference to switch to that tab at any time, and omit it to continue the tab used last. The browser ID, tab ID, title, and URL must still match; a stale reference fails without opening another tab.' };
  definition.inputSchema.properties.targetBrowser = targetBrowserParameter;
  definition.description += ' If the user names Chrome or Edge, set targetBrowser and resolve their page with browser_list_tabs. After navigation, omit the old tabMention to continue the same tab.';
  definition.inputSchema.properties.tabDisposition = { type: 'string', enum: ['deliverable', 'handoff'],
    description: 'Keep an Agent-created in-app tab after this turn as a user-facing deliverable or for work in a later turn. These tabs otherwise close at turn end.' };
  if (definition.name === 'browser_take_screenshot') {
    definition.description = 'Capture a screenshot only from a connected Chrome/Edge tab or the dedicated Agent Chromium browser. Memmy in-app browser tabs do not support screenshots; use browser_snapshot for page text and element references. Do not switch tabs or use a desktop screenshot to capture an in-app tab.';
    delete definition.inputSchema.properties.tabDisposition;
  }
  if (definition.name === 'browser_snapshot' || definition.name === 'browser_find') {
    definition.description += ' Connected Memmy, Chrome and Edge pages return current semantic controls, visible text, state and element references in page order; indentation shows the dialog, form, table row, list or frame an element belongs to, and browser_find names that location. Use the exact returned reference for the next element action. Memmy in-app tabs have no screenshots, image previews or snapshot boxes.';
  }
  if (definition.name === 'browser_press_key') {
    definition.description += ' In a Chrome/Edge tab, keys reach only the page; browser shortcuts such as switching tabs or Back do nothing. Use browser_select_tab to show another tab.';
  }
  if (['browser_click', 'browser_type', 'browser_select_option', 'browser_press_key'].includes(definition.name)) {
    definition.inputSchema.properties.acceptDialog = { type: 'boolean',
      description: 'Memmy, Chrome and Edge pages: accept an alert/confirm/prompt this action opens. Dialogs are otherwise dismissed and reported as dialogs in the result. Set it only after seeing that report and only when the task requires accepting.' };
  }
  if (['browser_click', 'browser_type', 'browser_select_option'].includes(definition.name)) {
    definition.description += ' For connected Memmy, Chrome and Edge pages, prefer the exact element reference from the latest snapshot. Unique CSS selectors, text=substring and CSS selectors ending in :has-text("substring") are supported. Multiple matches require a more precise target or an explicit >> nth=N suffix. Actions wait for the target to be usable and return a fresh observation for verifying the result. A stale, hidden or covered target requires a fresh snapshot; do not infer the selected-tab state from a locator error.';
  }
  if (definition.name === "browser_navigate") {
    const localPathDescription =
      "The url may also be an absolute or workspace-relative local .html/.htm path; local files use a restricted temporary preview.";
    definition.description = `${definition.description} ${localPathDescription}`;
    const url = definition.inputSchema.properties?.url;
    if (url && typeof url === "object") {
      url.description = url.description
        ? `${url.description} ${localPathDescription}`
        : localPathDescription;
    }
    definition.inputSchema.properties.newTab = { type: 'boolean',
      description: 'Open the http(s) URL in a new tab and keep the current page open, for example to compare several sites. It opens in targetBrowser, or in the browser this chat is using. A Chrome/Edge tab opens in the background beside that chat\'s last tab there, and the result returns its tabMention. The new tab becomes the current tab; return to another one with its tabMention.' };
  }
  if (['browser_click', 'browser_navigate', 'browser_press_key'].includes(definition.name)) {
    definition.inputSchema.properties.downloadPath = { type: 'string',
      description: 'Exact absolute destination already requested by the user for a download triggered by this action. In Memmy and managed Chromium it bypasses the save-location picker for this tab/action only; name a new file in an existing folder. Do not combine with newTab. In Chrome/Edge complete its normal Save As automatically through Computer Use using this path; this parameter does not change that browser globally. Verify the completed file before claiming success.' };
  }
  if (definition.name === 'browser_file_upload') {
    definition.description += ' For a Memmy in-app or connected Chrome/Edge tab, provide target as an exact file input reference or unique CSS selector.';
    definition.inputSchema.properties.target = { type: 'string',
      description: 'File input reference or unique CSS selector in the selected in-app or connected external tab.' };
  }
  return definition;
}

function normalizeBrowserConfig(config: BrowserToolsConfig | Record<string, any>): {
  enabled: boolean;
  maxSessions: number;
  idleTimeoutS: number;
} {
  return {
    enabled: config?.enabled !== false,
    maxSessions: Number(config?.maxSessions ?? 4),
    idleTimeoutS: Number(config?.idleTimeoutS ?? 900),
  };
}

export class BrowserSessionManager {
  capability: BrowserCapability = "unknown";
  private readonly config: ReturnType<typeof normalizeBrowserConfig>;
  private readonly runtimeLoader: BrowserRuntimeLoader;
  private readonly preparationStateLoader: BrowserPreparationStateLoader;
  private readonly desktopManaged: boolean;
  private readonly preparationAttemptId: string | null;
  private readonly restrictLocalFiles: boolean;
  private readonly profileStore: BrowserProfileStore | null;
  private readonly downloadStore: BrowserDownloadStore | null;
  private readonly sitePermissionStore: BrowserSitePermissionStore | null;
  private managedTaskPermissionStore: BrowserSitePermissionStore | null = null;
  private readonly accessApproval: BrowserAccessApproval | null;
  private readonly capabilityApproval: BrowserCapabilityApproval;
  private readonly externalRouter: ExternalBrowserSessionRouter | null;
  private readonly embeddedBridge: EmbeddedBrowserBridge | null;
  private readonly embeddedRouter: ExternalBrowserSessionRouter | null;
  private runtime: PlaywrightRuntime | null = null;
  private executablePath: string | null = null;
  private definitions = new Map<BrowserToolName, BrowserToolDefinition>();
  private initializePromise: Promise<BrowserCapability> | null = null;
  private browser: Browser | null = null;
  private browserPromise: Promise<Browser> | null = null;
  private sessions = new Map<string, BrowserSession>();
  private readonly downloadDestinations = new WeakMap<Page, ManagedDownloadDestination>();
  private creations = new Map<string, Promise<BrowserSession>>();
  private idleTimer: NodeJS.Timeout | null = null;
  private closing = false;
  private clearingData = false;
  private clearDataPromise: Promise<void> | null = null;
  private readonly embeddedTurns = new Map<string, symbol>();
  private readonly browserDiscoveryControllers = new Map<string, Set<AbortController>>();

  private invalidateEmbeddedTurn(key: string): void {
    this.embeddedTurns.delete(key);
    for (const controller of this.browserDiscoveryControllers.get(key) ?? []) controller.abort();
    this.browserDiscoveryControllers.delete(key);
  }

  private beginBrowserDiscovery(scope: BrowserScope, signal?: AbortSignal | null) {
    const key = browserScopeKey(scope);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const controllers = this.browserDiscoveryControllers.get(key) ?? new Set<AbortController>();
    controllers.add(controller);
    this.browserDiscoveryControllers.set(key, controllers);
    return { signal: controller.signal, cleanup: () => {
      signal?.removeEventListener('abort', abort);
      controllers.delete(controller);
      if (!controllers.size && this.browserDiscoveryControllers.get(key) === controllers) this.browserDiscoveryControllers.delete(key);
    } };
  }

  private captureEmbeddedTurn(scope: BrowserScope, signal?: AbortSignal | null): () => void {
    const key = browserScopeKey(scope);
    let turn = this.embeddedTurns.get(key);
    if (!turn) { turn = Symbol('embedded-browser-turn'); this.embeddedTurns.set(key, turn); }
    return () => {
      if (signal?.aborted) throw new Error('Browser operation was canceled');
      if (this.closing || this.clearingData || this.embeddedTurns.get(key) !== turn) {
        throw new Error('Browser operation belongs to a finished turn; retry with the intended tab.');
      }
    };
  }

  supportsEmbeddedTabs(): boolean {
    return this.config.enabled && this.desktopManaged && this.embeddedBridge !== null;
  }

  async listEmbeddedTabs(): Promise<string> {
    if (!this.supportsEmbeddedTabs() || !this.embeddedBridge) {
      throw new Error('Memmy in-app browser tabs are unavailable');
    }
    const listing = await this.embeddedBridge.listTabs();
    return JSON.stringify({ ...listing, count: listing.tabs.length });
  }
  supportsTabListing(): boolean {
    return this.config.enabled && this.desktopManaged && Boolean(this.embeddedBridge || this.externalRouter);
  }
  async listBrowserTabs(scope: BrowserScope, targetBrowser?: TargetBrowser, signal?: AbortSignal | null,
    allowRecovery = true): Promise<string> {
    this.validateTargetBrowser(targetBrowser);
    if (!this.supportsTabListing()) throw new Error('Desktop browser tabs are unavailable');
    const discovery = this.beginBrowserDiscovery(scope, signal);
    const assertTurn = this.captureEmbeddedTurn(scope, discovery.signal);
    try {
      assertTurn();
      const explicitExternal = targetBrowser === 'chrome' || targetBrowser === 'edge' ? targetBrowser : null;
      const embedded = explicitExternal || !this.embeddedBridge ? null : await this.embeddedBridge.listTabs();
      assertTurn();
      let external = targetBrowser === 'memmy' || !this.externalRouter
        ? null : await this.externalRouter.listTabs(scope, explicitExternal ?? undefined);
      assertTurn();
      let state: ExternalBrowserState | null = null;
      let recovery: ExternalBrowserRecovery | 'not_attempted' = 'not_attempted';
      let waitTimeoutMs = 0;
      const canRecover = allowRecovery && !['system', 'cron'].includes(scope.channel);
      if (explicitExternal && external && (!external.connectedBrowsers.includes(explicitExternal)
        || external.pageDiscoveryStatus === 'unresponsive')) {
        try { state = await this.embeddedBridge?.getExternalBrowserState(discovery.signal) ?? null; }
        catch { /* Preserve unavailable metadata as unknown. */ }
        assertTurn();
        const installed = state?.installation[explicitExternal].installed ?? null;
        const enabled = state?.installation[explicitExternal].enabled ?? null;
        const running = state?.runningBrowsers === null || !state ? null : state.runningBrowsers.includes(explicitExternal);
        if (canRecover && installed !== false && enabled !== false && running !== false) {
          // Profile metadata can be denied even while the browser is running.
          // The user's explicit interactive request authorizes a bounded wake;
          // only a live extension handshake establishes successful recovery.
          if (running === true && this.embeddedBridge) {
            assertTurn();
            try { recovery = await this.embeddedBridge.recoverExternalBrowser(explicitExternal, discovery.signal); }
            catch { recovery = 'failed'; }
            assertTurn();
          }
          waitTimeoutMs = running === true ? 45_000 : 2_000;
          await this.externalRouter!.waitForConnection(explicitExternal, waitTimeoutMs, discovery.signal);
          assertTurn();
          external = await this.externalRouter!.listTabs(scope, explicitExternal);
          assertTurn();
        }
      }
      const tabs = [...(embedded?.tabs ?? []).map(tab => ({ ...tab, browser: 'memmy' })), ...(external?.tabs ?? [])];
      const connectedBrowsers = external?.connectedBrowsers ?? [];
      const wanted: Array<'chrome' | 'edge'> = explicitExternal ? [explicitExternal]
        : targetBrowser === undefined && connectedBrowsers.length === 0 ? ['chrome', 'edge'] : [];
      const statuses = explicitExternal ? [explicitExternal] : connectedBrowsers.length ? connectedBrowsers : wanted;
      const connectionStatus = statuses.map(browser => {
        const connected = connectedBrowsers.includes(browser);
        const installed = connected ? true : state?.installation[browser].installed ?? null;
        const enabled = connected ? true : state?.installation[browser].enabled ?? null;
        const running = connected ? true : !state || state.runningBrowsers === null ? null : state.runningBrowsers.includes(browser);
        const reason = external?.pageDiscoveryStatus === 'unresponsive' ? 'page_discovery_unresponsive'
          : connected ? undefined : installed === false ? 'not_installed'
          : enabled === false ? 'extension_disabled' : running === false ? 'browser_not_running'
          : !canRecover ? 'recovery_not_allowed' : waitTimeoutMs === 45_000 ? 'connection_timeout' : 'state_unknown';
        return { browser, installed, enabled, running, connected,
          recovery: connected && waitTimeoutMs === 0 && external?.pageDiscoveryStatus !== 'unresponsive' ? 'not_needed' : recovery, waitTimeoutMs,
          ...(reason ? { reason } : {}) };
      });
      const notConnected = external ? wanted.filter(browser => !connectedBrowsers.includes(browser)) : [];
      return JSON.stringify({ browserId: embedded?.browserId ?? null, selectedTabId: embedded?.selectedTabId ?? null,
        tabs, count: tabs.length, connectedBrowsers, connectionStatus, tabStatuses: external?.tabStatuses ?? [],
        ...(external ? { pageDiscoveryStatus: external.pageDiscoveryStatus ?? 'ready' } : {}),
        ...(notConnected.length ? { extensionSetup: { notConnected,
          installRequired: connectionStatus.filter(status => status.installed === false).map(status => status.browser),
          settingsLink: BROWSER_EXTENSION_SETTINGS_LINK,
          note: 'Connection, installation, enabled state, and browser process state are separate facts. Suggest installation only for installRequired; null means unknown. If enabled is false, the existing extension needs enabling. An installed but disconnected extension may be starting or reconnecting. Preserve the requested browser, account, and page when continuing with another available interface.' } } : {}) });
    } finally { discovery.cleanup(); }
  }
  supportsExternalTabSelection(): boolean {
    return this.config.enabled && this.desktopManaged && this.externalRouter !== null;
  }
  async selectBrowserTab(scope: BrowserScope, input: Record<string, unknown>,
    signal?: AbortSignal | null): Promise<string> {
    const assertTurn = this.captureEmbeddedTurn(scope, signal);
    if (input.targetBrowser !== 'chrome' && input.targetBrowser !== 'edge') {
      throw new Error('browser_select_tab requires targetBrowser chrome or edge');
    }
    if (typeof input.tabMention !== 'string') throw new Error('browser_select_tab requires a tabMention from browser_list_tabs');
    const claim = await this.resolveExternalTarget(scope, input, assertTurn);
    assertTurn();
    if (!claim || !this.externalRouter) throw new Error('Browser extension tools are unavailable');
    const result = await this.externalRouter.activate(scope, claim, signal);
    assertTurn();
    return result;
  }
  private validateTargetBrowser(value: unknown): asserts value is TargetBrowser | undefined {
    if (value !== undefined && value !== 'memmy' && value !== 'chrome' && value !== 'edge') {
      throw new Error('Invalid targetBrowser');
    }
  }
  private async resolveExternalTarget(scope: BrowserScope, input: Record<string, unknown>,
    assertCurrent: () => void): Promise<ExternalBrowserClaim | null> {
    this.validateTargetBrowser(input.targetBrowser);
    const mention = input.tabMention;
    if (mention !== undefined && typeof mention !== 'string') throw new Error('Invalid browser tab mention');
    const reference = parseExternalBrowserTabReference(mention);
    const browser = input.targetBrowser ?? reference?.browser;
    if (browser === 'memmy') {
      if (reference) throw new Error('Browser reference does not match targetBrowser');
      return null;
    }
    if (browser === 'chrome' || browser === 'edge') {
      if (!this.config.enabled || !this.externalRouter) throw new Error('Browser extension tools are unavailable');
      if (mention !== undefined && !reference) throw new Error('An external browser target requires an external tab reference');
      return this.externalRouter.selectBrowser(scope, browser, mention as string | undefined, assertCurrent);
    }
    if (mention !== undefined) return null;
    // Without a target, continue the browser surface this chat used most recently.
    if (this.externalIsCurrent(scope)) return this.externalRouter!.select(scope, false);
    return null;
  }
  private externalIsCurrent(scope: BrowserScope): boolean {
    return Boolean(this.externalRouter?.hasBinding?.(scope))
      && (this.externalRouter?.lastUsed?.(scope) ?? 0) >= (this.embeddedRouter?.lastUsed?.(scope) ?? 0);
  }
  async queryEmbeddedHistory(input: { from: string; to: string; keyword: string; limit: number }): Promise<string> {
    if (!this.supportsEmbeddedTabs() || !this.embeddedBridge) {
      throw new Error('Memmy in-app browser history is unavailable');
    }
    const result = await this.embeddedBridge.queryHistory(input);
    if (!result || typeof result !== 'object' || !Array.isArray((result as { entries?: unknown }).entries)) {
      throw new Error('Memmy in-app browser history response was invalid');
    }
    return JSON.stringify(result);
  }
  supportsCdpTabs(): boolean {
    return this.config.enabled && this.desktopManaged
      && (this.embeddedBridge !== null || this.externalRouter !== null);
  }
  async callCdp(scope: BrowserScope, operation: 'cdpCall' | 'cdpEvents' | 'cdpWrite',
    input: Record<string, unknown>, signal?: AbortSignal | null): Promise<string> {
    const assertEmbeddedTurn = this.captureEmbeddedTurn(scope, signal);
    const tabMention = input.tabMention;
    if (tabMention !== undefined && typeof tabMention !== 'string') throw new Error('Invalid browser tab mention');
    const args = { ...input };
    delete args.tabMention;
    delete args.targetBrowser;
    const externalTarget = await this.resolveExternalTarget(scope, input, assertEmbeddedTurn);
    assertEmbeddedTurn();
    if (externalTarget && this.externalRouter) {
      const result = await this.externalRouter.cdp(scope, externalTarget, operation, args,
        (url, name, abort) => this.capabilityApproval.authorize(
          operation === 'cdpWrite' ? 'debug-write' : 'debug', url, [name], abort), signal);
      assertEmbeddedTurn();
      return result;
    }
    if (tabMention !== undefined) {
      if (!this.embeddedBridge || !this.embeddedRouter) throw new Error('Mentioned browser tab is unavailable');
      if (input.method === 'Page.captureScreenshot') throw new Error(EMBEDDED_BROWSER_SCREENSHOT_UNSUPPORTED);
      const claim = await this.embeddedBridge.resolveMention(tabMention);
      assertEmbeddedTurn();
      this.embeddedRouter.selectClaim(scope, claim);
      const result = await this.embeddedRouter.cdp(scope, claim, operation, args, async () => false, signal);
      assertEmbeddedTurn();
      return result;
    }
    if (this.embeddedBridge && this.embeddedRouter) {
      const selected = await this.embeddedBridge.refresh().catch(() => null);
      assertEmbeddedTurn();
      if (input.method === 'Page.captureScreenshot' && (selected || this.embeddedRouter.hasBinding(scope))) {
        throw new Error(EMBEDDED_BROWSER_SCREENSHOT_UNSUPPORTED);
      }
      const claim = this.embeddedRouter.select(scope,
        this.sessions.has(browserScopeKey(scope)) || this.creations.has(browserScopeKey(scope)));
      if (claim) {
        if (input.method === 'Page.captureScreenshot') throw new Error(EMBEDDED_BROWSER_SCREENSHOT_UNSUPPORTED);
        const result = await this.embeddedRouter.cdp(scope, claim, operation, args, async () => false, signal);
        assertEmbeddedTurn();
        return result;
      }
    }
    if (this.externalRouter && input.targetBrowser !== 'memmy') {
      const claim = this.externalRouter.select(scope,
        this.sessions.has(browserScopeKey(scope)) || this.creations.has(browserScopeKey(scope)));
      if (claim) return this.externalRouter.cdp(scope, claim, operation, args,
        (url, name, abort) => this.capabilityApproval.authorize(
          operation === 'cdpWrite' ? 'debug-write' : 'debug', url, [name], abort), signal);
    }
    throw new Error('Controlled CDP operations require a selected in-app or claimed Chrome/Edge tab');
  }
  async requestBrowserAuth(scope: BrowserScope, input: Record<string, unknown>,
    signal?: AbortSignal | null): Promise<string> {
    const assertEmbeddedTurn = this.captureEmbeddedTurn(scope, signal);
    const tabMention = input.tabMention;
    if (tabMention !== undefined && typeof tabMention !== 'string') throw new Error('Invalid browser tab mention');
    const args = { ...input };
    delete args.tabMention;
    delete args.targetBrowser;
    const externalTarget = await this.resolveExternalTarget(scope, input, assertEmbeddedTurn);
    assertEmbeddedTurn();
    if (externalTarget && this.externalRouter) {
      const result = await this.externalRouter.requestAuth(scope, externalTarget, args, signal);
      assertEmbeddedTurn();
      return publicBrowserAuthResult(JSON.parse(result));
    }
    if (this.embeddedBridge && this.embeddedRouter) {
      let claim;
      if (typeof tabMention === 'string') {
        claim = await this.embeddedBridge.resolveMention(tabMention);
        assertEmbeddedTurn();
        this.embeddedRouter.selectClaim(scope, claim);
      } else {
        await this.embeddedBridge.refresh();
        assertEmbeddedTurn();
        claim = this.embeddedRouter.select(scope,
          this.sessions.has(browserScopeKey(scope)) || this.creations.has(browserScopeKey(scope)));
      }
      if (claim) {
        await this.embeddedRouter.authorizeCurrent(scope, claim);
        assertEmbeddedTurn();
        const result = await this.embeddedBridge.command(claim, 'authRequest', args, signal ?? undefined);
        assertEmbeddedTurn();
        if (!result || typeof result !== 'object' || typeof (result as { status?: unknown }).status !== 'string') {
          throw new Error('Invalid browser auth response');
        }
        return publicBrowserAuthResult(result);
      }
    }
    if (tabMention !== undefined || !this.externalRouter || input.targetBrowser === 'memmy') return JSON.stringify({ status: 'unavailable' });
    const claim = this.externalRouter.select(scope,
      this.sessions.has(browserScopeKey(scope)) || this.creations.has(browserScopeKey(scope)));
    if (!claim) return JSON.stringify({ status: 'unavailable' });
    return publicBrowserAuthResult(JSON.parse(await this.externalRouter.requestAuth(scope, claim, args, signal)));
  }

  supportsSitePermissions(): boolean {
    return this.supportsCdpTabs() || (this.config.enabled && ['ready', 'preparing'].includes(this.capability));
  }

  async setBrowserSitePermission(scope: BrowserScope, input: Record<string, unknown>,
    signal?: AbortSignal | null): Promise<string> {
    const request = parseBrowserTaskSitePermission(input);
    if (!request || Object.keys(input).some(key => !['origin', 'permission', 'allow', 'targetBrowser', 'tabMention'].includes(key))) {
      throw new Error('Invalid browser site permission');
    }
    const assertTurn = this.captureEmbeddedTurn(scope, signal);
    const tabMention = input.tabMention;
    if (tabMention !== undefined && typeof tabMention !== 'string') throw new Error('Invalid browser tab mention');
    if ((input.targetBrowser === 'chrome' || input.targetBrowser === 'edge') && tabMention === undefined
      && (!this.externalRouter?.hasBinding(scope) || this.externalRouter.currentBrowser(scope) !== input.targetBrowser)) {
      throw new Error('Browser site permission requires a tab already bound to this task');
    }
    const external = await this.resolveExternalTarget(scope, input, assertTurn);
    assertTurn();
    if (external && this.externalRouter) {
      const result = await this.externalRouter.setSitePermission(scope, external, request, signal);
      assertTurn();
      return result;
    }
    if (this.embeddedBridge && this.embeddedRouter) {
      let claim: ExternalBrowserClaim | null;
      if (typeof tabMention === 'string') {
        claim = await this.embeddedBridge.resolveMention(tabMention);
        assertTurn();
        this.embeddedRouter.selectClaim(scope, claim);
      } else {
        await this.embeddedBridge.refresh();
        assertTurn();
        claim = this.embeddedRouter.select(scope, true);
      }
      if (claim) {
        const result = await this.embeddedRouter.setSitePermission(scope, claim, request, signal);
        assertTurn();
        return result;
      }
    }
    if (tabMention !== undefined) throw new Error('Mentioned browser tab is unavailable');
    const session = this.sessions.get(browserScopeKey(scope));
    if (!session || session.closed) throw new Error('Browser site permission requires a page already bound to this task');
    return session.mutex.runExclusive(async () => {
      const pages = session.context.pages().filter(page => !page.isClosed());
      if (pages.length !== 1) throw new Error('Browser site permission requires one unambiguous task page');
      const page = pages[0]!;
      const current = () => {
        assertTurn();
        const currentPages = session.context.pages().filter(candidate => !candidate.isClosed());
        if (session.closed || this.sessions.get(session.key) !== session || page.isClosed()
          || new URL(page.url()).origin !== request.origin
          || currentPages.length !== 1 || currentPages[0] !== page) {
          throw new Error('Browser site permission origin or task changed');
        }
      };
      current();
      if (request.allow && this.accessApproval && !await this.accessApproval.authorize(page.url(), session.allowedOrigins)) {
        throw new Error('Browser site permission page access was not approved');
      }
      current();
      const permissions = this.sitePermissionStore
        ?? (this.managedTaskPermissionStore ??= new BrowserSitePermissionStore());
      await permissions.setForContext(session.context, request, current);
      return JSON.stringify({ status: request.allow ? 'granted' : 'revoked', origin: request.origin,
        permission: request.permission, allowed: request.allow, lasts: 'task' });
    });
  }
  private readonly surfaceActionListener = (raw: unknown) => {
    if (isBrowserProfileClearRequest(raw)) {
      void this.clearBrowsingData().then(
        () => this.replyToProfileClear(raw.requestId, true),
        () => this.replyToProfileClear(raw.requestId, false),
      );
      return;
    }
    if (isComputerUseSurfaceAction(raw) && raw.surface === 'browser') {
      void this.handleSurfaceAction(raw);
    }
  };

  private replyToProfileClear(requestId: string, ok: boolean): void {
    if (!process.send || !process.connected) return;
    try { process.send({ type: BROWSER_PROFILE_CLEAR_RESULT, requestId, ok }, () => undefined); }
    catch { /* Desktop child is stopping. */ }
  }

  constructor(
    config: BrowserToolsConfig | Record<string, any>,
    {
      runtimeLoader = defaultRuntimeLoader,
      preparationStateLoader = readBrowserPreparationState,
      desktopManaged = process.env.MEMMY_DESKTOP_MANAGED_GATEWAY === "1",
      preparationAttemptId =
        process.env[BROWSER_PREPARATION_ATTEMPT_ID_ENV]?.trim() || null,
      restrictLocalFiles = false,
      profileStore,
      downloadStore,
      sitePermissionStore,
      accessApproval,
      capabilityApproval,
      externalRouter,
      embeddedBridge,
      embeddedRouter,
    }: {
      runtimeLoader?: BrowserRuntimeLoader;
      preparationStateLoader?: BrowserPreparationStateLoader;
      desktopManaged?: boolean;
      preparationAttemptId?: string | null;
      restrictLocalFiles?: boolean;
      profileStore?: BrowserProfileStore | null;
      downloadStore?: BrowserDownloadStore | null;
      sitePermissionStore?: BrowserSitePermissionStore | null;
      accessApproval?: BrowserAccessApproval | null;
      capabilityApproval?: BrowserCapabilityApproval;
      externalRouter?: ExternalBrowserSessionRouter | null;
      embeddedBridge?: EmbeddedBrowserBridge | null;
      embeddedRouter?: ExternalBrowserSessionRouter | null;
    } = {},
  ) {
    this.config = normalizeBrowserConfig(config);
    this.runtimeLoader = runtimeLoader;
    this.preparationStateLoader = preparationStateLoader;
    this.desktopManaged = desktopManaged;
    this.preparationAttemptId = preparationAttemptId;
    this.restrictLocalFiles = restrictLocalFiles;
    this.profileStore = profileStore === undefined
      ? (desktopManaged ? new BrowserProfileStore() : null)
      : profileStore;
    this.capabilityApproval = capabilityApproval ?? new BrowserCapabilityApproval();
    this.downloadStore = downloadStore === undefined
      ? (desktopManaged ? new BrowserDownloadStore(undefined,
        (url, name) => this.capabilityApproval.authorize('download', url, [name]),
        url => this.capabilityApproval.blocked('download', url)) : null)
      : downloadStore;
    this.sitePermissionStore = sitePermissionStore === undefined
      ? (desktopManaged ? new BrowserSitePermissionStore() : null)
      : sitePermissionStore;
    this.accessApproval = accessApproval === undefined
      ? (desktopManaged ? new BrowserAccessApproval() : null)
      : accessApproval;
    this.externalRouter = externalRouter === undefined
      ? (desktopManaged ? new ExternalBrowserSessionRouter(externalBrowserBridge,
        (url, allowed) => this.accessApproval?.authorize(url, allowed) ?? Promise.resolve(false)) : null)
      : externalRouter;
    this.embeddedBridge = embeddedBridge === undefined
      ? (desktopManaged && process.env.MEMMY_DESKTOP_MANAGED_GATEWAY === '1'
        && process.send && process.connected ? new EmbeddedBrowserBridge() : null) : embeddedBridge;
    this.embeddedRouter = embeddedRouter === undefined
      ? (this.embeddedBridge ? new ExternalBrowserSessionRouter(this.embeddedBridge,
        (url, allowed) => this.accessApproval?.authorize(url, allowed) ?? Promise.resolve(false), 'embedded') : null)
      : embeddedRouter;
    if (this.desktopManaged && process.send) process.on('message', this.surfaceActionListener);
    if (!this.config.enabled) this.capability = "disabled";
  }

  private async handleSurfaceAction(action: ComputerUseSurfaceAction): Promise<void> {
    if (this.closing || this.clearingData) return;
    if (this.embeddedRouter && await this.embeddedRouter.handleSurfaceAction(action)) return;
    if (this.externalRouter && await this.externalRouter.handleSurfaceAction(action)) return;
    if (action.targetId !== 'active-tab') return;
    const scope: BrowserScope = { sessionKey: action.sessionKey, channel: action.channel, chatId: action.chatId };
    const existing = this.sessions.get(browserScopeKey(scope));
    if ((!existing || existing.closed) && action.action !== 'navigate') return;
    if (!existing || existing.closed) {
      await this.ensureReadyForTool().catch(() => undefined);
      if (this.capability !== 'ready') return;
    }
    const session = await this.acquireSession(scope).catch(() => null);
    if (!session) return;
    try { await session.mutex.runExclusive(async () => {
      session.lastUsedAt = Date.now();
      const page = session.context.pages().at(-1)
        ?? (action.action === 'navigate' ? await session.context.newPage() : null);
      if (!page || page.isClosed()) return;
      try {
        if (this.sitePermissionStore && typeof session.context.clearPermissions === 'function') {
          await this.sitePermissionStore.apply(session.context);
        }
        if (action.action === 'open') {
          if (this.browser && await setAgentBrowserPageVisible(this.browser, page, true)) session.visible = true;
          return;
        }
        if (action.action === 'fill-credential' || action.action === 'fill-contact') {
          const autofill = action.autofill;
          if (!autofill || new URL(page.url()).origin !== autofill.origin) return;
          if (action.action === 'fill-credential' && 'password' in autofill) {
            const username = page.locator('input[autocomplete="username"]:visible, input[type="email"]:visible, input[name*="user" i]:visible, input[name*="email" i]:visible').first();
            if (await username.count()) await username.fill(autofill.username);
            const password = page.locator('input[type="password"]:visible').first();
            if (await password.count()) await password.fill(autofill.password);
          } else if (action.action === 'fill-contact' && 'name' in autofill) {
            const fields = [
              ['input[autocomplete="name"]:visible', autofill.name],
              ['input[autocomplete="email"]:visible, input[type="email"]:visible', autofill.email],
              ['input[autocomplete="tel"]:visible, input[type="tel"]:visible', autofill.phone],
              ['input[autocomplete="street-address"]:visible', autofill.address],
            ] as const;
            for (const [selector, value] of fields) {
              if (!value) continue;
              const input = page.locator(selector).first();
              if (await input.count()) await input.fill(value);
            }
          }
          await this.emitBrowserFrame(session);
          return;
        }
        const perform = async () => {
          if (action.action === 'navigate') {
            try { session.allowedOrigins.add(new URL(action.url!).origin); } catch { /* Validated action. */ }
            await page.goto(action.url!, { waitUntil: 'domcontentloaded', timeout: 60_000 });
          } else if (action.action === 'back') {
            await page.goBack({ waitUntil: 'domcontentloaded' });
          } else if (action.action === 'forward') {
            await page.goForward({ waitUntil: 'domcontentloaded' });
          } else if (action.action === 'reload') {
            await page.reload({ waitUntil: 'domcontentloaded' });
          } else {
            const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
            if (action.action === 'click') {
              await page.mouse.click(Math.round(action.x! * viewport.width), Math.round(action.y! * viewport.height));
            } else if (action.action === 'scroll') {
              await page.mouse.wheel(0, action.deltaY!);
            } else if (action.action === 'key') {
              await page.keyboard.press(action.key!);
            }
          }
        };
        if (this.desktopManaged && process.env.MEMMY_DESKTOP_MANAGED_GATEWAY === '1'
            && process.platform === 'darwin') {
          await withMacFocusGuard('com.google.chrome.for.testing', `browser_${action.action}`, perform);
        } else await perform();
        await this.emitBrowserFrame(session);
        if (!this.clearingData && !session.closed) {
          await this.profileStore?.save(session.context).catch(() => undefined);
        }
      } catch (error) {
        if (action.action === 'navigate' || action.action === 'back' || action.action === 'forward' || action.action === 'reload') {
          emitComputerUseSurface({ surface: 'browser', ...session.scope, targetId: 'active-tab',
            title: 'Browser', url: page.url().slice(0, 4096),
            error: /ERR_BLOCKED_BY_CLIENT/.test(String(error)) ? 'access-blocked' : 'navigation-failed' });
        }
      }
    }); } finally { session.pendingCalls = Math.max(0, session.pendingCalls - 1); }
  }

  private async browserNavigationState(page: any): Promise<{ canGoBack: boolean; canGoForward: boolean }> {
    const context = typeof page.context === 'function' ? page.context() : null;
    if (!context || typeof context.newCDPSession !== 'function') return { canGoBack: false, canGoForward: false };
    const cdp = await context.newCDPSession(page);
    try {
      const history = await cdp.send('Page.getNavigationHistory');
      const current = Number(history.currentIndex ?? 0);
      const count = Array.isArray(history.entries) ? history.entries.length : 0;
      return { canGoBack: current > 0, canGoForward: current + 1 < count };
    } catch { return { canGoBack: false, canGoForward: false }; }
    finally { await cdp.detach().catch(() => undefined); }
  }

  private async emitBrowserFrame(session: BrowserSession): Promise<void> {
    if (!this.desktopManaged || !process.send || !process.connected) return;
    if (typeof session.context.pages !== 'function') return;
    const page = session.context.pages().at(-1);
    if (!page || page.isClosed()) return;
    try {
      const screenshot = await captureBackgroundBrowserPage(page);
      const title = (await page.title().catch(() => '')) || page.url() || '浏览器';
      const history = await this.browserNavigationState(page);
      emitComputerUseSurface({
        surface: 'browser', ...session.scope, targetId: 'active-tab', title: title.slice(0, 256),
        imageDataUrl: `data:image/jpeg;base64,${screenshot}`,
        url: page.url().slice(0, 4096), ...history,
      });
    } catch { /* Preview never makes a browser action fail. */ }
  }

  definition(name: BrowserToolName): BrowserToolDefinition | null {
    const definition = this.definitions.get(name);
    return definition ? structuredClone(definition) : null;
  }

  initialize(): Promise<BrowserCapability> {
    if (this.initializePromise) return this.initializePromise;
    const attempt = this.probe();
    this.initializePromise = attempt;
    void attempt.finally(() => {
      if (
        this.initializePromise === attempt
        && this.capability !== "ready"
        && this.capability !== "disabled"
      ) {
        this.initializePromise = null;
      }
    });
    return attempt;
  }

  private async probe(): Promise<BrowserCapability> {
    if (!this.config.enabled) {
      this.capability = "disabled";
      return this.capability;
    }
    try {
      const runtime = await this.runtimeLoader();
      // Discover schemas without launching Chromium on the gateway startup
      // path. The first managed browser operation validates launch via ensureBrowser.
      await this.loadDefinitionsWithoutBrowser(runtime);
      this.runtime = runtime;
      this.executablePath = runtime.executablePath || null;
      if (!runtime.executablePath || !fs.existsSync(runtime.executablePath)) {
        const preparationState = this.preparationStateLoader();
        this.capability = preparationState?.status === "preparing"
          || this.desktopManaged
          ? "preparing"
          : "unavailable";
        return this.capability;
      }
      this.capability = "ready";
      return this.capability;
    } catch {
      this.capability = "unavailable";
      return this.capability;
    }
  }

  private captureDefinitions(tools: any[]): void {
    const byName = new Map(tools.map((tool: any) => [String(tool.name), tool]));
    if (BROWSER_TOOL_NAMES.some((name) => !byName.has(name))) {
      throw new Error("Playwright MCP browser tool set changed");
    }
    this.definitions = new Map(
      BROWSER_TOOL_NAMES.map((name) => [
        name,
        narrowBrowserToolDefinition(byName.get(name)),
      ]),
    );
  }

  private async loadDefinitionsWithoutBrowser(runtime: PlaywrightRuntime): Promise<void> {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-browser-definitions-"));
    let connection: InMemoryMcpConnection | null = null;
    try {
      const server = await runtime.createConnection(
        this.connectionConfig(outputDir),
        async () => {
          throw new Error(BROWSER_COMPONENT_PREPARING_MESSAGE);
        },
      );
      connection = await connectInMemoryMcpServer(server);
      const listed = await connection.client.listTools();
      this.captureDefinitions(listed.tools ?? []);
    } finally {
      await connection?.close().catch(() => undefined);
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  }

  private async ensureReadyForTool(
    abortSignal: AbortSignal | null = null,
  ): Promise<void> {
    if (this.capability === "ready") return;
    const isExecutableReady = (): boolean => Boolean(
      this.executablePath && fs.existsSync(this.executablePath),
    );
    if (this.capability === "preparing" && !isExecutableReady()) {
      await waitForBrowserPreparation({
        loadState: this.preparationStateLoader,
        isExecutableReady,
        abortSignal,
        expectedAttemptId: this.preparationAttemptId,
      });
    }
    const preparationState = this.preparationStateLoader();
    if (preparationState?.status === "unavailable" && !isExecutableReady()) {
      this.capability = "unavailable";
      throw new Error(
        `浏览器组件准备失败${preparationState.error ? `：${preparationState.error}` : ""}`,
      );
    }
    const capability = await this.initialize();
    if (capability === "ready") return;
    if (capability === "preparing") {
      await waitForBrowserPreparation({
        loadState: this.preparationStateLoader,
        isExecutableReady,
        abortSignal,
        expectedAttemptId: this.preparationAttemptId,
      });
      if (await this.initialize() === "ready") return;
    }
    throw new Error("浏览器组件当前不可用");
  }

  private connectionConfig(outputDir: string): PlaywrightMcpConfig {
    return {
      browser: {
        browserName: "chromium",
        isolated: false,
      },
      imageResponses: "allow",
      snapshot: { mode: "full" },
      timeouts: {
        action: 30_000,
        navigation: 60_000,
      },
      outputDir,
      saveSession: false,
      allowUnrestrictedFileAccess: false,
      codegen: "none",
    };
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (this.browserPromise) return this.browserPromise;
    if (this.capability !== "ready" || !this.runtime || !this.executablePath) {
      throw new Error("browser capability is unavailable");
    }
    this.browserPromise = this.runtime.chromium
      .launch({
        headless: !this.desktopManaged,
        executablePath: this.executablePath,
        ...(this.desktopManaged ? { args: ['--start-minimized', '--window-position=-32000,-32000',
          '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
          '--disable-backgrounding-occluded-windows'] } : {}),
      })
      .then((browser) => {
        this.browser = browser;
        browser.on("disconnected", () => {
          void this.handleBrowserDisconnected(browser);
        });
        return browser;
      })
      .finally(() => {
        this.browserPromise = null;
      });
    return this.browserPromise;
  }

  private async handleBrowserDisconnected(browser: Browser): Promise<void> {
    if (this.browser !== browser) return;
    this.browser = null;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map((session) => this.disposeSession(session)));
  }

  private startIdleTimer(): void {
    if (this.idleTimer) return;
    const intervalMs = Math.min(60_000, Math.max(5_000, this.config.idleTimeoutS * 500));
    this.idleTimer = setInterval(() => {
      void this.sweepIdle();
    }, intervalMs);
    this.idleTimer.unref?.();
  }

  private async sweepIdle(): Promise<void> {
    const cutoff = Date.now() - this.config.idleTimeoutS * 1000;
    const keys = [...this.sessions.entries()]
      .filter(([, session]) => session.pendingCalls === 0 && session.lastUsedAt <= cutoff)
      .map(([key]) => key);
    for (const key of keys) await this.closeByKey(key);
  }

  private async ensureCapacity(): Promise<void> {
    if (this.sessions.size + this.creations.size < this.config.maxSessions) return;
    const candidate = [...this.sessions.values()]
      .filter((session) => session.pendingCalls === 0 && !session.closed)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
    if (!candidate) throw new Error("browser session limit reached");
    await this.closeByKey(candidate.key);
  }

  private async createSession(
    scope: BrowserScope,
    initialPendingCalls = 0,
  ): Promise<BrowserSession> {
    await this.ensureCapacity();
    const browser = await this.ensureBrowser();
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-browser-session-"));
    let context: BrowserContext | null = null;
    let connection: InMemoryMcpConnection | null = null;
    try {
      const savedProfile = this.profileStore?.load();
      context = await browser.newContext({ acceptDownloads: true,
        ...(savedProfile ? { storageState: savedProfile } : {}) });
      if (this.sitePermissionStore && typeof context.clearPermissions === 'function') {
        await this.sitePermissionStore.apply(context);
      }
      const server = await this.runtime!.createConnection(
        this.connectionConfig(outputDir),
        async () => context!,
      );
      connection = await connectInMemoryMcpServer(server);
      const listed = await connection.client.listTools();
      const names = new Set((listed.tools ?? []).map((tool: any) => String(tool.name)));
      if (BROWSER_TOOL_NAMES.some((name) => !names.has(name))) {
        throw new Error("Playwright MCP browser tool set changed");
      }
      const key = browserScopeKey(scope);
      const session: BrowserSession = {
        key,
        scope: { ...scope },
        context,
        connection,
        outputDir,
        preview: null,
        lastUsedAt: Date.now(),
        pendingCalls: initialPendingCalls,
        closed: false,
        visible: false,
        mutex: new AsyncMutex(),
        allowedOrigins: new Set<string>(),
      };
      if (this.accessApproval && typeof context.route === 'function') {
        await context.route('**/*', async route => {
          const request = route.request();
          if (!request.isNavigationRequest() || request.resourceType() !== 'document') {
            await route.continue(); return;
          }
          try { if (request.frame().parentFrame()) { await route.continue(); return; } }
          catch { /* The first top-level navigation may not have a frame yet. */ }
          if (await this.accessApproval!.authorize(request.url(), session.allowedOrigins)) await route.continue();
          else await route.abort('blockedbyclient');
        });
      }
      if (this.desktopManaged && typeof context.on === 'function') {
        const attachedPages = new WeakSet<Page>();
        const attachPage = (page: Page) => {
          if (attachedPages.has(page)) return;
          attachedPages.add(page);
          if (!this.browser) return;
          void setAgentBrowserPageVisible(this.browser, page, session.visible).catch(() => undefined);
          page.on('download', download => {
            const destination = this.downloadDestinations.get(page);
            if (destination?.state === 'cancelled') {
              this.downloadDestinations.delete(page);
              void download.cancel().catch(() => undefined);
              return;
            }
            const filePath = destination?.state === 'pending' ? destination.filePath : undefined;
            if (destination?.state === 'pending') { destination.state = 'started'; destination.settle(null); }
            const saved = filePath === undefined ? this.downloadStore?.save(download, page.url())
              : this.downloadStore?.save(download, page.url(), filePath);
            void saved?.catch(() => undefined);
          });
          page.on('framenavigated', frame => {
            if (frame === page.mainFrame()) void this.emitBrowserFrame(session);
          });
        };
        context.on('page', attachPage);
        for (const page of context.pages()) attachPage(page);
      }
      this.sessions.set(key, session);
      for (const transport of [
        connection.clientTransport,
        connection.serverTransport,
      ]) {
        const protocolClose = transport.onclose;
        transport.onclose = () => {
          protocolClose?.();
          if (!session.closed && this.sessions.get(key) === session) {
            void this.closeByKey(key);
          }
        };
      }
      this.startIdleTimer();
      return session;
    } catch (error) {
      await connection?.close().catch(() => undefined);
      await context?.close().catch(() => undefined);
      fs.rmSync(outputDir, { recursive: true, force: true });
      throw error;
    }
  }

  private acquireSession(scope: BrowserScope): Promise<BrowserSession> {
    if (this.clearingData) return Promise.reject(new Error("browser data is being cleared"));
    const key = browserScopeKey(scope);
    const existing = this.sessions.get(key);
    if (existing && !existing.closed) {
      existing.pendingCalls += 1;
      return Promise.resolve(existing);
    }
    const pending = this.creations.get(key);
    if (pending) {
      return pending.then((session) => {
        if (session.closed) throw new Error("browser session closed");
        session.pendingCalls += 1;
        return session;
      });
    }
    const creation = this.createSession(scope, 1).finally(() => {
      this.creations.delete(key);
    });
    this.creations.set(key, creation);
    return creation;
  }

  private validateUploadFiles(files: unknown, workspace: string | undefined): asserts files is string[] {
    if (!workspace || !Array.isArray(files) || files.length < 1 || files.length > 20
      || files.some(file => typeof file !== 'string' || !path.isAbsolute(file))) {
      throw new Error('Browser upload requires 1 to 20 absolute workspace file paths');
    }
    const root = fs.realpathSync(workspace);
    for (const file of files) {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Browser upload requires regular files');
      const relative = path.relative(root, fs.realpathSync(file));
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('Browser upload file is outside the trusted workspace');
      }
    }
  }

  private async verifyEmbeddedUpload(tabId: number, params: Record<string, any>,
    workspace: string | undefined): Promise<void> {
    const files = params.paths;
    this.validateUploadFiles(files, workspace);
    if (typeof params.target !== 'string' || !params.target || params.target.length > 500) {
      throw new Error('In-app browser upload requires a file input target');
    }
    const listing = await this.embeddedBridge!.listTabs();
    if (listing.selectedTabId !== tabId) throw new Error('Selected in-app browser tab changed');
  }

  private async withEmbeddedDownloadDestination<T>(scope: BrowserScope, claim: ExternalBrowserClaim,
    filePath: string | undefined, action: () => Promise<T>, signal?: AbortSignal | null): Promise<T> {
    if (!filePath) return action();
    const destinationId = randomUUID();
    await this.embeddedRouter!.setDownloadDestination(scope, claim, filePath, destinationId, signal);
    try {
      const result = await action();
      await this.embeddedRouter!.waitDownloadDestination(scope, claim, destinationId, signal);
      return result;
    } finally {
      await this.embeddedRouter!.setDownloadDestination(scope, claim, null, destinationId).catch(() => undefined);
    }
  }

  private beginManagedDownload(page: Page, filePath: string): ManagedDownloadDestination {
    if (!this.downloadStore) throw new Error('Managed browser downloads are unavailable');
    const previous = this.downloadDestinations.get(page);
    if (previous && previous.state !== 'started')
      throw new Error('A previous download has not started or was cancelled. Use a fresh browser tab for another download.');
    let settle!: ManagedDownloadDestination['settle'];
    const outcome = new Promise<string | null>(resolve => { settle = resolve; });
    const destination: ManagedDownloadDestination = { filePath, state: 'pending', outcome, settle };
    this.downloadDestinations.set(page, destination);
    return destination;
  }

  private async waitManagedDownload(page: Page, destination: ManagedDownloadDestination,
    signal?: AbortSignal | null, timeoutMs = 30_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    const cancel = (message: string) => {
      if (destination.state !== 'pending') return;
      destination.state = 'cancelled'; destination.settle(message);
    };
    const onAbort = () => cancel('Browser download action was cancelled');
    if (signal?.aborted || page.isClosed()) cancel('Browser download action was cancelled or its page closed');
    if (destination.state === 'pending') {
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => cancel('Browser download did not start within 30 seconds; the requested destination was not used'), timeoutMs);
      poll = setInterval(() => { if (page.isClosed()) cancel('Browser download page closed before it started'); }, 50);
    }
    try {
      const error = await destination.outcome;
      if (error) throw new Error(error);
      if (signal?.aborted) throw new Error('Browser download action was cancelled');
    } finally {
      if (timer) clearTimeout(timer); if (poll) clearInterval(poll);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private releaseManagedDownload(page: Page, destination: ManagedDownloadDestination): void {
    if (this.downloadDestinations.get(page) !== destination) return;
    if (destination.state === 'started') this.downloadDestinations.delete(page);
    else {
      destination.state = 'cancelled'; destination.settle('Browser download action ended before its download started');
    }
  }

  private withExternalDownloadInstruction(result: Array<Record<string, any>>, filePath?: string): Array<Record<string, any>> {
    return filePath ? [...result, { type: 'text', text: `Requested download destination: ${filePath}. This action keeps the browser's normal download behavior. Complete any Save As dialog automatically with Computer Use using this exact path, or move only a reliably identified completed file. Do not ask the user to repeat the known destination. Verify the completed file before reporting success.` }] : result;
  }

  async callTool(
    scope: BrowserScope,
    name: BrowserToolName,
    params: Record<string, any>,
    abortSignal: AbortSignal | null = null,
    localPreviewContext: BrowserLocalPreviewContext | null = null,
  ): Promise<string | Array<Record<string, any>>> {
    const assertEmbeddedTurn = this.captureEmbeddedTurn(scope, abortSignal);
    const downloadPath = params.downloadPath;
    if (downloadPath !== undefined && (!['browser_click', 'browser_navigate', 'browser_press_key'].includes(name)
      || typeof downloadPath !== 'string' || downloadPath.length > 4096 || !path.isAbsolute(downloadPath)
      || downloadPath.includes('\0') || !fs.statSync(path.dirname(downloadPath)).isDirectory()
      || fs.existsSync(downloadPath))) throw new Error('downloadPath must name a new file in an existing absolute folder');
    const tabMention = params.tabMention;
    const disposition = params.tabDisposition;
    if (tabMention !== undefined && typeof tabMention !== 'string') throw new Error('Invalid browser tab mention');
    if (disposition !== undefined && disposition !== 'deliverable' && disposition !== 'handoff') {
      throw new Error('Invalid browser tab disposition');
    }
    if (params.newTab !== undefined && typeof params.newTab !== 'boolean') throw new Error('Invalid newTab');
    const openNewTab = name === 'browser_navigate' && params.newTab === true;
    if (openNewTab) {
      if (downloadPath !== undefined) throw new Error('downloadPath requires an existing browser tab; open the tab before triggering its download');
      this.validateTargetBrowser(params.targetBrowser);
      if (tabMention !== undefined) throw new Error('newTab opens another tab; omit tabMention');
      const browser = params.targetBrowser
        ?? (this.externalIsCurrent(scope) ? this.externalRouter?.currentBrowser?.(scope) : null) ?? 'memmy';
      if (browser === 'chrome' || browser === 'edge') {
        if (disposition) throw new Error('tabDisposition requires an in-app browser tab');
        if (!this.config.enabled || !this.externalRouter) throw new Error('Browser extension tools are unavailable');
        const opened = await this.externalRouter.openTab(scope, browser, String(params.url ?? ''), assertEmbeddedTurn);
        assertEmbeddedTurn();
        return [{ type: 'text', text: JSON.stringify({ newTab: true, browser, title: opened.title, url: opened.url,
          tabMention: formatExternalBrowserTabReference({ ...opened, browser }) }) }];
      }
    }
    const browserParams = { ...params };
    delete browserParams.tabMention;
    delete browserParams.tabDisposition;
    delete browserParams.targetBrowser;
    delete browserParams.newTab;
    delete browserParams.downloadPath;
    const externalTarget = openNewTab ? null : await this.resolveExternalTarget(scope, params, assertEmbeddedTurn);
    assertEmbeddedTurn();
    if (externalTarget && this.externalRouter) {
      if (disposition) throw new Error('tabDisposition requires an in-app browser tab');
      if (name === 'browser_file_upload') {
        this.validateUploadFiles(browserParams.paths, localPreviewContext?.workspace);
        const result = await this.externalRouter.upload(scope, externalTarget, browserParams,
          (url, files, signal) => this.capabilityApproval.authorize('upload', url, files, signal), abortSignal);
        assertEmbeddedTurn();
        return result;
      }
      const result = await this.externalRouter.call(scope, externalTarget, name, browserParams, abortSignal);
      assertEmbeddedTurn();
      return Array.isArray(result) ? convertMcpToolContent({ content: this.withExternalDownloadInstruction(result, downloadPath) }, 'structured') : result;
    }
    if (tabMention !== undefined) {
      if (!this.config.enabled) throw new Error('Browser tools are disabled');
      if (!this.embeddedBridge || !this.embeddedRouter) throw new Error('Mentioned Memmy browser is unavailable');
      if (name === 'browser_take_screenshot') throw new Error(EMBEDDED_BROWSER_SCREENSHOT_UNSUPPORTED);
      const claim = await this.embeddedBridge.resolveMention(tabMention);
      assertEmbeddedTurn();
      if (name === 'browser_file_upload') await this.verifyEmbeddedUpload(claim.tabId, browserParams,
        localPreviewContext?.workspace);
      assertEmbeddedTurn();
      const selected = this.embeddedRouter.selectClaim(scope, claim);
      const result = await this.withEmbeddedDownloadDestination(scope, selected, downloadPath,
        () => this.embeddedRouter!.call(scope, selected, name, browserParams, abortSignal), abortSignal);
      assertEmbeddedTurn();
      if (disposition) this.embeddedRouter.markTab(scope, disposition, selected);
      return result;
    }
    if (this.config.enabled && this.embeddedBridge && this.embeddedRouter && !openNewTab && !abortSignal?.aborted) {
      const key = browserScopeKey(scope);
      const tab = await this.embeddedBridge.refresh().catch(() => null);
      assertEmbeddedTurn();
      const hasManagedSession = this.sessions.has(key) || this.creations.has(key);
      const targetUrl = name === 'browser_navigate' ? String(params.url ?? '') : '';
      if ((tab && !targetUrl) || this.embeddedRouter.hasBinding(scope)) {
        if (name === 'browser_take_screenshot') throw new Error(EMBEDDED_BROWSER_SCREENSHOT_UNSUPPORTED);
        const embedded = this.embeddedRouter.select(scope, hasManagedSession);
        if (embedded) {
          if (name === 'browser_file_upload') await this.verifyEmbeddedUpload(embedded.tabId, browserParams,
            localPreviewContext?.workspace);
          assertEmbeddedTurn();
          const result = await this.withEmbeddedDownloadDestination(scope, embedded, downloadPath,
            () => this.embeddedRouter!.call(scope, embedded, name, browserParams, abortSignal), abortSignal);
          assertEmbeddedTurn();
          if (disposition) this.embeddedRouter.markTab(scope, disposition, embedded);
          return result;
        }
      }
    }
    if (this.config.enabled && this.externalRouter && params.targetBrowser !== 'memmy' && !openNewTab && !abortSignal?.aborted) {
      const key = browserScopeKey(scope);
      const external = this.externalRouter.select(scope,
        this.sessions.has(key) || this.creations.has(key));
      if (external) {
        if (name === 'browser_file_upload') {
          this.validateUploadFiles(browserParams.paths, localPreviewContext?.workspace);
          return this.externalRouter.upload(scope, external, browserParams,
            (url, files, signal) => this.capabilityApproval.authorize('upload', url, files, signal), abortSignal);
        }
        if (disposition) throw new Error('tabDisposition requires an in-app browser tab');
        const result = await this.externalRouter.call(scope, external, name, browserParams, abortSignal);
        assertEmbeddedTurn();
        return Array.isArray(result) ? convertMcpToolContent({ content: this.withExternalDownloadInstruction(result, downloadPath) }, 'structured') : result;
      }
    }
    // Only in-app and extension tabs take acceptDialog.
    delete browserParams.acceptDialog;
    if (this.config.enabled && this.embeddedBridge && this.embeddedRouter
      && name === 'browser_navigate' && !abortSignal?.aborted
      && (openNewTab || (!this.embeddedRouter.hasBinding(scope)
        && !this.sessions.has(browserScopeKey(scope)) && !this.creations.has(browserScopeKey(scope))))) {
      if (downloadPath !== undefined) throw new Error('downloadPath requires an existing in-app tab; open a regular page first');
      const targetUrl = String(params.url ?? '');
      let targetOrigin: string | null = null;
      try {
        const parsed = new URL(targetUrl);
        if (['http:', 'https:'].includes(parsed.protocol)) targetOrigin = parsed.origin;
      } catch { /* Existing browser path reports invalid URLs. */ }
      if (targetOrigin) {
        const approved = new Set<string>();
        if (!await this.accessApproval?.authorize(targetUrl, approved)) {
          throw new Error(`Access to ${targetOrigin} was not approved`);
        }
        assertEmbeddedTurn();
        approved.add(targetOrigin);
        const opened = await this.embeddedBridge.openTab(targetUrl, scope.chatId ?? scope.sessionKey);
        try { assertEmbeddedTurn(); }
        catch (error) {
          if (opened) await this.embeddedBridge.command(opened, 'closeTab').catch(() => undefined);
          throw error;
        }
        if (!opened) throw new Error('Memmy browser tab did not open');
        const selected = this.embeddedRouter.selectClaim(scope, opened,
          { allowedOrigins: approved, agentCreated: true });
        // openTab already navigates the webview through its initial src. A
        // second navigate can abort that load or reset a page that has begun
        // rendering. Keep the live-site approval check without loading again.
        await this.embeddedRouter.authorizeCurrent(scope, selected);
        assertEmbeddedTurn();
        if (disposition) this.embeddedRouter.markTab(scope, disposition, selected);
        return [{ type: 'text', text: JSON.stringify({ url: selected.url }) }];
      }
    }
    if (openNewTab) throw new Error('newTab requires the Memmy in-app browser and an http(s) URL');
    if (disposition) throw new Error('tabDisposition requires an in-app browser tab');
    await this.ensureReadyForTool(abortSignal);
    if (!this.definitions.has(name)) throw new Error(`browser tool '${name}' is unavailable`);
    const navigateTarget: BrowserNavigateTarget | null = name === "browser_navigate"
      ? classifyBrowserNavigateTarget(String(params.url ?? ""))
      : null;
    const session = await this.acquireSession(scope);
    try {
      return await session.mutex.runExclusive(async () => {
        let candidatePreview: BrowserPreviewLease | null = null;
        let uploadTempDir: string | null = null;
        let pendingDownload: { page: Page; destination: ManagedDownloadDestination } | null = null;
        try {
          if (session.closed) throw new Error("browser session closed");
          if (this.sitePermissionStore && typeof session.context.clearPermissions === 'function') {
            await this.sitePermissionStore.apply(session.context);
          }
          if (abortSignal?.aborted) {
            const error = new Error("browser tool call cancelled");
            error.name = "AbortError";
            throw error;
          }
          session.lastUsedAt = Date.now();
          if (downloadPath !== undefined) {
            const pages = session.context.pages().filter(page => !page.isClosed());
            if (pages.length !== 1) throw new Error('Browser download destination requires one unambiguous page');
            const page = pages[0]!;
            pendingDownload = { page, destination: this.beginManagedDownload(page, downloadPath) };
          }
          let approvedUploadPage: Page | null = null;
          let approvedUploadUrl: string | null = null;
          let approvedFiles: Array<{ path: string; realPath: string; dev: number; ino: number;
            size: number; mtimeMs: number }> = [];
          if (name === 'browser_file_upload') {
            const files = browserParams.paths;
            this.validateUploadFiles(files, localPreviewContext?.workspace);
            approvedFiles = files.map(file => {
              const info = fs.lstatSync(file);
              return { path: file, realPath: fs.realpathSync(file), dev: info.dev,
                ino: info.ino, size: info.size, mtimeMs: info.mtimeMs };
            });
            const pages = session.context.pages().filter(page => !page.isClosed());
            if (pages.length !== 1) throw new Error('Browser upload requires one unambiguous page');
            const page = pages[0]!;
            const pageUrl = page.url();
            if (!await this.capabilityApproval.authorize('upload', pageUrl, files)) {
              throw new Error('Browser upload was not approved');
            }
            approvedUploadPage = page;
            approvedUploadUrl = pageUrl;
          }
          let callParams = browserParams;
          if (name === 'browser_file_upload') {
            this.validateUploadFiles(browserParams.paths, localPreviewContext?.workspace);
            uploadTempDir = fs.mkdtempSync(path.join(session.outputDir, 'approved-upload-'));
            const staged: string[] = [];
            for (const [index, stamp] of approvedFiles.entries()) {
              const directory = path.join(uploadTempDir, String(index));
              fs.mkdirSync(directory, { mode: 0o700 });
              const destination = path.join(directory, path.basename(stamp.path));
              if (fs.realpathSync(stamp.path) !== stamp.realPath) {
                throw new Error('Browser upload file changed after approval');
              }
              const source = await fs.promises.open(stamp.path, 'r');
              try {
                const before = await source.stat();
                if (before.dev !== stamp.dev || before.ino !== stamp.ino
                  || before.size !== stamp.size || before.mtimeMs !== stamp.mtimeMs) {
                  throw new Error('Browser upload file changed after approval');
                }
                const target = await fs.promises.open(destination, 'wx', 0o600);
                try {
                  const buffer = Buffer.allocUnsafe(1024 * 1024);
                  while (true) {
                    if (abortSignal?.aborted) throw new Error('browser tool call cancelled');
                    const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
                    if (!bytesRead) break;
                    let written = 0;
                    while (written < bytesRead) {
                      const next = await target.write(buffer, written, bytesRead - written);
                      written += next.bytesWritten;
                    }
                  }
                  await target.chmod(0o600);
                } finally { await target.close().catch(() => undefined); }
                const after = await source.stat();
                if (after.size !== stamp.size || after.mtimeMs !== stamp.mtimeMs) {
                  throw new Error('Browser upload file changed during staging');
                }
              } finally { await source.close().catch(() => undefined); }
              staged.push(destination);
            }
            callParams = { ...browserParams };
            delete callParams.target;
            delete callParams.ref;
            callParams.paths = staged;
          }
          if (navigateTarget?.kind === "path") {
            if (!localPreviewContext?.workspace) {
              throw new Error("local browser preview requires a trusted workspace");
            }
            candidatePreview = await createBrowserPreview(navigateTarget.path, {
              workspace: localPreviewContext.workspace,
              readonlyRoots: localPreviewContext.readonlyRoots,
              restrictLocalFiles: this.restrictLocalFiles,
            });
            callParams = { ...browserParams, url: candidatePreview.url };
            session.allowedOrigins.add(new URL(candidatePreview.url).origin);
          }
          const directScreenshot = this.desktopManaged
            && name === 'browser_take_screenshot' && !callParams.element && !callParams.target;
          const invoke = async () => {
            if (abortSignal?.aborted) {
              const error = new Error('browser tool call cancelled');
              error.name = 'AbortError';
              throw error;
            }
            if (approvedUploadPage && (approvedUploadPage.isClosed()
              || session.context.pages().filter(page => !page.isClosed()).length !== 1
              || session.context.pages()[0] !== approvedUploadPage
              || approvedUploadPage.url() !== approvedUploadUrl)) {
              throw new Error('Browser upload page changed after approval');
            }
            if (approvedUploadPage && this.capabilityApproval.blocked('upload', approvedUploadUrl!)) {
              throw new Error('Browser upload was blocked by site policy');
            }
            return directScreenshot
            ? this.captureBrowserScreenshotTool(session, callParams)
            : session.connection.client.callTool(
            { name, arguments: callParams },
            undefined,
            {
              signal: abortSignal ?? undefined,
              timeout: 70_000,
              maxTotalTimeout: 70_000,
            },
          );
          };
          const result = this.desktopManaged && process.env.MEMMY_DESKTOP_MANAGED_GATEWAY === '1'
            && process.platform === 'darwin'
            && this.definitions.get(name)?.annotations?.readOnlyHint !== true
            ? await withMacFocusGuard('com.google.chrome.for.testing', name, invoke)
            : await invoke();
          if (pendingDownload && result.isError !== true)
            await this.waitManagedDownload(pendingDownload.page, pendingDownload.destination, abortSignal);
          session.lastUsedAt = Date.now();
          if (navigateTarget && result.isError !== true) {
            const previousPreview = session.preview;
            session.preview = navigateTarget.kind === "path"
              ? candidatePreview
              : null;
            candidatePreview = null;
            await previousPreview?.close().catch(() => undefined);
          } else {
            await candidatePreview?.close().catch(() => undefined);
            candidatePreview = null;
          }
          if (result.isError !== true) {
            await this.emitBrowserFrame(session);
            if (!this.clearingData && !session.closed) {
              await this.profileStore?.save(session.context).catch(() => undefined);
            }
          }
          return convertMcpToolContent(result, "structured");
        } catch (error) {
          await candidatePreview?.close().catch(() => undefined);
          if (abortSignal?.aborted || (error as Error).name === "AbortError") {
            await this.closeByKey(session.key);
          }
          throw error;
        } finally {
          if (pendingDownload) this.releaseManagedDownload(pendingDownload.page, pendingDownload.destination);
          if (uploadTempDir) fs.rmSync(uploadTempDir, { recursive: true, force: true });
        }
      });
    } finally {
      session.pendingCalls = Math.max(0, session.pendingCalls - 1);
    }
  }

  private async captureBrowserScreenshotTool(session: BrowserSession, params: Record<string, any>) {
    const page = session.context.pages().at(-1);
    if (!page || page.isClosed()) throw new Error('No browser page is open');
    const format = params.type === 'jpeg' ? 'jpeg' : 'png';
    const data = await captureBackgroundBrowserPage(page, format, params.fullPage === true);
    const filename = typeof params.filename === 'string' && params.filename.trim()
      ? params.filename.trim() : `page-${Date.now()}.${format}`;
    if (path.isAbsolute(filename) || filename.split(/[\\/]/).includes('..')) {
      throw new Error('Screenshot filename must stay within the browser output directory');
    }
    const destination = path.resolve(session.outputDir, filename);
    if (!destination.startsWith(`${session.outputDir}${path.sep}`)) {
      throw new Error('Screenshot filename must stay within the browser output directory');
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, Buffer.from(data, 'base64'));
    return { isError: false, content: [
      { type: 'text' as const, text: `Screenshot saved to ${destination}` },
      { type: 'image' as const, mimeType: `image/${format}`, data },
    ] };
  }

  async closeSession(scope: BrowserScope): Promise<void> {
    this.invalidateEmbeddedTurn(browserScopeKey(scope));
    this.embeddedRouter?.closeSession(scope);
    this.externalRouter?.closeSession(scope);
    const key = browserScopeKey(scope);
    await this.creations.get(key)?.catch(() => undefined);
    await this.closeByKey(key);
  }

  async closeChat(channel: string, chatId: string): Promise<void> {
    for (const key of this.embeddedTurns.keys()) {
      const [, boundChannel, boundChatId] = JSON.parse(key);
      if (boundChannel === channel && boundChatId === chatId) this.invalidateEmbeddedTurn(key);
    }
    this.embeddedRouter?.closeChat(channel, chatId);
    this.externalRouter?.closeChat(channel, chatId);
    const creationKeys = [...this.creations.keys()].filter((key) => {
      try {
        const parsed = JSON.parse(key);
        return parsed[1] === channel && parsed[2] === chatId;
      } catch {
        return false;
      }
    });
    await Promise.allSettled(
      creationKeys.map((key) => this.creations.get(key) ?? Promise.resolve()),
    );
    const keys = [...this.sessions.entries()]
      .filter(([, session]) => session.scope.channel === channel && session.scope.chatId === chatId)
      .map(([key]) => key);
    await Promise.allSettled(keys.map((key) => this.closeByKey(key)));
  }

  clearBrowsingData(): Promise<void> {
    if (this.clearDataPromise) return this.clearDataPromise;
    const task = this.clearBrowsingDataOnce().finally(() => { this.clearDataPromise = null; });
    this.clearDataPromise = task;
    return task;
  }

  private async clearBrowsingDataOnce(): Promise<void> {
    this.clearingData = true;
    for (const key of this.embeddedTurns.keys()) this.invalidateEmbeddedTurn(key);
    try {
      await Promise.allSettled([...this.creations.values()]);
      const sessions = [...this.sessions.values()];
      this.sessions.clear();
      await Promise.allSettled(sessions.map(session => this.disposeSession(session)));
      await this.closeBrowserIfUnused();
      const cleared = await Promise.allSettled([
        this.profileStore?.clear(),
        this.downloadStore?.clearHistory(),
        Promise.resolve().then(() => this.sitePermissionStore?.clear()),
        Promise.resolve().then(() => this.accessApproval?.clear()),
      ]);
      const failure = cleared.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failure) throw failure.reason;
    } finally { this.clearingData = false; }
  }

  async closeSurfacesForTurn(scope: BrowserScope): Promise<void> {
    const projectedScope = { sessionKey: scope.sessionKey,
      channel: 'projected-session', chatId: scope.sessionKey };
    const turnScopes = browserScopeKey(scope) === browserScopeKey(projectedScope)
      ? [scope] : [scope, projectedScope];
    for (const item of turnScopes) this.invalidateEmbeddedTurn(browserScopeKey(item));
    await Promise.allSettled(turnScopes.map(item => this.embeddedRouter?.finishTurn(item)));
    await Promise.allSettled(turnScopes.map(async item => this.externalRouter?.finishTurn(item)));
    const session = this.sessions.get(browserScopeKey(scope))
      ?? this.sessions.get(browserScopeKey(projectedScope));
    if (session && !session.closed) emitComputerUseSurface({
      surface: 'browser', ...session.scope, targetId: 'active-tab', title: '浏览器',
      close: true, presentationOnly: true,
    });
  }

  private async closeByKey(key: string): Promise<void> {
    const session = this.sessions.get(key);
    if (!session) return;
    this.sessions.delete(key);
    await this.disposeSession(session);
    await this.closeBrowserIfUnused();
  }

  private async disposeSession(session: BrowserSession): Promise<void> {
    if (session.closed) return;
    session.closed = true;
    emitComputerUseSurface({ surface: 'browser', ...session.scope, targetId: 'active-tab', title: '浏览器', close: true });
    if (!this.clearingData) await this.profileStore?.save(session.context).catch(() => undefined);
    await session.connection.close().catch(() => undefined);
    await session.context.close().catch(() => undefined);
    await session.preview?.close().catch(() => undefined);
    session.preview = null;
    fs.rmSync(session.outputDir, { recursive: true, force: true });
  }

  private async closeBrowserIfUnused(): Promise<void> {
    if (this.sessions.size || this.creations.size || !this.browser) return;
    const browser = this.browser;
    this.browser = null;
    await browser.close().catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    for (const key of this.embeddedTurns.keys()) this.invalidateEmbeddedTurn(key);
    this.externalRouter?.closeAll();
    this.embeddedRouter?.closeAll();
    this.embeddedBridge?.close();
    process.removeListener('message', this.surfaceActionListener);
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
    const creations = [...this.creations.values()];
    await Promise.allSettled(creations);
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map((session) => this.disposeSession(session)));
    if (this.browser) {
      const browser = this.browser;
      this.browser = null;
      await browser.close().catch(() => undefined);
    }
    this.closing = false;
  }
}

abstract class BrowserTool extends Tool {
  static scopes = new Set(["core"]);
  static browserToolName: BrowserToolName;
  protected readonly manager: BrowserSessionManager;
  private readonly toolDefinition: BrowserToolDefinition;
  private readonly requestContext = new RequestContextStore();
  private readonly readonlySkillRoots: readonly string[];

  constructor(
    manager: BrowserSessionManager,
    definition: BrowserToolDefinition,
    readonlySkillRoots: readonly string[] = [],
  ) {
    super();
    this.manager = manager;
    this.toolDefinition = definition;
    this.readonlySkillRoots = Object.freeze([...readonlySkillRoots]);
  }

  static enabled(ctx: any): boolean {
    return ctx.browserSessionManager?.capability === "ready"
      || ctx.browserSessionManager?.capability === "preparing";
  }

  static create<T extends typeof BrowserTool>(this: T, ctx: any): InstanceType<T> {
    const name = this.browserToolName;
    const definition = ctx.browserSessionManager?.definition(name);
    if (!definition) throw new Error(`browser tool '${name}' is unavailable`);
    return new (this as any)(
      ctx.browserSessionManager,
      definition,
      ctx.readonlySkillRoots ?? [],
    ) as InstanceType<T>;
  }

  get name(): string {
    return this.toolDefinition.name;
  }

  get description(): string {
    return this.toolDefinition.description;
  }

  get parameters(): Record<string, any> {
    return structuredClone(this.toolDefinition.inputSchema);
  }

  override get readOnly(): boolean {
    return this.toolDefinition.annotations?.readOnlyHint === true;
  }

  setContext(context: RequestContext): void {
    this.requestContext.set(context);
  }

  async execute(
    params: Record<string, any> = {},
    context?: ToolExecutionContext,
  ): Promise<string | Array<Record<string, any>>> {
    const request = this.requestContext.get();
    const sessionKey = request?.sessionKey?.trim();
    const channel = request?.channel?.trim();
    const chatId = request?.chatId?.trim();
    const workspace = request?.workspace?.trim();
    if (!sessionKey || !channel || !chatId || !workspace) {
      throw new Error("browser tool requires a trusted chat context");
    }
    try {
      return await this.manager.callTool(
        request?.browserScope ?? { sessionKey, channel, chatId },
        this.name as BrowserToolName,
        params,
        context?.abortSignal ?? null,
        {
          workspace,
          readonlyRoots: this.readonlySkillRoots,
        },
      );
    } catch (error) {
      if (!(error instanceof OcuUserIntervened)) throw error;
      context?.stopTurn?.(error.message);
      return error.message;
    }
  }
}

export class BrowserNavigateTool extends BrowserTool {
  static browserToolName = "browser_navigate" as const;
}
export class BrowserSnapshotTool extends BrowserTool {
  static browserToolName = "browser_snapshot" as const;
}
export class BrowserFindTool extends BrowserTool {
  static browserToolName = "browser_find" as const;
}
export class BrowserClickTool extends BrowserTool {
  static browserToolName = "browser_click" as const;
}
export class BrowserTypeTool extends BrowserTool {
  static browserToolName = "browser_type" as const;
}
export class BrowserSelectOptionTool extends BrowserTool {
  static browserToolName = "browser_select_option" as const;
}
export class BrowserPressKeyTool extends BrowserTool {
  static browserToolName = "browser_press_key" as const;
}
export class BrowserWaitForTool extends BrowserTool {
  static browserToolName = "browser_wait_for" as const;
}
export class BrowserConsoleMessagesTool extends BrowserTool {
  static browserToolName = "browser_console_messages" as const;
}
export class BrowserNetworkRequestsTool extends BrowserTool {
  static browserToolName = "browser_network_requests" as const;
}
export class BrowserTakeScreenshotTool extends BrowserTool {
  static browserToolName = "browser_take_screenshot" as const;
}
export class BrowserResizeTool extends BrowserTool {
  static browserToolName = "browser_resize" as const;
}
export class BrowserFileUploadTool extends BrowserTool {
  static browserToolName = "browser_file_upload" as const;
}

/** Tab enumeration is provided by Memmy's real webview, not Playwright MCP. */
export class BrowserListTabsTool extends Tool {
  static scopes = new Set(["core"]);
  private readonly requestContext = new RequestContextStore();

  constructor(private readonly manager: BrowserSessionManager) { super(); }

  static enabled(ctx: any): boolean {
    return ctx.browserSessionManager?.supportsTabListing() === true;
  }

  static create(ctx: any): BrowserListTabsTool {
    return new BrowserListTabsTool(ctx.browserSessionManager);
  }

  get name(): string { return 'browser_list_tabs'; }
  get description(): string {
    return 'Discover open Memmy, Chrome, and Edge web tabs. Set targetBrowser when the user names a browser. For an explicitly requested running Chrome/Edge, interactive discovery may bring that browser forward without navigation and waits up to 45 seconds for a live extension handshake, including when installation metadata cannot be read. Confirmed absent or disabled extensions and stopped browsers return immediately. Untargeted, Memmy, and non-interactive discovery never wake an external browser. When the running-process state is unknown, discovery allows only a short passive grace period. connectionStatus separates installed/enabled/running/connected facts; null means unknown. Only extensionSetup.installRequired confirms missing installation. Connected extensions with no controllable tabs remain connected; pageDiscoveryStatus unresponsive is a page-list reply failure, not proof of disconnection. Resolve the requested page to its tabMention internally; never ask the user to copy it. If several tabs match, ask which page. available is false only while another chat is still working in that tab. In-app about:blank has a null reference. Listing does not navigate or bind a chat to a tab.';
  }
  get parameters(): Record<string, any> { return { type: 'object', properties: { targetBrowser: targetBrowserParameter }, additionalProperties: false }; }
  override get readOnly(): boolean { return false; }

  setContext(context: RequestContext): void { this.requestContext.set(context); }

  async execute(params: Record<string, any> = {}, context?: ToolExecutionContext): Promise<string> {
    const request = this.requestContext.get();
    if (!request?.sessionKey?.trim() || !request.channel?.trim()
        || !request.chatId?.trim() || !request.workspace?.trim()) {
      throw new Error('browser tool requires a trusted chat context');
    }
    return this.manager.listBrowserTabs(request.browserScope ?? {
      sessionKey: request.sessionKey, channel: request.channel, chatId: request.chatId,
    }, params.targetBrowser, context?.abortSignal,
      request.metadata.computerUseInteractive !== false && !['system', 'cron'].includes(request.channel));
  }
}

export class BrowserSelectTabTool extends Tool {
  static scopes = new Set(["core"]);
  private readonly requestContext = new RequestContextStore();

  constructor(private readonly manager: BrowserSessionManager) { super(); }

  static enabled(ctx: any): boolean {
    return ctx.browserSessionManager?.supportsExternalTabSelection?.() === true;
  }

  static create(ctx: any): BrowserSelectTabTool {
    return new BrowserSelectTabTool(ctx.browserSessionManager);
  }

  get name(): string { return 'browser_select_tab'; }
  get description(): string {
    return 'Show a connected Chrome or Edge tab as the selected tab in its browser window and continue this chat on it, for example to return to search results after a link opened a new tab. Pass targetBrowser and the exact tabMention from browser_list_tabs. Any listed tab is allowed unless another chat is still working in it. The browser window is not raised over other apps. To read or act on another tab without showing it, pass its tabMention to that browser tool instead.';
  }
  get parameters(): Record<string, any> {
    return { type: 'object', properties: {
      targetBrowser: { type: 'string', enum: ['chrome', 'edge'], description: 'Browser that contains the tab.' },
      tabMention: { type: 'string', description: 'Exact tab reference returned by browser_list_tabs for the tab to show.' },
    }, required: ['targetBrowser', 'tabMention'], additionalProperties: false };
  }

  setContext(context: RequestContext): void { this.requestContext.set(context); }

  async execute(params: Record<string, any> = {}, context?: ToolExecutionContext): Promise<string> {
    const request = this.requestContext.get();
    if (!request?.sessionKey?.trim() || !request.channel?.trim()
        || !request.chatId?.trim() || !request.workspace?.trim()) {
      throw new Error('browser tool requires a trusted chat context');
    }
    return this.manager.selectBrowserTab(request.browserScope ?? {
      sessionKey: request.sessionKey, channel: request.channel, chatId: request.chatId,
    }, params, context?.abortSignal);
  }
}

/** History is read from the desktop's in-app store under its effective website approval. */
export class BrowserHistoryTool extends Tool {
  static scopes = new Set(['core']);
  private readonly requestContext = new RequestContextStore();

  constructor(private readonly manager: BrowserSessionManager) { super(); }
  static enabled(ctx: any): boolean { return ctx.browserSessionManager?.supportsEmbeddedTabs() === true; }
  static create(ctx: any): BrowserHistoryTool { return new BrowserHistoryTool(ctx.browserSessionManager); }
  get name(): string { return 'browser_history'; }
  get description(): string {
    return 'Search the Memmy in-app browser history using a keyword and an ISO 8601 time range of at most 30 days. Computer Use allow-all or website allow-all covers this request; otherwise the desktop asks for this history query. This reads the in-app browser store.';
  }
  get parameters(): Record<string, any> {
    return { type: 'object', properties: {
      from: { type: 'string', description: 'Inclusive start time, ISO 8601 with timezone.' },
      to: { type: 'string', description: 'Inclusive end time, ISO 8601 with timezone.' },
      keyword: { type: 'string', minLength: 2, maxLength: 100,
        description: 'Required search term matched against the page title and URL.' },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum entries, default 20.' },
    }, required: ['from', 'to', 'keyword'], additionalProperties: false };
  }
  override get readOnly(): boolean { return true; }
  setContext(context: RequestContext): void { this.requestContext.set(context); }
  async execute(params: Record<string, any> = {}): Promise<string> {
    const request = this.requestContext.get();
    if (!request?.sessionKey?.trim() || !request.channel?.trim() || !request.chatId?.trim()
        || !request.workspace?.trim() || request.metadata.computerUseInteractive === false
        || ['system', 'cron'].includes(request.channel)) {
      throw new Error('Browser history requires a current interactive desktop chat');
    }
    if (Object.keys(params).some(key => !['from', 'to', 'keyword', 'limit'].includes(key))) {
      throw new Error('Invalid browser history query');
    }
    return this.manager.queryEmbeddedHistory({ from: params.from, to: params.to,
      keyword: params.keyword, limit: params.limit ?? 20 });
  }
}

abstract class BrowserCdpReadTool extends Tool {
  static scopes = new Set(['core']);
  protected readonly requestContext = new RequestContextStore();
  constructor(protected readonly manager: BrowserSessionManager) { super(); }
  static enabled(ctx: any): boolean { return ctx.browserSessionManager?.supportsCdpTabs() === true; }
  static create(ctx: any): BrowserCdpReadTool { return new (this as any)(ctx.browserSessionManager); }
  override get readOnly(): boolean { return true; }
  setContext(context: RequestContext): void { this.requestContext.set(context); }
  protected scope(): BrowserScope {
    const request = this.requestContext.get();
    if (!request?.sessionKey?.trim() || !request.channel?.trim() || !request.chatId?.trim()
      || !request.workspace?.trim() || request.metadata.computerUseInteractive === false
      || ['system', 'cron'].includes(request.channel)) {
      throw new Error('Browser operations require a current interactive desktop chat');
    }
    return request.browserScope ?? { sessionKey: request.sessionKey, channel: request.channel, chatId: request.chatId };
  }
}

export class BrowserCdpSendTool extends BrowserCdpReadTool {
  get name(): string { return 'browser_cdp_read'; }
  get description(): string {
    return 'Read the current selected or claimed browser tab with a restricted CDP method. Only read-only methods are accepted; each call follows the Debug / CDP site rule and may require a visible approval. Page.captureScreenshot is available only for connected Chrome/Edge tabs; Memmy in-app tabs do not support screenshots. Use browser_snapshot to read in-app page text and element references.';
  }
  get parameters(): Record<string, any> { return { type: 'object', properties: {
    method: { type: 'string', enum: ['Accessibility.getFullAXTree', 'DOM.getDocument',
      'Page.getLayoutMetrics', 'Page.captureScreenshot', 'Runtime.evaluate'] },
    params: { type: 'object', description: 'Method parameters; Runtime.evaluate is forced to throw on side effects.' },
    target: { type: 'object', description: 'Optional attached child target of the current approved tab: sessionId or targetId.',
      properties: { sessionId: { type: 'string' }, targetId: { type: 'string' } }, additionalProperties: false },
    timeoutMs: { type: 'integer', minimum: 0, maximum: 30000,
      description: 'Maximum CDP command wait in milliseconds; defaults to 3000.' },
    targetBrowser: targetBrowserParameter,
    tabMention: { type: 'string', description: 'Exact Memmy browser tab reference supplied by the user or returned by browser_list_tabs for the user-requested tab. Resolve a unique title or URL match internally; do not ask the user to copy the reference.' },
  }, required: ['method'], additionalProperties: false }; }
  async execute(params: Record<string, any> = {}, context?: ToolExecutionContext): Promise<string> {
    return this.manager.callCdp(this.scope(), 'cdpCall', params, context?.abortSignal);
  }
}

export class BrowserCdpEventsTool extends BrowserCdpReadTool {
  get name(): string { return 'browser_cdp_events'; }
  get description(): string {
    return 'Read recent CDP events from the current selected or claimed browser tab after the Debug / CDP site rule is satisfied. Omit afterSequence to start at the current cursor.';
  }
  get parameters(): Record<string, any> { return { type: 'object', properties: {
    afterSequence: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 1000 },
    methods: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 },
    target: { type: 'object', description: 'Filter events from one attached child target by sessionId or targetId.',
      properties: { sessionId: { type: 'string' }, targetId: { type: 'string' } }, additionalProperties: false },
    timeoutMs: { type: 'integer', minimum: 0, maximum: 30000,
      description: 'Wait this long for a matching event. With no cursor, wait for future events.' },
    targetBrowser: targetBrowserParameter,
    tabMention: { type: 'string', description: 'Exact Memmy browser tab reference supplied by the user or returned by browser_list_tabs for the user-requested tab. Resolve a unique title or URL match internally; do not ask the user to copy the reference.' },
  }, additionalProperties: false }; }
  async execute(params: Record<string, any> = {}, context?: ToolExecutionContext): Promise<string> {
    return this.manager.callCdp(this.scope(), 'cdpEvents', params, context?.abortSignal);
  }
}

export class BrowserCdpWriteTool extends BrowserCdpReadTool {
  get name(): string { return 'browser_cdp_send'; }
  get description(): string {
    return 'Send a permitted Chrome DevTools Protocol command to the selected in-app or claimed Chrome/Edge tab. This can change the page or browser state. The Debug / CDP site rule applies; Requires approval shows a high-risk desktop prompt for this operation and any explicit destination origin. Report lasting changes to the user.';
  }
  override get readOnly(): boolean { return false; }
  get parameters(): Record<string, any> { return { type: 'object', properties: {
    method: { type: 'string', pattern: '^[A-Za-z]+\\.[A-Za-z]+$',
      description: 'A CDP method in a permitted domain. Navigation, file-input, browser-global and protected methods are rejected.' },
    params: { type: 'object', description: 'CDP method parameters, bounded to 24 KB. Explicit destination URLs require separate site access.' },
    target: { type: 'object', description: 'Optional attached child target of the current approved tab: sessionId or targetId.',
      properties: { sessionId: { type: 'string' }, targetId: { type: 'string' } }, additionalProperties: false },
    timeoutMs: { type: 'integer', minimum: 0, maximum: 30000,
      description: 'Maximum CDP command wait in milliseconds; defaults to 3000.' },
    targetBrowser: targetBrowserParameter,
    tabMention: { type: 'string', description: 'Exact Memmy browser tab reference supplied by the user or returned by browser_list_tabs for the user-requested tab. Resolve a unique title or URL match internally; do not ask the user to copy the reference.' },
  }, required: ['method'], additionalProperties: false }; }
  async execute(params: Record<string, any> = {}, context?: ToolExecutionContext): Promise<string> {
    return this.manager.callCdp(this.scope(), 'cdpWrite', params, context?.abortSignal);
  }
}

export class BrowserAuthRequestTool extends BrowserCdpReadTool {
  static enabled(ctx: any): boolean { return ctx.browserSessionManager?.supportsCdpTabs() === true; }
  get name(): string { return 'browser_auth_request'; }
  get description(): string {
    return 'Fill a visible secure web form on the selected Memmy or connected Chrome/Edge tab. Pass inspected field metadata, exact CSS selectors and any needed submit control. Use provided_values for values already supplied for this task or obtained through an authorized channel; the secure form collects missing values or a still unresolved option. Supplied values are redacted from tool history/progress and never returned. The client validates visible controls, fills them and optionally submits; submitted reports dispatch, so verify the task result afterward. After secret entry, explicitly navigate to the retained site origin before inspecting the new document.';
  }
  override get readOnly(): boolean { return false; }
  get parameters(): Record<string, any> { return { type: 'object', properties: {
    origin: { type: 'string', description: 'Canonical current HTTP(S) origin only, with no path or query.' },
    frame: { type: 'string', description: 'Optional exact CSS selector for one iframe containing every requested secure form control, including cross-origin frames.' },
    frames: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string' },
      description: 'Optional chain of exact iframe CSS selectors from the top document to the secure form; do not combine with frame.' },
    fields: { type: 'array', maxItems: 8, items: { type: 'object', properties: {
      id: { type: 'string' }, label: { type: 'string' }, type: { type: 'string', enum: ['text', 'email', 'password', 'tel', 'number'] },
      autocomplete: { type: 'string' }, required: { type: 'boolean' }, selector: { type: 'string', description: 'Exact CSS selector for one visible enabled input in the document selected by frame or frames, or the top document when omitted.' },
    }, required: ['id', 'label', 'type', 'required', 'selector'], additionalProperties: false } },
    options: { type: 'array', minItems: 2, maxItems: 8, items: { type: 'object', properties: {
      id: { type: 'string' }, label: { type: 'string' }, selector: { type: 'string' },
      field_ids: { type: 'array', items: { type: 'string' } },
    }, required: ['id', 'label'], additionalProperties: false } },
    submit: { type: 'object', properties: { selector: { type: 'string' }, action: { type: 'string', enum: ['click', 'press_enter'] } },
      required: ['selector', 'action'], additionalProperties: false },
    provided_values: { type: 'object', maxProperties: 8, additionalProperties: { type: 'string', maxLength: 4096 },
      description: 'Values already supplied for this task or obtained through an authorized channel, keyed by an inspected field id. Never invent values, copy redaction placeholders, or collect secrets from unrelated sources. Do not echo them in messages.' },
    selected_option: { type: 'string', description: 'Known form option id from options. The secure form resolves an option still missing from the task context.' },
    targetBrowser: targetBrowserParameter,
    tabMention: { type: 'string', description: 'Exact Memmy browser tab reference supplied by the user or returned by browser_list_tabs for the user-requested tab. Resolve a unique title or URL match internally; do not ask the user to copy the reference.' },
  }, required: ['origin', 'fields'], additionalProperties: false }; }
  async execute(params: Record<string, any> = {}, context?: ToolExecutionContext): Promise<string> {
    return this.manager.requestBrowserAuth(this.scope(), params, context?.abortSignal);
  }
}

export class BrowserSitePermissionTool extends BrowserCdpReadTool {
  static enabled(ctx: any): boolean { return ctx.browserSessionManager?.supportsSitePermissions?.() === true; }
  get name(): string { return 'browser_site_permission'; }
  get description(): string {
    return 'Grant or revoke camera or microphone permission for the HTTP(S) origin in the current task browser tab. In Memmy and managed Chromium the choice applies only to this task tab or context and origin (lasts: "task"), ends with the task, and leaves the user\'s saved site settings unchanged. Chrome/Edge returns the browser UI step for the Agent to complete with Computer Use. A granted result describes site configuration: perform the page action and verify its result.';
  }
  override get readOnly(): boolean { return false; }
  get parameters(): Record<string, any> { return { type: 'object', properties: {
    origin: { type: 'string', description: 'Exact current HTTP(S) origin from this task tab, without a path or query.' },
    permission: { type: 'string', enum: ['camera', 'microphone'] },
    allow: { type: 'boolean', description: 'Grant this site permission when true; revoke this site grant when false.' },
    targetBrowser: targetBrowserParameter,
    tabMention: { type: 'string', description: 'Exact reference for the task tab returned by browser_list_tabs.' },
  }, required: ['origin', 'permission', 'allow'], additionalProperties: false }; }
  async execute(params: Record<string, any> = {}, context?: ToolExecutionContext): Promise<string> {
    return this.manager.setBrowserSitePermission(this.scope(), params, context?.abortSignal);
  }
}

export const BROWSER_TOOL_CLASSES = [
  BrowserNavigateTool,
  BrowserSnapshotTool,
  BrowserFindTool,
  BrowserClickTool,
  BrowserTypeTool,
  BrowserSelectOptionTool,
  BrowserPressKeyTool,
  BrowserWaitForTool,
  BrowserConsoleMessagesTool,
  BrowserNetworkRequestsTool,
  BrowserTakeScreenshotTool,
  BrowserResizeTool,
  BrowserFileUploadTool,
  BrowserListTabsTool,
  BrowserSelectTabTool,
  BrowserHistoryTool,
  BrowserCdpSendTool,
  BrowserCdpEventsTool,
  BrowserCdpWriteTool,
  BrowserAuthRequestTool,
  BrowserSitePermissionTool,
];
