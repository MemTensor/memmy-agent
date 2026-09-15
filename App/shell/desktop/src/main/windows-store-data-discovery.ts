import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { win32 } from "node:path";
import { promisify } from "node:util";
import type { WindowsStoreLegacyTransitionOptions } from "./windows-store-legacy-transition.js";

export interface WindowsStoreImportSource {
  userDataPath?: string;
  runtimeHomePath?: string;
  installation?: WindowsStoreDiscoveredInstallation;
}

export interface WindowsStoreDiscoveredInstallation {
  installDirectory: string;
  appVersion: string;
  fingerprint?: string;
}

export const discoverWindowsStoreLegacyInstallation = async (
  options: WindowsStoreLegacyTransitionOptions
): Promise<WindowsStoreDiscoveredInstallation | undefined> => {
  const result = await promisify(execFile)(win32.join(options.resourcesPath, "native", "MemmyStoreUpdate.exe"),
    ["discover-legacy-installation"], { timeout: 10_000, windowsHide: true });
  const value = JSON.parse(result.stdout);
  if (!value) return undefined;
  if (typeof value.installDirectory !== "string" || !win32.isAbsolute(value.installDirectory)
      || win32.parse(value.installDirectory).root === value.installDirectory
      || /\\WindowsApps\\/iu.test(value.installDirectory)) throw new Error("Invalid legacy installation directory");
  return { installDirectory: win32.normalize(value.installDirectory), appVersion: String(value.appVersion ?? "0.0.0"),
    fingerprint: typeof value.fingerprint === "string" ? value.fingerprint : undefined };
};

export const legacyRuntimeForInstallation = (installDirectory: string, homeDirectory: string): string => {
  const drive = win32.parse(installDirectory).root;
  return drive.toLowerCase() === "c:\\" ? win32.join(homeDirectory, ".memmy") : win32.join(drive, "MemmyData", ".memmy");
};

export const readOptionalWindowsDataPointer = async (path: string): Promise<string | null> => {
  try {
    const bytes = await readFile(path);
    const value = (bytes[0] === 0xff && bytes[1] === 0xfe
      ? bytes.subarray(2).toString("utf16le") : bytes.toString("utf8")).replace(/^\uFEFF/u, "").trim();
    return win32.isAbsolute(value) && win32.basename(value).toLowerCase() === ".memmy" ? win32.normalize(value) : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

export const isPlainWindowsDataDirectory = async (path: string): Promise<boolean> => {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) throw new Error(`Store import refuses a linked data directory: ${path}`);
    return stats.isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

const hasAppDatabase = async (path: string): Promise<boolean> => {
  try { return (await lstat(win32.join(path, "app.sqlite"))).isFile(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

/** Data discovery deliberately does not require an installed EXE, registry key or broker. */
export const discoverWindowsStoreImportSource = async (
  options: WindowsStoreLegacyTransitionOptions,
  dependencies: {
    discoverInstallation?: typeof discoverWindowsStoreLegacyInstallation;
    isDirectory?: typeof isPlainWindowsDataDirectory;
    hasDatabase?: typeof hasAppDatabase;
    readPointer?: typeof readOptionalWindowsDataPointer;
  } = {}
): Promise<WindowsStoreImportSource> => {
  const isDirectory = dependencies.isDirectory ?? isPlainWindowsDataDirectory;
  const installation = await (dependencies.discoverInstallation ?? discoverWindowsStoreLegacyInstallation)(options).catch(() => undefined);
  const legacyProfile = win32.join(options.roamingAppDataPath, "Memmy");
  // Preserve the account of an already-used Store profile when updating an older Store build.
  const existingStoreProfile = await (dependencies.hasDatabase ?? hasAppDatabase)(options.storeUserDataPath);
  const userDataPath = existingStoreProfile
    ? options.storeUserDataPath
    : await isDirectory(legacyProfile) ? legacyProfile : undefined;
  if (installation && !existingStoreProfile) {
    const runtime = legacyRuntimeForInstallation(installation.installDirectory, options.homeDirectory);
    if (await isDirectory(runtime)) return { userDataPath, runtimeHomePath: runtime, installation };
  }
  const pointer = userDataPath
    ? await (dependencies.readPointer ?? readOptionalWindowsDataPointer)(win32.join(userDataPath, "data-root.txt")) : null;
  if (pointer) {
    if (!await isDirectory(pointer)) throw new Error(`Legacy data volume is unavailable: ${pointer}`);
    return { userDataPath, runtimeHomePath: pointer, installation };
  }
  const homeRuntime = win32.join(options.homeDirectory, ".memmy");
  if (await isDirectory(homeRuntime)) return { userDataPath, runtimeHomePath: homeRuntime, installation };

  // Old uninstallers can remove the pointer while leaving the external data directory.
  // Probe only the historical fixed directory on each drive; never recursively scan a disk.
  const candidates: string[] = [];
  for (const drive of "DEFGHIJKLMNOPQRSTUVWXYZABC") {
    const candidate = `${drive}:\\MemmyData\\.memmy`;
    if (await isDirectory(candidate)) candidates.push(candidate);
  }
  if (candidates.length > 1) throw new Error("Several legacy data roots exist without a data-root pointer");
  return { userDataPath, runtimeHomePath: candidates[0], installation };
};
