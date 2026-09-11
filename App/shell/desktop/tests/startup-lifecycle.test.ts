import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveStartupSplashHtml, resolveUpdateSplashHtml } from "../src/main/startup-splash.js";

// Execute the real startup/window callbacks without importing Electron or starting user services.
// The AST extraction keeps the race tests tied to main.ts rather than a copy of its implementation.
const source = ts.createSourceFile("main.ts", readFileSync(new URL("../src/main/main.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const functionNames = new Set([
  "boot", "showSplashWindow", "showUpdateInstallSplashWindow", "showSplashHtml", "closeSplashWindow",
  "createInitialWindow", "createMainWindow", "showPetWindowAfterRendererLayout", "hideAppShellForQuit",
  "watchStartupRenderer", "handleStartupFailure", "handleRendererLoadFailure"
]);
const variableNames = new Set([
  "mainWindow", "petWindow", "runtimeServices", "runtimeConfig", "isBootReady", "isQuitting",
  "isQuitCleanupInProgress", "isQuitCleanupComplete", "stopMemoryServiceForCurrentQuit",
  "splashWindow", "splashCloseTimer", "splashTimer", "SPLASH_MAX_VISIBLE_MS", "STARTUP_SLOW_MS",
  "UPDATE_SPLASH_MAX_VISIBLE_MS", "bootStage", "bootStartedAt", "isPetWindowReadyToShow",
  "latestPetWindowLayout", "petMascotScreenAnchor", "startupRendererCleanup", "STARTUP_RENDERER_TIMEOUT_MS",
  "isStartupFailureReported", "localBackend"
]);
const selected = source.statements.filter(statement => {
  if (ts.isFunctionDeclaration(statement)) return functionNames.has(statement.name?.text ?? "");
  if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.some(declaration => variableNames.has(declaration.name.getText(source)));
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false;
  const call = statement.expression;
  return call.expression.getText(source) === "app.on"
    && ["window-all-closed", "before-quit"].includes((call.arguments[0] as ts.StringLiteral)?.text);
});
const readyStatement = source.statements.find(statement => ts.isExpressionStatement(statement)
  && statement.expression.getText(source).startsWith("app.whenReady().then(")) as ts.ExpressionStatement;
const failureHandler = (readyStatement.expression as ts.CallExpression).arguments[0]!.getText(source);
const code = ts.transpileModule([
  ...selected.map(statement => statement.getText(source)),
  `globalThis.start = () => boot().catch(${failureHandler});`
].join("\n").replaceAll("import.meta.dirname", '"test-main-directory"'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText;

function setup(options: { delay?: number; error?: Error; apiError?: Error; cleanupHangs?: boolean; platform?: string; mode?: "full" | "pet" } = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const events: string[] = [];
  const windows = new Set<FakeWindow>();
  const app = new EventEmitter() as EventEmitter & Record<string, any>;
  let context: ReturnType<typeof createContext>;
  class FakeWindow extends EventEmitter {
    destroyed = false;
    visible: boolean;
    urls: string[] = [];
    webContents = new EventEmitter();
    constructor(settings: { show?: boolean } = {}) {
      super();
      this.visible = settings.show !== false;
      windows.add(this);
    }
    static getAllWindows() { return [...windows]; }
    isDestroyed() { return this.destroyed; }
    show() { this.visible = true; }
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
    loadURL(url: string) { this.urls.push(url); return Promise.resolve(); }
    close() {
      const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      this.emit("close", event);
      if (!event.defaultPrevented) this.destroy();
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      windows.delete(this);
      this.emit("closed");
      if (windows.size === 0) app.emit("window-all-closed");
    }
  }
  const services = { close: vi.fn(() => options.cleanupHangs ? new Promise<void>(() => {}) : Promise.resolve()) };
  const quit = vi.fn(() => {
    events.push("quit");
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    app.emit("before-quit", event);
  });
  Object.assign(app, { quit, getPath: () => "test-user-data", getAppPath: () => "test-app", isPackaged: true });
  const noop = () => {};
  context = createContext({
    app, BrowserWindow: FakeWindow, process: { platform: options.platform ?? "win32", env: {}, resourcesPath: "test-resources" },
    console: { warn: vi.fn(), error: vi.fn() }, Date, setTimeout, clearTimeout,
    join: (...parts: string[]) => parts.join("/"),
    writePackagedStartupLog: async (message: string) => { events.push(message); },
    formatStartupError: (error: Error) => error.message,
    showPackagedStartupError: () => { events.push("error-dialog"); },
    resolveCurrentDesktopEdition: () => "cn", initLogger: noop, forceLightWindowChrome: noop,
    installPreparedRequiredUpdateBeforeBoot: async () => false,
    registerIpcHandlers: noop, installBundledCliIfNeeded: async () => {}, startPackagedRendererServerIfNeeded: async () => {},
    windowsDataLayout: null,
    startManagedRuntimeServices: async () => {
      if (options.delay) await new Promise(resolve => setTimeout(resolve, options.delay));
      if (options.error) throw options.error;
      return services;
    },
    startLocalApi: async () => { if (options.apiError) throw options.apiError; return {}; },
    triggerAgentSourceAutoInject: noop, getCurrentLogLevel: () => "info",
    setDevelopmentDockIcon: noop, startRequiredUpdateBackgroundChecks: noop,
    pruneUpdatesDirectory: noop, pruneWindowsLegacyUpdateCaches: noop, UPDATES_PRUNE_STARTUP_DELAY_MS: 999_999,
    syncMenuBarTray: noop, resolveMenuBarIconEnabled: () => false,
    resolveCurrentStartupSplashLanguage: () => "zh-CN", resolveStartupSplashHtml, resolveUpdateSplashHtml,
    resolveInitialWindowMode: () => options.mode ?? "full",
    setPetWindowMode: () => { context.testPet = new FakeWindow({ show: false }); runInContext("petWindow = testPet", context); },
    configurePetWindowPriority: noop, applyPetWindowBounds: noop,
    resolveWindowsTaskbarIconPath: () => undefined, fullWindowOptions: {}, resolveFullWindowChromeOptions: () => ({}),
    resolveFullWindowSize: () => ({}), screen: { getPrimaryDisplay: () => ({ workArea: {} }) }, createWebPreferences: () => ({}),
    hideInWindowMenuBar: noop, updateFullWindowButtonPosition: noop, attachWindowOpenHandler: noop,
    attachRendererContextMenu: noop, attachRendererShortcutGuards: noop, attachMainWindowFullScreenSync: noop,
    handleMainWindowClose: noop, handleMainWindowMinimize: noop, resolveRendererUrl: () => "http://test-renderer.invalid",
    shouldIgnoreStaleReopenQuit: () => false, hasSingleInstanceLock: true,
    readStopMemoryServiceOnExitSetting: () => false, armQuitCleanupForceExitTimer: noop,
    cleanupBeforeQuit: async () => {}, clearQuitCleanupForceExitTimer: noop, relaunchAfterQuitCleanupIfRequested: noop
  });
  runInContext(code, context);
  return {
    events, app, quit, services,
    start: () => context.start() as Promise<void>,
    run: (code: string) => runInContext(code, context),
    splash: () => runInContext("splashWindow", context) as FakeWindow | null,
    main: () => runInContext("mainWindow", context) as FakeWindow | null,
    pet: () => runInContext("petWindow", context) as FakeWindow | null
  };
}

afterEach(() => vi.useRealTimers());

describe("desktop startup lifecycle", () => {
  it("keeps the startup splash and process alive while runtime startup takes 20 seconds", async () => {
    const test = setup({ delay: 20_000 });
    const boot = test.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(test.quit).not.toHaveBeenCalled();
    expect(test.splash()?.isDestroyed()).toBe(false);
    expect(test.splash()?.urls.at(-1)).toContain(encodeURIComponent("启动时间较长"));
    expect(test.events.some(event => event.startsWith("boot:slow"))).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    await boot;
    expect(test.main()).not.toBeNull();
    test.main()!.emit("ready-to-show");
    expect(test.splash()).toBeNull();
    expect(test.quit).not.toHaveBeenCalled();
    expect(test.events).toContain("boot:ready");
  });

  it("does not treat losing the only splash as a user-requested quit during boot", () => {
    const test = setup();
    test.run("showSplashWindow()");
    test.splash()!.destroy();
    expect(test.quit).not.toHaveBeenCalled();
  });

  it("closes a fast startup splash on renderer load and cancels the slow-start notice", async () => {
    const test = setup();
    await test.start();
    test.main()!.webContents.emit("did-finish-load");
    expect(test.splash()).toBeNull();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(test.events.some(event => event.startsWith("boot:slow"))).toBe(false);
    expect(test.quit).not.toHaveBeenCalled();
  });

  it("keeps the pet startup splash until the renderer layout makes the pet visible", async () => {
    const test = setup({ mode: "pet" });
    await test.start();
    expect(test.pet()?.visible).toBe(false);
    expect(test.splash()).not.toBeNull();
    test.run("latestPetWindowLayout = {}; petMascotScreenAnchor = {}; showPetWindowAfterRendererLayout()");
    expect(test.pet()?.visible).toBe(true);
    expect(test.splash()).toBeNull();
    expect(test.quit).not.toHaveBeenCalled();
  });

  it("records and displays a boot error before requesting quit", async () => {
    const test = setup({ error: new Error("runtime startup failed") });
    await test.start();
    expect(test.events.indexOf("boot:error\nruntime startup failed")).toBeLessThan(test.events.indexOf("quit"));
    expect(test.events.indexOf("error-dialog")).toBeLessThan(test.events.indexOf("quit"));
    expect(test.splash()).toBeNull();
    expect(test.quit).toHaveBeenCalled();
  });

  it("honors explicit quit during slow boot without showing a late main window", async () => {
    const test = setup({ delay: 20_000 });
    const boot = test.start();
    await vi.advanceTimersByTimeAsync(1_000);
    test.app.quit();
    await vi.advanceTimersByTimeAsync(19_000);
    await boot;
    expect(test.quit).toHaveBeenCalled();
    expect(test.main()).toBeNull();
    expect(test.services.close).toHaveBeenCalled();
    expect(test.events.some(event => event.startsWith("boot:slow"))).toBe(false);
  });

  it("treats a native close of the startup splash as explicit quit", async () => {
    const test = setup({ delay: 20_000 });
    const boot = test.start();
    await vi.advanceTimersByTimeAsync(1_000);
    test.splash()!.close();
    expect(test.quit).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(19_000);
    await boot;
    expect(test.main()).toBeNull();
  });

  it("reports local API failure without waiting for runtime cleanup to settle", async () => {
    const test = setup({ apiError: new Error("local API failed"), cleanupHangs: true });
    void test.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(test.events).toContain("boot:error\nlocal API failed");
    expect(test.events).toContain("error-dialog");
    expect(test.quit).toHaveBeenCalled();
  });

  it("starts the renderer deadline only after slow runtime startup has finished", async () => {
    const test = setup({ delay: 40_000, mode: "pet" });
    const boot = test.start();
    await vi.advanceTimersByTimeAsync(40_000);
    await boot;
    expect(test.quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(test.quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(test.events.some(event => event.startsWith("boot:error\n") && event.includes("30000"))).toBe(true);
    expect(test.events).toContain("error-dialog");
    expect(test.splash()).toBeNull();
    expect(test.quit).toHaveBeenCalled();
  });

  it.each(["full", "pet"] as const)("reports a %s renderer failure and cancels its timeout", async mode => {
    const test = setup({ mode });
    await test.start();
    const window = mode === "pet" ? test.pet()! : test.main()!;
    window.webContents.emit("did-fail-load", {}, -105, "NAME_NOT_RESOLVED", "http://test-renderer.invalid", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(test.events.some(event => event.startsWith("boot:error\n") && event.includes("NAME_NOT_RESOLVED"))).toBe(true);
    expect(test.splash()).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(test.events.filter(event => event.startsWith("boot:error\n"))).toHaveLength(1);
  });

  it("reports a renderer crash before the pet is visible", async () => {
    const test = setup({ mode: "pet" });
    await test.start();
    test.pet()!.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(test.events.some(event => event.startsWith("boot:error\n") && event.includes("crashed"))).toBe(true);
    expect(test.quit).toHaveBeenCalled();
  });

  it("ignores subframe load failures and aborted navigation during startup", async () => {
    const test = setup();
    await test.start();
    test.main()!.webContents.emit("did-fail-load", {}, -105, "NAME_NOT_RESOLVED", "http://test.invalid", false);
    test.main()!.webContents.emit("did-fail-load", {}, -3, "ERR_ABORTED", "http://test.invalid", true);
    test.main()!.emit("ready-to-show");
    await vi.advanceTimersByTimeAsync(40_000);
    expect(test.quit).not.toHaveBeenCalled();
  });

  it("preserves the update splash's separate 60-second timeout", async () => {
    const test = setup();
    test.run("showUpdateInstallSplashWindow('1.1.3')");
    await vi.advanceTimersByTimeAsync(59_999);
    expect(test.splash()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(test.splash()).toBeNull();
    expect(test.events.some(event => event.startsWith("boot:slow"))).toBe(false);
  });

  it.each(["win32", "linux", "darwin"])("preserves %s close behavior after boot", async platform => {
    const test = setup({ platform });
    await test.start();
    test.main()!.emit("ready-to-show");
    test.main()!.close();
    if (platform === "darwin") expect(test.quit).not.toHaveBeenCalled();
    else expect(test.quit).toHaveBeenCalled();
  });
});
