import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync } from "node:fs";
import { join } from "node:path";
/** Allocated once by the service-owned executor, never for progress/GET requests. */
export function nextScanGeneration(directory: string): number {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "state-generation.json");
  const previous: unknown = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : 0;
  if (typeof previous !== "number" || !Number.isSafeInteger(previous) || previous < 0 || previous >= Number.MAX_SAFE_INTEGER) {
    throw new Error("Invalid scan state generation; refusing to reuse an older version");
  }
  const next = previous + 1;
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
  const fd = openSync(temporary, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  // The service holds service.lock / the SQLite owner lock for this directory.
  // Persist the rename as well as its contents before publishing the new epoch.
  if (process.platform !== "win32") {
    const directoryFd = openSync(directory, "r");
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  }
  return next;
}
