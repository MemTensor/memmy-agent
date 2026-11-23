export const DEFAULT_MEMORY_URL = "http://127.0.0.1:18960";

export function sameHttpOrigin(target: string, configured: string): boolean {
  try {
    const url = new URL(target);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === new URL(configured).origin;
  } catch {
    return false;
  }
}

export const MEMORY_CONNECTION_ENV_ALIASES = [
  ["MEMMY_MEMORY_URL", "MEMMY_MEMORY_TOKEN"],
  ["MEMORY_SERVICE_URL", "MEMORY_SERVICE_TOKEN"]
] as const;

/** An environment token belongs to its own URL alias, or to the file origin when that alias has no URL. */
export function resolveMemoryConnection(
  fileEndpoint: string, fileToken: string | undefined, env: Readonly<Record<string, string | undefined>>,
  targetEndpoint?: string,
  aliases: readonly (readonly [string, string])[] = MEMORY_CONNECTION_ENV_ALIASES
): { endpoint: string; token?: string } {
  const endpoint = targetEndpoint || aliases.map(([url]) => env[url]?.trim()).find(Boolean) || fileEndpoint;
  for (const [urlKey, tokenKey] of aliases) {
    const token = env[tokenKey]?.trim();
    if (token && sameHttpOrigin(endpoint, env[urlKey]?.trim() || fileEndpoint)) return { endpoint, token };
  }
  return { endpoint, token: sameHttpOrigin(endpoint, fileEndpoint) ? fileToken?.trim() || undefined : undefined };
}
