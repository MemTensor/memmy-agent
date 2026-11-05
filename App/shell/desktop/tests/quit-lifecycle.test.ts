import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeQuitDiagnostic, type QuitDiagnostic } from "../src/main/quit-diagnostics.js";

// Exercise the actual quit callback and timer, not the startup harness's no-op timer.
const source = ts.createSourceFile("main.ts", readFileSync(new URL("../src/main/main.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const functions = new Set(["armQuitCleanupForceExitTimer", "forceQuitCleanup", "clearQuitCleanupForceExitTimer", "closeRuntimeForQuit", "recordQuitDiagnostic"]);
const variables = new Set(["quitCleanupContext", "quitCleanupForceExitTimer", "APP_QUIT_CLEANUP_FORCE_EXIT_DELAY_MS"]);
const selected = source.statements.filter(statement => {
  if (ts.isFunctionDeclaration(statement)) return functions.has(statement.name?.text ?? "");
  if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.some(d => variables.has(d.name.getText(source)));
  return ts.isExpressionStatement(statement) && statement.getText(source).startsWith('app.on("before-quit",');
});
const code = ts.transpileModule(selected.map(statement => statement.getText(source)).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText;

function setup(options: { stopMemory?: boolean; close?: () => Promise<void>; drain?: () => Promise<void>; terminate?: () => void } = {}) {
  vi.useFakeTimers();
  const records: QuitDiagnostic[] = [];
  const services = {
    agentGateway: { baseUrl: "http://fixture.invalid", bootstrapSecret: "must-not-log" },
    close: vi.fn(options.close ?? (async () => {})),
    terminateSync: vi.fn(options.terminate ?? (() => {}))
  };
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true, getPath: () => "test-user-data", quit: vi.fn(), exit: vi.fn()
  });
  const context = createContext({
    app, Date, setTimeout, clearTimeout, randomUUID, join, process: { platform: "win32", pid: 123 },
    runtimeServices: services, isQuitting: false, isQuitCleanupInProgress: false, isQuitCleanupComplete: false,
    stopMemoryServiceForCurrentQuit: false, hasSingleInstanceLock: true,
    readMacQuitContext: () => null, captureMacPermissionRestartRequest: vi.fn(),
    stopTaskRecordingBeforeExit: async () => {},
    shouldIgnoreStaleReopenQuit: () => false, closeSplashWindow: vi.fn(), hideAppShellForQuit: vi.fn(),
    readStopMemoryServiceOnExitSetting: () => options.stopMemory ?? false,
    writeQuitDiagnostic: (_path: string, record: QuitDiagnostic) => records.push(record),
    writePackagedStartupLog: async () => {}, formatStartupError: () => "test error",
    stopComputerHistoryBeforeExit: vi.fn(options.drain ?? (async () => {})),
    console: { warn: vi.fn() }, relaunchAfterQuitCleanupIfRequested: vi.fn()
  });
  runInContext(code + `
    globalThis.cleanupBeforeQuit = async () => {
      runtimeServices = null;
      await closeRuntimeForQuit(quitCleanupContext);
    };
    globalThis.closeLateServices = async (services) => {
      quitCleanupContext.services = services;
      await closeRuntimeForQuit(quitCleanupContext);
    };`, context);
  const quit = () => app.emit("before-quit", { preventDefault: vi.fn() });
  return { app, records, services, context, quit, events: () => records.map(r => r.event) };
}

afterEach(() => vi.useRealTimers());

describe("production quit lifecycle", () => {
  it.each([false, true])("finishes once with stopMemory=%s and cancels the actual force timer", async stopMemory => {
    const test = setup({ stopMemory });
    test.quit(); test.quit();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(test.events()).toEqual(["start", "history-stopped", "services-closed", "cleanup-complete"]);
    expect(new Set(test.records.map(r => r.quitId)).size).toBe(1);
    expect(test.records.every(r => r.stopMemory === stopMemory)).toBe(true);
    expect(test.services.close).toHaveBeenCalledExactlyOnceWith({ stopMemory });
    expect(test.services.terminateSync).not.toHaveBeenCalled();
    expect(test.app.quit).toHaveBeenCalledOnce();
    expect(test.app.exit).not.toHaveBeenCalled();
  });

  it.each([false, true])("retains the detached services and forces a hanging close with stopMemory=%s", async stopMemory => {
    let finish!: () => void;
    const test = setup({ stopMemory, close: () => new Promise<void>(resolve => { finish = resolve; }) });
    test.quit();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(test.context.runtimeServices).toBeNull();
    expect(test.app.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(test.services.terminateSync).toHaveBeenCalledExactlyOnceWith({ stopMemory, timeoutMs: 2_000 });
    expect(test.events()).toEqual(["start", "history-stopped", "force-start", "force-complete"]);
    expect(test.records.at(-1)).toMatchObject({ elapsedMs: 5_000, phase: "services-close" });
    finish(); await vi.advanceTimersByTimeAsync(0);
    test.quit();
    expect(test.app.quit).not.toHaveBeenCalled();
    expect(test.app.exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(test.events()).not.toContain("cleanup-complete");
  });

  it("does not run graceful cleanup or log success after a late stop response", async () => {
    let finish!: () => void;
    const test = setup({ drain: () => new Promise<void>(resolve => { finish = resolve; }) });
    test.quit();
    await vi.advanceTimersByTimeAsync(5_000);
    finish(); await vi.advanceTimersByTimeAsync(0);
    expect(test.events()).toEqual(["start", "force-start", "force-complete"]);
    expect(test.services.close).not.toHaveBeenCalled();
    expect(test.app.quit).not.toHaveBeenCalled();
  });

  it("records a failed drain and still closes services", async () => {
    const test = setup({ drain: async () => { throw new Error("private body and token"); } });
    test.quit(); await vi.advanceTimersByTimeAsync(0);
    expect(test.events()).toEqual(["start", "history-stop-failed", "services-closed", "cleanup-complete"]);
    expect(JSON.stringify(test.records)).not.toMatch(/private|must-not-log/);
  });

  it("records a failed cleanup without declaring normal completion", async () => {
    const test = setup({ close: async () => { throw new Error("fixture failure"); } });
    test.quit(); await vi.advanceTimersByTimeAsync(10_000);
    expect(test.events()).toEqual(["start", "history-stopped", "cleanup-failed", "force-start", "force-complete"]);
    expect(test.app.quit).not.toHaveBeenCalled();
    expect(test.app.exit).toHaveBeenCalledOnce();
  });

  it("still exits when synchronous termination throws", async () => {
    const test = setup({ close: () => new Promise(() => {}), terminate: () => { throw new Error("fixture termination error"); } });
    test.quit(); await vi.advanceTimersByTimeAsync(5_000);
    expect(test.events().slice(-2)).toEqual(["force-start", "force-failed"]);
    expect(test.app.exit).toHaveBeenCalledOnce();
  });

  it("terminates services materialized after quit has completed with the same policy", async () => {
    const test = setup({ stopMemory: true });
    test.quit(); await vi.advanceTimersByTimeAsync(0);
    const late = { terminateSync: vi.fn() };
    await test.context.closeLateServices(late);
    expect(late.terminateSync).toHaveBeenCalledExactlyOnceWith({ stopMemory: true, timeoutMs: 2_000 });
  });
});

describe("persistent quit diagnostics", () => {
  it("survives immediate exit of a fresh process", () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-quit-log-"));
    const file = join(root, "logs", "quit.jsonl");
    const record = { schemaVersion: 1, quitId: "fixture", pid: 123, timestamp: "fixture-time", elapsedMs: 5000, stopMemory: false, phase: "services-close", event: "force-start" } satisfies QuitDiagnostic;
    try {
      const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
        import { writeQuitDiagnostic } from ${JSON.stringify(new URL("../src/main/quit-diagnostics.ts", import.meta.url).href)};
        writeQuitDiagnostic(${JSON.stringify(file)}, ${JSON.stringify(record)});
        process.exit(0);
      `], { encoding: "utf8", timeout: 10_000 });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(record);
      expect(() => writeQuitDiagnostic(join(file, "cannot-be-a-directory"), record)).not.toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
