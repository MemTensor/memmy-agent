#!/usr/bin/env node

import { listPackage } from "@electron/asar";

const asarPath = process.argv[2];
if (!asarPath) {
  throw new Error("Usage: verify-packaged-yaml-runtime.mjs <app.asar>");
}

const entries = new Set(
  listPackage(asarPath).map((entry) => entry.replaceAll("\\", "/"))
);
const composerSuffix = "/node_modules/yaml/dist/compose/composer.js";
const requiredRuntimeSuffixes = [
  "/node_modules/yaml/dist/doc/directives.js",
  "/node_modules/yaml/dist/doc/Document.js"
];
const composerPaths = [...entries].filter((entry) => entry.endsWith(composerSuffix));

if (composerPaths.length === 0) {
  throw new Error(`No packaged yaml/dist/compose/composer.js entries found in ${asarPath}`);
}

const missing = [];
for (const composerPath of composerPaths) {
  const packagePrefix = composerPath.slice(0, -composerSuffix.length);
  for (const runtimeSuffix of requiredRuntimeSuffixes) {
    const requiredPath = `${packagePrefix}${runtimeSuffix}`;
    if (!entries.has(requiredPath)) {
      missing.push(requiredPath);
    }
  }
}

if (missing.length > 0) {
  throw new Error(
    `Missing YAML Document runtime modules in ${asarPath}:\n${missing.join("\n")}`
  );
}

console.log(`Verified YAML Document runtime modules for ${composerPaths.length} packaged copies.`);
