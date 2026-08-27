import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { defineConfig } from "vitest/config";

// Vitest configuration.
// Definition for module dir.
const moduleDir = dirname(fileURLToPath(import.meta.url));

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

const envPath = findRepoEnvFile(moduleDir);
const parsed = envPath ? (loadDotenv({ path: envPath, processEnv: {} }).parsed ?? {}) : {};
const testEnv = {
  ...parsed,
  MEMMY_CLOUD_SERVICE: "https://cloud.test.invalid"
};

export default defineConfig({
  test: {
    env: testEnv,
    coverage: {
      provider: "v8",
      include: ["src/adapters/outbound/agent-adapter/**/*.ts"],
      exclude: ["src/adapters/outbound/agent-adapter/tests/**/*.ts"],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100
      }
    }
  }
});
