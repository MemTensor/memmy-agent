/**
 * Gateway address env loader (memmy-agent entrypoint side-effect module).
 *
 * The repository-wide gateway address comes only from MEMMY_CLOUD_SERVICE in the
 * repository root .env. memmy-agent is packaged independently and is not part of
 * the main repository npm workspace, so the earliest entrypoint imports this
 * module first and uses dotenv to load the root .env into process.env for later
 * modules.
 *
 * Note: this module must be the first import in each entrypoint (main.ts /
 * index.ts), so it completes before providers/registry.ts or any other module
 * reads MEMMY_CLOUD_SERVICE during module evaluation. Existing env values, such
 * as externally injected ones, take priority and are not overwritten.
 */
import { config as loadDotenv } from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Walk upward from the given directory to find the absolute path of the
 * repository root .env containing MEMMY_CLOUD_SERVICE.
 *
 * @param startDir Starting directory.
 * @returns Absolute .env path when found; otherwise null.
 */
function findRepoEnvFile(startDir: string): string | null {
  let current = startDir;
  // Walk upward until the filesystem root.
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

function hasCloudService(filePath: string): boolean {
  try {
    return /^\s*MEMMY_CLOUD_SERVICE\s*=/m.test(readFileSync(filePath, "utf8"));
  } catch {
    return false;
  }
}

// Search upward from both the current working directory and this module directory to support different launch modes (source / dist).
const moduleDir = dirname(fileURLToPath(import.meta.url));
const envPath = findRepoEnvFile(process.cwd()) ?? findRepoEnvFile(moduleDir);
if (envPath) {
  loadDotenv({ path: envPath });
}
