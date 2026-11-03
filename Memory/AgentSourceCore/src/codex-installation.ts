import { realpathSync } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import { posix, win32 } from "node:path";

/** Codex may return a canonical path, including a Windows extended-path prefix. */
export function canonicalCodexPath(file: string, platform: NodeJS.Platform = process.platform): string {
  let canonical = file;
  try { canonical = realpathSync(file); } catch { /* Also support paths not created yet. */ }
  return platform === "win32"
    ? win32.toNamespacedPath(win32.normalize(canonical)).toLowerCase()
    : posix.normalize(canonical);
}

const ownership = new AsyncLocalStorage<string>();
const installations = new Map<string, Promise<unknown>>();

/** Serialize file mutations across target instances sharing the same Codex home. */
export async function withCodexInstallationLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const key = canonicalCodexPath(root);
  if (ownership.getStore() === key) throw new Error("Nested Codex installation operation");
  const previous = installations.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(() => ownership.run(key, () => withProcessLock(key, operation)));
  installations.set(key, current);
  try { return await current; }
  finally { if (installations.get(key) === current) installations.delete(key); }
}

/** Exclusive file creation works on macOS and Windows and is shared by both integration processes.
 * Do not steal an expired lock: a slow trust request may still own it. Fail with the lock path
 * after a bounded wait; an abandoned lock can be removed only after its owner has exited.
 */
async function withProcessLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const path = join(root, ".memmy-install.lock");
  const deadline = Date.now() + 120_000;
  for (;;) {
    let file;
    try { file = await open(path, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return operation();
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for Codex installation lock: ${path}. Check its owner before removing an abandoned lock.`);
      await delay(25);
      continue;
    }
    try {
      await file.writeFile(JSON.stringify({ pid: process.pid }));
      return await operation();
    } finally { await file.close(); await unlink(path); }
  }
}
