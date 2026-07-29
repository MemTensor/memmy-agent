/**
 * Loads repository / packaged .env into process.env before analytics reads
 * MEMMY_CLOUD_SERVICE. Existing externally injected env values win.
 */
import { config as loadDotenv } from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function hasCloudService(filePath: string): boolean {
  try {
    return /^\s*MEMMY_CLOUD_SERVICE\s*=/m.test(readFileSync(filePath, "utf8"));
  } catch {
    return false;
  }
}

/** Walk upward to find a .env that defines MEMMY_CLOUD_SERVICE. */
export function findRepoEnvFile(startDir: string): string | null {
  let current = startDir;
  for (;;) {
    const candidate = join(current, ".env");
    if (existsSync(candidate) && hasCloudService(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/** Load the first matching .env from cwd, module dir, or packaged resources. */
export function loadCloudServiceEnv(options: {
  cwd?: string;
  moduleDir?: string;
  loadDotenv?: (options: { path: string }) => void;
} = {}): string | null {
  const cwd = options.cwd ?? process.cwd();
  const moduleDir = options.moduleDir ?? dirname(fileURLToPath(import.meta.url));
  const envPath =
    findRepoEnvFile(cwd) ??
    findRepoEnvFile(moduleDir) ??
    findPackagedEnvFile(moduleDir);
  if (envPath) {
    (options.loadDotenv ?? loadDotenv)({ path: envPath });
  }
  return envPath;
}

function findPackagedEnvFile(moduleDir: string): string | null {
  const normalized = moduleDir.replace(/\\/g, "/");
  const resourcesMatch = normalized.match(/^(.*\/Resources)\//i);
  const resourcesDir = resourcesMatch?.[1];
  if (!resourcesDir) return null;
  const candidate = join(resourcesDir, ".env");
  return existsSync(candidate) && hasCloudService(candidate) ? candidate : null;
}
