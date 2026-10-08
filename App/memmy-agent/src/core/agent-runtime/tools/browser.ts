import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { BROWSER_PROFILE_CLEAR_RESULT, isBrowserProfileClearRequest, isComputerUseSurfaceAction,
  type ComputerUseSurfaceAction } from '@memmy/local-api-contracts';
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
    description: 'Exact plugin://browser@memmy tab reference from the user. The browser ID, tab ID, title, and URL must still match; a stale reference fails without opening another tab.' };
  definition.inputSchema.properties.tabDisposition = { type: 'string', enum: ['deliverable', 'handoff'],
    description: 'Keep an Agent-created in-app tab after this turn as a user-facing deliverable or for work in a later turn. These tabs otherwise close at turn end.' };
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
  private creations = new Map<string, Promise<BrowserSession>>();
  private idleTimer: NodeJS.Timeout | null = null;
  private closing = false;
  private clearingData = false;
  private clearDataPromise: Promise<void> | null = null;

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
    const tabMention = input.tabMention;
    if (tabMention !== undefined && typeof tabMention !== 'string') throw new Error('Invalid browser tab mention');
    const args = { ...input };
    delete args.tabMention;
    if (tabMention !== undefined) {
      if (!this.embeddedBridge || !this.embeddedRouter) throw new Error('Mentioned browser tab is unavailable');
      const claim = await this.embeddedBridge.resolveMention(tabMention);
      this.embeddedRouter.selectClaim(scope, claim);
      return this.embeddedRouter.cdp(scope, claim, operation, args, async () => false, signal);
    }
    if (this.embeddedBridge && this.embeddedRouter) {
      await this.embeddedBridge.refresh().catch(() => null);
      const claim = this.embeddedRouter.select(scope,
        this.sessions.has(browserScopeKey(scope)) || this.creations.has(browserScopeKey(scope)));
      if (claim) return this.embeddedRouter.cdp(scope, claim, operation, args, async () => false, signal);
    }
    if (this.externalRouter) {
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
    const tabMention = input.tabMention;
    if (tabMention !== undefined && typeof tabMention !== 'string') throw new Error('Invalid browser tab mention');
    const args = { ...input };
    delete args.tabMention;
    if (this.embeddedBridge && this.embeddedRouter) {
      let claim;
      if (typeof tabMention === 'string') {
        claim = await this.embeddedBridge.resolveMention(tabMention);
        this.embeddedRouter.selectClaim(scope, claim);
      } else {
        await this.embeddedBridge.refresh();
        claim = this.embeddedRouter.select(scope,
          this.sessions.has(browserScopeKey(scope)) || this.creations.has(browserScopeKey(scope)));
      }
      if (claim) {
        await this.embeddedRouter.authorizeCurrent(scope, claim);
        const result = await this.embeddedBridge.command(claim, 'authRequest', args, signal ?? undefined);
        if (!result || typeof result !== 'object' || typeof (result as { status?: unknown }).status !== 'string') {
          throw new Error('Invalid browser auth response');
        }
        return JSON.stringify(result);
      }
    }
    if (tabMention !== undefined || !this.externalRouter) return JSON.stringify({ status: 'unavailable' });
    const claim = this.externalRouter.select(scope,
      this.sessions.has(browserScopeKey(scope)) || this.creations.has(browserScopeKey(scope)));
    if (!claim) return JSON.stringify({ status: 'unavailable' });
    await this.externalRouter.authorizeCurrent(scope, claim);
    const result = await externalBrowserBridge.command(claim, 'authRequest', args, signal ?? undefined);
    if (!result || typeof result !== 'object' || typeof (result as { status?: unknown }).status !== 'string') {
      throw new Error('Invalid browser auth response');
    }
    return JSON.stringify(result);
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
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    let connection: InMemoryMcpConnection | null = null;
    let outputDir: string | null = null;
    try {
      const runtime = await this.runtimeLoader();
      if (!runtime.executablePath || !fs.existsSync(runtime.executablePath)) {
        await this.loadDefinitionsWithoutBrowser(runtime);
        this.runtime = runtime;
        this.executablePath = runtime.executablePath || null;
        const preparationState = this.preparationStateLoader();
        this.capability = preparationState?.status === "preparing"
          || this.desktopManaged
          ? "preparing"
          : "unavailable";
        return this.capability;
      }
      browser = await runtime.chromium.launch({
        headless: true,
        executablePath: runtime.executablePath,
      });
      context = await browser.newContext();
      outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-browser-probe-"));
      const server = await runtime.createConnection(
        this.connectionConfig(outputDir),
        async () => context!,
      );
      connection = await connectInMemoryMcpServer(server);
      const listed = await connection.client.listTools();
      this.captureDefinitions(listed.tools ?? []);
      this.runtime = runtime;
      this.executablePath = runtime.executablePath;
      this.capability = "ready";
      return this.capability;
    } catch {
      this.capability = "unavailable";
      return this.capability;
    } finally {
      await connection?.close().catch(() => undefined);
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
      if (outputDir) fs.rmSync(outputDir, { recursive: true, force: true });
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
            void this.downloadStore?.save(download, page.url()).catch(() => undefined);
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

  async callTool(
    scope: BrowserScope,
    name: BrowserToolName,
    params: Record<string, any>,
    abortSignal: AbortSignal | null = null,
    localPreviewContext: BrowserLocalPreviewContext | null = null,
  ): Promise<string | Array<Record<string, any>>> {
    const tabMention = params.tabMention;
    const disposition = params.tabDisposition;
    if (tabMention !== undefined && typeof tabMention !== 'string') throw new Error('Invalid browser tab mention');
    if (disposition !== undefined && disposition !== 'deliverable' && disposition !== 'handoff') {
      throw new Error('Invalid browser tab disposition');
    }
    const browserParams = { ...params };
    delete browserParams.tabMention;
    delete browserParams.tabDisposition;
    if (tabMention !== undefined) {
      if (!this.config.enabled) throw new Error('Browser tools are disabled');
      if (!this.embeddedBridge || !this.embeddedRouter) throw new Error('Mentioned Memmy browser is unavailable');
      const claim = await this.embeddedBridge.resolveMention(tabMention);
      if (name === 'browser_file_upload') await this.verifyEmbeddedUpload(claim.tabId, browserParams,
        localPreviewContext?.workspace);
      const selected = this.embeddedRouter.selectClaim(scope, claim);
      const result = await this.embeddedRouter.call(scope, selected, name, browserParams, abortSignal);
      if (disposition) this.embeddedRouter.markTab(scope, disposition);
      return result;
    }
    if (this.config.enabled && this.embeddedBridge && this.embeddedRouter && !abortSignal?.aborted) {
      const key = browserScopeKey(scope);
      const tab = await this.embeddedBridge.refresh().catch(() => null);
      const hasManagedSession = this.sessions.has(key) || this.creations.has(key);
      const targetUrl = name === 'browser_navigate' ? String(params.url ?? '') : '';
      if ((tab && !targetUrl) || this.embeddedRouter.hasBinding(scope)) {
        const embedded = this.embeddedRouter.select(scope, hasManagedSession);
        if (embedded) {
          if (name === 'browser_file_upload') await this.verifyEmbeddedUpload(embedded.tabId, browserParams,
            localPreviewContext?.workspace);
          const result = await this.embeddedRouter.call(scope, embedded, name, browserParams, abortSignal);
          if (disposition) this.embeddedRouter.markTab(scope, disposition);
          return result;
        }
      }
    }
    if (this.config.enabled && this.externalRouter && !abortSignal?.aborted) {
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
        return this.externalRouter.call(scope, external, name, browserParams, abortSignal);
      }
    }
    if (this.config.enabled && this.embeddedBridge && this.embeddedRouter
      && name === 'browser_navigate' && !abortSignal?.aborted && !this.embeddedRouter.hasBinding(scope)
      && !this.sessions.has(browserScopeKey(scope)) && !this.creations.has(browserScopeKey(scope))) {
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
        approved.add(targetOrigin);
        const opened = await this.embeddedBridge.openTab(targetUrl);
        if (!opened) throw new Error('Memmy browser tab did not open');
        const selected = this.embeddedRouter.selectClaim(scope, opened,
          { allowedOrigins: approved, agentCreated: true });
        const result = await this.embeddedRouter.call(scope, selected, name, browserParams);
        if (disposition) this.embeddedRouter.markTab(scope, disposition);
        return result;
      }
    }
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
            callParams = { ...params, url: candidatePreview.url };
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
            ? await withMacFocusGuard('com.google.chrome.for.testing', name, invoke,
              undefined, { blockWhenTargetForeground: true })
            : await invoke();
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
    this.embeddedRouter?.closeSession(scope);
    this.externalRouter?.closeSession(scope);
    const key = browserScopeKey(scope);
    await this.creations.get(key)?.catch(() => undefined);
    await this.closeByKey(key);
  }

  async closeChat(channel: string, chatId: string): Promise<void> {
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
    const embeddedScopes = browserScopeKey(scope) === browserScopeKey(projectedScope)
      ? [scope] : [scope, projectedScope];
    await Promise.allSettled(embeddedScopes.map(item => this.embeddedRouter?.finishTurn(item)));
    this.externalRouter?.closeSurfacesForTurn(scope);
    if (browserScopeKey(scope) !== browserScopeKey(projectedScope)) {
      this.externalRouter?.closeSurfacesForTurn(projectedScope);
    }
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
    return ctx.browserSessionManager?.supportsEmbeddedTabs() === true;
  }

  static create(ctx: any): BrowserListTabsTool {
    return new BrowserListTabsTool(ctx.browserSessionManager);
  }

  get name(): string { return 'browser_list_tabs'; }
  get description(): string {
    return 'List open Memmy in-app browser tabs and the selected tab. Web pages include exact references; about:blank has a null reference and cannot be addressed by browser actions. This does not open or navigate a page.';
  }
  get parameters(): Record<string, any> { return { type: 'object', properties: {}, additionalProperties: false }; }
  override get readOnly(): boolean { return true; }

  setContext(context: RequestContext): void { this.requestContext.set(context); }

  async execute(): Promise<string> {
    const request = this.requestContext.get();
    if (!request?.sessionKey?.trim() || !request.channel?.trim()
        || !request.chatId?.trim() || !request.workspace?.trim()) {
      throw new Error('browser tool requires a trusted chat context');
    }
    return this.manager.listEmbeddedTabs();
  }
}

/** History is read only from the desktop's in-app webview store after a visible host approval. */
export class BrowserHistoryTool extends Tool {
  static scopes = new Set(['core']);
  private readonly requestContext = new RequestContextStore();

  constructor(private readonly manager: BrowserSessionManager) { super(); }
  static enabled(ctx: any): boolean { return ctx.browserSessionManager?.supportsEmbeddedTabs() === true; }
  static create(ctx: any): BrowserHistoryTool { return new BrowserHistoryTool(ctx.browserSessionManager); }
  get name(): string { return 'browser_history'; }
  get description(): string {
    return 'Search only the Memmy in-app browser history when the current task needs it. Specify a keyword and an ISO 8601 time range of at most 30 days. Each call asks the user in a desktop approval dialog; use at most once per assistant turn. This does not read Chrome, Edge, or Computer History.';
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
      throw new Error('Browser CDP operations require a current interactive desktop chat');
    }
    return request.browserScope ?? { sessionKey: request.sessionKey, channel: request.channel, chatId: request.chatId };
  }
}

export class BrowserCdpSendTool extends BrowserCdpReadTool {
  get name(): string { return 'browser_cdp_read'; }
  get description(): string {
    return 'Read the current selected or claimed browser tab with a restricted CDP method. Only read-only methods are accepted; each call follows the Debug / CDP site rule and may require a visible approval.';
  }
  get parameters(): Record<string, any> { return { type: 'object', properties: {
    method: { type: 'string', enum: ['Accessibility.getFullAXTree', 'DOM.getDocument',
      'Page.getLayoutMetrics', 'Page.captureScreenshot', 'Runtime.evaluate'] },
    params: { type: 'object', description: 'Method parameters; Runtime.evaluate is forced to throw on side effects.' },
    target: { type: 'object', description: 'Optional attached child target of the current approved tab: sessionId or targetId.',
      properties: { sessionId: { type: 'string' }, targetId: { type: 'string' } }, additionalProperties: false },
    timeoutMs: { type: 'integer', minimum: 0, maximum: 30000,
      description: 'Maximum CDP command wait in milliseconds; defaults to 3000.' },
    tabMention: { type: 'string', description: 'Exact selected Memmy browser tab mention when supplied by the user.' },
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
    tabMention: { type: 'string', description: 'Exact selected Memmy browser tab mention when supplied by the user.' },
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
    tabMention: { type: 'string', description: 'Exact selected Memmy browser tab mention when supplied by the user.' },
  }, required: ['method'], additionalProperties: false }; }
  async execute(params: Record<string, any> = {}, context?: ToolExecutionContext): Promise<string> {
    return this.manager.callCdp(this.scope(), 'cdpWrite', params, context?.abortSignal);
  }
}

export class BrowserAuthRequestTool extends BrowserCdpReadTool {
  static enabled(ctx: any): boolean { return ctx.browserSessionManager?.supportsCdpTabs() === true; }
  get name(): string { return 'browser_auth_request'; }
  get description(): string {
    return 'Ask the user through a secure form for sign-in fields on the selected Memmy or connected Chrome/Edge tab. Pass only inspected, visible field metadata and exact CSS selectors. Passwords and codes never appear in tool results or chat. The browser client validates the form, fills it and optionally submits it; a submitted status does not prove sign-in. Do not use for signup or CAPTCHA. After submission, explicitly navigate to the retained site origin before inspecting the page.';
  }
  override get readOnly(): boolean { return false; }
  get parameters(): Record<string, any> { return { type: 'object', properties: {
    origin: { type: 'string', description: 'Canonical current HTTP(S) origin only, with no path or query.' },
    frame: { type: 'string', description: 'Optional exact CSS selector for one iframe containing every requested sign-in control, including cross-origin frames.' },
    frames: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string' },
      description: 'Optional chain of exact iframe CSS selectors from the top document to the sign-in form; do not combine with frame.' },
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
    tabMention: { type: 'string', description: 'Exact selected Memmy browser tab mention when supplied by the user.' },
  }, required: ['origin', 'fields'], additionalProperties: false }; }
  async execute(params: Record<string, any> = {}, context?: ToolExecutionContext): Promise<string> {
    return this.manager.requestBrowserAuth(this.scope(), params, context?.abortSignal);
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
  BrowserHistoryTool,
  BrowserCdpSendTool,
  BrowserCdpEventsTool,
  BrowserCdpWriteTool,
  BrowserAuthRequestTool,
];
