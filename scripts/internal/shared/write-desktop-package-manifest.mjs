#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const [envPath, manifestPath, edition, accountChannel, signing] = process.argv.slice(2);

if (!envPath || !manifestPath || !edition || !accountChannel || !signing) {
  throw new Error(
    "Usage: write-desktop-package-manifest <env-path> <manifest-path> <edition> <account-channel> <signing>",
  );
}
if (edition !== "cn" && edition !== "intl") {
  throw new Error(`Unsupported desktop edition: ${edition}`);
}
if (accountChannel !== "phone" && accountChannel !== "email") {
  throw new Error(`Unsupported account channel: ${accountChannel}`);
}
if (signing !== "signed" && signing !== "unsigned") {
  throw new Error(`Unsupported package signing mode: ${signing}`);
}

const cloudService = resolveCloudService(process.env.MEMMY_CLOUD_SERVICE, envPath);
writeFileSync(
  manifestPath,
  `${JSON.stringify({ edition, accountChannel, signing, cloudService }, null, 2)}\n`,
  { mode: 0o644 },
);

function resolveCloudService(environmentValue, sourcePath) {
  const configured = environmentValue?.trim() || readCloudServiceFromEnvFile(sourcePath);
  if (!configured) {
    throw new Error("MEMMY_CLOUD_SERVICE is required to build a desktop package");
  }

  let parsed;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error("MEMMY_CLOUD_SERVICE must be an absolute HTTP(S) URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("MEMMY_CLOUD_SERVICE must use HTTP or HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new Error("MEMMY_CLOUD_SERVICE must not contain credentials");
  }
  return configured;
}

function readCloudServiceFromEnvFile(sourcePath) {
  if (!existsSync(sourcePath)) return null;

  for (const line of readFileSync(sourcePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?MEMMY_CLOUD_SERVICE\s*=\s*(.*)$/);
    if (!match) continue;
    return parseEnvValue(match[1]);
  }
  return null;
}

function parseEnvValue(raw) {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      throw new Error("MEMMY_CLOUD_SERVICE has invalid double-quoted syntax");
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value.replace(/\s+#.*$/, "").trim();
}
