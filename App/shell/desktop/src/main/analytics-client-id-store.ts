import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const ANALYTICS_CLIENT_ID_FILENAME = "analytics-client-id";

/**
 * Shared GA4 client_id path used by desktop (writer) and memmy-cli (reader).
 * Desktop gtag is the source of truth; this file is an overwrite-only cache.
 */
export function resolveSharedAnalyticsClientIdPath(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir()
): string {
  const memmyHome = (env.MEMMY_HOME?.trim() || join(home, ".memmy")).replace(/^~(?=$|[/\\])/, home);
  return join(memmyHome, ANALYTICS_CLIENT_ID_FILENAME);
}

/**
 * Always overwrites the shared client_id file with the latest gtag value.
 * Call this whenever the renderer reports a client_id so reinstalls replace stale IDs.
 */
export function persistSharedAnalyticsClientId(
  clientId: string,
  options: {
    env?: NodeJS.ProcessEnv;
    home?: string;
    mkdirSyncImpl?: typeof mkdirSync;
    writeFileSyncImpl?: typeof writeFileSync;
  } = {}
): string {
  const trimmed = clientId.trim();
  if (!trimmed) {
    throw new Error("analytics client_id must be a non-empty string");
  }
  const filePath = resolveSharedAnalyticsClientIdPath(options.env, options.home);
  const mkdir = options.mkdirSyncImpl ?? mkdirSync;
  const write = options.writeFileSyncImpl ?? writeFileSync;
  mkdir(dirname(filePath), { recursive: true });
  write(filePath, `${trimmed}\n`, "utf8");
  return filePath;
}
