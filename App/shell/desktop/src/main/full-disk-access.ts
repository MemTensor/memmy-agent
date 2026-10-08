import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Reads that succeed only when this app has Full Disk Access. `access()` is not a reliable TCC check. */
export function fullDiskAccessProbePaths(home = homedir()): string[] {
  return [
    join(home, "Library/Application Support/com.apple.TCC/TCC.db"),
    join(home, "Library/Safari/Bookmarks.plist"),
    join(home, "Library/Mail"),
  ];
}

export type FullDiskAccessProbe = (path: string) => Promise<void>;

/**
 * macOS has no prompt API for Full Disk Access. Opening a protected file is the check:
 * success means the app is allowed; EPERM means the user still has to turn the switch on.
 * A missing file is inconclusive, so the next protected path is tried.
 */
export async function hasFullDiskAccess(options?: {
  platform?: NodeJS.Platform;
  paths?: readonly string[];
  probe?: FullDiskAccessProbe;
}): Promise<boolean> {
  const platform = options?.platform ?? process.platform;
  if (platform !== "darwin") return true;
  const paths = options?.paths ?? fullDiskAccessProbePaths();
  const probe = options?.probe ?? openForRead;
  for (const path of paths) {
    try {
      await probe(path);
      return true;
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      return false;
    }
  }
  return false;
}

async function openForRead(path: string): Promise<void> {
  const handle = await open(path, "r");
  await handle.close();
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "";
}
