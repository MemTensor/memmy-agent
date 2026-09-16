#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const desktopRoot = join(repositoryRoot, "App", "shell", "desktop");
const lockPath = join(desktopRoot, "resources", "bundled-plugins.json");
const outputDirectory = resolve(process.argv[2] ?? join(desktopRoot, "dist", "bundled-plugins"));
const configuredSourceDirectory = process.env.MEMMY_BUNDLED_PLUGIN_SOURCE_DIR?.trim();
const requireBundledPlugins = process.env.MEMMY_REQUIRE_BUNDLED_PLUGINS === "1";
const stateFile = "bundled-plugins-state.json";

const lock = JSON.parse(await readFile(lockPath, "utf8"));
if (
  lock.schemaVersion !== 1
  || (lock.bundlePolicy !== "omit" && lock.bundlePolicy !== "required")
  || !Array.isArray(lock.plugins)
  || lock.plugins.length === 0
) {
  throw new Error(`Invalid bundled plugin lock: ${lockPath}`);
}
for (const expected of lock.plugins) assertLockEntry(expected);

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

if (requireBundledPlugins && lock.bundlePolicy === "omit" && configuredSourceDirectory) {
  throw new Error(
    "MEMMY_BUNDLED_PLUGIN_SOURCE_DIR must not be set for a package whose bundled plugin policy is omit"
  );
}
if (!configuredSourceDirectory) {
  if (requireBundledPlugins && lock.bundlePolicy === "required") {
    throw new Error(
      "MEMMY_BUNDLED_PLUGIN_SOURCE_DIR is required when MEMMY_REQUIRE_BUNDLED_PLUGINS=1 and must point to the locked plugin release descriptors and MPP archives"
    );
  }
  console.warn(requireBundledPlugins && lock.bundlePolicy === "omit"
    ? "[bundled-plugins] release policy intentionally omits bundled plugins."
    : "[bundled-plugins] MEMMY_BUNDLED_PLUGIN_SOURCE_DIR is not set; continuing with no bundled plugins. Set it to a release directory for local plugin integration.");
} else {
  const sourceDirectory = resolve(configuredSourceDirectory);
  for (const expected of lock.plugins) {
    const descriptorPath = join(sourceDirectory, expected.releaseFile);
    await assertRegularFile(descriptorPath);
    const descriptorBytes = await readFile(descriptorPath);
    const descriptor = JSON.parse(descriptorBytes.toString("utf8"));
    const artifactFile = descriptor?.artifact?.file;
    if (
      descriptor?.manifest?.id !== expected.id
      || descriptor?.manifest?.version !== expected.version
      || descriptor?.artifact?.sha256 !== expected.sha256
      || typeof artifactFile !== "string"
      || basename(artifactFile) !== artifactFile
    ) {
      throw new Error(`Bundled plugin descriptor does not match lock: ${expected.id}`);
    }

    const artifactPath = join(sourceDirectory, artifactFile);
    await assertRegularFile(artifactPath);
    const artifact = await readFile(artifactPath);
    const digest = createHash("sha256").update(artifact).digest("hex");
    if (digest !== expected.sha256) {
      throw new Error(`Bundled plugin archive does not match locked SHA-256: ${expected.id}`);
    }

    await copyFile(descriptorPath, join(outputDirectory, expected.releaseFile));
    await copyFile(artifactPath, join(outputDirectory, artifactFile));
  }
}

await writeFile(join(outputDirectory, stateFile), `${JSON.stringify({
  schemaVersion: 1,
  managedPluginIds: lock.plugins.map((plugin) => plugin.id)
}, null, 2)}\n`);

process.stdout.write(`${outputDirectory}\n`);

function assertLockEntry(value) {
  if (
    !value
    || typeof value.id !== "string"
    || typeof value.version !== "string"
    || typeof value.releaseFile !== "string"
    || basename(value.releaseFile) !== value.releaseFile
    || typeof value.sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(value.sha256)
  ) {
    throw new Error("Invalid bundled plugin lock entry");
  }
}

async function assertRegularFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Bundled plugin source must be a regular file: ${path}`);
  }
}
