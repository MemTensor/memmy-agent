/** Load env module. */
import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Handles find repo env file. */
function findRepoEnvFile(startDir: string): string | null {
  let current = startDir;
  for (;;) {
    const candidate = join(current, ".env");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/** Reads load cloud service env. */
export function loadCloudServiceEnv(): void {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const envPath = findRepoEnvFile(process.cwd()) ?? findRepoEnvFile(moduleDir);
  if (envPath) {
    loadDotenv({ path: envPath });
  }
}
