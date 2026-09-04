#!/usr/bin/env node

import { extractFile, listPackage } from "@electron/asar";

const semanticVersionPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const assertSemanticVersion = (version, label) => {
  if (!semanticVersionPattern.test(version ?? "")) {
    throw new Error(`${label} must use semantic version syntax`);
  }
};

const {
  asarPath,
  expected: expectedDesktop,
  expectedMemory,
  platform,
  arch,
} = parseArgs(process.argv.slice(2));
assertSemanticVersion(expectedDesktop, "Expected packaged version");
if (platform === "win32") assertSemanticVersion(expectedMemory, "Expected packaged Memory version");

const entries = listPackage(asarPath).map((entry) => entry.replaceAll("\\", "/").replace(/^\/+/, ""));
if (entries.some((entry) => /(^|\/)\.env(?:$|\.)/u.test(entry))) {
  throw new Error("Packaged ASAR contains a forbidden environment file");
}

const requiredFiles = [
  "dist/main/desktop-edition.json",
  "package.json",
  "dist/runtime/memmy-agent/package.json",
  "dist/runtime/memmy-agent/node_modules/@memmy/local-api-contracts/dist/index.js",
  "node_modules/@memmy/backend/dist/src/adapters/outbound/skill-writer/workspace-bridge/memmy-workspace-bridge.mjs",
];
if (platform === "win32") {
  requiredFiles.push(
    "dist/runtime/memory/package.json",
    "dist/runtime/memory/node_modules/@memmy/agent-source-core/package.json",
    "dist/runtime/memory/node_modules/@memmy/agent-source-core/dist/src/index.js",
    `dist/runtime/memory/node_modules/onnxruntime-node/bin/napi-v3/${platform}/${arch}/onnxruntime_binding.node`,
    `dist/runtime/memory/node_modules/onnxruntime-node/bin/napi-v3/${platform}/${arch}/onnxruntime.dll`,
    "dist/runtime/memmy-agent/dist/main.js.map",
  );
}
const entrySet = new Set(entries);
for (const file of requiredFiles) {
  if (!entrySet.has(file)) throw new Error(`Packaged ASAR is missing required runtime file: ${file}`);
}

if (platform === "win32") {
  const onnxRuntimePrefix = "dist/runtime/memory/node_modules/onnxruntime-node/bin/napi-v3/";
  const targetOnnxRuntimePrefix = `${onnxRuntimePrefix}${platform}/${arch}/`;
  if (entries.some((entry) => entry.startsWith(onnxRuntimePrefix)
    && !entry.startsWith(targetOnnxRuntimePrefix)
    && !targetOnnxRuntimePrefix.startsWith(`${entry.replace(/\/+$/u, "")}/`))) {
    throw new Error("Packaged ASAR contains an incompatible onnxruntime-node platform");
  }

  const optionalPeerToolchainPattern = /^dist\/runtime\/memmy-agent\/node_modules\/(?:vitest|vite|rolldown)(?:\/|$)|^dist\/runtime\/memmy-agent\/node_modules\/@vitest(?:\/|$)|^dist\/runtime\/memmy-agent\/node_modules\/@rolldown\/binding-[^/]+(?:\/|$)/u;
  if (entries.some((entry) => optionalPeerToolchainPattern.test(entry))) {
    throw new Error("Packaged ASAR contains the html-validate optional-peer test toolchain");
  }

  const thirdPartySourceMap = entries.find((entry) =>
    /^dist\/runtime\/(?:memory|memmy-agent)\/node_modules\//u.test(entry)
    && entry.endsWith(".map")
    && !isFirstPartyPackageFile(entry));
  if (thirdPartySourceMap) {
    throw new Error(`Packaged ASAR contains a third-party production source map: ${thirdPartySourceMap}`);
  }
}

const versionedFiles = [
  ["package.json", false, expectedDesktop],
  ["dist/runtime/memmy-agent/package.json", false, expectedDesktop],
  ["dist/runtime/memmy-agent/package-lock.json", true, expectedDesktop],
];
if (platform === "win32") {
  versionedFiles.splice(1, 0,
    ["dist/runtime/memory/package.json", false, expectedMemory],
    ["dist/runtime/memory/package-lock.json", true, expectedMemory],
  );
}
for (const [file, lock, expectedVersion] of versionedFiles) {
  // electron-builder excludes npm lockfiles by default. The staged-runtime
  // version guard validates them before packaging; re-check any that are kept.
  if (lock && !entrySet.has(file)) continue;
  const json = readAsarJson(asarPath, file);
  if (json.version !== expectedVersion) {
    throw new Error(`Packaged version does not match the requested version: ${file}`);
  }
  if (lock && json.packages?.[""]?.version !== expectedVersion) {
    throw new Error(`Packaged lock root does not match the requested version: ${file}`);
  }
}

const memoryVersionSummary = expectedMemory ? ` and Memory version ${expectedMemory}` : "";
console.log(`Verified packaged ASAR boundary and version ${expectedDesktop}${memoryVersionSummary}`);

function readAsarJson(path, file) {
  try {
    const archiveFile = process.platform === "win32" ? file.replaceAll("/", "\\") : file;
    return JSON.parse(extractFile(path, archiveFile).toString("utf8"));
  } catch {
    throw new Error(`Packaged runtime JSON is invalid: ${file}`);
  }
}

function isFirstPartyPackageFile(entry) {
  const marker = "/node_modules/";
  const owner = entry.slice(entry.lastIndexOf(marker) + marker.length);
  return owner.startsWith("@memmy/");
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error("Usage: verify-packaged-asar.mjs --asar <path> --expected <version> [--expected-memory <version>] --platform <platform> --arch <arch>");
    }
    const key = flag.slice(2);
    if (!new Set(["asar", "expected", "expected-memory", "platform", "arch"]).has(key)
      || Object.hasOwn(parsed, key)) {
      throw new Error(`Unknown or duplicate option: ${flag}`);
    }
    parsed[key] = value;
  }
  if (!parsed.asar || !parsed.expected || !parsed.platform || !parsed.arch) {
    throw new Error("--asar, --expected, --platform, and --arch are required");
  }
  if (!new Set(["darwin", "linux", "win32"]).has(parsed.platform)) {
    throw new Error(`Unsupported packaged platform: ${parsed.platform}`);
  }
  if (!new Set(["arm64", "x64"]).has(parsed.arch)) {
    throw new Error(`Unsupported packaged architecture: ${parsed.arch}`);
  }
  const hasExpectedMemory = Object.hasOwn(parsed, "expected-memory");
  if (parsed.platform === "win32" && !hasExpectedMemory) {
    throw new Error("--expected-memory is required for win32 packages");
  }
  if (parsed.platform !== "win32" && hasExpectedMemory) {
    throw new Error("--expected-memory is only supported for win32 packages");
  }
  return {
    asarPath: parsed.asar,
    expected: parsed.expected,
    expectedMemory: parsed["expected-memory"],
    platform: parsed.platform,
    arch: parsed.arch,
  };
}
