import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { win32 } from "node:path";
import YAML from "yaml";
import {
  planWindowsStoreDataTransition, prepareWindowsStoreDataTransition,
  readWindowsStorePreparedDataTransition, rollbackWindowsStoreDataTransition,
  type PreparedWindowsStoreDataTransition
} from "./windows-store-data-transition.js";
import { discoverWindowsStoreImportSource, type WindowsStoreImportSource } from "./windows-store-data-discovery.js";
import { readWindowsStoreFirstRunRecord, resolveWindowsStoreFirstRunRoot, writeWindowsStoreFirstRunRecord, type WindowsStoreFirstRunRecord } from "./windows-store-first-run-state.js";
import type { WindowsStoreLegacyTransitionOptions } from "./windows-store-legacy-transition.js";
import { readWindowsStoreTransitionState, resolveWindowsStoreTransitionStatePath } from "./windows-store-transition-state.js";

export interface WindowsStoreFirstRunImportDependencies {
  discoverSource?: typeof discoverWindowsStoreImportSource;
  prepareData?: typeof prepareWindowsStoreDataTransition;
  writeRecord?: typeof writeWindowsStoreFirstRunRecord;
  rollbackData?: typeof rollbackWindowsStoreDataTransition;
  recoveryOnlyError?: string;
}

/** First import is independent of installer cleanup. Store always owns USERPROFILE/.memmy. */
export const importWindowsStoreDataOnce = async (
  options: WindowsStoreLegacyTransitionOptions,
  dependencies: WindowsStoreFirstRunImportDependencies = {}
): Promise<WindowsStoreFirstRunRecord> => {
  const writeRecord = dependencies.writeRecord ?? writeWindowsStoreFirstRunRecord;
  let record = readWindowsStoreFirstRunRecord(options.storeUserDataPath);
  if (record && record.status !== "pending" && !record.recoveryRequired && !record.retryAfterLegacyExit) return record;
  const rollbackData = dependencies.rollbackData ?? rollbackWindowsStoreDataTransition;
  let recovering = false;
  try {
    if (record && (record.status === "pending" || record.recoveryRequired)) {
      recovering = true;
      await rollbackInterruptedImport(options, record, rollbackData);
      recovering = false;
      record = { ...record, status: "failed", recoveryRequired: false, error: record.error ?? "Previous Store data import was interrupted" };
    }
    if (!record || record.retryAfterLegacyExit) {
      if (dependencies.recoveryOnlyError) {
        record = { schemaVersion: 1, status: "failed", generation: "standalone", checkedAt: new Date().toISOString(), error: dependencies.recoveryOnlyError };
        await writeRecord(options.storeUserDataPath, record);
        return record;
      }
      record = { schemaVersion: 1, status: "pending", generation: randomUUID(), checkedAt: new Date().toISOString() };
      // A crash leaves a durable attempt marker. Recovery never discovers/imports the source again.
      await writeRecord(options.storeUserDataPath, record);
      const source = await (dependencies.discoverSource ?? discoverWindowsStoreImportSource)(options);
      if (!source.userDataPath && !source.runtimeHomePath) {
        record = { ...record, status: "no-data" };
      } else {
        const root = win32.join(resolveWindowsStoreFirstRunRoot(options.storeUserDataPath), record.generation);
        const runtimeHomePath = win32.join(options.homeDirectory, ".memmy");
        const sourceUserDataPath = source.userDataPath ?? win32.join(root, "empty-profile");
        if (!source.userDataPath) await mkdir(sourceUserDataPath, { recursive: true });
        const plan = planWindowsStoreDataTransition({
          transactionId: record.generation, sourceUserDataPath,
          sourceRuntimeHomePath: source.runtimeHomePath ?? runtimeHomePath,
          destinationUserDataPath: win32.join(root, "Memmy"), destinationRuntimeHomePath: runtimeHomePath,
          migrateRuntime: Boolean(source.runtimeHomePath && !samePath(source.runtimeHomePath, runtimeHomePath))
        });
        record = { ...record, sourceUserDataPath: source.userDataPath, sourceRuntimeHomePath: source.runtimeHomePath, installation: source.installation };
        await writeRecord(options.storeUserDataPath, record);
        await (dependencies.prepareData ?? prepareWindowsStoreDataTransition)(plan, {
          preparedStatePath: win32.join(root, "prepared.json")
        });
        if (plan.migrateRuntime) await rebaseImportedRuntime(source.runtimeHomePath!, runtimeHomePath);
        await mkdir(runtimeHomePath, { recursive: true });
        await writeFile(win32.join(root, "Memmy", "data-root.txt"), `${runtimeHomePath}\r\n`, "utf8");
        const cleanup = await readCompatibleCleanup(options, source).catch(() => undefined);
        record = { ...record, status: "migrated", ...(cleanup ? { cleanup } : {}) };
      }
    }
    await writeRecord(options.storeUserDataPath, record);
    return record;
  } catch (error) {
    let rollbackError: unknown;
    // prepareData can throw after committing files but before returning its in-memory
    // result. Always recover from the durable prepared journal, including that case.
    if (record && !recovering) await rollbackInterruptedImport(options, record, rollbackData).catch((cause: unknown) => { rollbackError = cause; });
    if (recovering) rollbackError = error;
    const failed: WindowsStoreFirstRunRecord = {
      ...record, schemaVersion: 1, status: "failed", generation: record?.generation ?? "standalone", checkedAt: record?.checkedAt ?? new Date().toISOString(),
      recoveryRequired: Boolean(rollbackError), retryAfterLegacyExit: false,
      error: `${String(error)}${rollbackError ? `; rollback: ${String(rollbackError)}` : ""}`
    };
    await writeRecord(options.storeUserDataPath, failed).catch(() => undefined);
    await releaseLegacyTransition(options).catch(() => undefined);
    return failed;
  }
};

const rollbackInterruptedImport = async (
  options: WindowsStoreLegacyTransitionOptions, record: WindowsStoreFirstRunRecord,
  rollbackData = rollbackWindowsStoreDataTransition
): Promise<void> => {
  const root = win32.join(resolveWindowsStoreFirstRunRoot(options.storeUserDataPath), record.generation);
  const prepared = await readWindowsStorePreparedDataTransition(win32.join(root, "prepared.json"));
  if (!prepared) return;
  if (prepared.plan.transactionId !== record.generation
      || !samePath(prepared.plan.destinationUserDataPath, win32.join(root, "Memmy"))
      || !samePath(prepared.plan.destinationRuntimeHomePath, win32.join(options.homeDirectory, ".memmy"))) {
    throw new Error("Interrupted Store import does not match this user's destinations");
  }
  await rollbackData(prepared);
};

const readCompatibleCleanup = async (options: WindowsStoreLegacyTransitionOptions, source: WindowsStoreImportSource) => {
  const state = await readWindowsStoreTransitionState(resolveWindowsStoreTransitionStatePath(options.localAppDataPath));
  if (!state || state.phase === "cleaned" || state.packageFamilyName !== options.identity.packageFamilyName
      || state.aumid !== options.identity.aumid || state.edition !== options.identity.edition
      || !source.userDataPath || !source.runtimeHomePath
      || !samePath(state.sourceUserDataPath, source.userDataPath)
      || !samePath(state.sourceRuntimeHomePath, source.runtimeHomePath)) return undefined;
  return state;
};

const releaseLegacyTransition = async (options: WindowsStoreLegacyTransitionOptions): Promise<void> => {
  const path = resolveWindowsStoreTransitionStatePath(options.localAppDataPath);
  const state = await readWindowsStoreTransitionState(path);
  if (state?.packageFamilyName === options.identity.packageFamilyName && state.aumid === options.identity.aumid) {
    await rename(path, `${path}.data-import-finished-${randomUUID()}`);
  }
};

/** Only rewrite paths inside the migrated runtime; never relocate user project directories. */
export const rebaseImportedRuntime = async (sourceRuntime: string, destinationRuntime: string): Promise<void> => {
  const path = win32.join(destinationRuntime, "config.yaml");
  let contents: string;
  try { contents = await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const rebase = (value: unknown): unknown => {
    if (typeof value === "string" && win32.isAbsolute(value)) {
      const relative = win32.relative(sourceRuntime, value);
      return relative !== ".." && !relative.startsWith("..\\") && !win32.isAbsolute(relative)
        ? win32.join(destinationRuntime, relative) : value;
    }
    if (Array.isArray(value)) return value.map(rebase);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rebase(item)]));
    return value;
  };
  await writeFile(path, YAML.stringify(rebase(YAML.parse(contents))), "utf8");
};

const samePath = (left: string, right: string): boolean => win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();
