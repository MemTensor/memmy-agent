import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LOCK_WAIT_MS = 15_000;
const RETRY_MS = 50;
type NativeToken = object;
type NativeLock = { tryAcquire(path: string): NativeToken | null; release(token: NativeToken): void };

/** Store packages expose their bundled runtime from the protected WindowsApps tree. */
export function isWindowsStoreInstall(context: {
  home?: string;
  runtimeDirectory?: string;
  nodeExecutable?: string;
} = {}): boolean {
  if (process.platform !== "win32") return false;
  if ([context.runtimeDirectory, context.nodeExecutable, process.execPath]
    .some((value) => typeof value === "string" && /(?:^|[\\/])WindowsApps[\\/]/i.test(value))) return true;
  if (context.home) {
    try {
      const pointer = JSON.parse(readFileSync(join(context.home, "memory-service", "current.json"), "utf8")) as Record<string, unknown>;
      return [pointer.runtimeExecutable, pointer.runtimeDir]
        .some((value) => typeof value === "string" && /(?:^|[\\/])WindowsApps[\\/]/i.test(value));
    } catch { /* Missing or malformed pointer follows normal installer validation. */ }
  }
  return false;
}

function loadNativeLock(): NativeLock {
  const require = createRequire(import.meta.url);
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "../../native/memory-install-lock.node"),
    resolve(here, "../../dist/native/memory-install-lock.node")
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error(`Windows Store install lock native module was not found (looked in ${candidates.join(", ")})`);
  return require(path) as NativeLock;
}

export async function acquireWindowsStoreInstallLock(path: string): Promise<{ release(): Promise<void> }> {
  const native = loadNativeLock();
  const startedAt = Date.now();
  for (;;) {
    const token = native.tryAcquire(path);
    if (token) {
      let released = false;
      return {
        async release() {
          if (released) return;
          released = true;
          native.release(token);
        }
      };
    }
    if (Date.now() - startedAt >= LOCK_WAIT_MS) throw new Error(`timed out waiting for installer lock: ${path}`);
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, RETRY_MS));
  }
}
