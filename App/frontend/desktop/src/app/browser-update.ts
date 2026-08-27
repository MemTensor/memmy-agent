/** Browser update fallback module. */
import type { DesktopUpdateCheckResult } from "@memmy/desktop-interface";
import { resolveDesktopAccountChannel } from "./account-channel.js";

const UPDATE_MANIFEST_PATH = "/api/memmy/desktop/latest";

/**
 * Requests the update manifest in browser development environments.
 *
 * @param currentVersion The current app version.
 * @returns The normalized update check result.
 */
export async function checkForUpdatesInBrowser(currentVersion: string): Promise<DesktopUpdateCheckResult> {
  const manifestUrl = readBrowserUpdateManifestUrl(currentVersion);
  if (!manifestUrl) {
    return { status: "not-configured", currentVersion };
  }

  const response = await fetch(manifestUrl, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`update manifest request failed: ${response.status}`);
  }

  return parseBrowserUpdateManifest(await response.json() as unknown, currentVersion);
}

/**
 * Reads the update manifest URL for browser development environments.
 *
 * @param currentVersion The current app version.
 * @returns The configured manifest URL, or null when updates are not configured.
 */
export function readBrowserUpdateManifestUrl(currentVersion: string): string | null {
  const cloudServiceBaseUrl = import.meta.env.MEMMY_CLOUD_SERVICE;
  if (typeof cloudServiceBaseUrl !== "string" || !cloudServiceBaseUrl.trim()) {
    return null;
  }

  const url = new URL(`${cloudServiceBaseUrl.trim().replace(/\/+$/, "")}${UPDATE_MANIFEST_PATH}`);
  url.searchParams.set("platformType", resolveBrowserUpdatePlatformType());
  url.searchParams.set("version", currentVersion);
  return url.toString();
}

/**
 * Parses the cloud update manifest response.
 *
 * @param manifest The raw cloud response.
 * @param currentVersion The current app version.
 * @returns The normalized update check result.
 */
export function parseBrowserUpdateManifest(manifest: unknown, currentVersion: string): DesktopUpdateCheckResult {
  const normalizedManifest = readBrowserUpdateEnvelopeManifest(manifest);
  const latestVersion = readUpdateManifestString(normalizedManifest, "version");
  if (!latestVersion) {
    throw new Error("update manifest missing version");
  }

  if (compareUpdateVersions(latestVersion, currentVersion) <= 0) {
    return { status: "latest", currentVersion, latestVersion };
  }

  const downloadUrl = resolveBrowserUpdateDownloadUrl(normalizedManifest);
  const minSupportedVersion = readUpdateManifestString(normalizedManifest, "minSupportedVersion");
  const updateMode = readBrowserUpdateMode(normalizedManifest);
  const force = updateMode === "force"
    || Boolean(minSupportedVersion && compareUpdateVersions(currentVersion, minSupportedVersion) < 0);
  const releaseNotes = readUpdateManifestString(normalizedManifest, "releaseNotes");
  const publishedAt = readUpdateManifestString(normalizedManifest, "publishedAt");
  return {
    status: "available",
    currentVersion,
    latestVersion,
    ...(minSupportedVersion ? { minSupportedVersion } : {}),
    ...(updateMode ? { updateMode } : {}),
    ...(force ? { force } : {}),
    ...(downloadUrl ? { downloadUrl } : {}),
    ...(releaseNotes ? { releaseNotes } : {}),
    ...(publishedAt ? { publishedAt } : {})
  };
}

/** Opens the update URL in a browser development environment. */
export function openUpdateUrlInBrowser(downloadUrl: string): void {
  if (typeof window === "undefined") {
    return;
  }

  window.open(downloadUrl, "_blank", "noopener,noreferrer");
}

/** Compares numeric version segments. */
export function compareUpdateVersions(left: string, right: string): number {
  const leftParts = extractUpdateVersionSegments(left);
  const rightParts = extractUpdateVersionSegments(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function resolveBrowserUpdateEdition(): "cn" | "intl" {
  return resolveDesktopAccountChannel() === "email" ? "intl" : "cn";
}

function resolveBrowserUpdateSigning(): "signed" | "unsigned" {
  return import.meta.env.MEMMY_PACKAGE_SIGNING === "unsigned" ? "unsigned" : "signed";
}

function resolveBrowserUpdatePlatformType(): string {
  return `${resolveBrowserUpdatePlatform()}-${resolveBrowserUpdateArch()}-${resolveBrowserUpdateEdition()}-${resolveBrowserUpdateSigning()}`;
}

function readBrowserUpdateEnvelopeManifest(manifest: unknown): unknown {
  if (!isUpdateManifestRecord(manifest)) {
    return {};
  }

  if (manifest.code !== 0) {
    throw new Error("update manifest response code is not ok");
  }

  return readUpdateManifestRecord(manifest, "data") ?? {};
}

function resolveBrowserUpdateDownloadUrl(manifest: unknown): string | null {
  const downloads = readUpdateManifestRecord(manifest, "downloads");
  if (!downloads) {
    return null;
  }

  for (const key of buildBrowserUpdateDownloadKeys()) {
    const value = downloads[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  const firstDownloadUrl = Object.values(downloads).find(
    (value): value is string => typeof value === "string" && value.trim().length > 0
  );
  return firstDownloadUrl?.trim() ?? null;
}

function resolveBrowserUpdatePlatform(): string {
  if (typeof navigator === "undefined") {
    return "darwin";
  }

  const platform = navigator.platform || navigator.userAgent;
  if (/win/i.test(platform)) {
    return "win32";
  }
  if (/mac/i.test(platform)) {
    return "darwin";
  }
  if (/linux/i.test(platform)) {
    return "linux";
  }
  return "darwin";
}

function resolveBrowserUpdateArch(): string {
  if (typeof navigator === "undefined") {
    return "arm64";
  }

  return /arm64|aarch64/i.test(navigator.userAgent) ? "arm64" : "x64";
}

function buildBrowserUpdateDownloadKeys(): string[] {
  return [resolveBrowserUpdatePlatformType()];
}

function extractUpdateVersionSegments(version: string): number[] {
  return (version.match(/\d+/gu) ?? []).map((part) => Number(part));
}

function readUpdateManifestString(value: unknown, key: string): string | null {
  if (!isUpdateManifestRecord(value)) {
    return null;
  }

  const raw = value[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function readBrowserUpdateMode(value: unknown): DesktopUpdateCheckResult["updateMode"] {
  const updateMode = readUpdateManifestString(value, "updateMode");
  return updateMode === "manual" || updateMode === "silent" || updateMode === "force" ? updateMode : undefined;
}

function readUpdateManifestRecord(value: unknown, key: string): Record<string, unknown> | null {
  if (!isUpdateManifestRecord(value)) {
    return null;
  }

  const raw = value[key];
  return isUpdateManifestRecord(raw) ? raw : null;
}

function isUpdateManifestRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
