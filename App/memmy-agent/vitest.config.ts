import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { defineConfig } from "vitest/config";

// Load optional repository test settings before test modules are evaluated, then pin the required
// gateway address to a non-routable HTTPS test origin so local .env files cannot affect test behavior.
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
const parsed = envPath ? (loadDotenv({ path: envPath, processEnv: {} }).parsed ?? {}) : {};
const testEnv = {
  ...parsed,
  MEMMY_CLOUD_SERVICE: "https://cloud.test.invalid"
};

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    restoreMocks: true,
    env: testEnv,
  },
  resolve: {
    alias: {
      "memmy-agent": new URL("./src/index.ts", import.meta.url).pathname,
    },
  },
});
