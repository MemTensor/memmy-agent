import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWindowsStoreInstallSingleFlight,
  prepareWindowsStoreInstallHandoff,
  startWindowsStoreInstallHandoff,
  type WindowsStoreInstallHandoff,
  type WindowsStoreInstallHandoffChild
} from "../src/main/windows-store-install-handoff.js";
import {
  createWindowsStoreInstallState,
  readWindowsStoreInstallState,
  writeWindowsStoreInstallState
} from "../src/main/windows-store-install-state.js";

const temporaryDirectories: string[] = [];
const builtHelperPath = process.env.MEMMY_STORE_UPDATE_HELPER_PATH ??
  fileURLToPath(new URL("../dist/native/MemmyStoreUpdate.exe", import.meta.url));

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe("Windows Store install handoff", () => {
  it("uses the native handle-resolved user-profile finalizer before writing the install barrier", async () => {
    const root = await createTemporaryDirectory();
    const resourcesPath = join(root, "resources");
    const userDataPath = join(root, "LocalState", "Memmy");
    const helperPath = join(resourcesPath, "native", "MemmyStoreUpdate.exe");
    await mkdir(join(resourcesPath, "native"), { recursive: true });
    await writeFile(helperPath, "native helper", "utf8");

    const attemptId = "12345678-1234-4234-8234-123456789abc";
    const resolvedExternalHelperPath = join(
      root,
      "PhysicalProfile",
      ".memmy",
      "store-update",
      "NeutralCo.MemmyStoreTest_abc123def4567",
      attemptId,
      "MemmyStoreUpdate.exe"
    );
    const stageFinalizer = vi.fn(async () => ({
      type: "finalizer-staged" as const,
      attemptId,
      path: resolvedExternalHelperPath,
      externalReadyPath: join(dirname(resolvedExternalHelperPath), "external-ready-v1.json"),
      installerReadyPath: join(dirname(resolvedExternalHelperPath), "installer-ready-v1.json"),
      resultPath: join(dirname(resolvedExternalHelperPath), "store-update-result-v1.txt"),
      logPath: join(dirname(resolvedExternalHelperPath), "store-update-handoff.jsonl"),
      size: 13,
      sha256: "a".repeat(64)
    }));

    const handoff = await prepareWindowsStoreInstallHandoff({
      resourcesPath,
      userDataPath,
      mode: "manual",
      baselinePackageVersion: "1.0.12.0",
      baselinePackageFullName: "NeutralCo.MemmyStoreTest_1.0.12.0_x64__abc123def4567",
      oldPid: 9988,
      aumid: "NeutralCo.MemmyStoreTest_abc123def4567!Memmy",
      packageFamilyName: "NeutralCo.MemmyStoreTest_abc123def4567",
      now: new Date("2026-08-05T10:00:00.000Z")
    }, {
      createAttemptId: () => attemptId,
      stageFinalizer
    });

    expect(handoff.helperPath).toBe(helperPath);
    expect(handoff.externalHelperPath).toBe(resolvedExternalHelperPath);
    expect(handoff.externalReadyPath).toBe(join(
      root,
      "PhysicalProfile",
      ".memmy",
      "store-update",
      "NeutralCo.MemmyStoreTest_abc123def4567",
      attemptId,
      "external-ready-v1.json"
    ));
    expect(handoff.installerReadyPath).toBe(join(
      root,
      "PhysicalProfile",
      ".memmy",
      "store-update",
      "NeutralCo.MemmyStoreTest_abc123def4567",
      attemptId,
      "installer-ready-v1.json"
    ));
    expect(stageFinalizer).toHaveBeenCalledWith({
      resourcesPath,
      packageFamilyName: "NeutralCo.MemmyStoreTest_abc123def4567",
      attemptId
    });
    expect(handoff.statePath).toBe(join(
      userDataPath,
      "store-update",
      "NeutralCo.MemmyStoreTest_abc123def4567",
      "store-update-install-state-v2.json"
    ));
    expect(handoff.resultPath).toBe(join(
      root,
      "PhysicalProfile",
      ".memmy",
      "store-update",
      "NeutralCo.MemmyStoreTest_abc123def4567",
      attemptId,
      "store-update-result-v1.txt"
    ));
    await expect(readWindowsStoreInstallState(handoff.statePath)).resolves.toMatchObject({
      mode: "manual",
      status: "installing",
      attemptId,
      baselinePackageVersion: "1.0.12.0",
      baselinePackageFullName: "NeutralCo.MemmyStoreTest_1.0.12.0_x64__abc123def4567",
      autoActivateOnSuccess: true
    });
  });

  it("starts the packaged helper detached without Store UI or inherited pipes", async () => {
    const root = await createTemporaryDirectory();
    const resourcesPath = join(root, "resources");
    const userDataPath = join(root, "LocalState", "Memmy");
    const helperPath = join(resourcesPath, "native", "MemmyStoreUpdate.exe");
    await mkdir(join(resourcesPath, "native"), { recursive: true });
    await writeFile(helperPath, "native helper", "utf8");
    const handoff = await prepareWindowsStoreInstallHandoff({
      resourcesPath,
      userDataPath,
      mode: "silent",
      baselinePackageVersion: "1.0.12.0",
      baselinePackageFullName: "NeutralCo.MemmyStoreTest_1.0.12.0_x64__abc123def4567",
      oldPid: 9988,
      aumid: "NeutralCo.MemmyStoreTest_abc123def4567!Memmy",
      packageFamilyName: "NeutralCo.MemmyStoreTest_abc123def4567"
    }, {
      createAttemptId: () => "12345678-1234-4234-8234-123456789abc",
      stageFinalizer: async ({ packageFamilyName, attemptId }) => ({
        type: "finalizer-staged",
        attemptId,
        path: join(root, "PhysicalProfile", ".memmy", "store-update", packageFamilyName, attemptId, "MemmyStoreUpdate.exe"),
        externalReadyPath: join(root, "PhysicalProfile", ".memmy", "store-update", packageFamilyName, attemptId, "external-ready-v1.json"),
        installerReadyPath: join(root, "PhysicalProfile", ".memmy", "store-update", packageFamilyName, attemptId, "installer-ready-v1.json"),
        resultPath: join(root, "PhysicalProfile", ".memmy", "store-update", packageFamilyName, attemptId, "store-update-result-v1.txt"),
        logPath: join(root, "PhysicalProfile", ".memmy", "store-update", packageFamilyName, attemptId, "store-update-handoff.jsonl"),
        size: 13,
        sha256: "a".repeat(64)
      })
    });
    const unref = vi.fn();
    const child = Object.assign(new EventEmitter(), { pid: 1234, unref, kill: vi.fn(() => true) });
    const spawnDetached = vi.fn((): WindowsStoreInstallHandoffChild => child);
    let readySignal: AbortSignal | undefined;
    const waitForReady = vi.fn(async (_path: string, _timeoutMs: number, signal: AbortSignal) => {
      readySignal = signal;
      return createReadyReceipt(handoff, 1234);
    });
    const isProcessAlive = vi.fn(() => true);

    const pid = await startWindowsStoreInstallHandoff(handoff, {
      spawnDetached,
      waitForReady,
      isProcessAlive
    });

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
    expect(args).toContain("--external-ready-path");
    expect(args).toContain(handoff.externalReadyPath);
    expect(args).toContain("--ready-path");
    expect(args).toContain(handoff.installerReadyPath);
    expect(args).toContain("--old-pid");
    expect(args).toContain("9988");
    expect(args).toContain("--mode");
    expect(args).toContain("silent");
    expect(args).not.toContain("install-user");
    expect(args).not.toContain("--hwnd");
    expect(options).toEqual({ detached: true, stdio: "ignore", windowsHide: true });
    expect(waitForReady).toHaveBeenCalledWith(
      handoff.installerReadyPath,
      15_000,
      expect.any(AbortSignal)
    );
    expect(readySignal?.aborted).toBe(true);
    expect(isProcessAlive.mock.calls).toEqual([[1234], [5678]]);
  });

  it("reports a synchronous detached spawn failure with the original cause", async () => {
    const handoff = await prepareSilentTestHandoff();
    const cause = Object.assign(new Error("access denied"), { code: "EACCES" });
    const spawnDetached = vi.fn((): WindowsStoreInstallHandoffChild => {
      throw cause;
    });

    let thrown: unknown;
    try {
      await startWindowsStoreInstallHandoff(handoff, { spawnDetached });
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
    const kill = vi.fn(() => true);
    const child = Object.assign(new EventEmitter(), { pid: undefined, unref, kill });
    const spawnDetached = vi.fn((): WindowsStoreInstallHandoffChild => child);
    const reportChildError = vi.fn();

    await expect(startWindowsStoreInstallHandoff(handoff, {
      spawnDetached,
      reportChildError
    })).rejects.toThrow("Microsoft Store update handoff did not report a process ID");

    const childError = Object.assign(new Error("spawn access denied"), { code: "EACCES" });
    expect(() => child.emit("error", childError)).not.toThrow();
    expect(reportChildError).toHaveBeenCalledOnce();
    expect(reportChildError).toHaveBeenCalledWith(childError);
    expect(kill).toHaveBeenCalledOnce();
    expect(unref).not.toHaveBeenCalled();
  });

  it.each(["exit", "close"] as const)(
    "rejects and kills a packaged handoff child that emits %s before acknowledgment",
    async (event) => {
      const handoff = await prepareSilentTestHandoff();
      const unref = vi.fn();
      const kill = vi.fn(() => true);
      const child = Object.assign(new EventEmitter(), { pid: 4321, unref, kill });
      let readySignal: AbortSignal | undefined;
      const pending = startWindowsStoreInstallHandoff(handoff, {
        spawnDetached: () => child,
        waitForReady: async (_path, _timeoutMs, signal) => {
          readySignal = signal;
          return new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }
      });

      child.emit(event, 0, null);

      await expect(pending).rejects.toThrow(
        `${event === "exit" ? "exited" : "closed"} before installer readiness`
      );
      expect(readySignal?.aborted).toBe(true);
      expect(kill).toHaveBeenCalledOnce();
      expect(unref).not.toHaveBeenCalled();
    }
  );

  it("rejects and kills a packaged handoff child error before acknowledgment", async () => {
    const handoff = await prepareSilentTestHandoff();
    const unref = vi.fn();
    const kill = vi.fn(() => true);
    const child = Object.assign(new EventEmitter(), { pid: 4321, unref, kill });
    const reportChildError = vi.fn();
    const pending = startWindowsStoreInstallHandoff(handoff, {
      spawnDetached: () => child,
      reportChildError,
      waitForReady: async () => new Promise<never>(() => undefined)
    });
    const childError = new Error("packaged helper startup failed");

    child.emit("error", childError);

    await expect(pending).rejects.toThrow("failed before installer readiness");
    expect(reportChildError).toHaveBeenCalledWith(childError);
    expect(kill).toHaveBeenCalledOnce();
    expect(unref).not.toHaveBeenCalled();
  });

  it("consumes and reports an asynchronous child error after returning the PID", async () => {
    const handoff = await prepareSilentTestHandoff();
    const unref = vi.fn();
    const child = Object.assign(new EventEmitter(), { pid: 4321, unref, kill: vi.fn(() => true) });
    const spawnDetached = vi.fn((): WindowsStoreInstallHandoffChild => child);
    const reportChildError = vi.fn();

    await expect(startWindowsStoreInstallHandoff(handoff, {
      spawnDetached,
      reportChildError,
      waitForReady: async () => createReadyReceipt(handoff, 4321),
      isProcessAlive: () => true
    })).resolves.toBe(4321);

    const childError = Object.assign(new Error("detached child failed"), { code: "UNKNOWN" });
    expect(() => child.emit("error", childError)).not.toThrow();
    expect(reportChildError).toHaveBeenCalledOnce();
    expect(reportChildError).toHaveBeenCalledWith(childError);
    expect(unref).toHaveBeenCalledOnce();
  });

  it("keeps the old app alive when installer readiness is not acknowledged", async () => {
    const handoff = await prepareSilentTestHandoff();
    const unref = vi.fn();
    const kill = vi.fn(() => true);
    const child = Object.assign(new EventEmitter(), { pid: 4321, unref, kill });
    const spawnDetached = vi.fn((): WindowsStoreInstallHandoffChild => child);

    await expect(startWindowsStoreInstallHandoff(handoff, {
      spawnDetached,
      waitForReady: async () => {
        throw new Error("Microsoft Store update installer did not become ready within 15000ms");
      }
    })).rejects.toThrow("did not become ready");

    expect(kill).toHaveBeenCalledOnce();
    expect(unref).not.toHaveBeenCalled();
  });

  it.each([
    ["attempt", (receipt: ReturnType<typeof createReadyReceipt>) => ({
      ...receipt,
      attemptId: "87654321-4321-4321-8321-cba987654321"
    })],
    ["path", (receipt: ReturnType<typeof createReadyReceipt>) => ({
      ...receipt,
      path: `${receipt.path}.stale`
    })],
    ["hash", (receipt: ReturnType<typeof createReadyReceipt>) => ({
      ...receipt,
      sha256: "b".repeat(64)
    })],
    ["packaged pid", (receipt: ReturnType<typeof createReadyReceipt>) => ({
      ...receipt,
      pid: receipt.pid + 1
    })]
  ])("rejects a ready receipt with a mismatched %s without releasing the old app", async (_field, mutate) => {
    const handoff = await prepareSilentTestHandoff();
    const unref = vi.fn();
    const kill = vi.fn(() => true);
    const child = Object.assign(new EventEmitter(), { pid: 4321, unref, kill });

    await expect(startWindowsStoreInstallHandoff(handoff, {
      spawnDetached: () => child,
      waitForReady: async () => mutate(createReadyReceipt(handoff, 4321)),
      isProcessAlive: () => true
    })).rejects.toThrow("mismatched readiness receipt");

    expect(kill).toHaveBeenCalledOnce();
    expect(unref).not.toHaveBeenCalled();
  });

  it("does not publish an install barrier when native finalizer staging fails", async () => {
    const root = await createTemporaryDirectory();
    const resourcesPath = join(root, "resources");
    const userDataPath = join(root, "LocalState", "Memmy");
    await mkdir(join(resourcesPath, "native"), { recursive: true });
    await writeFile(join(resourcesPath, "native", "MemmyStoreUpdate.exe"), "native helper", "utf8");
    const statePath = join(
      userDataPath,
      "store-update",
      "NeutralCo.MemmyStoreTest_abc123def4567",
      "store-update-install-state-v2.json"
    );

    await expect(prepareWindowsStoreInstallHandoff({
      resourcesPath,
      userDataPath,
      mode: "manual",
      baselinePackageVersion: "1.0.12.0",
      baselinePackageFullName: "NeutralCo.MemmyStoreTest_1.0.12.0_x64__abc123def4567",
      oldPid: 9988,
      aumid: "NeutralCo.MemmyStoreTest_abc123def4567!Memmy",
      packageFamilyName: "NeutralCo.MemmyStoreTest_abc123def4567"
    }, {
      createAttemptId: () => "12345678-1234-4234-8234-123456789abc",
      stageFinalizer: async () => {
        throw new Error("CopyFileExW failed (5)");
      }
    })).rejects.toThrow("CopyFileExW failed");

    await expect(readFile(statePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("joins a pending manual and quit request into one handoff with the original manual mode", async () => {
    let releaseHandoff!: () => void;
    const handoffReady = new Promise<void>((resolve) => {
      releaseHandoff = resolve;
    });
    const onStart = vi.fn();
    const onFailure = vi.fn();
    const singleFlight = createWindowsStoreInstallSingleFlight<string>({ onStart, onFailure });
    const spawnHandoff = vi.fn(async (mode: "manual" | "silent") => {
      await handoffReady;
      return mode;
    });
    const baseline = "NeutralCo.MemmyStoreTest_1.0.12.0_x64__abc123def4567";

    const manualPromise = singleFlight.run(baseline, "manual", spawnHandoff);
    const quitPromise = singleFlight.run(baseline, "silent", spawnHandoff);

    expect(quitPromise).toBe(manualPromise);
    expect(spawnHandoff).toHaveBeenCalledOnce();
    expect(spawnHandoff).toHaveBeenCalledWith("manual");
    expect(onStart.mock.invocationCallOrder[0]).toBeLessThan(
      spawnHandoff.mock.invocationCallOrder[0]!
    );
    expect(singleFlight.current()).toMatchObject({
      baselinePackageFullName: baseline,
      mode: "manual",
      promise: manualPromise
    });
    expect(onStart).toHaveBeenCalledOnce();
    releaseHandoff();
    await expect(quitPromise).resolves.toBe("manual");
    expect(singleFlight.current()?.promise).toBe(manualPromise);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("fails closed for another baseline and resets the flight only after a startup failure", async () => {
    const onFailure = vi.fn();
    const singleFlight = createWindowsStoreInstallSingleFlight<string>({ onFailure });
    const baseline = "NeutralCo.MemmyStoreTest_1.0.12.0_x64__abc123def4567";
    const failed = singleFlight.run(baseline, "manual", async () => {
      throw new Error("installer readiness failed");
    });

    expect(() => singleFlight.run(
      "NeutralCo.MemmyStoreTest_1.0.13.0_x64__abc123def4567",
      "silent",
      async () => "unexpected"
    )).toThrow("different Microsoft Store package baseline");
    await expect(failed).rejects.toThrow("installer readiness failed");
    await vi.waitFor(() => expect(singleFlight.current()).toBeNull());
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it("rejects a helper that is absent from the packaged native resource boundary", async () => {
    const root = await createTemporaryDirectory();

    await expect(prepareWindowsStoreInstallHandoff({
      resourcesPath: join(root, "resources"),
      userDataPath: join(root, "LocalState", "Memmy"),
      mode: "manual",
      baselinePackageVersion: "1.0.12.0",
      baselinePackageFullName: "NeutralCo.MemmyStoreTest_1.0.12.0_x64__abc123def4567",
      oldPid: 9988,
      aumid: "NeutralCo.MemmyStoreTest_abc123def4567!Memmy",
      packageFamilyName: "NeutralCo.MemmyStoreTest_abc123def4567"
    })).rejects.toThrow("Store update helper is unavailable");
  });

  it.skipIf(
    process.platform !== "win32" ||
    !existsSync(builtHelperPath) ||
    process.env.MEMMY_RUN_UNPACKAGED_FINALIZER_TEST !== "1"
  )(
    "persists a recoverable failure from the real unpackaged finalizer",
    async () => {
      const root = await createTemporaryDirectory();
      const packageFamilyName = "NeutralCo.MemmyStoreTest_abc123def4567";
      const requestedStateProbeRoot = process.env.MEMMY_STORE_UPDATE_STATE_PROBE_ROOT?.trim();
      const stateProbeDirectory = requestedStateProbeRoot
        ? join(requestedStateProbeRoot, `codex-finalizer-state-probe-${randomUUID()}`)
        : root;
      if (requestedStateProbeRoot) {
        temporaryDirectories.push(stateProbeDirectory);
      }
      const namespaceDirectory = join(stateProbeDirectory, "store-update", packageFamilyName);
      const statePath = join(namespaceDirectory, "store-update-install-state-v2.json");
      const attemptId = randomUUID();
      const externalDirectory = join(
        homedir(),
        ".memmy",
        "store-update",
        packageFamilyName,
        attemptId
      );
      const externalHelperPath = join(externalDirectory, "MemmyStoreUpdate.exe");
      const externalReadyPath = join(externalDirectory, "external-ready-v1.json");
      const installerReadyPath = join(externalDirectory, "installer-ready-v1.json");
      const resultPath = join(externalDirectory, "store-update-result-v1.txt");
      const logPath = join(externalDirectory, "store-update-handoff.jsonl");
      await mkdir(externalDirectory, { recursive: true });
      temporaryDirectories.push(externalDirectory);
      await copyFile(builtHelperPath, externalHelperPath);
      const externalHelperSha256 = createHash("sha256")
        .update(await readFile(externalHelperPath))
        .digest("hex");
      const oldPid = 4_294_967_294;
      const createdAt = "2026-08-05T10:00:00.000Z";
      await writeWindowsStoreInstallState(statePath, createWindowsStoreInstallState({
        attemptId,
        mode: "silent",
        baselinePackageVersion: "65535.0.0.0",
        baselinePackageFullName: "NeutralCo.MemmyStoreTest_65535.0.0.0_x64__abc123def4567",
        oldPid,
        aumid: "NeutralCo.MemmyStoreTest_abc123def4567!Memmy",
        packageFamilyName,
        now: new Date(createdAt)
      }));
      await writeFile(
        resultPath,
        `${attemptId}\nexception\n0x80073CF9\nsimulated deployment failure\n`,
        "utf8"
      );

      const result = spawnSync(externalHelperPath, [
        "finalize-store-update",
        "--external-helper-path", externalHelperPath,
        "--state-path", statePath,
        "--result-path", resultPath,
        "--log-path", logPath,
        "--external-ready-path", externalReadyPath,
        "--ready-path", installerReadyPath,
        "--old-pid", String(oldPid),
        "--baseline-package-version", "65535.0.0.0",
        "--baseline-package-full-name", "NeutralCo.MemmyStoreTest_65535.0.0.0_x64__abc123def4567",
        "--created-at", createdAt,
        "--aumid", "NeutralCo.MemmyStoreTest_abc123def4567!Memmy",
        "--package-family-name", packageFamilyName,
        "--attempt-id", attemptId,
        "--external-helper-sha256", externalHelperSha256,
        "--mode", "silent"
      ], {
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expect(result.stderr).toBe("");
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

  it.skipIf(
    process.platform !== "win32" ||
    !existsSync(builtHelperPath) ||
    process.env.MEMMY_RUN_UNPACKAGED_FINALIZER_TEST !== "1" ||
    !process.env.MEMMY_STORE_UPDATE_STATE_PROBE_ROOT?.trim() ||
    !process.env.MEMMY_STORE_UPDATE_INSTALLED_PFN?.trim()
  )(
    "deletes a matching protected LocalState barrier after observing a newer installed package",
    async () => {
      const packageFamilyName = process.env.MEMMY_STORE_UPDATE_INSTALLED_PFN!.trim();
      const stateProbeDirectory = join(
        process.env.MEMMY_STORE_UPDATE_STATE_PROBE_ROOT!.trim(),
        `codex-finalizer-state-probe-${randomUUID()}`
      );
      temporaryDirectories.push(stateProbeDirectory);
      const namespaceDirectory = join(stateProbeDirectory, "store-update", packageFamilyName);
      const statePath = join(namespaceDirectory, "store-update-install-state-v2.json");
      const attemptId = randomUUID();
      const externalDirectory = join(
        homedir(),
        ".memmy",
        "store-update",
        packageFamilyName,
        attemptId
      );
      const externalHelperPath = join(externalDirectory, "MemmyStoreUpdate.exe");
      const externalReadyPath = join(externalDirectory, "external-ready-v1.json");
      const installerReadyPath = join(externalDirectory, "installer-ready-v1.json");
      const resultPath = join(externalDirectory, "store-update-result-v1.txt");
      const logPath = join(externalDirectory, "store-update-handoff.jsonl");
      await mkdir(externalDirectory, { recursive: true });
      temporaryDirectories.push(externalDirectory);
      await copyFile(builtHelperPath, externalHelperPath);
      const externalHelperSha256 = createHash("sha256")
        .update(await readFile(externalHelperPath))
        .digest("hex");
      const oldPid = 4_294_967_294;
      const createdAt = "2026-08-05T10:00:00.000Z";
      const baselinePackageFullName = `${packageFamilyName}_0.0.0.0_x64__probe`;
      await writeWindowsStoreInstallState(statePath, createWindowsStoreInstallState({
        attemptId,
        mode: "silent",
        baselinePackageVersion: "0.0.0.0",
        baselinePackageFullName,
        oldPid,
        aumid: `${packageFamilyName}!Memmy`,
        packageFamilyName,
        now: new Date(createdAt)
      }));

      const result = spawnSync(externalHelperPath, [
        "finalize-store-update",
        "--external-helper-path", externalHelperPath,
        "--state-path", statePath,
        "--result-path", resultPath,
        "--log-path", logPath,
        "--external-ready-path", externalReadyPath,
        "--ready-path", installerReadyPath,
        "--old-pid", String(oldPid),
        "--baseline-package-version", "0.0.0.0",
        "--baseline-package-full-name", baselinePackageFullName,
        "--created-at", createdAt,
        "--aumid", `${packageFamilyName}!Memmy`,
        "--package-family-name", packageFamilyName,
        "--attempt-id", attemptId,
        "--external-helper-sha256", externalHelperSha256,
        "--mode", "silent"
      ], {
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      await expect(readWindowsStoreInstallState(statePath)).resolves.toBeNull();
      await expect(readFile(logPath, "utf8")).resolves.toContain('"event":"replacement-package-ready"');
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
    mode: "silent",
    baselinePackageVersion: "1.0.12.0",
    baselinePackageFullName: "NeutralCo.MemmyStoreTest_1.0.12.0_x64__abc123def4567",
    oldPid: 9988,
    aumid: "NeutralCo.MemmyStoreTest_abc123def4567!Memmy",
    packageFamilyName: "NeutralCo.MemmyStoreTest_abc123def4567"
  }, {
    createAttemptId: () => "12345678-1234-4234-8234-123456789abc",
    stageFinalizer: async ({ packageFamilyName, attemptId }) => ({
      type: "finalizer-staged",
      attemptId,
      path: join(root, "PhysicalProfile", ".memmy", "store-update", packageFamilyName, attemptId, "MemmyStoreUpdate.exe"),
      externalReadyPath: join(root, "PhysicalProfile", ".memmy", "store-update", packageFamilyName, attemptId, "external-ready-v1.json"),
      installerReadyPath: join(root, "PhysicalProfile", ".memmy", "store-update", packageFamilyName, attemptId, "installer-ready-v1.json"),
      resultPath: join(root, "PhysicalProfile", ".memmy", "store-update", packageFamilyName, attemptId, "store-update-result-v1.txt"),
      logPath: join(root, "PhysicalProfile", ".memmy", "store-update", packageFamilyName, attemptId, "store-update-handoff.jsonl"),
      size: 13,
      sha256: "a".repeat(64)
    })
  });
};

const createReadyReceipt = (
  handoff: WindowsStoreInstallHandoff,
  packagedPid: number
) => ({
  type: "installer-ready" as const,
  attemptId: handoff.attemptId,
  pid: packagedPid,
  finalizerPid: 5678,
  path: handoff.externalHelperPath,
  sha256: handoff.externalHelperSha256
});
