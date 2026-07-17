export type DesktopEdition = "cn" | "intl";
export type DesktopPackageSigning = "signed" | "unsigned";

interface DesktopEditionManifest {
  edition?: unknown;
  accountChannel?: unknown;
  signing?: unknown;
}

export function resolveDesktopEdition(rawManifest: string | null | undefined, envAccountChannel?: string): DesktopEdition {
  const manifest = parseDesktopEditionManifest(rawManifest);
  if (manifest?.edition === "intl" || manifest?.accountChannel === "email") {
    return "intl";
  }
  if (manifest?.edition === "cn" || manifest?.accountChannel === "phone") {
    return "cn";
  }

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
