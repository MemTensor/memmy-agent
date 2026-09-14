/**
 * Loads external env, packaged public manifest, or development .env before
 * analytics reads MEMMY_CLOUD_SERVICE.
 */
import {
  cloudServiceFromDesktopRuntimeManifest,
} from "../contracts/desktop-runtime-manifest.js";
import { config as loadDotenv } from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

/** Load external env, then the packaged manifest, then a development .env. */
export function loadCloudServiceEnv(options: {
  cwd?: string;
  moduleDir?: string;
  manifestPath?: string;
  env?: NodeJS.ProcessEnv;
  loadDotenv?: typeof loadDotenv;
} = {}): string | null {
  const env = options.env ?? process.env;
  if (Object.prototype.hasOwnProperty.call(env, "MEMMY_CLOUD_SERVICE")) {
    const externalValue = env.MEMMY_CLOUD_SERVICE?.trim();
    if (externalValue) {
      env.MEMMY_CLOUD_SERVICE = externalValue;
      return "environment";
    }
    delete env.MEMMY_CLOUD_SERVICE;
  }

  const moduleDir = options.moduleDir ?? dirname(fileURLToPath(import.meta.url));
  const packagedRuntime = isPackagedRuntimeModule(moduleDir);
  if (options.manifestPath !== undefined || packagedRuntime) {
    const manifestPath = options.manifestPath ?? packagedManifestPath(moduleDir);
    if (!existsSync(manifestPath)) {
      throw new Error("Packaged desktop runtime manifest is missing");
    }
    env.MEMMY_CLOUD_SERVICE = cloudServiceFromDesktopRuntimeManifest(
      readFileSync(manifestPath, "utf8"),
    );
    return manifestPath;
  }

  const envPath =
    findRepoEnvFile(options.cwd ?? process.cwd()) ?? findRepoEnvFile(moduleDir);
  if (envPath) {
    (options.loadDotenv ?? loadDotenv)({
      path: envPath,
      processEnv: env as Record<string, string>,
    });
  }
  return envPath;
}

function isPackagedRuntimeModule(moduleDir: string): boolean {
  const normalized = resolve(moduleDir).replace(/\\/g, "/");
  return normalized.endsWith("/dist/runtime/memory/src/cli")
    || normalized.endsWith("/memory-runtime/dist/src/cli");
}

function packagedManifestPath(moduleDir: string): string {
  const normalized = resolve(moduleDir).replace(/\\/g, "/");
  if (normalized.endsWith("/memory-runtime/dist/src/cli")) {
    return resolve(moduleDir, "../../../../app.asar/dist/main/desktop-edition.json");
  }
  return resolve(moduleDir, "../../../../main/desktop-edition.json");
}

loadCloudServiceEnv();
