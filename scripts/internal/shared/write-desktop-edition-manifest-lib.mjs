import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseDotenv } from "dotenv";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const windowsStorePublishingConfigKeys = [
  "schemaVersion",
  "publisher",
  "publisherDisplayName",
  "windowsDisplayName",
  "legacyNsisAumid",
  "applications",
];
const windowsStorePublishingApplicationKeys = ["cn", "intl"];
const windowsStorePublishingProfileKeys = [
  "storeListingDisplayName",
  "storeProductId",
  "acquisitionUri",
  "identityName",
  "manifestApplicationId",
  "packageFamilyName",
];
const restrictedWindowsApplicationIds = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

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
  if (hasOwn(environment, "MEMMY_CLOUD_SERVICE")) {
    return normalizePublicCloudService(environment.MEMMY_CLOUD_SERVICE);
  }
  if (!envFile || !existsSync(envFile)) {
    throw new Error("MEMMY_CLOUD_SERVICE is missing from the packaging environment and root .env");
  }
  const parsed = parseDotenv(readFileSync(envFile));
  return normalizePublicCloudService(parsed.MEMMY_CLOUD_SERVICE);
}

function assertExactObjectKeys(value, expectedKeys, context) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (actualKeys.length !== sortedExpectedKeys.length
      || actualKeys.some((key, index) => key !== sortedExpectedKeys[index])) {
    throw new Error(`${context} must contain exactly: ${expectedKeys.join(", ")}`);
  }
}

function requireNonEmptyString(value, context) {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new Error(`${context} must be a non-empty string without surrounding whitespace`);
  }
  return value;
}

function validateWindowsStorePublishingProfile(value, edition) {
  const context = `Windows Store publishing profile company/${edition}`;
  assertExactObjectKeys(value, windowsStorePublishingProfileKeys, context);

  const storeListingDisplayName = requireNonEmptyString(
    value.storeListingDisplayName,
    `${context} storeListingDisplayName`,
  );
  const storeProductId = requireNonEmptyString(value.storeProductId, `${context} storeProductId`);
  const identityName = requireNonEmptyString(value.identityName, `${context} identityName`);
  const manifestApplicationId = requireNonEmptyString(
    value.manifestApplicationId,
    `${context} manifestApplicationId`,
  );
  const packageFamilyName = requireNonEmptyString(
    value.packageFamilyName,
    `${context} packageFamilyName`,
  );

  if (storeListingDisplayName.length > 256) {
    throw new Error(`${context} storeListingDisplayName must not exceed 256 characters`);
  }
  if (!/^[A-Z0-9]{12}$/.test(storeProductId)) {
    throw new Error(`${context} has an invalid storeProductId`);
  }
  if (!/^[A-Za-z0-9.-]{3,50}$/.test(identityName)
      || restrictedWindowsApplicationIds.has(identityName.toUpperCase())) {
    throw new Error(`${context} has an invalid identityName`);
  }
  if (manifestApplicationId.length > 64
      || !/^([A-Za-z][A-Za-z0-9]*)(\.[A-Za-z][A-Za-z0-9]*)*$/.test(manifestApplicationId)
      || restrictedWindowsApplicationIds.has(manifestApplicationId.toUpperCase())) {
    throw new Error(`${context} has an invalid manifestApplicationId`);
  }
  if (!/^[A-Za-z0-9.-]+_[a-z0-9]{13}$/.test(packageFamilyName)
      || !packageFamilyName.startsWith(`${identityName}_`)) {
    throw new Error(`${context} packageFamilyName does not match identityName`);
  }

  return {
    storeProductId,
    acquisitionUri: normalizeWindowsStoreAcquisitionUri(value.acquisitionUri, storeProductId, `${context} acquisitionUri`),
    identityName,
    manifestApplicationId,
    packageFamilyName,
    aumid: `${packageFamilyName}!${manifestApplicationId}`,
  };
}

function readWindowsStorePublishingProfiles(configPath) {
  if (typeof configPath !== "string" || !configPath.trim()) {
    throw new Error("--windows-store-publishing-config must be a non-empty path");
  }

  let config;
  try {
    config = JSON.parse(readFileSync(resolve(configPath), "utf8"));
  } catch (error) {
    throw new Error(`Unable to read Windows Store publishing config: ${error.message}`);
  }
  assertExactObjectKeys(config, windowsStorePublishingConfigKeys, "Windows Store publishing config");
  if (config.schemaVersion !== 2) {
    throw new Error("Windows Store publishing config must use schemaVersion 2");
  }
  const publisher = requireNonEmptyString(config.publisher, "Windows Store publishing config publisher");
  const publisherDisplayName = requireNonEmptyString(
    config.publisherDisplayName,
    "Windows Store publishing config publisherDisplayName",
  );
  const windowsDisplayName = requireNonEmptyString(
    config.windowsDisplayName,
    "Windows Store publishing config windowsDisplayName",
  );
  const legacyNsisAumid = requireNonEmptyString(
    config.legacyNsisAumid,
    "Windows Store publishing config legacyNsisAumid",
  );
  if (legacyNsisAumid !== "cn.memtensor.memmy") {
    throw new Error(
      "Windows Store publishing config legacyNsisAumid must exactly match cn.memtensor.memmy",
    );
  }
  if (publisher.length > 8192) throw new Error("Windows Store publishing config publisher is too long");
  if (publisherDisplayName.length > 256 || windowsDisplayName.length > 256) {
    throw new Error("Windows Store publishing config display names must not exceed 256 characters");
  }

  assertExactObjectKeys(
    config.applications,
    windowsStorePublishingApplicationKeys,
    "Windows Store publishing applications",
  );
  const profiles = Object.fromEntries(windowsStorePublishingApplicationKeys.map((edition) => [
    edition,
    validateWindowsStorePublishingProfile(config.applications[edition], edition),
  ]));
  for (const field of ["storeProductId", "identityName", "packageFamilyName", "aumid"]) {
    if (profiles.cn[field].toLowerCase() === profiles.intl[field].toLowerCase()) {
      throw new Error(`Windows Store publishing profiles must use unique ${field} values`);
    }
  }
  return profiles;
}

function resolveWindowsStoreMigrationEnabled(environment) {
  if (!hasOwn(environment, "MEMMY_WINDOWS_STORE_MIGRATION_ENABLED")) return true;
  if (environment.MEMMY_WINDOWS_STORE_MIGRATION_ENABLED === "true") return true;
  if (environment.MEMMY_WINDOWS_STORE_MIGRATION_ENABLED === "false") return false;
  throw new Error("MEMMY_WINDOWS_STORE_MIGRATION_ENABLED must be true or false");
}

function normalizeWindowsStoreAcquisitionUri(value, storeId, variableName) {
  if (value === "") return undefined;
  if (typeof value !== "string" || value !== value.trim()) {
    throw new Error(`${variableName} must be a valid Store acquisition URI for ${storeId}`);
  }

  let uri;
  try {
    uri = new URL(value);
  } catch {
    throw new Error(`${variableName} must be a valid Store acquisition URI for ${storeId}`);
  }
  if (uri.username || uri.password || uri.port || uri.hash) {
    throw new Error(`${variableName} must be a valid Store acquisition URI for ${storeId}`);
  }

  if (uri.protocol === "ms-windows-store:") {
    const parameters = [...uri.searchParams.entries()];
    if (uri.hostname.toLowerCase() === "pdp"
        && uri.pathname === "/"
        && parameters.length === 1
        && parameters[0]?.[0] === "ProductId"
        && parameters[0]?.[1].toUpperCase() === storeId) {
      return uri.toString();
    }
  } else if (uri.protocol === "https:" && !uri.search) {
    const hostname = uri.hostname.toLowerCase();
    const pathname = uri.pathname.toUpperCase();
    if ((hostname === "get.microsoft.com" && pathname === `/INSTALLER/DOWNLOAD/${storeId}`)
        || (hostname === "apps.microsoft.com" && pathname === `/DETAIL/${storeId}`)) {
      return uri.toString();
    }
  }
  throw new Error(`${variableName} must be a valid Store acquisition URI for ${storeId}`);
}

function resolveWindowsStoreMigration({ edition, environment, publishingConfig }) {
  const profiles = readWindowsStorePublishingProfiles(publishingConfig);
  const profile = profiles[edition];
  const acquisitionVariable = edition === "cn"
    ? "MEMMY_WINDOWS_STORE_ACQUISITION_URI_CN"
    : "MEMMY_WINDOWS_STORE_ACQUISITION_URI_INTL";
  const acquisitionUri = hasOwn(environment, acquisitionVariable)
    ? normalizeWindowsStoreAcquisitionUri(
      environment[acquisitionVariable],
      profile.storeProductId,
      acquisitionVariable,
    )
    : profile.acquisitionUri;
  const storeDestination = {
    edition,
    storeId: profile.storeProductId,
    packageFamilyName: profile.packageFamilyName,
    aumid: profile.aumid,
  };
  if (acquisitionUri) storeDestination.acquisitionUri = acquisitionUri;
  return {
    internalEnabled: resolveWindowsStoreMigrationEnabled(environment),
    storeDestination,
  };
}

export async function writeDesktopEditionManifest({
  output,
  edition,
  accountChannel,
  signing,
  environment = process.env,
  envFile = join(repoRoot, ".env"),
  windowsStorePublishingConfig,
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
  if (windowsStorePublishingConfig !== undefined) {
    manifest.windowsStoreMigration = resolveWindowsStoreMigration({
      edition,
      environment,
      publishingConfig: windowsStorePublishingConfig,
    });
  }
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
        "Usage: write-desktop-edition-manifest.mjs --output <path> --edition <cn|intl> --account-channel <phone|email> --signing <signed|unsigned> [--windows-store-publishing-config <path>]",
      );
    }
    const key = flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (!new Set([
      "output",
      "edition",
      "accountChannel",
      "signing",
      "windowsStorePublishingConfig",
    ]).has(key) || parsed[key]) {
      throw new Error(`Unknown or duplicate option: ${flag}`);
    }
    parsed[key] = value;
  }
  return parsed;
}
