import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  STORE_UPDATE_INSTALL_STALE_MS,
  createWindowsStoreInstallState,
  readWindowsStoreInstallState,
  resolveWindowsStoreInstallNamespaceDirectory,
  resolveWindowsStoreInstallStatePath,
  resolveWindowsStoreStartupDecision,
  updateWindowsStoreInstallState,
  writeWindowsStoreInstallState
} from "../src/main/windows-store-install-state.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Windows Store install state", () => {
  it("derives a stable PFN namespace for edition-isolated state", () => {
    const root = join("C:\\Users\\tester\\AppData\\Local", "Packages");
    const packageFamilyName = "NeutralCo.MemmyStoreTest_abc123def4567";

    expect(resolveWindowsStoreInstallNamespaceDirectory(root, packageFamilyName)).toBe(
      join(root, "store-update", packageFamilyName)
    );
    expect(resolveWindowsStoreInstallStatePath(root, packageFamilyName)).toBe(
      join(root, "store-update", packageFamilyName, "store-update-install-state-v2.json")
    );
    expect(() => resolveWindowsStoreInstallStatePath(root, "..\\shared"))
      .toThrow("package family name is invalid");
  });

  it("persists the complete manual handoff record in LocalState", async () => {
    const directory = await createTemporaryDirectory();
    const statePath = join(directory, "store-update-install-state-v2.json");
    const state = createWindowsStoreInstallState({
      mode: "manual",
      baselinePackageVersion: "1.0.12.0",
      baselinePackageFullName: "NeutralCo.MemmyStoreTest_1.0.12.0_x64__abc123def4567",
      oldPid: 4321,
      aumid: "NeutralCo.MemmyStoreTest_abc123def4567!Memmy",
      packageFamilyName: "NeutralCo.MemmyStoreTest_abc123def4567",
      now: new Date("2026-08-05T10:00:00.000Z")
    });

    await writeWindowsStoreInstallState(statePath, state);

    await expect(readWindowsStoreInstallState(statePath)).resolves.toEqual(state);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
      schemaVersion: 2,
      mode: "manual",
      status: "installing",
      baselinePackageVersion: "1.0.12.0",
      baselinePackageFullName: "NeutralCo.MemmyStoreTest_1.0.12.0_x64__abc123def4567",
      oldPid: 4321,
      autoActivateOnSuccess: true,
      nativeState: null,
      hresult: null,
      failureReason: null
    });
  });

  it("blocks every old-version launch while a fresh install is active", () => {
    const state = createWindowsStoreInstallState({
      mode: "manual",
      baselinePackageVersion: "1.0.12.0",
      baselinePackageFullName: "NeutralCo.MemmyStoreTest_1.0.12.0_x64__abc123def4567",
      oldPid: 4321,
      aumid: "NeutralCo.MemmyStoreTest_abc123def4567!Memmy",
      packageFamilyName: "NeutralCo.MemmyStoreTest_abc123def4567",
      now: new Date("2026-08-05T10:00:00.000Z")
    });

    expect(resolveWindowsStoreStartupDecision({
      state,
      currentPackageVersion: "1.0.12.0",
      currentPackageFullName: "NeutralCo.MemmyStoreTest_1.0.12.0_x64__abc123def4567",
      now: new Date("2026-08-05T10:05:00.000Z")
    })).toEqual({ action: "block", reason: "installing", nextState: state });
  });

  it.each(["manual", "silent"] as const)(
    "clears the %s barrier when the installed package identity changed",
    (mode) => {
    const state = createWindowsStoreInstallState({
      mode,
      baselinePackageVersion: "1.0.12.0",
      baselinePackageFullName: "NeutralCo.MemmyStoreTest_1.0.12.0_x64__abc123def4567",
      oldPid: 4321,
      aumid: "NeutralCo.MemmyStoreTest_abc123def4567!Memmy",
      packageFamilyName: "NeutralCo.MemmyStoreTest_abc123def4567",
      now: new Date("2026-08-05T10:00:00.000Z")
    });

    expect(resolveWindowsStoreStartupDecision({
      state,
      currentPackageVersion: "1.0.14.0",
      currentPackageFullName: "NeutralCo.MemmyStoreTest_1.0.14.0_x64__abc123def4567",
      now: new Date("2026-08-05T10:05:00.000Z")
    })).toEqual({ action: "continue", reason: "updated", nextState: null });
    }
  );

  it.each(["manual", "silent"] as const)(
    "allows the old version to start after a %s install failure",
    (mode) => {
      const state = {
        ...createWindowsStoreInstallState({
          mode,
          baselinePackageVersion: "1.0.12.0",
          baselinePackageFullName: "NeutralCo.MemmyStoreTest_1.0.12.0_x64__abc123def4567",
          oldPid: 4321,
          aumid: "NeutralCo.MemmyStoreTest_abc123def4567!Memmy",
          packageFamilyName: "NeutralCo.MemmyStoreTest_abc123def4567",
          now: new Date("2026-08-05T10:00:00.000Z")
        }),
        status: "failed" as const,
        nativeState: "other-error",
        hresult: "0x80073CF9",
        failureReason: "simulated failure",
        failurePending: true
      };

      expect(resolveWindowsStoreStartupDecision({
        state,
        currentPackageVersion: "1.0.12.0",
        currentPackageFullName: "NeutralCo.MemmyStoreTest_1.0.12.0_x64__abc123def4567",
        now: new Date("2026-08-05T10:05:00.000Z")
      })).toEqual({ action: "continue", reason: "failed", nextState: state });
      expect(state.autoActivateOnSuccess).toBe(mode === "manual");
    }
  );

  it("turns an expired install into a recoverable failure instead of a permanent lock", () => {
    const state = createWindowsStoreInstallState({
      mode: "silent",
      baselinePackageVersion: "1.0.12.0",
      baselinePackageFullName: "NeutralCo.MemmyStoreTest_1.0.12.0_x64__abc123def4567",
      oldPid: 4321,
      aumid: "NeutralCo.MemmyStoreTest_abc123def4567!Memmy",
      packageFamilyName: "NeutralCo.MemmyStoreTest_abc123def4567",
      now: new Date("2026-08-05T10:00:00.000Z")
    });
    const now = new Date(new Date(state.createdAt).getTime() + STORE_UPDATE_INSTALL_STALE_MS + 1);

    const decision = resolveWindowsStoreStartupDecision({
      state,
      currentPackageVersion: "1.0.12.0",
      currentPackageFullName: "NeutralCo.MemmyStoreTest_1.0.12.0_x64__abc123def4567",
      now
    });

    expect(decision.action).toBe("continue");
    expect(decision.reason).toBe("expired");
    expect(decision.nextState).toMatchObject({
      mode: "silent",
      status: "failed",
      nativeState: "timeout",
      failureReason: "The Microsoft Store update handoff expired before the baseline package was replaced",
      failurePending: true
    });
  });

  it("records HRESULT and native package state for failure recovery", async () => {
    const directory = await createTemporaryDirectory();
    const statePath = join(directory, "store-update-install-state-v2.json");
    const state = createWindowsStoreInstallState({
      mode: "manual",
      baselinePackageVersion: "1.0.12.0",
      baselinePackageFullName: "NeutralCo.MemmyStoreTest_1.0.12.0_x64__abc123def4567",
      oldPid: 4321,
      aumid: "NeutralCo.MemmyStoreTest_abc123def4567!Memmy",
      packageFamilyName: "NeutralCo.MemmyStoreTest_abc123def4567",
      now: new Date("2026-08-05T10:00:00.000Z")
    });
    await writeWindowsStoreInstallState(statePath, state);

    const failed = await updateWindowsStoreInstallState(statePath, (current) => ({
      ...current,
      status: "failed",
      updatedAt: "2026-08-05T10:01:00.000Z",
      nativeState: "other-error",
      hresult: "0x80073d02",
      failureReason: "Package resources are in use",
      failurePending: true
    }));

    expect(failed).toMatchObject({
      status: "failed",
      nativeState: "other-error",
      hresult: "0x80073d02",
      failurePending: true
    });
    await expect(readWindowsStoreInstallState(statePath)).resolves.toEqual(failed);
  });
});

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "memmy-store-install-state-"));
  temporaryDirectories.push(directory);
  return directory;
};
