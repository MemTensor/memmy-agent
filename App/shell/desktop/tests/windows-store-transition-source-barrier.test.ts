import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { win32 } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveWindowsStoreTransitionSourceBarrier } from "../src/main/windows-store-transition-source-barrier.js";
import {
  advanceWindowsStoreTransitionState,
  createWindowsStoreTransitionState,
  resolveWindowsStoreTransitionStatePath,
  writeWindowsStoreTransitionState
} from "../src/main/windows-store-transition-state.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Windows Store transition source barrier", () => {
  it("treats only a missing journal as no active transition", async () => {
    const fixture = await createFixture();
    await expect(resolveWindowsStoreTransitionSourceBarrier(fixture.options)).resolves.toEqual({
      action: "no-transition"
    });
  });

  it("does not fail open when the journal is corrupted", async () => {
    const fixture = await createFixture();
    await mkdir(win32.dirname(fixture.statePath), { recursive: true });
    await writeFile(fixture.statePath, "{not-json", "utf8");

    await expect(resolveWindowsStoreTransitionSourceBarrier(fixture.options))
      .rejects.toThrow("Windows Store transition journal is invalid");
  });

  it("does not fail open when journal access is denied", async () => {
    const fixture = await createFixture();
    const accessError = Object.assign(new Error("access denied"), { code: "EACCES" });

    await expect(resolveWindowsStoreTransitionSourceBarrier(fixture.options, {
      readState: async () => {
        throw accessError;
      }
    })).rejects.toBe(accessError);
  });

  it("blocks the bound NSIS source while its Store package remains registered", async () => {
    const fixture = await createFixture();
    let state = createState(fixture.executablePath);
    const queryPackageRegistration = vi.fn(async () => ({ registered: true, packageFullNames: ["package"] }));
    const archiveOrphanedTransition = vi.fn();
    for (const phase of [
      "authority-recorded",
      "store-install-launched",
      "package-registered",
      "data-prepared",
      "awaiting-app-verification",
      "app-verified",
      "legacy-cleanup-attested",
      "cleanup-eligible",
      "cleaned"
    ] as const) {
      state = advanceWindowsStoreTransitionState(state, phase);
      await writeWindowsStoreTransitionState(fixture.statePath, state);
      await expect(resolveWindowsStoreTransitionSourceBarrier(fixture.options, {
        queryPackageRegistration,
        archiveOrphanedTransition
      })).resolves.toEqual({ action: "block-source", phase });
    }
    expect(queryPackageRegistration).toHaveBeenCalledTimes(9);
    expect(archiveOrphanedTransition).not.toHaveBeenCalled();
  });

  it("archives an orphaned transaction in every phase and allows NSIS when the PFN is unregistered", async () => {
    const fixture = await createFixture();
    let state = createState(fixture.executablePath);
    for (const phase of [
      "authority-recorded",
      "store-install-launched",
      "package-registered",
      "data-prepared",
      "awaiting-app-verification",
      "app-verified",
      "legacy-cleanup-attested",
      "cleanup-eligible",
      "cleaned"
    ] as const) {
      state = advanceWindowsStoreTransitionState(state, phase);
      await writeWindowsStoreTransitionState(fixture.statePath, state);
      const queryPackageRegistration = vi.fn(async () => ({ registered: false, packageFullNames: [] }));
      const archiveOrphanedTransition = vi.fn(async () => ({
        archiveDirectory: "C:\\archive",
        archivedStatePath: "C:\\archive\\active.json",
        archivedPreparedStatePath: "C:\\archive\\prepared-data.json",
        recoveryRecordPath: "C:\\archive\\recovery.json"
      }));

      await expect(resolveWindowsStoreTransitionSourceBarrier(fixture.options, {
        queryPackageRegistration,
        archiveOrphanedTransition
      })).resolves.toEqual({
        action: "orphan-recovered",
        phase,
        archivedStatePath: "C:\\archive\\active.json"
      });
      expect(queryPackageRegistration).toHaveBeenCalledWith({
        resourcesPath: fixture.options.resourcesPath,
        packageFamilyName: state.packageFamilyName
      });
      expect(archiveOrphanedTransition).toHaveBeenCalledWith({
        statePath: fixture.statePath,
        expectedState: state
      });
    }
  });

  it("blocks on a package-registration query error instead of archiving", async () => {
    const fixture = await createFixture();
    let state = createState(fixture.executablePath);
    state = advanceWindowsStoreTransitionState(state, "store-install-launched");
    await writeWindowsStoreTransitionState(fixture.statePath, state);
    const queryError = new Error("package query failed");
    const archiveOrphanedTransition = vi.fn();

    await expect(resolveWindowsStoreTransitionSourceBarrier(fixture.options, {
      queryPackageRegistration: async () => {
        throw queryError;
      },
      archiveOrphanedTransition
    })).rejects.toBe(queryError);
    expect(archiveOrphanedTransition).not.toHaveBeenCalled();
  });

  it("archives an abandoned authority-only transaction when the PFN is not registered", async () => {
    const fixture = await createFixture();
    const state = createState(fixture.executablePath);
    await writeWindowsStoreTransitionState(fixture.statePath, state);
    const archiveOrphanedTransition = vi.fn(async () => ({
      archiveDirectory: "C:\\archive",
      archivedStatePath: "C:\\archive\\active.json",
      archivedPreparedStatePath: null,
      recoveryRecordPath: "C:\\archive\\recovery.json"
    }));

    await expect(resolveWindowsStoreTransitionSourceBarrier(fixture.options, {
      queryPackageRegistration: async () => ({ registered: false, packageFullNames: [] }),
      archiveOrphanedTransition
    })).resolves.toEqual({
      action: "orphan-recovered",
      phase: "authority-recorded",
      archivedStatePath: "C:\\archive\\active.json"
    });
    expect(archiveOrphanedTransition).toHaveBeenCalledWith({
      statePath: fixture.statePath,
      expectedState: state
    });
  });

  it("blocks a reinstalled NSIS in another directory while the PFN remains registered", async () => {
    const fixture = await createFixture();
    let state = createState(fixture.executablePath);
    state = advanceWindowsStoreTransitionState(state, "store-install-launched");
    await writeWindowsStoreTransitionState(fixture.statePath, state);
    const queryPackageRegistration = vi.fn(async () => ({ registered: true, packageFullNames: ["package"] }));
    const archiveOrphanedTransition = vi.fn();

    await expect(resolveWindowsStoreTransitionSourceBarrier({
      ...fixture.options,
      executablePath: "D:\\Other\\Memmy.exe"
    }, {
      queryPackageRegistration,
      archiveOrphanedTransition
    })).resolves.toEqual({
      action: "block-source",
      phase: "store-install-launched"
    });
    expect(queryPackageRegistration).toHaveBeenCalledOnce();
    expect(archiveOrphanedTransition).not.toHaveBeenCalled();
  });

  it("archives an orphaned transaction when NSIS was reinstalled to another directory", async () => {
    const fixture = await createFixture();
    let state = createState(fixture.executablePath);
    state = advanceWindowsStoreTransitionState(state, "store-install-launched");
    await writeWindowsStoreTransitionState(fixture.statePath, state);
    const archiveOrphanedTransition = vi.fn(async () => ({
      archiveDirectory: "C:\\archive",
      archivedStatePath: "C:\\archive\\active.json",
      archivedPreparedStatePath: null,
      recoveryRecordPath: "C:\\archive\\recovery.json"
    }));

    await expect(resolveWindowsStoreTransitionSourceBarrier({
      ...fixture.options,
      executablePath: "D:\\Other\\Memmy.exe"
    }, {
      queryPackageRegistration: async () => ({ registered: false, packageFullNames: [] }),
      archiveOrphanedTransition
    })).resolves.toEqual({
      action: "orphan-recovered",
      phase: "store-install-launched",
      archivedStatePath: "C:\\archive\\active.json"
    });
    expect(archiveOrphanedTransition).toHaveBeenCalledWith({
      statePath: fixture.statePath,
      expectedState: state
    });
  });
});

const createFixture = async () => {
  const root = await mkdtemp(win32.join(tmpdir(), "memmy-store-source-barrier-"));
  temporaryDirectories.push(root);
  const executablePath = win32.join(root, "NSIS", "Memmy", "Memmy.exe");
  const statePath = resolveWindowsStoreTransitionStatePath(win32.join(root, "LocalAppData"));
  return {
    executablePath,
    statePath,
    options: {
      platform: "win32" as const,
      isPackaged: true,
      isWindowsStore: false,
      executablePath,
      statePath,
      resourcesPath: win32.join(root, "NSIS", "resources")
    }
  };
};

const createState = (sourceExecutablePath: string) => createWindowsStoreTransitionState({
  edition: "cn",
  storeId: "9MZGLKWMZZV6",
  packageFamilyName: "Memtensor.Memmy_eyack96k521x2",
  aumid: "Memtensor.Memmy_eyack96k521x2!Memmy",
  sourceExecutablePath,
  sourceInstallDirectory: win32.dirname(sourceExecutablePath),
  sourceVersion: "1.1.1",
  sourceUserDataPath: "C:\\Users\\lee\\AppData\\Roaming\\Memmy",
  sourceRuntimeHomePath: "C:\\Users\\lee\\.memmy",
  authority: "current-install-authority"
});
