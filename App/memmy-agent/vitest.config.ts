import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { defineConfig } from "vitest/config";

// The test-time gateway address comes only from MEMMY_CLOUD_SERVICE in the repository root .env.
// Load the root .env during configuration, before test modules are evaluated, and inject it through test.env.
// This ensures tests that directly import providers/registry.ts or other module-evaluation readers can also see the value.
const moduleDir = dirname(fileURLToPath(import.meta.url));

/**
 * Walk upward from the given directory to find the repository root .env.
 *
 * @param startDir Starting directory.
 * @returns Absolute .env path when found; otherwise null.
 */
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
const parsed = envPath ? (loadDotenv({ path: envPath }).parsed ?? {}) : {};

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    restoreMocks: true,
    env: parsed,
  },
  resolve: {
    alias: {
      "memmy-agent": new URL("./src/index.ts", import.meta.url).pathname,
    },
  },
});
