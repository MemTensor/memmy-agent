import { realpathSync } from "node:fs";
import { link, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
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

const CLAIM_PATTERN = /^\.memmy-install\.claim\.(\d+)\.[0-9a-f-]+\.json$/;
interface Claim { pid: number; ticket: number; token: string }

function ownerExited(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

async function readClaim(path: string): Promise<Claim | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as Claim; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Per-owner bakery tickets serialize acquisition AND stale-lock recovery. Each owner
 * alone deletes its unique ticket; dead tickets can be removed without touching a successor.
 * Keep the original lock file too, so older desktop/Memory processes still exclude us.
 */
async function withProcessLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const token = randomUUID();
  const name = `.memmy-install.claim.${process.pid}.${token}.json`;
  const claimPath = join(root, name);
  const path = join(root, ".memmy-install.lock");
  const deadline = Date.now() + 120_000;
  const wait = async () => {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for Codex installation lock: ${path}`);
    await delay(25);
  };
  const claims = async () => (await readdir(root)).filter(file => CLAIM_PATTERN.test(file));
  const load = async (file: string): Promise<Claim | null> => {
    const pid = Number(CLAIM_PATTERN.exec(file)![1]);
    if (ownerExited(pid)) { await unlink(join(root, file)).catch(error => { if (error.code !== "ENOENT") throw error; }); return null; }
    return readClaim(join(root, file));
  };
  const initial: Claim = { pid: process.pid, ticket: 0, token };
  try { await writeFile(claimPath, JSON.stringify(initial), { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return operation(); throw error; }
  let acquired = false;
  try {
    let maximum = 0;
    for (const file of await claims()) {
      // An empty file is an owner still publishing its choosing marker.
      let other;
      try { other = await load(file); } catch (error) { if (error instanceof SyntaxError) continue; throw error; }
      maximum = Math.max(maximum, other?.ticket ?? 0);
    }
    const mine = { ...initial, ticket: maximum + 1 };
    const temporary = join(root, `.memmy-ticket-${token}.tmp`);
    try { await writeFile(temporary, JSON.stringify(mine), { mode: 0o600 }); await rename(temporary, claimPath); }
    finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
    for (const file of await claims()) {
      if (file === name) continue;
      for (;;) {
        let other;
        try { other = await load(file); } catch (error) { if (!(error instanceof SyntaxError)) throw error; await wait(); continue; }
        if (!other || (other.ticket > 0 && (other.ticket > mine.ticket || (other.ticket === mine.ticket && file > name)))) break;
        await wait();
      }
    }
    for (;;) {
      // Hard-link a fully written owner record: no empty lock if the creator crashes.
      try { await link(claimPath, path); acquired = true; break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const previous = await readClaim(path).catch(error => { if (error instanceof SyntaxError) return null; throw error; });
      if (previous && Number.isSafeInteger(previous.pid) && previous.pid > 0 && ownerExited(previous.pid)) {
        // All new recoverers hold the bakery mutex; legacy owners never reclaim locks.
        await unlink(path).catch(error => { if (error.code !== "ENOENT") throw error; });
      } else { await wait(); }
    }
    return await operation();
  } finally {
    try {
      if (acquired && (await readClaim(path))?.token === token) await unlink(path);
    } finally { await unlink(claimPath).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  }
}
