#!/usr/bin/env node
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const outputDirectory = resolve(
  process.argv[2] ?? join(repositoryRoot, "App", "shell", "desktop", "dist", "bundled-plugins")
);

// Keep only the IDs needed to migrate installations from older bundled builds.
// Releases and versions come from the account's remote plugin registry.
// Deliberately ignore the retired MEMMY_BUNDLED_PLUGIN_SOURCE_DIR setting.
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await writeFile(join(outputDirectory, "bundled-plugins-state.json"), `${JSON.stringify({
  schemaVersion: 1,
  managedPluginIds: ["literature-review"]
}, null, 2)}\n`);
process.stdout.write(`${outputDirectory}\n`);
