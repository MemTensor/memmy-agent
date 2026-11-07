export const DEFAULT_MEMORY_URL = "http://127.0.0.1:18960";

export function sameHttpOrigin(target: string, configured: string): boolean {
  try {
    const url = new URL(target);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === new URL(configured).origin;
  } catch {
    return false;
  }
}

/** An environment token belongs to its own URL alias, or to the file origin when that alias has no URL. */
export function resolveMemoryConnection(
  fileEndpoint: string, fileToken: string | undefined, env: Readonly<Record<string, string | undefined>>,
  targetEndpoint?: string
): { endpoint: string; token?: string } {
  const currentUrl = env.MEMMY_MEMORY_URL?.trim();
  const legacyUrl = env.MEMORY_SERVICE_URL?.trim();
  const endpoint = targetEndpoint || currentUrl || legacyUrl || fileEndpoint;
  const currentToken = env.MEMMY_MEMORY_TOKEN?.trim();
  if (currentToken && sameHttpOrigin(endpoint, currentUrl || fileEndpoint)) return { endpoint, token: currentToken };
  const legacyToken = env.MEMORY_SERVICE_TOKEN?.trim();
  if (legacyToken && sameHttpOrigin(endpoint, legacyUrl || fileEndpoint)) return { endpoint, token: legacyToken };
  return { endpoint, token: sameHttpOrigin(endpoint, fileEndpoint) ? fileToken?.trim() || undefined : undefined };
}
