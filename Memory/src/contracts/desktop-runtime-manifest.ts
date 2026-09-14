/** Public runtime configuration embedded in packaged desktop applications. */
export interface DesktopRuntimeManifest {
  cloudService?: unknown;
  [key: string]: unknown;
}

/**
 * Normalizes the public cloud-service origin allowed in a packaged artifact.
 * Credentials, paths, query strings, and fragments are rejected so secrets
 * cannot be smuggled through a value that is intentionally public.
 */
export function normalizePublicCloudService(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("MEMMY_CLOUD_SERVICE must be a non-empty HTTPS origin");
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("MEMMY_CLOUD_SERVICE must be a valid HTTPS origin");
  }

  if (url.protocol !== "https:") {
    throw new Error("MEMMY_CLOUD_SERVICE must use HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("MEMMY_CLOUD_SERVICE must not contain credentials");
  }
  if (url.search || url.hash) {
    throw new Error("MEMMY_CLOUD_SERVICE must not contain a query or fragment");
  }
  if (url.pathname !== "/") {
    throw new Error("MEMMY_CLOUD_SERVICE must be an origin without a path");
  }
  return url.origin;
}

/** Parses and validates the cloud-service field from a desktop manifest. */
export function cloudServiceFromDesktopRuntimeManifest(rawManifest: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawManifest);
  } catch {
    throw new Error("Desktop runtime manifest must contain valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Desktop runtime manifest must be a JSON object");
  }
  return normalizePublicCloudService((parsed as DesktopRuntimeManifest).cloudService);
}
