import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureWindowsStoreLegacyCleanupBroker,
  recoverWindowsStoreLegacyCleanupJournal
} from "../src/main/windows-store-legacy-broker.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  lstat: vi.fn()
}));

afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

describe("Windows Store legacy cleanup broker", () => {
  const baseOptions = {
    platform: "win32" as const,
    isPackaged: true,
    isWindowsStore: false,
    resourcesPath: "D:\\memmy\\resources",
    packageFamilyName: "Memtensor.MemmyAgent_eyack96k521x2"
  };

  it("starts the fixed helper before the NSIS app enters any Store context", async () => {
    const runHelper = vi.fn(async () => undefined);
    await expect(ensureWindowsStoreLegacyCleanupBroker(baseOptions, { runHelper }))
      .resolves.toEqual({ status: "ready" });
    expect(runHelper).toHaveBeenCalledWith(
      "D:\\memmy\\resources\\native\\MemmyStoreUpdate.exe",
      [
        "ensure-legacy-cleanup-broker",
        "--package-family-name",
        "Memtensor.MemmyAgent_eyack96k521x2"
      ]
    );
  });

  it.each([
    { platform: "linux" as const },
    { isPackaged: false },
    { isWindowsStore: true }
  ])("does not start a broker outside the unpackaged Windows app", async (override) => {
    const runHelper = vi.fn(async () => undefined);
    await expect(ensureWindowsStoreLegacyCleanupBroker({ ...baseOptions, ...override }, { runHelper }))
      .resolves.toEqual({ status: "not-applicable" });
    expect(runHelper).not.toHaveBeenCalled();
  });

  it("rejects an invalid package family before invoking native code", async () => {
    const runHelper = vi.fn(async () => undefined);
    await expect(ensureWindowsStoreLegacyCleanupBroker({
      ...baseOptions,
      packageFamilyName: "../wrong"
    }, { runHelper })).rejects.toThrow("package family is invalid");
    expect(runHelper).not.toHaveBeenCalled();
  });

  it("keeps the Store acquisition route available when optional cleanup or journaling fails", async () => {
    const mainSource = await readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
    const start = mainSource.indexOf("async function openWindowsStoreMigration(");
    const end = mainSource.indexOf("function createCurrentWindowsStoreTransitionBinding(", start);
    const openMigrationSource = mainSource.slice(start, end);

    const brokerIndex = openMigrationSource.indexOf(
      "await ensureCurrentWindowsStoreLegacyCleanupBroker();"
    );
    const journalWriteIndex = openMigrationSource.indexOf(
      "await writeWindowsStoreTransitionState(statePath, state);"
    );
    const installerOpenIndex = openMigrationSource.indexOf(
      "await installer.launchPrepared(activeOffer.policy);"
    );
    expect(brokerIndex).toBeGreaterThan(-1);
    expect(journalWriteIndex).toBeGreaterThan(brokerIndex);
    expect(installerOpenIndex).toBeGreaterThan(journalWriteIndex);
    expect(openMigrationSource).not.toContain("shell.openExternal");
    expect(openMigrationSource).toContain("continuing with data discovery");
    expect(openMigrationSource).not.toContain("await requireCurrentWindowsStoreLegacyCleanupBroker();");
  });

  it("creates the resident broker only when handing off to the Store installer", async () => {
    const mainSource = await readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
    const handoffStart = mainSource.indexOf("async function openWindowsStoreMigration(");
    const handoffEnd = mainSource.indexOf("function createCurrentWindowsStoreTransitionBinding(", handoffStart);
    const otherFlows = mainSource.slice(0, handoffStart) + mainSource.slice(handoffEnd);
    expect(otherFlows).not.toContain("await ensureCurrentWindowsStoreLegacyCleanupBroker();");
    const installer = await readFile(new URL("../build/installer-win-unsigned.nsh", import.meta.url), "utf8");
    expect(installer).not.toContain("ensure-legacy-cleanup-broker");
  });
});

describe("one-shot Windows orphan cleanup journal recovery", () => {
  const options = {
    platform: "win32" as const,
    isPackaged: true,
    isWindowsStore: false,
    resourcesPath: "D:\\memmy\\resources",
    localAppDataPath: "C:\\Users\\fixture\\AppData\\Local"
  };
  const journalPath = "C:\\Users\\fixture\\AppData\\Local\\Memmy\\store-transition\\broker\\cleanup-journal-v1.bin";

  it("runs recovery before the lifetime barrier and preserves that barrier after recovery failure", async () => {
    const source = await readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
    const startup = source.slice(source.indexOf("app.whenReady().then(async () => {"));
    const recovery = startup.indexOf("await recoverWindowsStoreLegacyCleanupJournal({");
    const failure = startup.indexOf('console.warn("Windows orphan cleanup journal recovery deferred:", error);');
    const barrier = startup.indexOf("if (await applyWindowsStoreTransitionSourceBarrier())");
    expect(recovery).toBeGreaterThan(-1);
    expect(failure).toBeGreaterThan(recovery);
    expect(barrier).toBeGreaterThan(failure);
    expect(startup.slice(failure, barrier)).not.toMatch(/\b(return|throw)\b/u);
  });

  it.each([
    { platform: "linux" as const }, { isPackaged: false }, { isWindowsStore: true }
  ])("skips all disk and native work outside the packaged NSIS app: %j", async (override) => {
    await expect(recoverWindowsStoreLegacyCleanupJournal({ ...options, ...override }))
      .resolves.toEqual({ status: "not-applicable" });
    expect(lstat).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  });

  it("does not invoke native code when the fixed journal is absent", async () => {
    vi.mocked(lstat).mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    await expect(recoverWindowsStoreLegacyCleanupJournal(options))
      .resolves.toEqual({ status: "no-journal" });
    expect(lstat).toHaveBeenCalledExactlyOnceWith(journalPath);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("propagates journal inspection errors without attempting cleanup", async () => {
    const failure = Object.assign(new Error("access denied"), { code: "EACCES" });
    vi.mocked(lstat).mockRejectedValue(failure);
    await expect(recoverWindowsStoreLegacyCleanupJournal(options)).rejects.toBe(failure);
    expect(execFile).not.toHaveBeenCalled();
  });

  it.each([
    { resourcesPath: "relative" }, { localAppDataPath: "C:relative" }, { localAppDataPath: " C:\\Local" }
  ])("rejects an invalid recovery path: %j", async (override) => {
    await expect(recoverWindowsStoreLegacyCleanupJournal({ ...options, ...override }))
      .rejects.toThrow("path must be absolute");
    expect(lstat).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  });

  it.each([false, true])("rejects a non-regular journal, symlink = %s", async (symbolicLink) => {
    vi.mocked(lstat).mockResolvedValue({
      isFile: () => symbolicLink, isSymbolicLink: () => symbolicLink
    } as Awaited<ReturnType<typeof lstat>>);
    await expect(recoverWindowsStoreLegacyCleanupJournal(options)).rejects.toThrow("regular file");
    expect(execFile).not.toHaveBeenCalled();
  });

  it.each(["recovered", "no-journal"] as const)("returns native %s using only the fixed one-shot command", async (status) => {
    const runHelper = vi.fn(async () => JSON.stringify({ status }));
    await expect(recoverWindowsStoreLegacyCleanupJournal(options, {
      journalExists: async () => true, runHelper
    })).resolves.toEqual({ status });
    expect(runHelper).toHaveBeenCalledExactlyOnceWith(
      "D:\\memmy\\resources\\native\\MemmyStoreUpdate.exe", ["recover-legacy-cleanup-journal"]
    );
  });

  it.each(["null", "{}", '{"status":"ready"}', "not-json"])("rejects invalid native output %s", async (output) => {
    await expect(recoverWindowsStoreLegacyCleanupJournal(options, {
      journalExists: async () => true, runHelper: async () => output
    })).rejects.toThrow();
  });

  const startNativeFixture = async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => false)
    });
    vi.mocked(execFile).mockReturnValue(child as ReturnType<typeof execFile>);
    const result = recoverWindowsStoreLegacyCleanupJournal(options, { journalExists: async () => true });
    await Promise.resolve();
    expect(execFile).toHaveBeenCalledExactlyOnceWith(
      "D:\\memmy\\resources\\native\\MemmyStoreUpdate.exe",
      ["recover-legacy-cleanup-journal"],
      { timeout: 15_000, windowsHide: true, encoding: "utf8" }, expect.any(Function)
    );
    const callback = vi.mocked(execFile).mock.calls[0][3] as
      (error: Error | null, stdout: string, stderr: string) => void;
    return { child, result, callback };
  };

  it("rejects at 15 seconds even if killing the native helper never produces a callback or close", async () => {
    vi.useFakeTimers();
    const { child, result, callback } = await startNativeFixture();
    const rejection = expect(result).rejects.toThrow("timed out after 15000ms");
    await vi.advanceTimersByTimeAsync(14_999);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    callback(null, '{"status":"recovered"}', "");
    await expect(result).rejects.toThrow("timed out");
  });

  it.each([false, true])("clears the watchdog after the native callback, failure = %s", async (failure) => {
    vi.useFakeTimers();
    const { child, result, callback } = await startNativeFixture();
    const error = new Error("recovery refused: Store registered or lock busy");
    if (failure) {
      const rejection = expect(result).rejects.toBe(error);
      callback(error, "", "");
      await rejection;
    } else {
      callback(null, '{"status":"recovered"}', "");
      await expect(result).resolves.toEqual({ status: "recovered" });
    }
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("clears the watchdog if spawning throws synchronously", async () => {
    vi.useFakeTimers();
    vi.mocked(execFile).mockImplementation(() => { throw new Error("spawn failed"); });
    await expect(recoverWindowsStoreLegacyCleanupJournal(options, { journalExists: async () => true }))
      .rejects.toThrow("spawn failed");
    expect(vi.getTimerCount()).toBe(0);
  });
});
