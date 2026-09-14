import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  prepareWindowsStoreInstallHandoff,
  startWindowsStoreInstallHandoff,
  type WindowsStoreInstallHandoff,
  type WindowsStoreInstallHandoffChild
} from "../src/main/windows-store-install-handoff.js";
import { readWindowsStoreInstallState } from "../src/main/windows-store-install-state.js";

const temporaryDirectories: string[] = [];
const builtHelperPath = process.env.MEMMY_STORE_UPDATE_HELPER_PATH ??
  fileURLToPath(new URL("../dist/native/MemmyStoreUpdate.exe", import.meta.url));

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe("Windows Store install handoff", () => {
  it("copies an external finalizer and writes a baseline-keyed manual install barrier", async () => {
    const root = await createTemporaryDirectory();
    const resourcesPath = join(root, "resources");
    const userDataPath = join(root, "LocalState", "Memmy");
    const localAppDataPath = join(root, "LocalAppData");
    const helperPath = join(resourcesPath, "native", "MemmyStoreUpdate.exe");
    await mkdir(join(resourcesPath, "native"), { recursive: true });
    await writeFile(helperPath, "native helper", "utf8");

    const handoff = await prepareWindowsStoreInstallHandoff({
      resourcesPath,
      userDataPath,
      localAppDataPath,
      mode: "manual",
      baselinePackageVersion: "1.0.12.0",
      baselinePackageFullName: "NeutralCo.MemmyStoreTest_1.0.12.0_x64__abc123def4567",
      oldPid: 9988,
      aumid: "NeutralCo.MemmyStoreTest_abc123def4567!Memmy",
      packageFamilyName: "NeutralCo.MemmyStoreTest_abc123def4567",
      now: new Date("2026-08-05T10:00:00.000Z")
    });

    expect(handoff.helperPath).toBe(helperPath);
    expect(handoff.externalHelperPath).toBe(join(
      localAppDataPath,
      "Memmy",
      "store-update",
      "NeutralCo.MemmyStoreTest_abc123def4567",
      "MemmyStoreUpdate.exe"
    ));
    expect(handoff.statePath).toBe(join(
      userDataPath,
      "store-update",
      "NeutralCo.MemmyStoreTest_abc123def4567",
      "store-update-install-state-v2.json"
    ));
    expect(handoff.resultPath).toBe(join(
      userDataPath,
      "store-update",
      "NeutralCo.MemmyStoreTest_abc123def4567",
      "handoff",
      "store-update-result-v1.txt"
    ));
    await expect(readFile(handoff.externalHelperPath, "utf8")).resolves.toBe("native helper");
    await expect(readWindowsStoreInstallState(handoff.statePath)).resolves.toMatchObject({
      mode: "manual",
      status: "installing",
      baselinePackageVersion: "1.0.12.0",
      baselinePackageFullName: "NeutralCo.MemmyStoreTest_1.0.12.0_x64__abc123def4567",
      autoActivateOnSuccess: true
    });
  });

  it("starts the packaged helper detached without Store UI or inherited pipes", async () => {
    const root = await createTemporaryDirectory();
    const resourcesPath = join(root, "resources");
    const userDataPath = join(root, "LocalState", "Memmy");
    const localAppDataPath = join(root, "LocalAppData");
    const helperPath = join(resourcesPath, "native", "MemmyStoreUpdate.exe");
    await mkdir(join(resourcesPath, "native"), { recursive: true });
    await writeFile(helperPath, "native helper", "utf8");
    const handoff = await prepareWindowsStoreInstallHandoff({
      resourcesPath,
      userDataPath,
      localAppDataPath,
      mode: "silent",
      baselinePackageVersion: "1.0.12.0",
      baselinePackageFullName: "NeutralCo.MemmyStoreTest_1.0.12.0_x64__abc123def4567",
      oldPid: 9988,
      aumid: "NeutralCo.MemmyStoreTest_abc123def4567!Memmy",
      packageFamilyName: "NeutralCo.MemmyStoreTest_abc123def4567"
    });
    const unref = vi.fn();
    const child = Object.assign(new EventEmitter(), { pid: 1234, unref });
    const spawnDetached = vi.fn((): WindowsStoreInstallHandoffChild => child);

    const pid = startWindowsStoreInstallHandoff(handoff, { spawnDetached });

    expect(pid).toBe(1234);
    expect(unref).toHaveBeenCalledTimes(1);
    expect(child.listenerCount("error")).toBe(1);
    expect(spawnDetached).toHaveBeenCalledTimes(1);
    const [executable, args, options] = spawnDetached.mock.calls[0];
    expect(executable).toBe(helperPath);
    expect(args[0]).toBe("handoff-install");
    expect(args).toContain("--external-helper-path");
    expect(args).toContain("--state-path");
    expect(args).toContain("--result-path");
    expect(args).toContain("--log-path");
    expect(args).toContain("--old-pid");
    expect(args).toContain("9988");
    expect(args).toContain("--mode");
    expect(args).toContain("silent");
    expect(args).not.toContain("install-user");
    expect(args).not.toContain("--hwnd");
    expect(options).toEqual({ detached: true, stdio: "ignore", windowsHide: true });
  });

  it("reports a synchronous detached spawn failure with the original cause", async () => {
    const handoff = await prepareSilentTestHandoff();
    const cause = Object.assign(new Error("access denied"), { code: "EACCES" });
    const spawnDetached = vi.fn((): WindowsStoreInstallHandoffChild => {
      throw cause;
    });

    let thrown: unknown;
    try {
      startWindowsStoreInstallHandoff(handoff, { spawnDetached });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("Microsoft Store update handoff failed to spawn");
    expect((thrown as Error & { cause?: unknown }).cause).toBe(cause);
    expect(spawnDetached).toHaveBeenCalledOnce();
  });

  it("reports a missing child PID and still consumes the later child error event", async () => {
    const handoff = await prepareSilentTestHandoff();
    const unref = vi.fn();
    const child = Object.assign(new EventEmitter(), { pid: undefined, unref });
    const spawnDetached = vi.fn((): WindowsStoreInstallHandoffChild => child);
    const reportChildError = vi.fn();

    expect(() => startWindowsStoreInstallHandoff(handoff, {
      spawnDetached,
      reportChildError
    })).toThrow("Microsoft Store update handoff did not report a process ID");

    const childError = Object.assign(new Error("spawn access denied"), { code: "EACCES" });
    expect(() => child.emit("error", childError)).not.toThrow();
    expect(reportChildError).toHaveBeenCalledOnce();
    expect(reportChildError).toHaveBeenCalledWith(childError);
    expect(unref).not.toHaveBeenCalled();
  });

  it("consumes and reports an asynchronous child error after returning the PID", async () => {
    const handoff = await prepareSilentTestHandoff();
    const unref = vi.fn();
    const child = Object.assign(new EventEmitter(), { pid: 4321, unref });
    const spawnDetached = vi.fn((): WindowsStoreInstallHandoffChild => child);
    const reportChildError = vi.fn();

    expect(startWindowsStoreInstallHandoff(handoff, {
      spawnDetached,
      reportChildError
    })).toBe(4321);

    const childError = Object.assign(new Error("detached child failed"), { code: "UNKNOWN" });
    expect(() => child.emit("error", childError)).not.toThrow();
    expect(reportChildError).toHaveBeenCalledOnce();
    expect(reportChildError).toHaveBeenCalledWith(childError);
    expect(unref).toHaveBeenCalledOnce();
  });

  it("rejects a helper that is absent from the packaged native resource boundary", async () => {
    const root = await createTemporaryDirectory();

    await expect(prepareWindowsStoreInstallHandoff({
      resourcesPath: join(root, "resources"),
      userDataPath: join(root, "LocalState", "Memmy"),
      localAppDataPath: join(root, "LocalAppData"),
      mode: "manual",
      baselinePackageVersion: "1.0.12.0",
      baselinePackageFullName: "NeutralCo.MemmyStoreTest_1.0.12.0_x64__abc123def4567",
      oldPid: 9988,
      aumid: "NeutralCo.MemmyStoreTest_abc123def4567!Memmy",
      packageFamilyName: "NeutralCo.MemmyStoreTest_abc123def4567"
    })).rejects.toThrow("Store update helper is unavailable");
  });

  it.skipIf(process.platform !== "win32" || !existsSync(builtHelperPath))(
    "persists a recoverable failure from the real unpackaged finalizer",
    async () => {
      const root = await createTemporaryDirectory();
      const packageFamilyName = "NeutralCo.MemmyStoreTest_abc123def4567";
      const namespaceDirectory = join(root, "store-update", packageFamilyName);
      const statePath = join(namespaceDirectory, "store-update-install-state-v2.json");
      const handoffDirectory = join(namespaceDirectory, "handoff");
      const resultPath = join(handoffDirectory, "store-update-result-v1.txt");
      const logPath = join(handoffDirectory, "store-update-handoff.jsonl");
      await mkdir(handoffDirectory, { recursive: true });
      await writeFile(
        resultPath,
        "exception\n0x80073CF9\nsimulated deployment failure\n",
        "utf8"
      );

      const result = spawnSync(builtHelperPath, [
        "finalize-store-update",
        "--state-path", statePath,
        "--result-path", resultPath,
        "--log-path", logPath,
        "--old-pid", String(process.pid),
        "--baseline-package-version", "65535.0.0.0",
        "--baseline-package-full-name", "NeutralCo.MemmyStoreTest_65535.0.0.0_x64__abc123def4567",
        "--created-at", "2026-08-05T10:00:00.000Z",
        "--aumid", "NeutralCo.MemmyStoreTest_abc123def4567!Memmy",
        "--package-family-name", packageFamilyName,
        "--mode", "silent"
      ], {
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      await expect(readWindowsStoreInstallState(statePath)).resolves.toMatchObject({
        status: "failed",
        baselinePackageVersion: "65535.0.0.0",
        baselinePackageFullName: "NeutralCo.MemmyStoreTest_65535.0.0.0_x64__abc123def4567",
        nativeState: "exception",
        hresult: "0x80073CF9",
        failureReason: "simulated deployment failure",
        failurePending: true
      });
      await expect(readFile(logPath, "utf8")).resolves.toContain('"event":"finalizer-failed"');
    }
  );
});

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "memmy-store-install-handoff-"));
  temporaryDirectories.push(directory);
  return directory;
};

const prepareSilentTestHandoff = async (): Promise<WindowsStoreInstallHandoff> => {
  const root = await createTemporaryDirectory();
  const resourcesPath = join(root, "resources");
  const helperPath = join(resourcesPath, "native", "MemmyStoreUpdate.exe");
  await mkdir(join(resourcesPath, "native"), { recursive: true });
  await writeFile(helperPath, "native helper", "utf8");
  return prepareWindowsStoreInstallHandoff({
    resourcesPath,
    userDataPath: join(root, "LocalState", "Memmy"),
    localAppDataPath: join(root, "LocalAppData"),
    mode: "silent",
    baselinePackageVersion: "1.0.12.0",
    baselinePackageFullName: "NeutralCo.MemmyStoreTest_1.0.12.0_x64__abc123def4567",
    oldPid: 9988,
    aumid: "NeutralCo.MemmyStoreTest_abc123def4567!Memmy",
    packageFamilyName: "NeutralCo.MemmyStoreTest_abc123def4567"
  });
};
