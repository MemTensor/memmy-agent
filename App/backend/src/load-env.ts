/** Load env module. */
import {
  cloudServiceFromDesktopRuntimeManifest,
} from "@memmy/local-api-contracts";
import { config as loadDotenv } from "dotenv";
import { existsSync, readFileSync } from "node:fs";
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

export interface LoadCloudServiceEnvOptions {
  cwd?: string;
  moduleDir?: string;
  manifestPath?: string;
  env?: NodeJS.ProcessEnv;
  loadDotenv?: typeof loadDotenv;
}

/** Loads the public cloud-service origin without allowing packaged raw env files. */
export function loadCloudServiceEnv(options: LoadCloudServiceEnvOptions = {}): string | null {
  const env = options.env ?? process.env;
  if (Object.prototype.hasOwnProperty.call(env, "MEMMY_CLOUD_SERVICE")) {
    const externalValue = env.MEMMY_CLOUD_SERVICE?.trim();
    if (externalValue) {
      env.MEMMY_CLOUD_SERVICE = externalValue;
      return "environment";
    }
    delete env.MEMMY_CLOUD_SERVICE;
  }

  if (options.manifestPath !== undefined) {
    if (!existsSync(options.manifestPath)) {
      throw new Error("Packaged desktop runtime manifest is missing");
    }
    env.MEMMY_CLOUD_SERVICE = cloudServiceFromDesktopRuntimeManifest(
      readFileSync(options.manifestPath, "utf8"),
    );
    return options.manifestPath;
  }

  const moduleDir = options.moduleDir ?? dirname(fileURLToPath(import.meta.url));
  const envPath = findRepoEnvFile(options.cwd ?? process.cwd()) ?? findRepoEnvFile(moduleDir);
  if (envPath) {
    (options.loadDotenv ?? loadDotenv)({
      path: envPath,
      processEnv: env as Record<string, string>,
    });
  }
  return envPath;
}
