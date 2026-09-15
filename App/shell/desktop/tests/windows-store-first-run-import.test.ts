import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { win32 } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { importWindowsStoreDataOnce } from "../src/main/windows-store-first-run-import.js";
import { readWindowsStoreFirstRunRecord, resolveWindowsStoreFirstRunLayout, resolveWindowsStoreFirstRunRoot, writeWindowsStoreFirstRunRecord, WINDOWS_STORE_SHORTCUT_REPAIR_VERSION, WINDOWS_STORE_SHORTCUT_REPAIR_MAX_ATTEMPTS } from "../src/main/windows-store-first-run-state.js";
import { discoverWindowsStoreImportSource } from "../src/main/windows-store-data-discovery.js";
import { planWindowsStoreDataTransition, prepareWindowsStoreDataTransition } from "../src/main/windows-store-data-transition.js";
import type { WindowsStoreLegacyTransitionOptions } from "../src/main/windows-store-legacy-transition.js";
import { finishWindowsStoreFirstRunIntegration } from "../src/main/windows-store-first-run-integration.js";
import { createWindowsStoreTransitionState } from "../src/main/windows-store-transition-state.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!root.startsWith(win32.join(tmpdir(), "memmy-store-import-"))) throw new Error("Unexpected test root");
    await rm(root, { recursive: true, force: true });
  }
});
const put = async (path: string, value: string) => {
  await mkdir(win32.dirname(path), { recursive: true });
  await writeFile(path, value);
};
const fixture = async () => {
  const root = await mkdtemp(win32.join(tmpdir(), "memmy-store-import-"));
  roots.push(root);
  const options: WindowsStoreLegacyTransitionOptions = {
    platform: "win32", isPackaged: true, isWindowsStore: true,
    localAppDataPath: win32.join(root, "Local"), roamingAppDataPath: win32.join(root, "Roaming"),
    homeDirectory: win32.join(root, "Home"), resourcesPath: win32.join(root, "resources"), desktopPath: win32.join(root, "Desktop"),
    storeUserDataPath: win32.join(root, "Local", "Packages", "Memtensor.Memmy_eyack96k521x2", "LocalState", "Memmy"),
    identity: { edition: "cn", packageFamilyName: "Memtensor.Memmy_eyack96k521x2", aumid: "Memtensor.Memmy_eyack96k521x2!Memmy" }
  };
  const source = { userDataPath: win32.join(options.roamingAppDataPath, "Memmy"), runtimeHomePath: win32.join(options.homeDirectory, ".memmy") };
  return { root, options, source };
};

describe.runIf(process.platform === "win32")("Store first-run data import", () => {
  it("upgrades the old integration marker once without importing data again", async () => {
    const { options } = await fixture();
    const baseline = { schemaVersion: 1 as const, status: "migrated" as const,
      generation: "11111111-1111-4111-8111-111111111111", checkedAt: "original",
      integrationAttempted: true, cleanupAttempted: true };
    await writeWindowsStoreFirstRunRecord(options.storeUserDataPath, baseline);
    const createShortcut = vi.fn(async () => {
      expect(readWindowsStoreFirstRunRecord(options.storeUserDataPath)?.shortcutRepair).toMatchObject({
        version: WINDOWS_STORE_SHORTCUT_REPAIR_VERSION, attempts: 1, completed: false
      });
    });
    await finishWindowsStoreFirstRunIntegration(options, { createShortcut });
    await finishWindowsStoreFirstRunIntegration(options, { createShortcut });
    const discoverSource = vi.fn();
    const record = await importWindowsStoreDataOnce(options, { discoverSource });
    expect(discoverSource).not.toHaveBeenCalled();
    expect(createShortcut).toHaveBeenCalledOnce();
    expect(record).toMatchObject({ ...baseline, shortcutRepair: {
      version: WINDOWS_STORE_SHORTCUT_REPAIR_VERSION, attempts: 1, completed: true
    } });
  });

  it("bounds failed shortcut repairs independently of the old attempted boolean", async () => {
    const { options } = await fixture();
    await writeWindowsStoreFirstRunRecord(options.storeUserDataPath, {
      schemaVersion: 1, status: "no-data", generation: "standalone", checkedAt: "original", integrationAttempted: true
    });
    const createShortcut = vi.fn(async () => { throw new Error("desktop denied"); });
    for (let index = 0; index < WINDOWS_STORE_SHORTCUT_REPAIR_MAX_ATTEMPTS + 2; index++) {
      await finishWindowsStoreFirstRunIntegration(options, { createShortcut });
    }
    expect(createShortcut).toHaveBeenCalledTimes(WINDOWS_STORE_SHORTCUT_REPAIR_MAX_ATTEMPTS);
    expect(readWindowsStoreFirstRunRecord(options.storeUserDataPath)?.shortcutRepair).toMatchObject({
      version: WINDOWS_STORE_SHORTCUT_REPAIR_VERSION, attempts: WINDOWS_STORE_SHORTCUT_REPAIR_MAX_ATTEMPTS, completed: false
    });
  });

  it("retries an interrupted repair and stops once its version succeeds", async () => {
    const { options } = await fixture();
    await writeWindowsStoreFirstRunRecord(options.storeUserDataPath, {
      schemaVersion: 1, status: "no-data", generation: "standalone", checkedAt: "original",
      shortcutRepair: { version: WINDOWS_STORE_SHORTCUT_REPAIR_VERSION, attempts: 1, completed: false }
    });
    const createShortcut = vi.fn(async () => undefined);
    await finishWindowsStoreFirstRunIntegration(options, { createShortcut });
    await finishWindowsStoreFirstRunIntegration(options, { createShortcut });
    expect(createShortcut).toHaveBeenCalledOnce();
    expect(readWindowsStoreFirstRunRecord(options.storeUserDataPath)?.shortcutRepair).toMatchObject({ attempts: 2, completed: true });
  });

  it("does not downgrade a shortcut repaired by a newer package", async () => {
    const { options } = await fixture();
    await writeWindowsStoreFirstRunRecord(options.storeUserDataPath, {
      schemaVersion: 1, status: "no-data", generation: "standalone", checkedAt: "original",
      shortcutRepair: { version: WINDOWS_STORE_SHORTCUT_REPAIR_VERSION + 1, attempts: 1, completed: true }
    });
    const createShortcut = vi.fn();
    await finishWindowsStoreFirstRunIntegration(options, { createShortcut });
    expect(createShortcut).not.toHaveBeenCalled();
  });

  it.each([false, true])("repairs after discovered cleanup, including failure=%s", async (fails) => {
    const { options } = await fixture();
    await writeWindowsStoreFirstRunRecord(options.storeUserDataPath, {
      schemaVersion: 1, status: "migrated", generation: "11111111-1111-4111-8111-111111111111", checkedAt: "original",
      installation: { installDirectory: "D:\\Memmy", appVersion: "1.1.2" },
      shortcutRepair: { version: WINDOWS_STORE_SHORTCUT_REPAIR_VERSION, attempts: 1, completed: true }
    });
    const calls: string[] = [];
    const cleanupDiscovered = vi.fn(async () => {
      calls.push("cleanup-rebuilds-link");
      if (fails) throw new Error("uninstall failed");
    });
    const createShortcut = vi.fn(async () => { calls.push("repair-icon-and-deduplicate"); });
    const integration = finishWindowsStoreFirstRunIntegration(options, { cleanupDiscovered, createShortcut });
    if (fails) await expect(integration).rejects.toThrow("uninstall failed");
    else await integration;
    expect(calls).toEqual(["cleanup-rebuilds-link", "repair-icon-and-deduplicate"]);
    expect(readWindowsStoreFirstRunRecord(options.storeUserDataPath)?.shortcutRepair).toMatchObject({
      completed: !fails, cleanupUncertain: fails
    });
    for (let index = 0; index < 4; index++) await finishWindowsStoreFirstRunIntegration(options, { cleanupDiscovered, createShortcut });
    // The fixture starts at attempt 1: uncertain cleanup leaves two attempts
    // total for this version, even when it rebuilds the old link after timeout.
    expect(createShortcut).toHaveBeenCalledTimes(fails ? 2 : 1);
    expect(cleanupDiscovered).toHaveBeenCalledOnce();
  });

  it("uses the discovered install drive ahead of an abandoned home runtime", async () => {
    const { options } = await fixture();
    const source = await discoverWindowsStoreImportSource(options, {
      discoverInstallation: async () => ({ installDirectory: "D:\\Memmy", appVersion: "1.0.0" }),
      isDirectory: async () => true, hasDatabase: async () => false, readPointer: async () => null
    });
    expect(source.runtimeHomePath).toBe("D:\\MemmyData\\.memmy");
    expect(source.installation?.installDirectory).toBe("D:\\Memmy");
  });

  it("keeps the transaction generation and retries recovery after a rollback failure", async () => {
    const { root, options, source } = await fixture();
    const external = win32.join(root, "external", ".memmy");
    await put(win32.join(source.userDataPath, "app.sqlite"), "account");
    await put(win32.join(source.runtimeHomePath, "prior.txt"), "before");
    await put(win32.join(external, "new.txt"), "copy");
    const result = await importWindowsStoreDataOnce(options, {
      discoverSource: async () => ({ ...source, runtimeHomePath: external }),
      prepareData: async (plan, params) => { await prepareWindowsStoreDataTransition(plan, params); throw new Error("commit interrupted"); },
      rollbackData: async () => { throw new Error("EACCES: backup locked"); }
    });
    expect(result.recoveryRequired).toBe(true);
    expect(result.generation).not.toBe("standalone");
    expect(result.sourceRuntimeHomePath).toBe(external);
    const discoverSource = vi.fn();
    const recovered = await importWindowsStoreDataOnce(options, { discoverSource });
    expect(recovered.recoveryRequired).toBe(false);
    expect(discoverSource).not.toHaveBeenCalled();
    expect(await readFile(win32.join(source.runtimeHomePath, "prior.txt"), "utf8")).toBe("before");
  });

  it("allows a confirmed old-process conflict to retry import after the old app is removed", async () => {
    const { options, source } = await fixture();
    await writeWindowsStoreFirstRunRecord(options.storeUserDataPath, { schemaVersion: 1, status: "failed", generation: "standalone", checkedAt: "now", retryAfterLegacyExit: true });
    await put(win32.join(source.userDataPath, "app.sqlite"), "account");
    await put(win32.join(source.runtimeHomePath, "config.yaml"), "name: old\n");
    expect((await importWindowsStoreDataOnce(options)).status).toBe("migrated");
  });

  it("tries independent cleanup after protocol-free migration and keeps shell errors nonfatal", async () => {
    const { options } = await fixture();
    await writeWindowsStoreFirstRunRecord(options.storeUserDataPath, { schemaVersion: 1, status: "migrated", generation: "11111111-1111-4111-8111-111111111111", checkedAt: "now", installation: { installDirectory: "D:\\Memmy", appVersion: "1.0.0" } });
    const cleanupDiscovered = vi.fn(async () => undefined);
    await finishWindowsStoreFirstRunIntegration(options, { createShortcut: async () => { throw new Error("desktop denied"); }, cleanupDiscovered });
    expect(cleanupDiscovered).toHaveBeenCalledOnce();
    await finishWindowsStoreFirstRunIntegration(options, { createShortcut: vi.fn(), cleanupDiscovered });
    expect(cleanupDiscovered).toHaveBeenCalledOnce();
  });

  it("persists compatible cleanup before ACK and retries only ACK after a crash", async () => {
    const { options, source } = await fixture();
    const cleanup = createWindowsStoreTransitionState({ ...options.identity, storeId: "9MZGLKWMZZV6",
      sourceInstallDirectory: "D:\\Memmy", sourceExecutablePath: "D:\\Memmy\\Memmy.exe", sourceVersion: "1.1.3",
      sourceUserDataPath: source.userDataPath, sourceRuntimeHomePath: source.runtimeHomePath, authority: "current-install-authority" });
    await writeWindowsStoreFirstRunRecord(options.storeUserDataPath, { schemaVersion: 1, status: "migrated", generation: cleanup.transactionId,
      checkedAt: "now", sourceUserDataPath: source.userDataPath, sourceRuntimeHomePath: source.runtimeHomePath, cleanup });
    const calls: string[] = [];
    const finalizeCompatible = vi.fn(async () => { calls.push("cleanup"); }), cleanupDiscovered = vi.fn();
    const acknowledgeCompatible = vi.fn(async () => {
      expect(readWindowsStoreFirstRunRecord(options.storeUserDataPath)?.cleanup?.phase).toBe("legacy-cleanup-attested");
      throw new Error("ACK interrupted");
    });
    await finishWindowsStoreFirstRunIntegration(options, { createShortcut: async () => { calls.push("shortcut"); }, finalizeCompatible, cleanupDiscovered, acknowledgeCompatible });
    expect(calls).toEqual(["cleanup", "shortcut"]);
    expect(finalizeCompatible).toHaveBeenCalledOnce();
    expect(cleanupDiscovered).not.toHaveBeenCalled();
    await finishWindowsStoreFirstRunIntegration(options, { finalizeCompatible, acknowledgeCompatible: async () => undefined });
    expect(finalizeCompatible).toHaveBeenCalledOnce();
    expect(readWindowsStoreFirstRunRecord(options.storeUserDataPath)?.cleanupAcknowledged).toBe(true);
  });

  it("reports permission failures once with both paths and never uninstalls on failed import", async () => {
    const { options, source } = await fixture();
    await writeWindowsStoreFirstRunRecord(options.storeUserDataPath, { schemaVersion: 1, status: "failed", generation: "standalone", checkedAt: "now", sourceRuntimeHomePath: "D:\\MemmyData\\.memmy", error: "EACCES" });
    const notifyFailure = vi.fn(async () => undefined), cleanupDiscovered = vi.fn();
    const dependencies = { notifyFailure, cleanupDiscovered, createShortcut: async () => undefined };
    await finishWindowsStoreFirstRunIntegration(options, dependencies);
    await finishWindowsStoreFirstRunIntegration(options, dependencies);
    expect(notifyFailure).toHaveBeenCalledOnce();
    expect(notifyFailure.mock.calls[0][0]).toContain(source.runtimeHomePath);
    expect(notifyFailure.mock.calls[0][0]).toContain("D:\\MemmyData\\.memmy");
    expect(cleanupDiscovered).not.toHaveBeenCalled();
  });
  it("imports an incompatible/uninstalled legacy profile without installer authority and keeps home .memmy", async () => {
    const { options, source } = await fixture();
    await put(win32.join(source.userDataPath, "app.sqlite"), "account");
    await put(win32.join(source.runtimeHomePath, "memory-service", "memory.sqlite"), "memory");
    const record = await importWindowsStoreDataOnce(options);
    expect(record.status).toBe("migrated");
    expect(record.cleanup).toBeUndefined();
    const layout = resolveWindowsStoreFirstRunLayout(options.storeUserDataPath, options.homeDirectory);
    expect(layout.runtimeHomePath).toBe(source.runtimeHomePath);
    expect(await readFile(win32.join(layout.userDataPath, "app.sqlite"), "utf8")).toBe("account");
    expect(await readFile(win32.join(source.userDataPath, "app.sqlite"), "utf8")).toBe("account");
    const discoverSource = vi.fn();
    await put(win32.join(source.userDataPath, "app.sqlite"), "old app changed later");
    expect(await importWindowsStoreDataOnce(options, { discoverSource })).toEqual(record);
    expect(discoverSource).not.toHaveBeenCalled();
    expect(await readFile(win32.join(layout.userDataPath, "app.sqlite"), "utf8")).toBe("account");
  });

  it("copies external .memmy including WAL to home, rebases internal paths and retains both old baselines", async () => {
    const { root, options, source } = await fixture();
    const external = win32.join(root, "OtherDrive", "MemmyData", ".memmy");
    await put(win32.join(source.userDataPath, "app.sqlite"), "account");
    await put(win32.join(source.userDataPath, "data-root.txt"), external);
    await put(win32.join(source.runtimeHomePath, "prior.txt"), "previous home data");
    await put(win32.join(external, "memory-service", "memory.sqlite-wal"), "wal");
    await put(win32.join(external, "config.yaml"), YAML.stringify({ agents: { defaults: { workspace: win32.join(external, "workspace") } }, project: "D:\\Projects\\keep" }));
    expect((await discoverWindowsStoreImportSource(options)).runtimeHomePath).toBe(external);
    const result = await importWindowsStoreDataOnce(options);
    expect(result.status).toBe("migrated");
    expect(await readFile(win32.join(source.runtimeHomePath, "memory-service", "memory.sqlite-wal"), "utf8")).toBe("wal");
    const config = YAML.parse(await readFile(win32.join(source.runtimeHomePath, "config.yaml"), "utf8"));
    expect(config.agents.defaults.workspace).toBe(win32.join(source.runtimeHomePath, "workspace"));
    expect(config.project).toBe("D:\\Projects\\keep");
    expect(await readFile(win32.join(external, "memory-service", "memory.sqlite-wal"), "utf8")).toBe("wal");
    expect(await readFile(`${source.runtimeHomePath}.store-backup-${result.generation}\\prior.txt`, "utf8")).toBe("previous home data");
  });

  it("imports runtime-only leftovers after old uninstall removed the profile", async () => {
    const { options, source } = await fixture();
    await put(win32.join(source.runtimeHomePath, "config.yaml"), "name: old\n");
    const result = await importWindowsStoreDataOnce(options);
    expect(result.status).toBe("migrated");
    expect(result.sourceUserDataPath).toBeUndefined();
    expect(await readFile(win32.join(source.runtimeHomePath, "config.yaml"), "utf8")).toBe("name: old\n");
  });

  it("marks no-data once and never scans again", async () => {
    const { options } = await fixture();
    const discoverSource = vi.fn(async () => ({}));
    expect((await importWindowsStoreDataOnce(options, { discoverSource })).status).toBe("no-data");
    expect((await importWindowsStoreDataOnce(options, { discoverSource })).status).toBe("no-data");
    expect(discoverSource).toHaveBeenCalledOnce();
  });

  it("ignores the old journal and its leftover staging/backup artifacts", async () => {
    const { options, source } = await fixture();
    await put(win32.join(source.userDataPath, "app.sqlite"), "account");
    await put(win32.join(source.runtimeHomePath, "config.yaml"), "name: old\n");
    await put(win32.join(options.localAppDataPath, "Memmy", "store-transition", "active.json"), "corrupt old journal");
    const residual = `${options.storeUserDataPath}.store-backup-00000000-0000-0000-0000-000000000000\\keep.txt`;
    await put(residual, "do not delete");
    expect((await importWindowsStoreDataOnce(options)).status).toBe("migrated");
    expect(await readFile(residual, "utf8")).toBe("do not delete");
  });

  it("records copy/permission failure without replacing source data or retrying on next boot", async () => {
    const { options, source } = await fixture();
    await put(win32.join(source.userDataPath, "app.sqlite"), "account");
    await put(win32.join(source.runtimeHomePath, "config.yaml"), "name: old\n");
    const prepareData = vi.fn(async () => { throw new Error("EACCES: copy denied"); });
    expect((await importWindowsStoreDataOnce(options, { prepareData })).status).toBe("failed");
    expect((await importWindowsStoreDataOnce(options, { prepareData })).status).toBe("failed");
    expect(prepareData).toHaveBeenCalledOnce();
    expect(await readFile(win32.join(source.userDataPath, "app.sqlite"), "utf8")).toBe("account");
  });

  it("recovers a killed import transaction without rediscovering data", async () => {
    const { root, options, source } = await fixture();
    const generation = "11111111-1111-4111-8111-111111111111";
    const external = win32.join(root, "OtherDrive", ".memmy");
    await put(win32.join(source.userDataPath, "app.sqlite"), "account");
    await put(win32.join(source.runtimeHomePath, "prior.txt"), "before");
    await put(win32.join(external, "imported.txt"), "imported");
    const target = win32.join(resolveWindowsStoreFirstRunRoot(options.storeUserDataPath), generation);
    await writeWindowsStoreFirstRunRecord(options.storeUserDataPath, { schemaVersion: 1, status: "pending", generation, checkedAt: new Date().toISOString() });
    await prepareWindowsStoreDataTransition(planWindowsStoreDataTransition({ transactionId: generation,
      sourceUserDataPath: source.userDataPath, sourceRuntimeHomePath: external,
      destinationUserDataPath: win32.join(target, "Memmy"), destinationRuntimeHomePath: source.runtimeHomePath, migrateRuntime: true
    }), { preparedStatePath: win32.join(target, "prepared.json") });
    const discoverSource = vi.fn();
    expect((await importWindowsStoreDataOnce(options, { discoverSource })).status).toBe("failed");
    expect(discoverSource).not.toHaveBeenCalled();
    expect(await readFile(win32.join(source.runtimeHomePath, "prior.txt"), "utf8")).toBe("before");
    expect(readWindowsStoreFirstRunRecord(options.storeUserDataPath)?.status).toBe("failed");
  });
});
