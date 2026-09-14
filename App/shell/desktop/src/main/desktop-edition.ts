export type DesktopEdition = "cn" | "intl";
export type DesktopPackageSigning = "signed" | "unsigned";

interface DesktopEditionManifest {
  edition?: unknown;
  accountChannel?: unknown;
  signing?: unknown;
  windowsStoreMigration?: unknown;
}

export interface DesktopWindowsStoreMigrationConfig {
  internalEnabled: boolean;
  storeDestination: Record<string, unknown>;
}

export function resolveDesktopEdition(rawManifest: string | null | undefined, envAccountChannel?: string): DesktopEdition {
  const manifest = parseDesktopEditionManifest(rawManifest);
  if (manifest?.edition === "intl") return "intl";
  if (manifest?.edition === "cn") return "cn";
  if (manifest?.accountChannel === "email") return "intl";
  if (manifest?.accountChannel === "phone") return "cn";

  return envAccountChannel?.trim().toLowerCase() === "email" ? "intl" : "cn";
}

export function resolveDesktopPackageSigning(rawManifest: string | null | undefined, envPackageSigning?: string): DesktopPackageSigning {
  const manifest = parseDesktopEditionManifest(rawManifest);
  if (manifest?.signing === "unsigned") {
    return "unsigned";
  }
  if (manifest?.signing === "signed") {
    return "signed";
  }

  return envPackageSigning?.trim().toLowerCase() === "unsigned" ? "unsigned" : "signed";
}

export function resolveDesktopWindowsStoreMigrationConfig(
  rawManifest: string | null | undefined
): DesktopWindowsStoreMigrationConfig | null {
  const manifest = parseDesktopEditionManifest(rawManifest);
  const value = manifest?.windowsStoreMigration;
  if (!isRecord(value)
      || value.internalEnabled !== true && value.internalEnabled !== false
      || !isRecord(value.storeDestination)) {
    return null;
  }
  const keys = Object.keys(value);
  if (keys.length !== 2
      || !keys.includes("internalEnabled")
      || !keys.includes("storeDestination")) {
    return null;
  }
  return {
    internalEnabled: value.internalEnabled,
    storeDestination: value.storeDestination
  };
}

export function desktopUserDataDirectoryName(edition: DesktopEdition): string {
  void edition;
  return "Memmy";
}

export function desktopRuntimeHomeDirectoryName(edition: DesktopEdition): string {
  void edition;
  return ".memmy";
}

function parseDesktopEditionManifest(rawManifest: string | null | undefined): DesktopEditionManifest | null {
  if (!rawManifest?.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(rawManifest) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
