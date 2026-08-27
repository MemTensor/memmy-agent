/** Desktop install state service module. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AppStateStore } from "../infrastructure/app-state-store/index.js";

const DESKTOP_INSTALL_MARKER_FILE = "desktop-install-state.json";

export interface ResetAccountRuntimeForDesktopInstallChangeOptions {
  appStateStore: AppStateStore;
  databasePath: string;
  memmyConfigPath: string;
  installFingerprint: string;
  markerPath?: string;
  now?: () => Date;
}

export interface DesktopInstallResetResult {
  changedInstall: boolean;
  resetAccountRuntime: boolean;
  markerPath: string;
  reason: "empty_fingerprint" | "same_install_fingerprint" | "new_install_fingerprint";
}

interface DesktopInstallMarker {
  installFingerprint: string;
  updatedAt: string;
}

/** Handles reset account runtime for desktop install change. */
export async function resetAccountRuntimeForDesktopInstallChange(
  options: ResetAccountRuntimeForDesktopInstallChangeOptions
): Promise<DesktopInstallResetResult> {
  const installFingerprint = options.installFingerprint.trim();
  const markerPath = options.markerPath ?? resolveDesktopInstallMarkerPath(options.databasePath);
  if (!installFingerprint) {
    return { changedInstall: false, resetAccountRuntime: false, markerPath, reason: "empty_fingerprint" };
  }

  const marker = await readDesktopInstallMarker(markerPath);
  if (marker?.installFingerprint === installFingerprint) {
    return { changedInstall: false, resetAccountRuntime: false, markerPath, reason: "same_install_fingerprint" };
  }

  await writeDesktopInstallMarker(markerPath, {
    installFingerprint,
    updatedAt: (options.now ?? (() => new Date()))().toISOString()
  });

  return {
    changedInstall: true,
    resetAccountRuntime: false,
    markerPath,
    reason: "new_install_fingerprint"
  };
}

function resolveDesktopInstallMarkerPath(databasePath: string): string {
  return join(dirname(databasePath), DESKTOP_INSTALL_MARKER_FILE);
}

async function readDesktopInstallMarker(markerPath: string): Promise<DesktopInstallMarker | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(markerPath, "utf8"));
    if (!isRecord(parsed) || typeof parsed.installFingerprint !== "string" || typeof parsed.updatedAt !== "string") {
      return null;
    }
    return {
      installFingerprint: parsed.installFingerprint,
      updatedAt: parsed.updatedAt
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    return null;
  }
}

async function writeDesktopInstallMarker(markerPath: string, marker: DesktopInstallMarker): Promise<void> {
  await mkdir(dirname(markerPath), { recursive: true });
  await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}
