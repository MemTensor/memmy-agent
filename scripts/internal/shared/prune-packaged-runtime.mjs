#!/usr/bin/env node

import { prunePackagedRuntime } from "./prune-packaged-runtime-lib.mjs";

const options = readOptions(process.argv.slice(2));
const result = await prunePackagedRuntime(options);
console.log(`Pruned ${result.removedFiles} file(s), ${result.removedBytes} byte(s), and ${result.removedDirectories} directorie(s)`);
console.log(JSON.stringify(result));

function readOptions(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (!option?.startsWith("--") || value === undefined) {
      throw new Error("Usage: prune-packaged-runtime.mjs --platform <platform> --arch <arch> --runtime-root <path>");
    }
    values.set(option, value);
  }
  if (values.size !== 3) {
    throw new Error("Usage: prune-packaged-runtime.mjs --platform <platform> --arch <arch> --runtime-root <path>");
  }
  return {
    platform: values.get("--platform"),
    arch: values.get("--arch"),
    runtimeRoot: values.get("--runtime-root"),
  };
}
