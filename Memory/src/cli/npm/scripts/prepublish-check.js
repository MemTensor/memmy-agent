#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
const failures = [];

if (manifest.name !== "@memtensor/memmy-memory-cli") {
  failures.push("package name must be @memtensor/memmy-memory-cli");
}
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version ?? "")) {
  failures.push("version must be valid semver");
}
if (manifest.bin?.["memmy-memory"] !== "./bin/memmy-memory.js") {
  failures.push("bin.memmy-memory must point to ./bin/memmy-memory.js");
}
if (manifest.scripts?.postinstall !== "node scripts/postinstall.js") {
  failures.push("scripts.postinstall must run node scripts/postinstall.js");
}
if (manifest.scripts?.prepublishOnly !== "node scripts/prepublish-check.js") {
  failures.push("scripts.prepublishOnly must run node scripts/prepublish-check.js");
}
if (!Array.isArray(manifest.files) || !manifest.files.includes("bin") || !manifest.files.includes("scripts")) {
  failures.push("files must include bin and scripts");
}
for (const relativePath of ["README.md", "bin/memmy-memory.js", "scripts/postinstall.js", "scripts/prepublish-check.js"]) {
  if (!existsSync(join(packageRoot, relativePath))) {
    failures.push(`${relativePath} is missing`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`prepublish check failed: ${failure}`);
  }
  process.exit(1);
}
