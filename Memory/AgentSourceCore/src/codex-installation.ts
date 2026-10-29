import { realpathSync } from "node:fs";
import { posix, win32 } from "node:path";

/** Codex may return a canonical path, including a Windows extended-path prefix. */
export function canonicalCodexPath(file: string, platform: NodeJS.Platform = process.platform): string {
  let canonical = file;
  try { canonical = realpathSync(file); } catch { /* Also support paths not created yet. */ }
  return platform === "win32"
    ? win32.toNamespacedPath(win32.normalize(canonical)).toLowerCase()
    : posix.normalize(canonical);
}

const installations = new Map<string, Promise<unknown>>();

/** Serialize file mutations across target instances sharing the same Codex home. */
export async function withCodexInstallationLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const key = canonicalCodexPath(root);
  const previous = installations.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  installations.set(key, current);
  try { return await current; }
  finally { if (installations.get(key) === current) installations.delete(key); }
}
