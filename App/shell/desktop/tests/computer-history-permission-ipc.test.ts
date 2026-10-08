import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { memmyPermissionSnapshot } from "../src/main/memmy-screen-permission.js";
import type { GuideControls } from "../src/main/computer-use-onboarding.js";

const sessionChannel = "memmy:get-computer-history-permission-session";
const restartChannel = "memmy:restart-for-computer-history-permissions";
const channels = new Set([sessionChannel, restartChannel]);
const mainSource = readFileSync(new URL("../src/main/main.ts", import.meta.url), "utf8");
const mainAst = ts.createSourceFile("main.ts", mainSource, ts.ScriptTarget.Latest, true);

interface PermissionApi {
  getComputerHistoryPermissionSessionId(): Promise<string>;
  restartForComputerHistoryPermissions(): Promise<void>;
}

function mainFunction(name: string): ts.FunctionDeclaration {
  const declaration = mainAst.statements.find(
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  if (!declaration?.body) throw new Error(`Missing main function: ${name}`);
  return declaration;
}

function mainVariable(name: string): string {
  const declaration = mainAst.statements.find((node) =>
    ts.isVariableStatement(node) && node.declarationList.declarations.some(
      (item) => ts.isIdentifier(item.name) && item.name.text === name,
    ),
  );
  if (!declaration) throw new Error(`Missing main variable: ${name}`);
  return declaration.getText(mainAst);
}

function permissionIpcStatements(functionName: string, method: string): string {
  const statements = mainFunction(functionName).body!.statements.filter((statement) => {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false;
    const call = statement.expression;
    const channel = call.arguments[0];
    return call.expression.getText(mainAst) === `ipcMain.${method}`
      && channel && ts.isStringLiteral(channel) && channels.has(channel.text);
  });
  expect(statements).toHaveLength(channels.size);
  return statements.map((statement) => statement.getText(mainAst)).join("\n");
}

function loadPermissionIpc(platform: NodeJS.Platform) {
  const handlers = new Map<string, () => unknown>();
  const deferred: Array<() => void> = [];
  const app = { quit: vi.fn(), relaunch: vi.fn() };
  const stopComputerUseAgentForPermissionRestart = vi.fn().mockResolvedValue(undefined);
  const createSessionId = vi.fn(randomUUID);
  const ipcMain = {
    handle: (channel: string, callback: () => unknown) => handlers.set(channel, callback),
    removeHandler: (channel: string) => handlers.delete(channel),
  };
  const program = [
    mainVariable("computerHistoryPermissionSessionId"),
    mainVariable("shouldRelaunchAfterQuitCleanup"),
    permissionIpcStatements("registerIpcHandlers", "handle"),
    mainFunction("relaunchAfterQuitCleanupIfRequested").getText(mainAst),
    `return {
      relaunchRequested: () => shouldRelaunchAfterQuitCleanup,
      finishCleanup: relaunchAfterQuitCleanupIfRequested,
      removeHandlers: () => { ${permissionIpcStatements("cleanupBeforeQuit", "removeHandler")} },
    };`,
  ].join("\n");
  const compiled = ts.transpileModule(program, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  // Execute the real handler bodies without importing Electron's app entrypoint.
  const lifecycle = Function("ipcMain", "app", "process", "setImmediate", "randomUUID", "writePackagedStartupLog", "stopComputerUseAgentForPermissionRestart", compiled)(
    ipcMain, app, { platform, env: {} }, (callback: () => void) => deferred.push(callback), createSessionId, vi.fn(), stopComputerUseAgentForPermissionRestart,
  ) as { relaunchRequested(): boolean; finishCleanup(): void; removeHandlers(): void };

  let api: PermissionApi | undefined;
  const ipcRenderer = {
    invoke: vi.fn(async (channel: string) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`No handler for ${channel}`);
      return handler();
    }),
    on: vi.fn(), send: vi.fn(), removeListener: vi.fn(),
  };
  const electron = {
    contextBridge: { exposeInMainWorld: (_name: string, value: PermissionApi) => { api = value; } },
    ipcRenderer,
  };
  const preloadSource = readFileSync(new URL("../src/preload/preload.cts", import.meta.url), "utf8");
  const preload = ts.transpileModule(preloadSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  Function("require", "module", "exports", "process", preload)(
    (specifier: string) => {
      if (specifier === "electron") return electron;
      throw new Error(`Unexpected preload dependency: ${specifier}`);
    },
    module, module.exports, { platform },
  );
  if (!api) throw new Error("Preload did not expose the Memmy API");
  return { api, app, deferred, handlers, createSessionId, ipcRenderer, stopComputerUseAgentForPermissionRestart, ...lifecycle };
}

describe("Computer History permission IPC", () => {
  it("observes the native permission flags while the settings guide is open", async () => {
    const binary = "/Applications/Memmy.app/Contents/Resources/Memmy Computer Use.app/Contents/MacOS/MemmyComputerUse";
    const helper = "/Applications/Memmy.app/Contents/Resources/Memmy Computer Use.app";
    const guide = vi.fn(async (_reason: unknown, _helper: unknown, controls: GuideControls) => {
      expect(controls.canContinue).toBe(false);
      expect(controls.observe).toBeTypeOf("function");
      expect(await controls.observe!()).toMatchObject({ inputMonitoring: "required" });
      expect(await controls.observe!()).toMatchObject({ inputMonitoring: "granted" });
      expect(await controls.check()).toMatchObject({ inputMonitoring: "granted" });
      return true;
    });
    const runHelperCommand = vi.fn()
      .mockResolvedValueOnce({ stdout: JSON.stringify({ accessibility: true, inputMonitoring: false, screenRecording: false }) })
      .mockResolvedValue({ stdout: JSON.stringify({ accessibility: true, inputMonitoring: true, screenRecording: false }) });
    const compiled = ts.transpileModule(`${mainFunction("guideMemmySystemPermission").getText(mainAst)}\nreturn guideMemmySystemPermission;`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const guidePermission = Function("memmyPermissionOnboarding", "resolveComputerUseBinary", "computerUseApp", "app", "process", "runHelperCommand", "memmyPermissionSnapshot", compiled)(
      { guide }, vi.fn().mockResolvedValue(binary), vi.fn().mockReturnValue(helper),
      { isPackaged: true }, { resourcesPath: "/Applications/Memmy.app/Contents/Resources", env: {} },
      runHelperCommand, memmyPermissionSnapshot,
    ) as (permission: "inputMonitoring") => Promise<boolean>;
    await expect(guidePermission("inputMonitoring")).resolves.toBe(true);
    expect(guide).toHaveBeenCalledWith("inputMonitoring", helper, expect.any(Object));
    expect(runHelperCommand.mock.calls).toEqual([
      [binary, ["__memmy-history", "--permissions"]],
      [binary, ["__memmy-history", "--permissions"]],
      [binary, ["__memmy-history", "--permissions"]],
    ]);
  });

  it("keeps the session stable within a launch and renews it for the next launch", async () => {
    const first = loadPermissionIpc("darwin");
    const second = loadPermissionIpc("darwin");
    const session = await first.api.getComputerHistoryPermissionSessionId();
    expect(session).toMatch(/^[0-9a-f-]{36}$/);
    expect(await first.api.getComputerHistoryPermissionSessionId()).toBe(session);
    expect(await second.api.getComputerHistoryPermissionSessionId()).not.toBe(session);
    expect(first.createSessionId).toHaveBeenCalledTimes(1);
    expect(first.ipcRenderer.invoke).toHaveBeenCalledWith(sessionChannel);
  });

  it("returns from restart IPC before quitting and relaunches once after cleanup", async () => {
    const shell = loadPermissionIpc("darwin");
    await expect(shell.api.restartForComputerHistoryPermissions()).resolves.toBeUndefined();
    expect(shell.ipcRenderer.invoke).toHaveBeenCalledWith(restartChannel);
    expect(shell.relaunchRequested()).toBe(true);
    expect(shell.stopComputerUseAgentForPermissionRestart).toHaveBeenCalledOnce();
    expect(shell.app.quit).not.toHaveBeenCalled();
    expect(shell.app.relaunch).not.toHaveBeenCalled();
    expect(shell.deferred).toHaveLength(1);
    shell.deferred[0]();
    expect(shell.app.quit).toHaveBeenCalledTimes(1);
    expect(shell.app.relaunch).not.toHaveBeenCalled();
    shell.finishCleanup();
    expect(shell.app.relaunch).toHaveBeenCalledTimes(1);
    expect(shell.relaunchRequested()).toBe(false);
    shell.finishCleanup();
    expect(shell.app.relaunch).toHaveBeenCalledTimes(1);
  });

  it.each(["win32", "linux"] as const)("rejects restart on %s without quitting", async (platform) => {
    const shell = loadPermissionIpc(platform);
    await expect(shell.api.restartForComputerHistoryPermissions()).rejects.toThrow(
      "Computer History permissions require macOS",
    );
    expect(shell.relaunchRequested()).toBe(false);
    expect(shell.deferred).toHaveLength(0);
    expect(shell.app.quit).not.toHaveBeenCalled();
    expect(shell.app.relaunch).not.toHaveBeenCalled();
  });

  it("removes both permission handlers during quit cleanup", async () => {
    const shell = loadPermissionIpc("darwin");
    shell.removeHandlers();
    expect(shell.handlers.size).toBe(0);
    await expect(shell.api.getComputerHistoryPermissionSessionId()).rejects.toThrow("No handler");
    await expect(shell.api.restartForComputerHistoryPermissions()).rejects.toThrow("No handler");
    expect(shell.deferred).toHaveLength(0);
  });
});
