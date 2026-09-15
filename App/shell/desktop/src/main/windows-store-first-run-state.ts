import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { win32 } from "node:path";
import type { WindowsStoreTransitionState } from "./windows-store-transition-state.js";
import type { WindowsStoreDiscoveredInstallation } from "./windows-store-data-discovery.js";

export const WINDOWS_STORE_SHORTCUT_REPAIR_VERSION = 1;
export const WINDOWS_STORE_SHORTCUT_REPAIR_MAX_ATTEMPTS = 3;

export interface WindowsStoreFirstRunRecord {
  schemaVersion: 1;
  status: "pending" | "migrated" | "no-data" | "failed";
  generation: string;
  checkedAt: string;
  sourceUserDataPath?: string;
  sourceRuntimeHomePath?: string;
  error?: string;
  installation?: WindowsStoreDiscoveredInstallation;
  recoveryRequired?: boolean;
  retryAfterLegacyExit?: boolean;
  failureNotified?: boolean;
  cleanup?: WindowsStoreTransitionState;
  cleanupAcknowledged?: boolean;
  cleanupAttempted?: boolean;
  integrationAttempted?: boolean;
  shortcutRepair?: { version: number; attempts: number; completed: boolean; cleanupUncertain?: boolean };
}

export const resolveWindowsStoreFirstRunRoot = (storeUserDataPath: string): string =>
  win32.join(win32.dirname(storeUserDataPath), "store-data");

export const resolveWindowsStoreFirstRunStatePath = (storeUserDataPath: string): string =>
  win32.join(resolveWindowsStoreFirstRunRoot(storeUserDataPath), "first-run.json");

export const readWindowsStoreFirstRunRecord = (storeUserDataPath: string): WindowsStoreFirstRunRecord | null => {
  try {
    const value = JSON.parse(readFileSync(resolveWindowsStoreFirstRunStatePath(storeUserDataPath), "utf8"));
    if (value.schemaVersion !== 1 || !["pending", "migrated", "no-data", "failed"].includes(value.status)
        || !/^(?:standalone|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/u.test(value.generation)
        || typeof value.checkedAt !== "string") throw new Error("Invalid Store first-run marker");
    return value as WindowsStoreFirstRunRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    // An unreadable marker is never permission to import over a profile again.
    return { schemaVersion: 1, status: "failed", generation: "standalone", checkedAt: "", error: String(error) };
  }
};

export const resolveWindowsStoreFirstRunLayout = (storeUserDataPath: string, homeDirectory: string, independent = false) => {
  const record = readWindowsStoreFirstRunRecord(storeUserDataPath);
  const generation = !independent && record?.status === "migrated" ? record.generation : "standalone";
  const root = win32.join(resolveWindowsStoreFirstRunRoot(storeUserDataPath), generation);
  return { userDataPath: win32.join(root, "Memmy"), runtimeHomePath: win32.join(homeDirectory, ".memmy") };
};

export const recordWindowsStoreWorkerFailureSync = (storeUserDataPath: string, error: unknown): void => {
  const existing = readWindowsStoreFirstRunRecord(storeUserDataPath);
  if (existing && existing.status !== "pending") return;
  const record: WindowsStoreFirstRunRecord = {
    ...existing, schemaVersion: 1, status: "failed", generation: existing?.generation ?? "standalone",
    checkedAt: existing?.checkedAt ?? new Date().toISOString(), error: String(error),
    recoveryRequired: existing?.status === "pending"
  };
  const path = resolveWindowsStoreFirstRunStatePath(storeUserDataPath);
  mkdirSync(win32.dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
  renameSync(temporary, path);
};

export const writeWindowsStoreFirstRunRecord = async (
  storeUserDataPath: string,
  record: WindowsStoreFirstRunRecord
): Promise<void> => {
  const path = resolveWindowsStoreFirstRunStatePath(storeUserDataPath);
  await mkdir(win32.dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, path);
};
