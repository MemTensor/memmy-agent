import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";

const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 120_000;

export async function mutateMemoryConfig(
  configPath: string,
  mutate: (root: Record<string, unknown>) => void
): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  const lockPath = `${configPath}.lock`;
  const releaseLock = await acquireConfigLock(lockPath);
  try {
    const root = await readConfigRoot(configPath);
    mutate(root);
    const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, stringify(root), { encoding: "utf8", mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, configPath);
  } finally {
    await releaseLock().catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function readConfigRoot(configPath: string): Promise<Record<string, unknown>> {
  try {
    const parsed = parse(await readFile(configPath, "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return {};
    throw error;
  }
}

async function acquireConfigLock(lockPath: string) {
  const startedAt = Date.now();
  for (;;) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      return () => rm(lockPath, { recursive: true });
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const lockStat = await stat(lockPath).catch(() => undefined);
      if (lockStat && Date.now() - lockStat.mtimeMs > STALE_LOCK_MS) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw new Error(`timed out waiting for Memory config lock: ${lockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
