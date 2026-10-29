/**
 * Gateway address env loader (memmy-agent entrypoint side-effect module).
 *
 * Packaged builds read the single public cloud-service origin from the desktop
 * runtime manifest. Development builds retain repository .env discovery.
 *
 * Note: this module must be the first import in each entrypoint (main.ts /
 * index.ts), so it completes before providers/registry.ts or any other module
 * reads MEMMY_CLOUD_SERVICE during module evaluation. Packaged manifest values
 * take priority over inherited environment values so upgrades cannot keep a
 * stale cloud endpoint from an earlier installation.
 */
import { config as loadDotenv } from "dotenv";
import {
  cloudServiceFromDesktopRuntimeManifest,
} from "@memmy/local-api-contracts";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Walk upward from the given directory to find the absolute path of the
 * repository root .env containing MEMMY_CLOUD_SERVICE.
 *
 * @param startDir Starting directory.
 * @returns Absolute .env path when found; otherwise null.
 */
export function findRepoEnvFile(startDir: string): string | null {
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

export interface LoadCloudServiceEnvOptions {
  cwd?: string;
  moduleDir?: string;
  manifestPath?: string;
  env?: NodeJS.ProcessEnv;
  loadDotenv?: typeof loadDotenv;
}

/** Loads a packaged manifest first, then external env, then a development .env. */
export function loadCloudServiceEnv(options: LoadCloudServiceEnvOptions = {}): string | null {
  const env = options.env ?? process.env;
  const moduleDir = options.moduleDir ?? dirname(fileURLToPath(import.meta.url));
  const packagedRuntime = isPackagedRuntimeModule(moduleDir);
  if (options.manifestPath !== undefined || packagedRuntime) {
    const manifestPath = options.manifestPath ?? resolve(moduleDir, "../../../main/desktop-edition.json");
    if (!existsSync(manifestPath)) {
      throw new Error("Packaged desktop runtime manifest is missing");
    }
    env.MEMMY_CLOUD_SERVICE = cloudServiceFromDesktopRuntimeManifest(
      readFileSync(manifestPath, "utf8"),
    );
    // MEMMY_CLOUD_URL is a development-only override. Do not let a stale
    // value inherited from an older installation redirect a packaged app.
    delete env.MEMMY_CLOUD_URL;
    return manifestPath;
  }

  if (Object.prototype.hasOwnProperty.call(env, "MEMMY_CLOUD_SERVICE")) {
    const externalValue = env.MEMMY_CLOUD_SERVICE?.trim();
    if (externalValue) {
      env.MEMMY_CLOUD_SERVICE = externalValue;
      return "environment";
    }
    delete env.MEMMY_CLOUD_SERVICE;
  }

  const envPath = findRepoEnvFile(options.cwd ?? process.cwd()) ?? findRepoEnvFile(moduleDir);
  if (envPath) {
    (options.loadDotenv ?? loadDotenv)({
      path: envPath,
      processEnv: env as Record<string, string>,
    });
  }
  return envPath;
}

function isPackagedRuntimeModule(moduleDir: string): boolean {
  return resolve(moduleDir).replace(/\\/g, "/").endsWith("/dist/runtime/memmy-agent/dist");
}

loadCloudServiceEnv();
