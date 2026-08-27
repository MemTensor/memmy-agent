#!/usr/bin/env node

import { pruneRuntimeEnvFiles } from "./prune-runtime-env-files-lib.mjs";

const runtimeRoot = process.argv[2];
if (!runtimeRoot || process.argv.length !== 3) {
  throw new Error("Usage: prune-runtime-env-files.mjs <runtime-root>");
}
const count = await pruneRuntimeEnvFiles(runtimeRoot);
console.log(`Pruned ${count} runtime environment file(s)`);
