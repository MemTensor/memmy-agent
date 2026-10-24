import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isMacPermissionSystemQuit, isMacSystemSessionQuit, MacPermissionRestartIntent,
  type MacPermissionQuitContext } from "../src/main/mac-permission-quit.js";

// Exercise the real Electron callbacks and restart policy without starting Electron or services.
const source = ts.createSourceFile("main.ts", readFileSync(new URL("../src/main/main.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const functionNames = new Set([
  "captureMacPermissionRestartRequest", "shouldIgnoreStaleReopenQuit", "relaunchAfterQuitCleanupIfRequested",
  "armQuitCleanupForceExitTimer", "clearQuitCleanupForceExitTimer",
  "isMacSystemSessionEnding", "readMacSystemSessionProbe", "readMacQuitContext",
]);
const variableNames = new Set([
  "isQuitting", "isQuitCleanupInProgress", "isQuitCleanupComplete", "stopMemoryServiceForCurrentQuit",
  "quitCleanupForceExitTimer", "APP_QUIT_CLEANUP_FORCE_EXIT_DELAY_MS", "MACOS_STALE_REOPEN_QUIT_GRACE_MS",
  "hasSingleInstanceLock", "didWaitForSingleInstanceLock", "hasIgnoredStaleReopenQuit",
  "shouldRelaunchAfterQuitCleanup", "appProcessStartedAt",
  "macPermissionRestartIntent", "isMacSystemQuitInProgress", "hasCapturedMacPermissionRestart",
  "permissionQuitNotificationSequence", "permissionQuitSameDispatch",
  "MACOS_PERMISSION_RELAUNCH_ARG", "wasMacPermissionRelaunch",
]);
const selected = source.statements.filter((statement) => {
  if (ts.isFunctionDeclaration(statement)) return functionNames.has(statement.name?.text ?? "");
  if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.some((declaration) => variableNames.has(declaration.name.getText(source)));
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false;
  const call = statement.expression;
  return call.expression.getText(source) === "app.on"
    && ["before-quit", "activate"].includes((call.arguments[0] as ts.StringLiteral)?.text);
});
const code = ts.transpileModule(selected.map((statement) => statement.getText(source)).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const cleanupFunction = source.statements.find((statement) => ts.isFunctionDeclaration(statement)
  && statement.name?.text === "cleanupBeforeQuit")!;
const actualCleanupCode = ts.transpileModule(cleanupFunction.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

const systemQuit: MacPermissionQuitContext = {
  eventClass: "aevt",
  eventId: "quit",
  senderBundleId: "com.apple.systempreferences",
  senderExecutablePath: "/System/Applications/System Settings.app/Contents/MacOS/System Settings",
  quitReason: null,
};
const userQuit: MacPermissionQuitContext = { ...systemQuit, senderBundleId: "com.memmy.desktop", senderExecutablePath: "/Applications/Memmy.app/Contents/MacOS/Memmy" };
const permissionRelaunch: MacPermissionQuitContext = { ...systemQuit,
  senderBundleId: "com.apple.settings.PrivacySecurity.extension",
  senderExecutablePath: "/System/Library/ExtensionKit/Extensions/SecurityPrivacyExtension.appex/Contents/MacOS/SecurityPrivacyExtension",
  quitReason: "rlgo" };
const loginwindowQuit: MacPermissionQuitContext = { ...systemQuit,
  senderBundleId: "com.apple.loginwindow",
  senderExecutablePath: "/System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow",
  quitReason: "rlgo" };

function setup(options: {
  platform?: NodeJS.Platform;
  quitContext?: MacPermissionQuitContext | null;
  oneShotQuitContext?: boolean;
  nativeError?: Error;
  nativeUnavailable?: boolean;
  waitedForLock?: boolean;
  ownsLock?: boolean;
  permissionRequested?: boolean;
  systemSessionEnding?: boolean;
  nativeSessionUnavailable?: boolean;
  nativeObserverUnavailable?: boolean;
  nativeSessionError?: Error;
  relaunchMarker?: boolean;
  argv?: string[];
  actualCleanup?: boolean;
} = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const app = new EventEmitter() as EventEmitter & {
    quit: ReturnType<typeof vi.fn>;
    exit: ReturnType<typeof vi.fn>;
    relaunch: ReturnType<typeof vi.fn>;
    requestSingleInstanceLock: ReturnType<typeof vi.fn>;
  };
  const logs: string[] = [];
  const events: string[] = [];
  let completeCleanup!: () => void;
  let failCleanup!: (error: Error) => void;
  const cleanup = new Promise<void>((resolve, reject) => { completeCleanup = resolve; failCleanup = reject; });
  const cleanupBeforeQuit = vi.fn(() => cleanup);
  const closeServices = vi.fn(() => cleanup);
  const terminateSync = vi.fn(() => events.push("terminate"));
  const stopComputerUseAgentsOnExitSync = vi.fn();
  const stopComputerUseAgentForPermissionRestart = vi.fn().mockResolvedValue(undefined);
  const installPreparedRequiredUpdateOnQuit = vi.fn().mockResolvedValue(undefined);
  let quitContext = options.quitContext === undefined ? systemQuit : options.quitContext;
  let systemSessionEnding: boolean | undefined = options.nativeSessionUnavailable ? undefined : options.systemSessionEnding ?? false;
  let notificationSequence = systemSessionEnding === true ? 1 : 0;
  let quitContextRead = false;
  const readCurrentQuitContext = vi.fn(() => {
    if (options.nativeError) throw options.nativeError;
    if (options.oneShotQuitContext && quitContextRead) return null;
    quitContextRead = true;
    return quitContext;
  });
  const readSystemSessionEnding = vi.fn(() => {
    if (options.nativeSessionError) throw options.nativeSessionError;
    return systemSessionEnding;
  });
  const readSystemSessionEndingState = vi.fn(() => {
    if (options.nativeSessionError) throw options.nativeSessionError;
    if (systemSessionEnding === undefined) return undefined;
    return { mainThread: true, observerInstalled: !options.nativeObserverUnavailable,
      notificationRecent: systemSessionEnding,
      notificationSequence, notificationAgeMs: systemSessionEnding ? 100 : null };
  });
  const loadMenuBarAppearanceNative = vi.fn(() => options.nativeUnavailable ? null
    : { readCurrentQuitContext, readSystemSessionEnding, readSystemSessionEndingState });
  const policy = vi.fn(isMacPermissionSystemQuit);
  const requestQuit = () => {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    app.emit("before-quit", event);
    if (!event.defaultPrevented) events.push("quit");
    return event;
  };
  Object.assign(app, {
    isPackaged: true,
    requestSingleInstanceLock: vi.fn(() => options.ownsLock !== false),
    quit: vi.fn(requestQuit),
    relaunch: vi.fn(() => events.push("relaunch")),
    exit: vi.fn(() => events.push("exit")),
  });
  const context = createContext({
    app,
    process: { platform: options.platform ?? "darwin", env: {}, resourcesPath: "/Applications/Memmy.app/Contents/Resources",
      argv: options.argv ?? ["Memmy", ...(options.relaunchMarker ? ["--memmy-permission-relaunch"] : [])] },
    Date, setTimeout, clearTimeout, queueMicrotask,
    console: { warn: vi.fn() },
    loadMenuBarAppearanceNative,
    isMacPermissionSystemQuit: policy,
    isMacSystemSessionQuit, MacPermissionRestartIntent,
    writePackagedStartupLog: async (message: string) => { logs.push(message); },
    closeSplashWindow: vi.fn(), hideAppShellForQuit: vi.fn(),
    readStopMemoryServiceOnExitSetting: () => false,
    cleanupBeforeQuit, runtimeServices: { terminateSync, close: closeServices },
    stopComputerUseAgentsOnExitSync, stopComputerUseAgentForPermissionRestart,
    requiredUpdateBackgroundFirstCheckTimer: null, requiredUpdateBackgroundCheckTimer: null,
    pendingMainWindowAction: null, memoryServiceControl: null, localBackend: null,
    browserWebviewDownloads: null, disposeBrowserWebviewPermissions: null, browserSidebarBridge: null,
    pipScreenPermissionGuide: null, computerUseSurfaceWindows: null, areIpcHandlersRegistered: true,
    ipcMain: { removeHandler: vi.fn(), removeListener: vi.fn(), removeAllListeners: vi.fn() },
    clearPetWindowCloseActivateSuppression: vi.fn(), closePetWindow: vi.fn(),
    installPreparedRequiredUpdateOnQuit, destroyMenuBarTray: vi.fn(),
    embeddedBrowserDriver: { dispose: vi.fn() }, stopPackagedRendererServer: vi.fn().mockResolvedValue(undefined),
    sendAppExitEventBeforeQuit: vi.fn().mockResolvedValue(undefined),
    EXTERNAL_BROWSER_EXTENSION_DRAG_CHANNEL: "test-browser-drag",
    handleComputerHistoryTrayIndicator: vi.fn(), handleMovePetWindow: vi.fn(), handleStartPetWindowDrag: vi.fn(),
    handleStopPetWindowDrag: vi.fn(), handleUpdatePetWindowLayout: vi.fn(), handleAnalyticsClientId: vi.fn(),
    formatStartupError: (error: Error) => error.message,
    isBootReady: true,
    consumePetWindowCloseActivateSuppression: () => false,
    activateMainWindow: vi.fn(),
  });
  runInContext(code, context);
  if (options.actualCleanup) runInContext(actualCleanupCode, context);
  if (options.waitedForLock) runInContext("didWaitForSingleInstanceLock = true", context);
  const beginGuide = () => runInContext("macPermissionRestartIntent.begin()", context) as number;
  const finishGuide = (token: number, approved: boolean) => runInContext(`macPermissionRestartIntent.finish(${token}, ${approved})`, context);
  if (options.permissionRequested) beginGuide();
  return {
    app, logs, events, readCurrentQuitContext, readSystemSessionEnding, readSystemSessionEndingState,
    loadMenuBarAppearanceNative, policy,
    cleanupBeforeQuit, closeServices, terminateSync, requestQuit, completeCleanup, failCleanup,
    stopComputerUseAgentsOnExitSync, stopComputerUseAgentForPermissionRestart,
    installPreparedRequiredUpdateOnQuit,
    hasRuntimeServices: () => runInContext("runtimeServices !== null", context) as boolean,
    beginGuide, finishGuide,
    setQuitContext: (next: MacPermissionQuitContext | null) => { quitContext = next; },
    setSystemSessionEnding: (next: boolean | undefined) => {
      if (next === true && systemSessionEnding !== true) notificationSequence += 1;
      systemSessionEnding = next;
    },
    armManualRestart: () => runInContext("shouldRelaunchAfterQuitCleanup = true", context),
    relaunchPending: () => runInContext("shouldRelaunchAfterQuitCleanup", context) as boolean,
  };
}

afterEach(() => vi.useRealTimers());

describe("native app-agent shutdown during desktop quit", () => {
  it.each(["resolved", "rejected"] as const)("cleans native agents before permission relaunch when services close is %s", async (completion) => {
    const test = setup({ actualCleanup: true });
    test.stopComputerUseAgentForPermissionRestart.mockImplementation(async () => { test.events.push("native-async"); });
    const closeServices = test.closeServices.getMockImplementation()!;
    test.closeServices.mockImplementation(() => {
      test.events.push("services-close");
      return closeServices();
    });
    test.stopComputerUseAgentsOnExitSync.mockImplementation(() => { test.events.push("native-sync"); });
    test.requestQuit();
    await vi.advanceTimersByTimeAsync(0);
    expect(test.events).toEqual(["native-async", "services-close"]);
    expect(test.hasRuntimeServices()).toBe(false);
    if (completion === "resolved") test.completeCleanup();
    else test.failCleanup(new Error("service close failed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(test.events).toEqual(["native-async", "services-close", "native-sync", "relaunch", "quit"]);
    expect(test.stopComputerUseAgentsOnExitSync).toHaveBeenCalledExactlyOnceWith(true,
      "/Applications/Memmy.app/Contents/Resources", undefined);
  });

  it("runs native exit cleanup after an earlier cleanup failure and before an ordinary quit", async () => {
    const test = setup({ actualCleanup: true, quitContext: userQuit });
    test.installPreparedRequiredUpdateOnQuit.mockRejectedValueOnce(new Error("update cleanup failed"));
    test.stopComputerUseAgentsOnExitSync.mockImplementation(() => { test.events.push("native-sync"); });
    test.requestQuit();
    await vi.advanceTimersByTimeAsync(0);
    expect(test.events).toEqual(["native-sync", "quit"]);
    expect(test.stopComputerUseAgentForPermissionRestart).not.toHaveBeenCalled();
    expect(test.logs).toContain("quit:cleanup-failed\nupdate cleanup failed");
  });

  it("retains the services captured before cleanup clears them and stops native agents before forced relaunch/exit", async () => {
    const test = setup({ actualCleanup: true });
    test.stopComputerUseAgentsOnExitSync.mockImplementation(() => { test.events.push("native-sync"); });
    test.requestQuit();
    await vi.advanceTimersByTimeAsync(0);
    expect(test.hasRuntimeServices()).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(test.terminateSync).toHaveBeenCalledExactlyOnceWith({ stopMemory: false });
    expect(test.events).toEqual(["terminate", "native-sync", "relaunch", "exit"]);
    test.completeCleanup();
    await vi.advanceTimersByTimeAsync(0);
    expect(test.app.relaunch).toHaveBeenCalledOnce();
  });

  it("still stops native agents and exits if forced service termination throws", async () => {
    const test = setup({ actualCleanup: true, quitContext: userQuit });
    test.terminateSync.mockImplementation(() => { throw new Error("service termination failed"); });
    test.stopComputerUseAgentsOnExitSync.mockImplementation(() => { test.events.push("native-sync"); });
    test.requestQuit();
    await vi.advanceTimersByTimeAsync(5000);
    expect(test.events).toEqual(["native-sync", "exit"]);
    test.completeCleanup();
    await vi.advanceTimersByTimeAsync(0);
  });

  it.each(["win32", "linux"] as const)("does not invoke macOS agent cleanup on %s for normal or forced quit", async (platform) => {
    const normal = setup({ platform, actualCleanup: true });
    normal.requestQuit();
    normal.completeCleanup();
    await vi.advanceTimersByTimeAsync(0);
    expect(normal.stopComputerUseAgentForPermissionRestart).not.toHaveBeenCalled();
    expect(normal.stopComputerUseAgentsOnExitSync).not.toHaveBeenCalled();

    const forced = setup({ platform, actualCleanup: true });
    forced.requestQuit();
    await vi.advanceTimersByTimeAsync(5000);
    expect(forced.stopComputerUseAgentForPermissionRestart).not.toHaveBeenCalled();
    expect(forced.stopComputerUseAgentsOnExitSync).not.toHaveBeenCalled();
    forced.completeCleanup();
    await vi.advanceTimersByTimeAsync(0);
  });
});

describe("macOS system permission restart lifecycle", () => {
  it("relaunches after cleanup for the system quit request even without an activate event", async () => {
    const test = setup();
    expect(test.requestQuit().defaultPrevented).toBe(true);
    expect(test.policy).toHaveBeenCalledWith(systemQuit, { permissionRequested: false, systemSessionEnding: false });
    expect(test.logs).toContain("quit:system-permission-restart-requested:com.apple.systempreferences");
    expect(test.app.relaunch).not.toHaveBeenCalled();
    expect(test.app.quit).not.toHaveBeenCalled();
    test.completeCleanup();
    await vi.advanceTimersByTimeAsync(0);
    expect(test.events).toEqual(["relaunch", "quit"]);
    expect(test.app.relaunch).toHaveBeenCalledOnce();
    expect(test.app.quit).toHaveBeenCalledOnce();
    expect(test.readCurrentQuitContext).toHaveBeenCalledOnce();
    expect(test.relaunchPending()).toBe(false);
  });

  it("ignores a stale system quit delivered to the new instance and honors the next quit", async () => {
    const test = setup({ waitedForLock: true });
    expect(test.requestQuit().defaultPrevented).toBe(true);
    expect(test.logs).toContain("quit:ignored-stale-reopen-quit");
    expect(test.readCurrentQuitContext).toHaveBeenCalledOnce();
    expect(test.cleanupBeforeQuit).not.toHaveBeenCalled();
    expect(test.app.relaunch).not.toHaveBeenCalled();
    test.requestQuit();
    expect(test.cleanupBeforeQuit).toHaveBeenCalledOnce();
    expect(test.readCurrentQuitContext).toHaveBeenCalledTimes(2);
    test.completeCleanup();
    await vi.advanceTimersByTimeAsync(0);
    expect(test.app.relaunch).toHaveBeenCalledOnce();
  });

  it("coalesces repeated quit requests while cleanup is pending", async () => {
    const test = setup();
    test.requestQuit();
    test.requestQuit();
    expect(test.cleanupBeforeQuit).toHaveBeenCalledOnce();
    expect(test.app.relaunch).not.toHaveBeenCalled();
    test.completeCleanup();
    await vi.advanceTimersByTimeAsync(0);
    test.requestQuit();
    expect(test.app.relaunch).toHaveBeenCalledOnce();
    expect(test.readCurrentQuitContext).toHaveBeenCalledTimes(2);
    expect(test.relaunchPending()).toBe(false);
  });

  it.each([
    ["a normal user quit", { quitContext: userQuit }],
    ["an unavailable quit context", { quitContext: null }],
    ["an unavailable native module", { nativeUnavailable: true }],
    ["a failed native probe", { nativeError: new Error("probe unavailable") }],
  ] as const)("finishes %s without relaunching", async (_name, options) => {
    const test = setup(options);
    test.requestQuit();
    test.completeCleanup();
    await vi.advanceTimersByTimeAsync(0);
    expect(test.events).toEqual(["quit"]);
    expect(test.app.relaunch).not.toHaveBeenCalled();
    expect(test.cleanupBeforeQuit).toHaveBeenCalledOnce();
    expect(test.relaunchPending()).toBe(false);
  });

  it("keeps the existing activate-during-quit restart path", async () => {
    const test = setup({ quitContext: null });
    test.requestQuit();
    test.app.emit("activate");
    expect(test.logs).toContain("quit:reopen-requested-during-quit");
    expect(test.app.relaunch).not.toHaveBeenCalled();
    test.completeCleanup();
    await vi.advanceTimersByTimeAsync(0);
    expect(test.app.relaunch).toHaveBeenCalledOnce();
    expect(test.relaunchPending()).toBe(false);
  });

  it("relaunches once even if cleanup times out and later resolves", async () => {
    const test = setup();
    test.requestQuit();
    await vi.advanceTimersByTimeAsync(5000);
    expect(test.terminateSync).toHaveBeenCalledWith({ stopMemory: false });
    expect(test.events).toEqual(["terminate", "relaunch", "exit"]);
    expect(test.app.exit).toHaveBeenCalledWith(0);
    expect(test.app.relaunch).toHaveBeenCalledOnce();
    test.completeCleanup();
    await vi.advanceTimersByTimeAsync(0);
    expect(test.app.relaunch).toHaveBeenCalledOnce();
    expect(test.relaunchPending()).toBe(false);
  });

  it("still relaunches when shutdown cleanup rejects", async () => {
    const test = setup();
    test.requestQuit();
    test.failCleanup(new Error("service close failed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(test.logs).toContain("quit:cleanup-failed\nservice close failed");
    expect(test.events).toEqual(["relaunch", "quit"]);
    expect(test.app.relaunch).toHaveBeenCalledOnce();
  });

  it.each(["win32", "linux"] as const)("does not inspect macOS native quit context on %s", async (platform) => {
    const test = setup({ platform });
    test.requestQuit();
    test.completeCleanup();
    await vi.advanceTimersByTimeAsync(0);
    expect(test.loadMenuBarAppearanceNative).not.toHaveBeenCalled();
    expect(test.readCurrentQuitContext).not.toHaveBeenCalled();
    expect(test.policy).not.toHaveBeenCalled();
    expect(test.app.relaunch).not.toHaveBeenCalled();
  });

  it("does not arm a restart for a secondary process that owns no instance lock", () => {
    const test = setup({ ownsLock: false });
    expect(test.requestQuit().defaultPrevented).toBe(false);
    expect(test.readCurrentQuitContext).not.toHaveBeenCalled();
    expect(test.cleanupBeforeQuit).not.toHaveBeenCalled();
    expect(test.app.relaunch).not.toHaveBeenCalled();
  });

  it("relaunches a permission rlgo without any activate event", async () => {
    const test = setup({ quitContext: permissionRelaunch, permissionRequested: true });
    test.requestQuit();
    expect(test.policy).toHaveBeenCalledWith(permissionRelaunch, { permissionRequested: true, systemSessionEnding: false });
    expect(test.logs).toContain("quit:system-permission-restart-requested:com.apple.settings.PrivacySecurity.extension");
    expect(test.logs).not.toContain("quit:reopen-requested-during-quit");
    test.completeCleanup(); await vi.advanceTimersByTimeAsync(0);
    expect(test.events).toEqual(["relaunch", "quit"]);
    expect(test.app.relaunch).toHaveBeenCalledOnce();
  });

  it.each(["expired", "cancelled", "absent"] as const)("does not restart a permission rlgo whose intent is %s", async (condition) => {
    const test = setup({ quitContext: permissionRelaunch });
    if (condition !== "absent") {
      const token = test.beginGuide();
      if (condition === "cancelled") test.finishGuide(token, false);
      else await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    }
    test.requestQuit(); test.app.emit("activate");
    test.completeCleanup(); await vi.advanceTimersByTimeAsync(0);
    expect(test.events).toEqual(["quit"]);
    expect(test.app.relaunch).not.toHaveBeenCalled();
  });

  it("retains the verified guide's short restart grace and rejects it after that grace", async () => {
    const test = setup({ quitContext: permissionRelaunch });
    const token = test.beginGuide(); test.finishGuide(token, true);
    await vi.advanceTimersByTimeAsync(29_000);
    test.requestQuit(); test.completeCleanup(); await vi.advanceTimersByTimeAsync(0);
    expect(test.app.relaunch).toHaveBeenCalledOnce();

    const expired = setup({ quitContext: permissionRelaunch });
    const next = expired.beginGuide(); expired.finishGuide(next, true);
    await vi.advanceTimersByTimeAsync(30_001);
    expired.requestQuit(); expired.completeCleanup(); await vi.advanceTimersByTimeAsync(0);
    expect(expired.app.relaunch).not.toHaveBeenCalled();
  });

  it("coalesces repeated permission rlgo requests without consuming the intent twice", async () => {
    const test = setup({ quitContext: permissionRelaunch, permissionRequested: true });
    test.requestQuit(); test.requestQuit(); test.app.emit("activate");
    expect(test.cleanupBeforeQuit).toHaveBeenCalledOnce();
    test.completeCleanup(); await vi.advanceTimersByTimeAsync(0);
    expect(test.app.relaunch).toHaveBeenCalledOnce();
    expect(test.events).toEqual(["relaunch", "quit"]);
  });

  it("keeps a same-dispatch duplicate after native quit context is consumed", async () => {
    const test = setup({ quitContext: permissionRelaunch, oneShotQuitContext: true,
      permissionRequested: true, systemSessionEnding: true });
    test.requestQuit(); test.requestQuit();
    expect(test.relaunchPending()).toBe(true);
    test.completeCleanup(); await vi.advanceTimersByTimeAsync(0);
    expect(test.app.relaunch).toHaveBeenCalledOnce();
  });

  it.each(["rest", "shut", "logo", "rlgo", "quia"])("never relaunches a real loginwindow %s despite an owned permission intent", async (quitReason) => {
    const test = setup({ quitContext: { ...loginwindowQuit, quitReason }, permissionRequested: true });
    test.requestQuit(); test.app.emit("activate");
    test.completeCleanup(); await vi.advanceTimersByTimeAsync(0);
    expect(test.app.relaunch).not.toHaveBeenCalled();
    expect(test.events).toEqual(["quit"]);
  });

  it.each(["rest", "shut", "logo", "quia"])("a permission intent does not convert Settings %s into a restart", async (quitReason) => {
    const test = setup({ quitContext: { ...permissionRelaunch, quitReason }, permissionRequested: true });
    test.requestQuit(); test.app.emit("activate");
    test.completeCleanup(); await vi.advanceTimersByTimeAsync(0);
    expect(test.app.relaunch).not.toHaveBeenCalled();
  });

  it("rejects a copied PrivacySecurity executable even with a live permission intent", async () => {
    const test = setup({ quitContext: { ...permissionRelaunch,
      senderExecutablePath: "/tmp/SecurityPrivacyExtension.appex/Contents/MacOS/SecurityPrivacyExtension" }, permissionRequested: true });
    test.requestQuit(); test.app.emit("activate");
    test.completeCleanup(); await vi.advanceTimersByTimeAsync(0);
    expect(test.app.relaunch).not.toHaveBeenCalled();
  });

  it.each(["cleanup", "timeout"] as const)("a real system quit during permission cleanup vetoes restart on %s", async (completion) => {
    const test = setup({ quitContext: permissionRelaunch, permissionRequested: true });
    test.requestQuit(); expect(test.relaunchPending()).toBe(true);
    test.setQuitContext(loginwindowQuit); test.requestQuit(); test.app.emit("activate");
    expect(test.relaunchPending()).toBe(false);
    if (completion === "cleanup") { test.completeCleanup(); await vi.advanceTimersByTimeAsync(0); }
    else await vi.advanceTimersByTimeAsync(5000);
    expect(test.app.relaunch).not.toHaveBeenCalled();
    expect(test.cleanupBeforeQuit).toHaveBeenCalledOnce();
  });

  it.each(["activate", "cleanup", "timeout"] as const)("a native session-ending notification arriving before %s vetoes restart", async (boundary) => {
    const test = setup({ quitContext: permissionRelaunch, permissionRequested: true });
    test.requestQuit(); expect(test.relaunchPending()).toBe(true);
    test.setSystemSessionEnding(true);
    if (boundary === "activate") test.app.emit("activate");
    if (boundary === "timeout") await vi.advanceTimersByTimeAsync(5000);
    else { test.completeCleanup(); await vi.advanceTimersByTimeAsync(0); }
    expect(test.app.relaunch).not.toHaveBeenCalled();
    expect(test.relaunchPending()).toBe(false);
  });

  it.each([
    { nativeSessionUnavailable: true }, { nativeObserverUnavailable: true },
    { nativeSessionError: new Error("session probe failed") },
  ])("a missing or failed native session probe cannot authorize restart: %j", async (options) => {
    const test = setup({ ...options, quitContext: permissionRelaunch, permissionRequested: true });
    test.requestQuit(); test.app.emit("activate");
    test.completeCleanup(); await vi.advanceTimersByTimeAsync(0);
    expect(test.app.relaunch).not.toHaveBeenCalled();
  });

  it("reopens after a Full Disk Access quit even if Settings is closed before cleanup", async () => {
    const test = setup({ quitContext: permissionRelaunch, permissionRequested: true, systemSessionEnding: true });
    test.requestQuit();
    expect(test.policy).toHaveBeenCalledWith(permissionRelaunch,
      { permissionRequested: true, systemSessionEnding: false });
    expect(test.logs.some((line) => line.includes('"source":"notification"')
      && line.includes('"ignoreExistingNotification":true'))).toBe(true);
    test.app.emit("activate");
    test.completeCleanup(); await vi.advanceTimersByTimeAsync(0);
    expect(test.app.relaunch).toHaveBeenCalledOnce();
  });


  it("a real loginwindow quit still wins after a verified notification-bearing permission quit", async () => {
    const test = setup({ quitContext: permissionRelaunch, permissionRequested: true, systemSessionEnding: true });
    test.requestQuit(); expect(test.relaunchPending()).toBe(true);
    test.setQuitContext(loginwindowQuit); test.requestQuit();
    test.completeCleanup(); await vi.advanceTimersByTimeAsync(0);
    expect(test.app.relaunch).not.toHaveBeenCalled();
  });

  it("a new system notification cancels a notification-bearing permission restart", async () => {
    const test = setup({ quitContext: permissionRelaunch, permissionRequested: true, systemSessionEnding: true });
    test.requestQuit(); expect(test.relaunchPending()).toBe(true);
    test.setSystemSessionEnding(false);
    test.setSystemSessionEnding(true);
    test.completeCleanup(); await vi.advanceTimersByTimeAsync(0);
    expect(test.app.relaunch).not.toHaveBeenCalled();
  });

  it("does not let a notification turn an ordinary quit into a permission restart", async () => {
    const test = setup({ quitContext: userQuit, permissionRequested: true, systemSessionEnding: true });
    test.requestQuit(); test.completeCleanup(); await vi.advanceTimersByTimeAsync(0);
    expect(test.app.relaunch).not.toHaveBeenCalled();
  });

  it("does not bypass a native notification without a fresh permission request", async () => {
    const test = setup({ quitContext: permissionRelaunch, systemSessionEnding: true });
    test.requestQuit(); test.completeCleanup(); await vi.advanceTimersByTimeAsync(0);
    expect(test.app.relaunch).not.toHaveBeenCalled();
  });

  it("keeps an ambiguous session notification as a veto for the page restart", async () => {
    const test = setup({ quitContext: null, permissionRequested: true, systemSessionEnding: true });
    test.armManualRestart();
    test.requestQuit(); test.completeCleanup(); await vi.advanceTimersByTimeAsync(0);
    expect(test.app.relaunch).not.toHaveBeenCalled();
  });

  it("ignores a trusted stale permission rlgo without starting cleanup", () => {
    const test = setup({ quitContext: permissionRelaunch, waitedForLock: true, relaunchMarker: true });
    expect(test.requestQuit().defaultPrevented).toBe(true);
    expect(test.logs).toContain("quit:ignored-stale-reopen-quit");
    expect(test.cleanupBeforeQuit).not.toHaveBeenCalled();
    expect(test.relaunchPending()).toBe(false);
  });

  it("ignores the verified stale permission quit even with an existing native notification", () => {
    const test = setup({ quitContext: permissionRelaunch, waitedForLock: true,
      relaunchMarker: true, systemSessionEnding: true });
    expect(test.requestQuit().defaultPrevented).toBe(true);
    expect(test.logs).toContain("quit:ignored-stale-reopen-quit");
    expect(test.cleanupBeforeQuit).not.toHaveBeenCalled();
  });

  it.each([userQuit, loginwindowQuit])("a reopened instance honors an ordinary or real system quit: %j", async (quitContext) => {
    const test = setup({ quitContext, waitedForLock: true });
    test.requestQuit(); test.completeCleanup(); await vi.advanceTimersByTimeAsync(0);
    expect(test.logs).not.toContain("quit:ignored-stale-reopen-quit");
    expect(test.cleanupBeforeQuit).toHaveBeenCalledOnce();
    expect(test.app.relaunch).not.toHaveBeenCalled();
    expect(test.events).toEqual(["quit"]);
  });

  it("never ignores a fresh system quit on a reopened instance after a native session notification", async () => {
    const test = setup({ waitedForLock: true, systemSessionEnding: true });
    test.requestQuit(); test.completeCleanup(); await vi.advanceTimersByTimeAsync(0);
    expect(test.logs).not.toContain("quit:ignored-stale-reopen-quit");
    expect(test.cleanupBeforeQuit).toHaveBeenCalledOnce();
    expect(test.app.relaunch).not.toHaveBeenCalled();
  });

  it("preserves Windows activate-during-cleanup behavior without calling any macOS native probe", async () => {
    const test = setup({ platform: "win32", quitContext: permissionRelaunch, permissionRequested: true, systemSessionEnding: true });
    test.requestQuit(); test.app.emit("activate");
    test.completeCleanup(); await vi.advanceTimersByTimeAsync(0);
    expect(test.app.relaunch).toHaveBeenCalledOnce();
    expect(test.loadMenuBarAppearanceNative).not.toHaveBeenCalled();
    expect(test.readCurrentQuitContext).not.toHaveBeenCalled();
    expect(test.readSystemSessionEnding).not.toHaveBeenCalled();
    expect(test.app.relaunch).toHaveBeenCalledWith({ args: [] });
  });

  it("a reopened instance cannot ignore Settings rlgo without the permission relaunch marker", async () => {
    const test = setup({ quitContext: permissionRelaunch, waitedForLock: true });
    test.requestQuit(); test.completeCleanup(); await vi.advanceTimersByTimeAsync(0);
    expect(test.logs).not.toContain("quit:ignored-stale-reopen-quit");
    expect(test.cleanupBeforeQuit).toHaveBeenCalledOnce();
    expect(test.app.relaunch).not.toHaveBeenCalled();
  });

  it("passes a single permission marker only for a newly authorized macOS permission restart", async () => {
    const marker = "--memmy-permission-relaunch";
    const test = setup({ quitContext: permissionRelaunch, permissionRequested: true,
      argv: ["Memmy", marker, "--keep=original", marker] });
    test.requestQuit(); test.completeCleanup(); await vi.advanceTimersByTimeAsync(0);
    expect(test.app.relaunch).toHaveBeenCalledExactlyOnceWith({ args: ["--keep=original", marker] });
  });

  it("an ordinary activate-driven relaunch strips an inherited permission marker", async () => {
    const test = setup({ quitContext: null, argv: ["Memmy", "--memmy-permission-relaunch", "--keep=original"] });
    test.requestQuit(); test.app.emit("activate");
    test.completeCleanup(); await vi.advanceTimersByTimeAsync(0);
    expect(test.app.relaunch).toHaveBeenCalledExactlyOnceWith({ args: ["--keep=original"] });
  });

  it.each(["cleanup", "timeout"] as const)("a system veto observed during quit remains latched through %s even when the native flag expires", async (completion) => {
    const test = setup({ quitContext: permissionRelaunch, permissionRequested: true });
    test.requestQuit(); test.setSystemSessionEnding(true); test.app.emit("activate");
    test.setSystemSessionEnding(false); test.app.emit("activate");
    expect(test.relaunchPending()).toBe(false);
    if (completion === "timeout") await vi.advanceTimersByTimeAsync(5000);
    else { test.completeCleanup(); await vi.advanceTimersByTimeAsync(0); }
    expect(test.app.relaunch).not.toHaveBeenCalled();
  });

  it.each([null, userQuit])("an ordinary quit during permission cleanup cancels the earlier automatic reopen: %j", async (quitContext) => {
    const test = setup({ quitContext: permissionRelaunch, permissionRequested: true });
    test.requestQuit(); expect(test.relaunchPending()).toBe(true);
    await Promise.resolve();
    test.setQuitContext(quitContext); test.requestQuit();
    expect(test.relaunchPending()).toBe(false);
    test.completeCleanup(); await vi.advanceTimersByTimeAsync(0);
    expect(test.app.relaunch).not.toHaveBeenCalled();
    expect(test.cleanupBeforeQuit).toHaveBeenCalledOnce();
    expect(test.events).toEqual(["quit"]);
  });

  it("latches an initial system-session veto even when no AppleEvent context is available", async () => {
    const test = setup({ quitContext: null, systemSessionEnding: true });
    test.requestQuit();
    test.setSystemSessionEnding(false); test.app.emit("activate");
    test.completeCleanup(); await vi.advanceTimersByTimeAsync(0);
    expect(test.events).toEqual(["quit"]);
    expect(test.app.relaunch).not.toHaveBeenCalled();
  });
});
