import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseDotenv } from "dotenv";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export function normalizePublicCloudService(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("MEMMY_CLOUD_SERVICE must be a non-empty HTTPS origin");
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("MEMMY_CLOUD_SERVICE must be a valid HTTPS origin");
  }
  if (url.protocol !== "https:") throw new Error("MEMMY_CLOUD_SERVICE must use HTTPS");
  if (url.username || url.password) {
    throw new Error("MEMMY_CLOUD_SERVICE must not contain credentials");
  }
  if (url.search || url.hash) {
    throw new Error("MEMMY_CLOUD_SERVICE must not contain a query or fragment");
  }
  if (url.pathname !== "/") {
    throw new Error("MEMMY_CLOUD_SERVICE must be an origin without a path");
  }
  return url.origin;
}

export function resolvePublicCloudService({ environment = process.env, envFile } = {}) {
  if (Object.prototype.hasOwnProperty.call(environment, "MEMMY_CLOUD_SERVICE")) {
    return normalizePublicCloudService(environment.MEMMY_CLOUD_SERVICE);
  }
  if (!envFile || !existsSync(envFile)) {
    throw new Error("MEMMY_CLOUD_SERVICE is missing from the packaging environment and root .env");
  }
  const parsed = parseDotenv(readFileSync(envFile));
  return normalizePublicCloudService(parsed.MEMMY_CLOUD_SERVICE);
}

export async function writeDesktopEditionManifest({
  output,
  edition,
  accountChannel,
  signing,
  environment = process.env,
  envFile = join(repoRoot, ".env"),
}) {
  if (!output) throw new Error("--output is required");
  if (!new Set(["cn", "intl"]).has(edition)) throw new Error("Invalid desktop edition");
  if (!new Set(["phone", "email"]).has(accountChannel)) {
    throw new Error("Invalid desktop account channel");
  }
  if (!new Set(["signed", "unsigned"]).has(signing)) {
    throw new Error("Invalid desktop signing identity");
  }

  const manifest = {
    edition,
    accountChannel,
    signing,
    cloudService: resolvePublicCloudService({ environment, envFile }),
  };
  const outputPath = resolve(output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

export function parseDesktopManifestArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(
        "Usage: write-desktop-edition-manifest.mjs --output <path> --edition <cn|intl> --account-channel <phone|email> --signing <signed|unsigned>",
      );
    }
    const key = flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (!new Set(["output", "edition", "accountChannel", "signing"]).has(key) || parsed[key]) {
      throw new Error(`Unknown or duplicate option: ${flag}`);
    }
    parsed[key] = value;
  }
  return parsed;
}
