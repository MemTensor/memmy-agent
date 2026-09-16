#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const desktopRoot = join(repositoryRoot, "App", "shell", "desktop");
const lockPath = join(desktopRoot, "resources", "bundled-plugins.json");
const args = process.argv.slice(2);
// Bundled plugins are released from their own repositories, so a machine that
// only runs the app from source has nothing to copy. `--optional` lets that be
// a skip instead of a failed startup; the packaging scripts pass no flag and
// keep failing, because an installer missing a locked plugin is a broken build.
const optional = args.includes("--optional");
const outputDirectory = resolve(args.find((value) => !value.startsWith("--")) ?? join(desktopRoot, "dist", "bundled-plugins"));
const configuredSourceDirectory = process.env.MEMMY_BUNDLED_PLUGIN_SOURCE_DIR?.trim();
if (!configuredSourceDirectory) {
  const requirement = "MEMMY_BUNDLED_PLUGIN_SOURCE_DIR is required and must point to a directory containing the locked plugin release descriptors and MPP archives";
  if (!optional) throw new Error(requirement);
  process.stderr.write(`Skipping bundled plugins: ${requirement}\n`);
  process.exit(0);
}
const sourceDirectory = resolve(configuredSourceDirectory);

const lock = JSON.parse(await readFile(lockPath, "utf8"));
if (lock.schemaVersion !== 1 || !Array.isArray(lock.plugins) || lock.plugins.length === 0) {
  throw new Error(`Invalid bundled plugin lock: ${lockPath}`);
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

for (const expected of lock.plugins) {
  assertLockEntry(expected);
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
