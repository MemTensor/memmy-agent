import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { win32 } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acknowledgeWindowsStoreLegacyCleanup,
  buildLegacyCleanupAcknowledgementArguments,
  buildLegacyCleanupArguments,
  finalizeWindowsStoreLegacyInstallation,
  prepareWindowsStoreLegacyTransitionBeforeLock,
  readWindowsStoreLegacyInstallAuthority,
  readWindowsStoreLegacyInstallAuthoritySync,
  retireWindowsStoreLegacyInstallAuthority
} from "../src/main/windows-store-legacy-transition.js";
import {
  readWindowsStoreTransitionState,
  resolveWindowsStoreTransitionStatePath,
  writeWindowsStoreTransitionState
} from "../src/main/windows-store-transition-state.js";

const temporaryDirectories: string[] = [];
const identity = {
  edition: "intl" as const,
  packageFamilyName: "Memtensor.MemmyAgent_eyack96k521x2",
  aumid: "Memtensor.MemmyAgent_eyack96k521x2!Memmy"
};

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Windows Store legacy transition", () => {
  it("runs the transactional Store migration before Electron can lock the destination profile", async () => {
    const source = await readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
    const gateIndex = source.indexOf("configureWindowsStoreSingleInstanceGate();");
    const lockIndex = source.indexOf("app.requestSingleInstanceLock()");
    const preReadyIndex = source.indexOf("runCurrentWindowsStoreTransitionPreReady();");
    const whenReadyIndex = source.indexOf("app.whenReady().then(async () => {");
    const finalUserDataIndex = source.indexOf('app.setPath("userData", storeUserDataPath);');
    const runtimeSelectionIndex = source.indexOf("resolveWindowsStoreFirstRunLayout(storeUserDataPath,");

    expect(gateIndex).toBeGreaterThanOrEqual(0);
    expect(lockIndex).toBeGreaterThan(gateIndex);
    expect(preReadyIndex).toBeGreaterThan(lockIndex);
    expect(whenReadyIndex).toBeGreaterThanOrEqual(0);
    expect(preReadyIndex).toBeLessThan(whenReadyIndex);
    expect(finalUserDataIndex).toBeGreaterThan(gateIndex);
    expect(finalUserDataIndex).toBeLessThan(runtimeSelectionIndex);
    expect(source).toContain("finishWindowsStoreFirstRunIntegration(resolveCurrentWindowsStoreLegacyTransitionOptions(),");
    expect(source).not.toContain("throw windowsStorePreReadyTransitionError;");
    expect(source.slice(whenReadyIndex)).not.toContain(
      "await prepareCurrentWindowsStoreLegacyTransitionBeforeLock();"
    );
  });

  it("discovers an authority-bound NSIS installation on a non-C drive and locks it before first Store boot", async () => {
    const fixture = await createFixture("E:\\Applications\\Memmy Custom");
    const actions: string[] = [];
    const runTakeover = vi.fn(async () => {
      actions.push("takeover");
      await expect(readWindowsStoreTransitionState(fixture.statePath)).resolves.toBeNull();
    });

    const result = await prepareWindowsStoreLegacyTransitionBeforeLock(fixture.options, {
      runTakeover,
      writeState: async (statePath, state) => {
        actions.push("journal");
        const { writeWindowsStoreTransitionState } = await import("../src/main/windows-store-transition-state.js");
        await writeWindowsStoreTransitionState(statePath, state);
      }
    });

    expect(result).toMatchObject({ status: "prepared", source: "manual-install" });
    expect(actions).toEqual(["takeover", "journal"]);
    expect(runTakeover).toHaveBeenCalledWith(expect.objectContaining({
      legacyInstallDirectory: "E:\\Applications\\Memmy Custom",
      legacyExecutablePath: "E:\\Applications\\Memmy Custom\\Memmy.exe"
    }));
    await expect(readWindowsStoreTransitionState(fixture.statePath)).resolves.toMatchObject({
      phase: "store-install-launched",
      storeId: "9NFVJC9K7ZK9",
      sourceInstallDirectory: "E:\\Applications\\Memmy Custom",
      sourceRuntimeHomePath: "E:\\MemmyData\\.memmy"
    });
  });

  it("uses an existing app-driven journal instead of rediscovering the default C-drive path", async () => {
    const fixture = await createFixture("D:\\产品\\Memmy");
    await prepareWindowsStoreLegacyTransitionBeforeLock(fixture.options, {
      runTakeover: async () => undefined
    });
    const runTakeover = vi.fn(async () => undefined);

    await expect(prepareWindowsStoreLegacyTransitionBeforeLock(fixture.options, {
      readLegacyAuthority: async () => {
        throw new Error("manual discovery must not run");
      },
      runTakeover
    })).resolves.toMatchObject({ status: "prepared", source: "journal" });
    expect(runTakeover).toHaveBeenCalledWith(expect.objectContaining({
      legacyInstallDirectory: "D:\\产品\\Memmy"
    }));
  });

  it("treats a missing installation record as a clean Store install", async () => {
    const fixture = await createFixture("E:\\Applications\\Memmy", { writeRecord: false });
    const runTakeover = vi.fn(async () => undefined);

    await expect(prepareWindowsStoreLegacyTransitionBeforeLock(fixture.options, { runTakeover }))
      .resolves.toEqual({ status: "none" });
    expect(runTakeover).not.toHaveBeenCalled();
  });

  it("starts a fresh manual transition when a new NSIS authority replaces a cleaned journal", async () => {
    const fixture = await createFixture("D:\\memmy");
    const first = await prepareWindowsStoreLegacyTransitionBeforeLock(fixture.options, {
      runTakeover: async () => undefined
    });
    if (first.status !== "prepared") throw new Error("first transition was not prepared");
    await writeWindowsStoreTransitionState(fixture.statePath, { ...first.state, phase: "cleaned" });
    const runTakeover = vi.fn(async () => undefined);

    const next = await prepareWindowsStoreLegacyTransitionBeforeLock(fixture.options, { runTakeover });
    expect(next).toMatchObject({
      status: "prepared",
      source: "manual-install",
      state: {
        phase: "store-install-launched",
        sourceInstallDirectory: "D:\\memmy",
        sourceRuntimeHomePath: "D:\\MemmyData\\.memmy"
      }
    });
    if (next.status !== "prepared") throw new Error("replacement transition was not prepared");
    expect(next.state.transactionId).not.toBe(first.state.transactionId);
    expect(runTakeover).toHaveBeenCalledOnce();
  });

  it("keeps a cleaned journal terminal when no new NSIS authority exists", async () => {
    const fixture = await createFixture("D:\\memmy");
    const first = await prepareWindowsStoreLegacyTransitionBeforeLock(fixture.options, {
      runTakeover: async () => undefined
    });
    if (first.status !== "prepared") throw new Error("first transition was not prepared");
    const cleaned = { ...first.state, phase: "cleaned" as const };
    await writeWindowsStoreTransitionState(fixture.statePath, cleaned);
    await rm(fixture.recordPath, { force: true });
    const runTakeover = vi.fn(async () => undefined);

    await expect(prepareWindowsStoreLegacyTransitionBeforeLock(fixture.options, { runTakeover }))
      .resolves.toEqual({ status: "none" });
    await expect(readWindowsStoreTransitionState(fixture.statePath)).resolves.toEqual(cleaned);
    expect(runTakeover).not.toHaveBeenCalled();
  });

  it("rejects a record whose runtime path does not match the recorded install drive", async () => {
    const fixture = await createFixture("E:\\Applications\\Memmy", {
      runtimeHomePath: "C:\\Users\\lee\\.memmy"
    });

    await expect(readWindowsStoreLegacyInstallAuthority({
      localAppDataPath: fixture.options.localAppDataPath,
      roamingAppDataPath: fixture.options.roamingAppDataPath,
      homeDirectory: fixture.options.homeDirectory
    })).rejects.toThrow("runtime path");
  });

  it("uses the same strict authority validation during synchronous pre-layout discovery", async () => {
    const fixture = await createFixture("C:\\Applications\\Memmy", {
      runtimeHomePath: "C:\\Users\\lee\\.memmy"
    });
    expect(readWindowsStoreLegacyInstallAuthoritySync({
      localAppDataPath: fixture.options.localAppDataPath,
      roamingAppDataPath: fixture.options.roamingAppDataPath,
      homeDirectory: fixture.options.homeDirectory
    })).toMatchObject({
      installDirectory: "C:\\Applications\\Memmy",
      runtimeHomePath: "C:\\Users\\lee\\.memmy"
    });
  });

  it("keeps compatibility with an ownerless NSIS external-v1 authority", async () => {
    const fixture = await createFixture("D:\\memmy");
    const record = JSON.parse(await readFile(fixture.recordPath, "utf8")) as Record<string, unknown>;
    delete record.installationOwner;
    await writeFile(fixture.recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    expect(readWindowsStoreLegacyInstallAuthoritySync({
      localAppDataPath: fixture.options.localAppDataPath,
      roamingAppDataPath: fixture.options.roamingAppDataPath,
      homeDirectory: fixture.options.homeDirectory
    })).toMatchObject({
      installDirectory: "D:\\memmy",
      runtimeHomePath: "D:\\MemmyData\\.memmy"
    });
  });

  it("fails closed when a WindowsApps record is only a near-match for the current Store package", async () => {
    const fixture = await createFixture(
      "C:\\Program Files\\WindowsApps\\Memtensor.MemmyAgent_1.1.2.0_x64__eyack96k521x2\\app",
      { runtimeHomePath: "C:\\Users\\lee\\.memmy" }
    );
    expect(() => readWindowsStoreLegacyInstallAuthoritySync({
      localAppDataPath: fixture.options.localAppDataPath,
      roamingAppDataPath: fixture.options.roamingAppDataPath,
      homeDirectory: fixture.options.homeDirectory,
      storeUserDataPath: fixture.options.storeUserDataPath,
      identity: fixture.options.identity
    })).toThrow("does not match the running package");
  });

  it("recognizes an exact ownerless Store-v1 record without treating it as NSIS authority", async () => {
    const fixture = await createFixture(
      "C:\\Program Files\\WindowsApps\\Memtensor.MemmyAgent_1.1.2.0_x64__eyack96k521x2\\app",
      { runtimeHomePath: "C:\\Users\\lee\\.memmy", writeRecord: false }
    );
    await mkdir(fixture.options.storeUserDataPath, { recursive: true });
    await writeFile(
      win32.join(fixture.options.storeUserDataPath, "data-root.txt"),
      `${fixture.runtimeHomePath}\r\n`,
      "utf8"
    );
    await writeFile(fixture.recordPath, `${JSON.stringify({
      schemaVersion: 1,
      dataLayoutGeneration: "external-v1",
      installDir: "C:\\Program Files\\WindowsApps\\Memtensor.MemmyAgent_1.1.2.0_x64__eyack96k521x2\\app",
      userDataPath: fixture.options.storeUserDataPath,
      runtimeHomePath: fixture.runtimeHomePath,
      appVersion: "1.1.2",
      recordedAt: "2026-09-03T01:42:25.223Z"
    }, null, 2)}\n`, "utf8");

    const readOptions = {
      localAppDataPath: fixture.options.localAppDataPath,
      roamingAppDataPath: fixture.options.roamingAppDataPath,
      homeDirectory: fixture.options.homeDirectory,
      storeUserDataPath: fixture.options.storeUserDataPath,
      identity: fixture.options.identity
    };
    expect(readWindowsStoreLegacyInstallAuthoritySync(readOptions)).toBeNull();
    await expect(readWindowsStoreLegacyInstallAuthority(readOptions)).resolves.toBeNull();
    const runTakeover = vi.fn(async () => undefined);
    await expect(prepareWindowsStoreLegacyTransitionBeforeLock(fixture.options, { runTakeover }))
      .resolves.toEqual({ status: "none" });
    expect(runTakeover).not.toHaveBeenCalled();
  });

  it("rejects a Store-looking record under an untrusted WindowsApps parent", async () => {
    const fixture = await createFixture(
      "C:\\fake\\WindowsApps\\Memtensor.MemmyAgent_1.1.2.0_x64__eyack96k521x2\\app",
      { runtimeHomePath: "C:\\Users\\lee\\.memmy", writeRecord: false }
    );
    await writeFile(fixture.recordPath, `${JSON.stringify({
      schemaVersion: 1,
      dataLayoutGeneration: "external-v1",
      installDir: "C:\\fake\\WindowsApps\\Memtensor.MemmyAgent_1.1.2.0_x64__eyack96k521x2\\app",
      userDataPath: fixture.options.storeUserDataPath,
      runtimeHomePath: fixture.runtimeHomePath,
      appVersion: "1.1.2",
      recordedAt: "2026-09-03T01:42:25.223Z"
    }, null, 2)}\n`, "utf8");

    expect(() => readWindowsStoreLegacyInstallAuthoritySync({
      localAppDataPath: fixture.options.localAppDataPath,
      roamingAppDataPath: fixture.options.roamingAppDataPath,
      homeDirectory: fixture.options.homeDirectory,
      storeUserDataPath: fixture.options.storeUserDataPath,
      identity: fixture.options.identity
    })).toThrow("does not match the running package");
  });

  it("requests native-broker cleanup for the exact authoritative source", async () => {
    const fixture = await createFixture("E:\\Applications\\Memmy Custom");
    await prepareWindowsStoreLegacyTransitionBeforeLock(fixture.options, {
      runTakeover: async () => undefined
    });
    const state = await readWindowsStoreTransitionState(fixture.statePath);
    if (!state) throw new Error("test transition state is missing");
    const runCleanup = vi.fn(async () => undefined);

    await finalizeWindowsStoreLegacyInstallation({
      resourcesPath: fixture.options.resourcesPath,
      localAppDataPath: fixture.options.localAppDataPath,
      desktopPath: fixture.options.desktopPath,
      state
    }, {
      runCleanup
    });

    expect(runCleanup).toHaveBeenCalledWith(expect.objectContaining({
      legacyInstallDirectory: "E:\\Applications\\Memmy Custom",
      legacyExecutablePath: "E:\\Applications\\Memmy Custom\\Memmy.exe",
      shortcutPath: win32.join(fixture.options.desktopPath, "Memmy.lnk"),
      transitionId: state.transactionId,
      attemptId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
      )
    }));
    expect(runCleanup.mock.calls[0]?.[0]).not.toHaveProperty("logPath");
  });

  it("acknowledges the exact broker cleanup only after attestation is durable", async () => {
    const fixture = await createFixture("E:\\Applications\\Memmy Custom");
    const prepared = await prepareWindowsStoreLegacyTransitionBeforeLock(fixture.options, {
      runTakeover: async () => undefined
    });
    if (prepared.status !== "prepared") throw new Error("transition was not prepared");
    const state = { ...prepared.state, phase: "legacy-cleanup-attested" as const };
    const runAcknowledgement = vi.fn(async () => undefined);

    await acknowledgeWindowsStoreLegacyCleanup({
      resourcesPath: fixture.options.resourcesPath,
      localAppDataPath: fixture.options.localAppDataPath,
      desktopPath: fixture.options.desktopPath,
      state
    }, {
      runAcknowledgement,
      createAttemptId: () => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    });

    expect(runAcknowledgement).toHaveBeenCalledWith(expect.objectContaining({
      legacyInstallDirectory: state.sourceInstallDirectory,
      legacyExecutablePath: state.sourceExecutablePath,
      shortcutPath: win32.join(fixture.options.desktopPath, "Memmy.lnk"),
      packageFamilyName: state.packageFamilyName,
      aumid: state.aumid,
      transitionId: state.transactionId,
      attemptId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    }));
    await expect(acknowledgeWindowsStoreLegacyCleanup({
      resourcesPath: fixture.options.resourcesPath,
      localAppDataPath: fixture.options.localAppDataPath,
      desktopPath: fixture.options.desktopPath,
      state: prepared.state
    }, { runAcknowledgement })).rejects.toThrow("only be acknowledged after attestation");
  });

  it("retires only the consumed NSIS authority and treats a repeated retirement as complete", async () => {
    const fixture = await createFixture("D:\\memmy");
    const prepared = await prepareWindowsStoreLegacyTransitionBeforeLock(fixture.options, {
      runTakeover: async () => undefined
    });
    if (prepared.status !== "prepared") throw new Error("transition was not prepared");
    const cleanupEligible = { ...prepared.state, phase: "cleanup-eligible" as const };

    await retireWindowsStoreLegacyInstallAuthority({
      localAppDataPath: fixture.options.localAppDataPath,
      state: cleanupEligible
    });
    await expect(readFile(fixture.recordPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(retireWindowsStoreLegacyInstallAuthority({
      localAppDataPath: fixture.options.localAppDataPath,
      state: cleanupEligible
    })).resolves.toBeUndefined();
  });

  it("preserves a replacement authority instead of retiring it for an older transition", async () => {
    const fixture = await createFixture("D:\\memmy");
    const prepared = await prepareWindowsStoreLegacyTransitionBeforeLock(fixture.options, {
      runTakeover: async () => undefined
    });
    if (prepared.status !== "prepared") throw new Error("transition was not prepared");
    const replacement = JSON.parse(await readFile(fixture.recordPath, "utf8")) as Record<string, unknown>;
    replacement.runtimeHomePath = "E:\\MemmyData\\.memmy";
    await writeFile(fixture.recordPath, `${JSON.stringify(replacement, null, 2)}\n`, "utf8");

    await expect(retireWindowsStoreLegacyInstallAuthority({
      localAppDataPath: fixture.options.localAppDataPath,
      state: { ...prepared.state, phase: "cleanup-eligible" }
    })).rejects.toThrow("changed before retirement");
    await expect(readFile(fixture.recordPath, "utf8")).resolves.toContain("E:\\\\MemmyData");
  });

  it("refuses to retire authority before the transition is cleanup-eligible", async () => {
    const fixture = await createFixture("D:\\memmy");
    const prepared = await prepareWindowsStoreLegacyTransitionBeforeLock(fixture.options, {
      runTakeover: async () => undefined
    });
    if (prepared.status !== "prepared") throw new Error("transition was not prepared");
    await expect(retireWindowsStoreLegacyInstallAuthority({
      localAppDataPath: fixture.options.localAppDataPath,
      state: prepared.state
    })).rejects.toThrow("only be retired");
    await expect(readFile(fixture.recordPath, "utf8")).resolves.toContain("D:\\\\memmy");
  });

  it("builds the exact packaged-helper cleanup argv without accepting a diagnostic path", () => {
    const options = {
      helperPath: "C:\\Program Files\\WindowsApps\\MemmyStoreUpdate.exe",
      legacyInstallDirectory: "D:\\memmy",
      legacyExecutablePath: "D:\\memmy\\Memmy.exe",
      shortcutPath: "E:\\Users\\lee\\Desktop\\Memmy.lnk",
      aumid: identity.aumid,
      packageFamilyName: identity.packageFamilyName,
      transitionId: "11111111-2222-4333-8444-555555555555",
      attemptId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    };
    const expectedIdentityArguments = [
      "--legacy-install-directory",
      "D:\\memmy",
      "--legacy-executable-path",
      "D:\\memmy\\Memmy.exe",
      "--aumid",
      identity.aumid,
      "--package-family-name",
      identity.packageFamilyName,
      "--transition-id",
      "11111111-2222-4333-8444-555555555555",
      "--attempt-id",
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "--shortcut",
      "E:\\Users\\lee\\Desktop\\Memmy.lnk"
    ];
    expect(buildLegacyCleanupArguments(options)).toEqual([
      "finalize-legacy-cleanup",
      ...expectedIdentityArguments
    ]);
    expect(buildLegacyCleanupAcknowledgementArguments(options)).toEqual([
      "ack-legacy-cleanup",
      ...expectedIdentityArguments
    ]);
  });

  it("keeps the transition ID stable and creates a new attempt ID for each historical-state retry", async () => {
    const fixture = await createFixture("D:\\memmy");
    const state = {
      schemaVersion: 1 as const,
      transactionId: "11111111-2222-4333-8444-555555555555",
      phase: "app-verified" as const,
      mode: "manual" as const,
      storeId: "9NFVJC9K7ZK9",
      packageFamilyName: identity.packageFamilyName,
      aumid: identity.aumid,
      sourceInstallDirectory: "D:\\memmy",
      sourceExecutablePath: "D:\\memmy\\Memmy.exe",
      sourceUserDataPath: "C:\\Users\\lee\\AppData\\Roaming\\Memmy",
      sourceRuntimeHomePath: "D:\\MemmyData.memmy",
      baselinePackageVersion: "",
      baselinePackageFullName: "",
      createdAt: "2026-09-03T09:11:42.000Z",
      updatedAt: "2026-09-03T09:11:42.000Z"
    };
    const attemptIds = [
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "ffffffff-1111-4222-8333-444444444444"
    ];
    const runCleanup = vi.fn(async () => {
      throw new Error("diagnostic retry");
    });
    const dependencies = {
      runCleanup,
      createAttemptId: () => attemptIds.shift() ?? "unexpected"
    };

    await expect(finalizeWindowsStoreLegacyInstallation({
      resourcesPath: fixture.options.resourcesPath,
      localAppDataPath: fixture.options.localAppDataPath,
      desktopPath: fixture.options.desktopPath,
      state
    }, dependencies)).rejects.toThrow("diagnostic retry");
    await expect(finalizeWindowsStoreLegacyInstallation({
      resourcesPath: fixture.options.resourcesPath,
      localAppDataPath: fixture.options.localAppDataPath,
      desktopPath: fixture.options.desktopPath,
      state
    }, dependencies)).rejects.toThrow("diagnostic retry");

    expect(runCleanup.mock.calls.map(([options]) => ({
      transitionId: options.transitionId,
      attemptId: options.attemptId,
      shortcutPath: options.shortcutPath
    }))).toEqual([
      {
        transitionId: state.transactionId,
        attemptId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        shortcutPath: win32.join(fixture.options.desktopPath, "Memmy.lnk")
      },
      {
        transitionId: state.transactionId,
        attemptId: "ffffffff-1111-4222-8333-444444444444",
        shortcutPath: win32.join(fixture.options.desktopPath, "Memmy.lnk")
      }
    ]);
    expect(state).not.toHaveProperty("attemptId");
  });
});

const createFixture = async (
  installDirectory: string,
  overrides: { writeRecord?: boolean; runtimeHomePath?: string } = {}
) => {
  const root = await mkdtemp(win32.join(tmpdir(), "memmy-store-legacy-transition-"));
  temporaryDirectories.push(root);
  const localAppDataPath = win32.join(root, "LocalAppData");
  const roamingAppDataPath = win32.join(root, "Roaming");
  const homeDirectory = "C:\\Users\\lee";
  const sourceUserDataPath = win32.join(roamingAppDataPath, "Memmy");
  const storeUserDataPath = win32.join(
    localAppDataPath,
    "Packages",
    identity.packageFamilyName,
    "LocalState",
    "Memmy"
  );
  const runtimeHomePath = overrides.runtimeHomePath ?? `${win32.parse(installDirectory).root}MemmyData\\.memmy`;
  const recordPath = win32.join(localAppDataPath, "Memmy", "data-layout", "last-install.json");
  await mkdir(win32.dirname(recordPath), { recursive: true });
  await mkdir(sourceUserDataPath, { recursive: true });
  await writeFile(win32.join(sourceUserDataPath, "data-root.txt"), `${runtimeHomePath}\r\n`, "utf8");
  if (overrides.writeRecord !== false) {
    await writeFile(recordPath, `${JSON.stringify({
      schemaVersion: 1,
      dataLayoutGeneration: "external-v1",
      installationOwner: "nsis",
      installDir: installDirectory,
      userDataPath: sourceUserDataPath,
      runtimeHomePath,
      appVersion: "1.1.2",
      recordedAt: "2026-09-03T01:42:25.223Z"
    }, null, 2)}\n`, "utf8");
  }
  const statePath = resolveWindowsStoreTransitionStatePath(localAppDataPath);
  return {
    statePath,
    recordPath,
    runtimeHomePath,
    options: {
      platform: "win32" as const,
      isPackaged: true,
      isWindowsStore: true,
      resourcesPath: win32.join(root, "WindowsApps", "resources"),
      localAppDataPath,
      roamingAppDataPath,
      homeDirectory,
      storeUserDataPath,
      desktopPath: win32.join(root, "Desktop"),
      identity
    }
  };
};
