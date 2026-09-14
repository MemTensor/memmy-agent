import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { acknowledgeWindowsStoreLegacyCleanup, buildLegacyCleanupArguments, finalizeWindowsStoreLegacyInstallation, type WindowsStoreLegacyTransitionOptions } from "./windows-store-legacy-transition.js";
import { readWindowsStoreFirstRunRecord, resolveWindowsStoreFirstRunLayout, resolveWindowsStoreFirstRunRoot, writeWindowsStoreFirstRunRecord, WINDOWS_STORE_SHORTCUT_REPAIR_VERSION, WINDOWS_STORE_SHORTCUT_REPAIR_MAX_ATTEMPTS, type WindowsStoreFirstRunRecord } from "./windows-store-first-run-state.js";
import { stageWindowsStoreUnpackagedHelper } from "./windows-store-helper-staging.js";
import { readWindowsStoreTransitionState, resolveWindowsStoreTransitionStatePath, writeWindowsStoreTransitionState } from "./windows-store-transition-state.js";
import { acquireWindowsStoreTransitionSourceLease } from "./windows-store-transition-source-lifetime.js";

const execFileAsync = promisify(execFile);
export interface WindowsStoreFirstRunIntegrationDependencies {
  createShortcut?: (options: WindowsStoreLegacyTransitionOptions) => Promise<unknown>;
  finalizeCompatible?: typeof finalizeWindowsStoreLegacyInstallation;
  acknowledgeCompatible?: typeof acknowledgeWindowsStoreLegacyCleanup;
  cleanupDiscovered?: typeof cleanupDiscoveredWindowsStoreLegacyInstallation;
  notifyFailure?: (message: string) => Promise<unknown>;
}

/** Shell integration is optional and runs only after the Store window has opened. */
export const finishWindowsStoreFirstRunIntegration = async (
  options: WindowsStoreLegacyTransitionOptions,
  dependencies: WindowsStoreFirstRunIntegrationDependencies = {}
): Promise<void> => {
  const initialRecord = readWindowsStoreFirstRunRecord(options.storeUserDataPath);
  if (!initialRecord) return;
  let record = initialRecord;
  const save = async (patch: Partial<WindowsStoreFirstRunRecord>) => {
    record = { ...record, ...patch };
    await writeWindowsStoreFirstRunRecord(options.storeUserDataPath, record);
  };
  if (record.status === "failed" && !record.failureNotified && dependencies.notifyFailure) {
    await dependencies.notifyFailure(describeWindowsStoreImportFailure(options, record));
    await save({ failureNotified: true }).catch(console.warn);
  }
  let cleanupReplacedShortcut = false;
  let cleanupUncertain = record.shortcutRepair?.cleanupUncertain === true;
  const finishCleanup = async () => {
    if (record.status !== "migrated") return;
    let state = record.cleanup;
    if (state && (state.packageFamilyName !== options.identity.packageFamilyName || state.aumid !== options.identity.aumid
        || state.edition !== options.identity.edition || state.sourceRuntimeHomePath !== record.sourceRuntimeHomePath
        || state.sourceUserDataPath !== record.sourceUserDataPath)) state = undefined;
    // An attestation survives a crash between uninstall and ACK. Retry only the ACK.
    if (state?.phase === "legacy-cleanup-attested") {
      if (!record.cleanupAcknowledged) {
        await withCompatibleSourceLease(options, () => (dependencies.acknowledgeCompatible ?? acknowledgeWindowsStoreLegacyCleanup)({ ...options, state: state! }));
        await save({ cleanupAcknowledged: true });
      }
      return;
    }
    if (record.cleanupAttempted) return;
    // The compatible NSIS broker remains the main path. An unknown result must be
    // replayed with that broker, never bypassed by an independent deletion attempt.
    if (state) {
      try {
        cleanupReplacedShortcut = true;
        cleanupUncertain = true;
        await withCompatibleSourceLease(options, () => (dependencies.finalizeCompatible ?? finalizeWindowsStoreLegacyInstallation)({ ...options, state: state! }));
        cleanupUncertain = false;
        state = { ...state, phase: "legacy-cleanup-attested" };
        await save({ cleanup: state });
        const path = resolveWindowsStoreTransitionStatePath(options.localAppDataPath);
        const active = await readWindowsStoreTransitionState(path).catch(() => null);
        if (active?.transactionId === state.transactionId) await writeWindowsStoreTransitionState(path, state).catch(console.warn);
        await withCompatibleSourceLease(options, () => (dependencies.acknowledgeCompatible ?? acknowledgeWindowsStoreLegacyCleanup)({ ...options, state: state! }));
        await save({ cleanupAcknowledged: true, cleanupAttempted: true });
        return;
      } catch (error) {
        console.warn("Compatible Store cleanup deferred:", error);
        return;
      }
    }
    await save({ cleanupAttempted: true });
    if (record.installation) {
      cleanupReplacedShortcut = true;
      cleanupUncertain = true;
      await (dependencies.cleanupDiscovered ?? cleanupDiscoveredWindowsStoreLegacyInstallation)(options, record);
      cleanupUncertain = false;
    }
  };
  try {
    await finishCleanup();
  } finally {
    // Cleanup can recreate an AppsFolder link without its persistent icon. Repair
    // afterwards, independently of the import generation and the old boolean.
    try {
      const previous = record.shortcutRepair;
      const current = previous?.version === WINDOWS_STORE_SHORTCUT_REPAIR_VERSION ? previous : undefined;
      const attempts = current && Number.isSafeInteger(current.attempts) && current.attempts >= 0 ? current.attempts : 0;
      if (!(previous && previous.version > WINDOWS_STORE_SHORTCUT_REPAIR_VERSION)
          && (!current?.completed || cleanupReplacedShortcut)
          && attempts < WINDOWS_STORE_SHORTCUT_REPAIR_MAX_ATTEMPTS) {
        const shortcutRepair = { version: WINDOWS_STORE_SHORTCUT_REPAIR_VERSION, attempts: attempts + 1, completed: false, cleanupUncertain };
        // Persist the attempt before touching the desktop: killed/failed helpers
        // cannot cause an unbounded repair on every subsequent app launch.
        await save({ shortcutRepair });
        await (dependencies.createShortcut ?? createStoreShortcut)(options);
        // An unpackaged cleanup can outlive its receipt timeout and recreate the
        // old link later. Keep subsequent repairs eligible within the same cap.
        await save({ shortcutRepair: { ...shortcutRepair, completed: !cleanupUncertain } });
      }
    } catch (error) {
      console.warn("Store shortcut repair failed:", error);
    }
  }
};

const withCompatibleSourceLease = async (options: WindowsStoreLegacyTransitionOptions, operation: () => Promise<void>): Promise<void> => {
  const lease = await acquireWindowsStoreTransitionSourceLease({ statePath: resolveWindowsStoreTransitionStatePath(options.localAppDataPath) });
  try { await operation(); } finally { await lease.release(); }
};

const createStoreShortcut = async (options: WindowsStoreLegacyTransitionOptions) => execFileAsync(
  win32.join(options.resourcesPath, "native", "MemmyStoreUpdate.exe"), [
    "create-store-shortcut", "--aumid", options.identity.aumid,
    "--package-family-name", options.identity.packageFamilyName
  ], { timeout: 15_000, windowsHide: true });

export const describeWindowsStoreImportFailure = (options: WindowsStoreLegacyTransitionOptions, record: WindowsStoreFirstRunRecord): string => {
  const layout = resolveWindowsStoreFirstRunLayout(options.storeUserDataPath, options.homeDirectory);
  return [
    "旧版本数据未能自动迁移，Memmy 将继续启动。旧数据和迁移备份已保留。",
    `原因：${record.error ?? "无法读取旧数据"}`,
    "如需手动迁移，请先退出新旧两个版本，并备份目标目录，再复制旧数据。",
    `旧数据目录：${record.sourceRuntimeHomePath ?? "旧安装盘的 MemmyData\\.memmy 或用户目录的 .memmy"}`,
    `新版数据目录：${layout.runtimeHomePath}`,
    ...(record.sourceUserDataPath ? [`旧应用配置：${record.sourceUserDataPath}`, `新版应用配置：${layout.userDataPath}`] : []),
    ...(record.recoveryRequired ? [`迁移恢复记录：${win32.join(resolveWindowsStoreFirstRunRoot(options.storeUserDataPath), record.generation, "prepared.json")}`] : [])
  ].join("\n\n");
};

export const cleanupDiscoveredWindowsStoreLegacyInstallation = async (
  options: WindowsStoreLegacyTransitionOptions, record: WindowsStoreFirstRunRecord
): Promise<void> => {
  if (record.status !== "migrated" || !record.installation?.fingerprint) return;
  const installDirectory = record.installation.installDirectory;
  // Never retire an installation containing the retained source or the new runtime.
  for (const dataPath of [record.sourceUserDataPath, record.sourceRuntimeHomePath, win32.join(options.homeDirectory, ".memmy")]) {
    if (!dataPath) continue;
    const relative = win32.relative(installDirectory, dataPath);
    if (relative !== ".." && !relative.startsWith("..\\") && !win32.isAbsolute(relative)) throw new Error("Legacy installation contains retained data");
  }
  const packagedHelper = win32.join(options.resourcesPath, "native", "MemmyStoreUpdate.exe");
  const externalHelper = win32.join(options.localAppDataPath, "Memmy", "store-transition", "native", options.identity.packageFamilyName, "MemmyStoreUpdate.exe");
  await stageWindowsStoreUnpackagedHelper(packagedHelper, externalHelper);
  const attemptId = randomUUID();
  const args = buildLegacyCleanupArguments({ helperPath: packagedHelper, legacyInstallDirectory: installDirectory,
    legacyExecutablePath: win32.join(installDirectory, "Memmy.exe"), aumid: options.identity.aumid,
    packageFamilyName: options.identity.packageFamilyName, transitionId: record.generation, attemptId });
  await execFileAsync(packagedHelper, ["launch-discovered-legacy-cleanup", ...args.slice(1), "--external-helper-path", externalHelper,
    "--legacy-install-fingerprint", record.installation.fingerprint],
    { timeout: 15_000, windowsHide: true });
  const receipt = win32.join(win32.dirname(externalHelper), `cleanup-${attemptId}.json`);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const result = JSON.parse(await readFile(receipt, "utf8"));
      if (result.status !== "cleaned") throw new Error("Legacy installation cleanup failed; Store remains available");
      return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await delay(500);
  }
  throw new Error("Legacy installation cleanup timed out; Store remains available");
};
