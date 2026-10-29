import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import type { BrowserWindow } from "electron";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachRendererRecovery, rendererRecoveryUrl,
  RENDERER_AUTO_RECOVERY_INTERVAL_MS, RENDERER_RECOVERY_TIMEOUT_MS
} from "../src/main/renderer-recovery.js";

const appUrl = "http://127.0.0.1:19100/?memmyMode=full#private-chat-title";
class FakeWindow extends EventEmitter {
  destroyed = false;
  webContents = Object.assign(new EventEmitter(), {
    id: 1, isDestroyed: () => this.destroyed, getURL: () => appUrl, send: vi.fn()
  });
  loadURL = vi.fn(async (_url: string) => {});
  isDestroyed() { return this.destroyed; }
  close() {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    this.emit("close", event);
    if (!event.defaultPrevented) this.destroy();
    return event;
  }
  destroy() {
    this.destroyed = true;
    this.emit("closed");
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup(mode: "full" | "pet" = "full") {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const window = new FakeWindow();
  const state = { quitting: false, startup: false };
  const choice = deferred<"reload" | "quit">();
  const showRecoveryDialog = vi.fn(() => choice.promise);
  const clearRendererState = vi.fn();
  const quit = vi.fn(() => { state.quitting = true; });
  const record = vi.fn();
  const recovery = attachRendererRecovery({
    window: window as unknown as BrowserWindow, mode,
    isQuitting: () => state.quitting, isStartup: () => state.startup,
    clearRendererState, reload: () => window.loadURL(appUrl), showRecoveryDialog, quit, record
  });
  return { window, state, choice, showRecoveryDialog, clearRendererState, quit, record, recovery,
    gone: (reason = "killed") => window.webContents.emit("render-process-gone", {}, { reason, exitCode: -9 }) };
}

afterEach(() => vi.useRealTimers());

describe("shell renderer recovery", () => {
  it.each(["full", "pet"] as const)("recovers a %s renderer after its initial load and waits for fresh app readiness", async mode => {
    const test = setup(mode);
    test.window.webContents.emit("did-finish-load");
    test.recovery.markReady();
    test.gone();
    await vi.advanceTimersByTimeAsync(0);
    expect(test.window.loadURL).toHaveBeenCalledOnce();
    expect(test.recovery.isUnavailable()).toBe(true);
    test.window.webContents.emit("did-finish-load");
    expect(test.recovery.isUnavailable()).toBe(true);
    test.recovery.markReady();
    expect(test.recovery.isUnavailable()).toBe(false);
    await vi.advanceTimersByTimeAsync(RENDERER_RECOVERY_TIMEOUT_MS);
    expect(test.showRecoveryDialog).not.toHaveBeenCalled();
    expect(test.record).toHaveBeenCalledWith({ event: "renderer-gone", mode, reason: "killed", exitCode: -9 });
    expect(test.record).toHaveBeenCalledWith({ event: "renderer-recovered", mode });
  });

  it("prompts once for repeated deaths and permits an explicit user reload without starting a retry loop", async () => {
    const test = setup();
    test.gone();
    await vi.advanceTimersByTimeAsync(0);
    test.recovery.markReady();
    test.gone();
    test.gone("crashed");
    expect(test.window.loadURL).toHaveBeenCalledOnce();
    expect(test.showRecoveryDialog).toHaveBeenCalledOnce();
    test.choice.resolve("reload");
    await vi.advanceTimersByTimeAsync(0);
    expect(test.window.loadURL).toHaveBeenCalledTimes(2);
    test.recovery.markReady();
    test.showRecoveryDialog.mockImplementation(() => new Promise(() => {}));
    test.gone();
    await vi.advanceTimersByTimeAsync(0);
    expect(test.window.loadURL).toHaveBeenCalledTimes(2);
    expect(test.showRecoveryDialog).toHaveBeenCalledTimes(2);
  });

  it("allows another automatic attempt only after the recovery interval", async () => {
    const test = setup();
    test.gone();
    await vi.advanceTimersByTimeAsync(0);
    test.recovery.markReady();
    await vi.advanceTimersByTimeAsync(RENDERER_AUTO_RECOVERY_INTERVAL_MS);
    test.gone();
    await vi.advanceTimersByTimeAsync(0);
    expect(test.window.loadURL).toHaveBeenCalledTimes(2);
    expect(test.showRecoveryDialog).not.toHaveBeenCalled();
    test.recovery.dispose();
  });

  it.each(["rejected", "synchronous"])("shows native recovery options when loadURL fails %s without logging private error contents", async kind => {
    const test = setup();
    const error = new Error("private-url-and-chat-title");
    test.window.loadURL.mockImplementation(() => {
      if (kind === "synchronous") throw error;
      return Promise.reject(error);
    });
    test.gone();
    await vi.advanceTimersByTimeAsync(0);
    expect(test.showRecoveryDialog).toHaveBeenCalledOnce();
    expect(test.record).toHaveBeenCalledWith({ event: "renderer-reload-failed", mode: "full" });
    expect(JSON.stringify(test.record.mock.calls)).not.toContain("private");
    test.choice.resolve("quit");
    await vi.advanceTimersByTimeAsync(0);
    expect(test.quit).toHaveBeenCalledOnce();
    expect(test.window.loadURL).toHaveBeenCalledOnce();
  });

  it("times out a loaded page with no app handshake and ignores a dialog result after recovery succeeds", async () => {
    const test = setup();
    test.gone();
    await vi.advanceTimersByTimeAsync(0);
    test.window.webContents.emit("did-finish-load");
    await vi.advanceTimersByTimeAsync(RENDERER_RECOVERY_TIMEOUT_MS);
    expect(test.showRecoveryDialog).toHaveBeenCalledOnce();
    test.recovery.markReady();
    test.choice.resolve("quit");
    await vi.advanceTimersByTimeAsync(0);
    expect(test.quit).not.toHaveBeenCalled();
  });

  it("ignores subframe failures and navigation cancellation, and handles a main-frame failure only once", async () => {
    const test = setup();
    test.window.webContents.emit("did-fail-load", {}, -105, "private description", appUrl, false);
    test.window.webContents.emit("did-fail-load", {}, -3, "ERR_ABORTED", appUrl, true);
    expect(test.clearRendererState).not.toHaveBeenCalled();
    expect(test.showRecoveryDialog).not.toHaveBeenCalled();
    const load = deferred<void>();
    test.window.loadURL.mockImplementation(() => load.promise);
    test.gone();
    await vi.advanceTimersByTimeAsync(0);
    test.window.webContents.emit("did-fail-load", {}, -105, "private description", appUrl, true);
    load.reject(new Error("private rejection"));
    await vi.advanceTimersByTimeAsync(0);
    expect(test.showRecoveryDialog).toHaveBeenCalledOnce();
    expect(JSON.stringify(test.record.mock.calls)).not.toContain("private");
  });

  it("leaves startup failure handling to the startup watcher", async () => {
    const test = setup();
    test.state.startup = true;
    test.gone();
    await vi.advanceTimersByTimeAsync(0);
    expect(test.clearRendererState).toHaveBeenCalled();
    expect(test.window.loadURL).not.toHaveBeenCalled();
    expect(test.showRecoveryDialog).not.toHaveBeenCalled();
  });

  it.each(["before reload", "during reload", "during dialog"])("does not recover or quit a closing app %s", async stage => {
    const test = setup();
    const load = deferred<void>();
    test.window.loadURL.mockImplementation(() => load.promise);
    test.gone();
    if (stage !== "before reload") await vi.advanceTimersByTimeAsync(0);
    if (stage === "during dialog") {
      test.gone();
      expect(test.showRecoveryDialog).toHaveBeenCalledOnce();
    }
    test.state.quitting = true;
    if (stage !== "before reload") load.reject(new Error("late failure"));
    test.choice.resolve("reload");
    await vi.advanceTimersByTimeAsync(RENDERER_RECOVERY_TIMEOUT_MS);
    expect(test.window.loadURL).toHaveBeenCalledTimes(stage === "before reload" ? 0 : 1);
    expect(test.quit).not.toHaveBeenCalled();
    test.recovery.dispose();
  });

  it("cleans up closed windows and ignores stale rejection/dialog continuations", async () => {
    const test = setup();
    const load = deferred<void>();
    test.window.loadURL.mockImplementation(() => load.promise);
    test.gone();
    await vi.advanceTimersByTimeAsync(0);
    test.gone();
    test.window.destroy();
    load.reject(new Error("late failure"));
    test.choice.resolve("reload");
    await vi.advanceTimersByTimeAsync(RENDERER_RECOVERY_TIMEOUT_MS);
    expect(test.window.loadURL).toHaveBeenCalledOnce();
    expect(test.quit).not.toHaveBeenCalled();
    expect(test.window.webContents.listenerCount("render-process-gone")).toBe(0);
    expect(test.window.webContents.listenerCount("did-fail-load")).toBe(0);
    expect(test.window.listenerCount("close")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("routes close through native recovery options while the renderer is unavailable", async () => {
    const test = setup();
    test.gone();
    const event = test.window.close();
    expect(event.defaultPrevented).toBe(true);
    expect(test.window.destroyed).toBe(false);
    expect(test.showRecoveryDialog).toHaveBeenCalledOnce();
    test.choice.resolve("quit");
    await vi.advanceTimersByTimeAsync(0);
    expect(test.quit).toHaveBeenCalledOnce();
  });

  it("preserves a trusted app route and rejects other origins or documents", () => {
    const trusted = "http://127.0.0.1:19100/?memmyMode=full";
    expect(rendererRecoveryUrl(appUrl, trusted)).toBe(appUrl);
    expect(rendererRecoveryUrl("https://external.example/#secret", trusted)).toBe(trusted);
    expect(rendererRecoveryUrl("http://127.0.0.1:19100/other", trusted)).toBe(trusted);
    expect(rendererRecoveryUrl("about:blank", trusted)).toBe(trusted);
    expect(rendererRecoveryUrl("file:///other/index.html", "file:///app/index.html?memmyMode=pet"))
      .toBe("file:///app/index.html?memmyMode=pet");
  });
});

// Exercise the actual main.ts wiring without importing Electron or starting user services.
const mainSource = ts.createSourceFile("main.ts", readFileSync(new URL("../src/main/main.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const functions = new Set(["attachShellRendererRecovery", "recordShellProcessDiagnostic", "handleMainWindowClose", "handleMainWindowMinimize", "requestMainWindowAction"]);
const variables = new Set(["mainWindow", "rendererRecoveries", "rendererReadyWebContentsIds", "rendererReadyWaiters", "pendingMainWindowAction", "nextMainWindowActionId", "isReplayingMainWindowAction", "isQuitting", "startupRendererCleanup", "programmaticPetWindowCloses"]);
const selected = mainSource.statements.filter(statement => {
  if (ts.isFunctionDeclaration(statement)) return functions.has(statement.name?.text ?? "");
  if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.some(declaration => variables.has(declaration.name.getText(mainSource)));
  return ts.isExpressionStatement(statement) && statement.expression.getText(mainSource).startsWith('app.on("child-process-gone",');
});
const register = mainSource.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "registerIpcHandlers") as ts.FunctionDeclaration;
const readyIpc = register.body!.statements.find(statement => statement.getText(mainSource).startsWith('ipcMain.on("memmy:renderer-ready",'))!;
const wiringCode = ts.transpileModule([...selected, readyIpc].map(statement => statement.getText(mainSource)).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText;

function setupWiring(mode: "full" | "pet" = "full") {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const window = new FakeWindow();
  const choice = deferred<{ response: number }>();
  const app = Object.assign(new EventEmitter(), { getLocale: () => "zh-CN", quit: vi.fn() });
  const ipcMain = new EventEmitter();
  const writeProcessDiagnostic = vi.fn();
  const writePackagedStartupLog = vi.fn(async (_message: string) => {});
  const dialog = { showMessageBox: vi.fn(() => choice.promise) };
  const context = createContext({ app, ipcMain, dialog, writeProcessDiagnostic, writePackagedStartupLog,
    attachRendererRecovery, rendererRecoveryUrl, resolveRendererUrl: () => "http://127.0.0.1:19100/?memmyMode=" + mode,
    window, mode });
  runInContext(wiringCode, context);
  runInContext('mainWindow = window; attachShellRendererRecovery(window, mode); window.on("close", handleMainWindowClose);', context);
  const run = (code: string) => runInContext(code, context);
  const ready = () => ipcMain.emit("memmy:renderer-ready", { sender: window.webContents });
  const gone = () => window.webContents.emit("render-process-gone", {}, { reason: "killed", exitCode: -9 });
  return { window, context, run, ready, gone, app, choice, dialog, writeProcessDiagnostic, writePackagedStartupLog };
}

describe("main process recovery wiring", () => {
  it("invalidates only this window's pending/readiness state and restores it on the new renderer handshake", async () => {
    const test = setupWiring();
    test.ready();
    expect(test.run("rendererReadyWebContentsIds.has(1)")).toBe(true);
    test.window.close();
    expect(test.run("pendingMainWindowAction !== null")).toBe(true);
    test.gone();
    await vi.advanceTimersByTimeAsync(0);
    expect(test.run("pendingMainWindowAction")).toBeNull();
    expect(test.run("rendererReadyWebContentsIds.has(1)")).toBe(false);
    expect(test.window.loadURL).toHaveBeenCalledWith(appUrl);
    test.window.close();
    expect(test.run("pendingMainWindowAction")).toBeNull();
    test.ready();
    expect(test.run("rendererRecoveries.get(1).isUnavailable()")).toBe(false);
    test.run('pendingMainWindowAction = { targetWindow: {} }; rendererReadyWebContentsIds.add(2);');
    test.gone();
    expect(test.run("pendingMainWindowAction !== null")).toBe(true);
    expect(test.run("rendererReadyWebContentsIds.has(2)")).toBe(true);
    test.window.destroy();
    expect(test.run("rendererRecoveries.size")).toBe(0);
    expect(test.run("rendererReadyWebContentsIds.has(1)")).toBe(false);
  });

  it("records renderer and child lifecycle metadata to both local sinks without URL, name, or error contents", async () => {
    const test = setupWiring();
    test.ready();
    test.gone();
    test.app.emit("child-process-gone", {}, { type: "GPU", reason: "killed", exitCode: -9, name: "private name", url: appUrl });
    await vi.advanceTimersByTimeAsync(0);
    expect(test.writeProcessDiagnostic.mock.calls).toEqual(test.writePackagedStartupLog.mock.calls);
    const logs = test.writeProcessDiagnostic.mock.calls.map(([message]) => JSON.parse(message.slice("shell-process:".length)));
    expect(logs).toContainEqual({ event: "child-process-gone", type: "GPU", reason: "killed", exitCode: -9 });
    expect(JSON.stringify(logs)).not.toContain("private");
    test.ready();
  });

  it("continues the independent local log if electron-log rejects a write", async () => {
    const test = setupWiring();
    test.writeProcessDiagnostic.mockImplementation(() => { throw new Error("log unavailable"); });
    expect(() => test.gone()).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(test.writePackagedStartupLog).toHaveBeenCalled();
    expect(test.window.loadURL).toHaveBeenCalledOnce();
    test.ready();
  });

  it("does not recover a pet being closed programmatically", async () => {
    const test = setupWiring("pet");
    test.run("programmaticPetWindowCloses.add(window)");
    test.gone();
    await vi.advanceTimersByTimeAsync(0);
    expect(test.window.loadURL).not.toHaveBeenCalled();
    expect(test.dialog.showMessageBox).not.toHaveBeenCalled();
    test.window.destroy();
  });

  it("offers native reload/quit after a second death and prevents dead-renderer minimize requests", async () => {
    const test = setupWiring();
    test.ready();
    test.gone();
    await vi.advanceTimersByTimeAsync(0);
    test.ready();
    test.gone();
    test.context.event = { preventDefault: vi.fn() };
    test.run("handleMainWindowMinimize(event)");
    expect(test.run("pendingMainWindowAction")).toBeNull();
    expect(test.dialog.showMessageBox).toHaveBeenCalledWith(test.window, expect.objectContaining({ buttons: ["重新加载", "退出 Memmy"] }));
    test.choice.resolve({ response: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(test.app.quit).toHaveBeenCalledOnce();
    expect(test.window.loadURL).toHaveBeenCalledOnce();
  });
});
