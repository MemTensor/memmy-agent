#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const [
  sourcePackagePath,
  agentSourceCorePackagePath,
  runtimePackagePath,
  runtimeMetadataPath,
] = process.argv.slice(2);
if (!sourcePackagePath || !agentSourceCorePackagePath
    || !runtimePackagePath || !runtimeMetadataPath) {
  throw new Error(
    "Usage: create-memory-runtime-manifest.mjs <source-package> <agent-source-core-package> <runtime-package> <runtime-metadata>",
  );
}

const sourcePackage = JSON.parse(await readFile(sourcePackagePath, "utf8"));
const agentSourceCorePackage = JSON.parse(
  await readFile(agentSourceCorePackagePath, "utf8"),
);
const dependencies = { ...(sourcePackage.dependencies ?? {}) };
if (!agentSourceCorePackage.name
    || dependencies[agentSourceCorePackage.name] !== agentSourceCorePackage.version) {
  throw new Error("Memory and AgentSourceCore workspace versions do not match");
}
dependencies[agentSourceCorePackage.name] = "file:./workspace-packages/agent-source-core";

const runtimePackage = {
  name: "@memmy/packaged-memory-runtime",
  version: sourcePackage.version,
  private: true,
  type: "module",
  dependencies,
};
const runtimeMetadata = {
  version: sourcePackage.version,
  protocolVersion: 1,
  target: "windows-x64",
  entrypoint: "dist/src/server/index.js",
  viewer: "dist/viewer/index.html",
};

await Promise.all([
  mkdir(dirname(runtimePackagePath), { recursive: true }),
  mkdir(dirname(runtimeMetadataPath), { recursive: true }),
]);
await Promise.all([
  writeFile(runtimePackagePath, `${JSON.stringify(runtimePackage, null, 2)}\n`),
  writeFile(runtimeMetadataPath, `${JSON.stringify(runtimeMetadata, null, 2)}\n`),
]);
