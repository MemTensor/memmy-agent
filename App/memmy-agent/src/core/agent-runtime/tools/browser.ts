import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Browser, BrowserContext } from "playwright";
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
  configurePlaywrightBrowsersPath,
  resolveManagedChromium,
} from "./browser-setup.js";

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
] as const;

export type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number];
export type BrowserCapability = "unknown" | "ready" | "disabled" | "unavailable";
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
  mutex: AsyncMutex;
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
  private readonly restrictLocalFiles: boolean;
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

  constructor(
    config: BrowserToolsConfig | Record<string, any>,
    {
      runtimeLoader = defaultRuntimeLoader,
      restrictLocalFiles = false,
    }: {
      runtimeLoader?: BrowserRuntimeLoader;
      restrictLocalFiles?: boolean;
    } = {},
  ) {
    this.config = normalizeBrowserConfig(config);
    this.runtimeLoader = runtimeLoader;
    this.restrictLocalFiles = restrictLocalFiles;
    if (!this.config.enabled) this.capability = "disabled";
  }

  definition(name: BrowserToolName): BrowserToolDefinition | null {
    const definition = this.definitions.get(name);
    return definition ? structuredClone(definition) : null;
  }

  initialize(): Promise<BrowserCapability> {
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = this.probe();
    return this.initializePromise;
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
        this.capability = "unavailable";
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
      const byName = new Map(
        (listed.tools ?? []).map((tool: any) => [String(tool.name), tool]),
      );
      if (BROWSER_TOOL_NAMES.some((name) => !byName.has(name))) {
        this.capability = "unavailable";
        return this.capability;
      }
      this.definitions = new Map(
        BROWSER_TOOL_NAMES.map((name) => [
          name,
          narrowBrowserToolDefinition(byName.get(name)),
        ]),
      );
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
        headless: true,
        executablePath: this.executablePath,
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
      context = await browser.newContext();
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
        mutex: new AsyncMutex(),
      };
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

  async callTool(
    scope: BrowserScope,
    name: BrowserToolName,
    params: Record<string, any>,
    abortSignal: AbortSignal | null = null,
    localPreviewContext: BrowserLocalPreviewContext | null = null,
  ): Promise<string | Array<Record<string, any>>> {
    if (!this.definitions.has(name)) throw new Error(`browser tool '${name}' is unavailable`);
    const navigateTarget: BrowserNavigateTarget | null = name === "browser_navigate"
      ? classifyBrowserNavigateTarget(String(params.url ?? ""))
      : null;
    const session = await this.acquireSession(scope);
    try {
      return await session.mutex.runExclusive(async () => {
        let candidatePreview: BrowserPreviewLease | null = null;
        try {
          if (session.closed) throw new Error("browser session closed");
          if (abortSignal?.aborted) {
            const error = new Error("browser tool call cancelled");
            error.name = "AbortError";
            throw error;
          }
          session.lastUsedAt = Date.now();
          let callParams = params;
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
          }
          const result = await session.connection.client.callTool(
            { name, arguments: callParams },
            undefined,
            {
              signal: abortSignal ?? undefined,
              timeout: 70_000,
              maxTotalTimeout: 70_000,
            },
          );
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
          return convertMcpToolContent(result, "structured");
        } catch (error) {
          await candidatePreview?.close().catch(() => undefined);
          if (abortSignal?.aborted || (error as Error).name === "AbortError") {
            await this.closeByKey(session.key);
          }
          throw error;
        }
      });
    } finally {
      session.pendingCalls = Math.max(0, session.pendingCalls - 1);
    }
  }

  async closeSession(scope: BrowserScope): Promise<void> {
    const key = browserScopeKey(scope);
    await this.creations.get(key)?.catch(() => undefined);
    await this.closeByKey(key);
  }

  async closeChat(channel: string, chatId: string): Promise<void> {
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
    return ctx.browserSessionManager?.capability === "ready";
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
    return this.manager.callTool(
      { sessionKey, channel, chatId },
      this.name as BrowserToolName,
      params,
      context?.abortSignal ?? null,
      {
        workspace,
        readonlyRoots: this.readonlySkillRoots,
      },
    );
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
];
