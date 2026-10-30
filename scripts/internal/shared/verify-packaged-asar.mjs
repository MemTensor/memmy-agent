#!/usr/bin/env node

import { extractFile, listPackage } from "@electron/asar";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyWindowsComputerUseRuntime } from "../win/verify-computer-use-runtime.mjs";
import { verifyWindowsComputerHistoryRuntime } from "../win/verify-computer-history-runtime.mjs";

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
  memoryRoot,
  platform,
  arch,
} = parseArgs(process.argv.slice(2));
assertSemanticVersion(expectedDesktop, "Expected packaged version");
if (platform === "win32") assertSemanticVersion(expectedMemory, "Expected packaged Memory version");

const entries = listPackage(asarPath).map((entry) => entry.replaceAll("\\", "/").replace(/^\/+/, ""));
if (entries.some((entry) => /(^|\/)\.env(?:$|\.)/u.test(entry))) {
  throw new Error("Packaged ASAR contains a forbidden environment file");
}

const entrySet = new Set(entries);
const memoryInAsar = entrySet.has("dist/runtime/memory/package.json");
const requiredFiles = [
  "dist/main/desktop-edition.json",
  "dist/main/computer-use-surface-window.js",
  "dist/main/computer-use-surface.html",
  "dist/preload/computer-use-surface-preload.cjs",
  "package.json",
  "dist/runtime/memmy-agent/package.json",
  "dist/runtime/memmy-agent/node_modules/@memmy/local-api-contracts/dist/index.js",
  "dist/runtime/memmy-agent/node_modules/@memmy/knowledge/dist/index.js",
  "node_modules/@memmy/backend/dist/src/adapters/outbound/skill-writer/workspace-bridge/memmy-workspace-bridge.mjs",
];
if (platform === "darwin") requiredFiles.push("dist/native/memmy-pip.node", "dist/native/menu-bar-appearance.node");
if (platform === "win32") {
  const historyPrefix = "dist/runtime/memmy-agent/dist/tools/computer-history/win/";
  requiredFiles.push(`${historyPrefix}memmy-history-recorder.exe`, `${historyPrefix}memmy-history-recorder.NOTICES.md`);
  if (entries.some((entry) => entry.startsWith(`${historyPrefix}native/`))) {
    throw new Error("Packaged ASAR contains Computer History native build/test sources");
  }
  const binary = readFileSync(join(`${asarPath}.unpacked`, historyPrefix, "memmy-history-recorder.exe"));
  const peOffset = binary.length >= 64 ? binary.readUInt32LE(60) : -1;
  if (binary.toString("ascii", 0, 2) !== "MZ" || peOffset < 64 || peOffset + 6 > binary.length
      || binary.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0" || binary.readUInt16LE(peOffset + 4) !== 0x8664) {
    throw new Error("Packaged Computer History helper must be an unpacked Windows x64 PE executable");
  }
  requiredFiles.push(
    "dist/main/computer-use-window-capture.js",
    "dist/runtime/memmy-agent/dist/tools/computer-use/managed-ocu-session.js",
    "dist/runtime/memmy-agent/dist/tools/computer-use/native-surface-control.js",
    "dist/runtime/memmy-agent/dist/tools/computer-use/windows-focus-guard.js",
    `dist/runtime/memmy-agent/dist/native-computer-use/windows/${arch === "x64" ? "amd64" : "arm64"}/memmy-computer-use.exe`,
    `dist/runtime/memmy-agent/dist/native-computer-history/windows/${arch === "x64" ? "amd64" : "arm64"}/memmy-computer-history.exe`,
    "dist/main/browser-sidebar-bridge.js",
    "dist/main/browser-history-store.js",
    "dist/main/browser-download-catalog.js",
    "dist/main/browser-site-permissions.js",
    "dist/main/browser-access-store.js",
    "dist/main/browser-download-settings.js",
    "dist/main/browser-auth-form.js",
    "dist/main/browser-browsing-data.js",
    "dist/runtime/memmy-agent/dist/core/agent-runtime/tools/browser-profile.js",
    "dist/runtime/memmy-agent/dist/core/agent-runtime/tools/browser-downloads.js",
    "dist/runtime/memmy-agent/dist/core/agent-runtime/tools/browser-site-permissions.js",
    "dist/runtime/memmy-agent/dist/core/agent-runtime/tools/browser-access-approval.js",
    "dist/runtime/memmy-agent/dist/core/agent-runtime/tools/browser-window-visibility.js",
    "dist/runtime/memmy-agent/dist/main.js.map",
  );
  if (memoryInAsar) {
    requiredFiles.push(
      "dist/runtime/memory/package.json",
      "dist/runtime/memory/node_modules/@memmy/agent-source-core/package.json",
      "dist/runtime/memory/node_modules/@memmy/agent-source-core/dist/src/index.js",
      `dist/runtime/memory/node_modules/onnxruntime-node/bin/napi-v3/${platform}/${arch}/onnxruntime_binding.node`,
      `dist/runtime/memory/node_modules/onnxruntime-node/bin/napi-v3/${platform}/${arch}/onnxruntime.dll`,
    );
  } else {
    if (!memoryRoot) throw new Error("--memory-root is required when Windows Memory is outside the ASAR");
    for (const file of [
      "package.json",
      "node_modules/@memmy/agent-source-core/package.json",
      "node_modules/@memmy/agent-source-core/dist/src/index.js",
      `node_modules/onnxruntime-node/bin/napi-v3/${platform}/${arch}/onnxruntime_binding.node`,
      `node_modules/onnxruntime-node/bin/napi-v3/${platform}/${arch}/onnxruntime.dll`,
    ]) {
      if (!existsSync(join(memoryRoot, file))) throw new Error(`Packaged Memory resource is missing: ${file}`);
    }
    const externalMemory = JSON.parse(readFileSync(join(memoryRoot, "package.json"), "utf8"));
    if (externalMemory.version !== expectedMemory) {
      throw new Error("Packaged Memory resource version does not match the requested version");
    }
  }
}
for (const file of requiredFiles) {
  if (!entrySet.has(file)) throw new Error(`Packaged ASAR is missing required runtime file: ${file}`);
}
for (const file of ["dist/main/computer-use-surface.html", "dist/preload/computer-use-surface-preload.cjs"]) {
  if (!readAsarFile(asarPath, file).length) throw new Error(`Packaged Computer Use preview asset is empty: ${file}`);
}
if (platform === "darwin") {
  for (const addon of ["memmy-pip", "menu-bar-appearance"]) {
    const file = `dist/native/${addon}.node`;
    if (!existsSync(join(`${asarPath}.unpacked`, file))) {
      throw new Error(`Packaged native PiP addon is missing from unpacked resources: ${file}`);
    }
  }
}
if (platform === "win32") {
  const helper = `dist/runtime/memmy-agent/dist/native-computer-use/windows/${arch === "x64" ? "amd64" : "arm64"}/memmy-computer-use.exe`;
  const unpackedHelper = join(`${asarPath}.unpacked`, helper);
  if (!existsSync(unpackedHelper)) {
    throw new Error(`Packaged Windows Computer Use helper is missing from unpacked resources: ${helper}`);
  }
  verifyWindowsComputerUseRuntime(readFileSync(unpackedHelper), arch);
  const history = `dist/runtime/memmy-agent/dist/native-computer-history/windows/${arch === "x64" ? "amd64" : "arm64"}/memmy-computer-history.exe`;
  const unpackedHistory = join(`${asarPath}.unpacked`, history);
  if (!existsSync(unpackedHistory)) throw new Error(`Packaged Windows History recorder is missing from unpacked resources: ${history}`);
  verifyWindowsComputerHistoryRuntime(readFileSync(unpackedHistory), arch);
  if (entries.some(entry => /^dist\/native\/(?:memmy-pip|menu-bar-appearance)\.node$/u.test(entry))) {
    throw new Error("Windows ASAR contains a macOS-only native Computer Use addon");
  }
}

// Renderer files are deliberately unpacked. Checking the archive index alone
// misses a mixed app.asar/app.asar.unpacked pair, which opens a blank window.
const rendererHtml = readAsarFile(asarPath, "dist/renderer/index.html").toString("utf8");
const rendererAssets = [...rendererHtml.matchAll(/(?:src|href)="\.\/(assets\/[^"?#]+)"/gu)]
  .map((match) => match[1]);
if (!rendererAssets.length) throw new Error("Packaged renderer index has no local entry assets");
for (const asset of rendererAssets) {
  const archivePath = `dist/renderer/${asset}`;
  if (!entrySet.has(archivePath) || !existsSync(join(`${asarPath}.unpacked`, archivePath))) {
    throw new Error(`Packaged renderer entry asset is missing: ${archivePath}`);
  }
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
if (platform === "win32" && memoryInAsar) {
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

function readAsarFile(path, file) {
  // ASAR lookup uses the build host's path separator, even for another target OS.
  return extractFile(path, join(...file.split("/")));
}

function readAsarJson(path, file) {
  try {
    return JSON.parse(readAsarFile(path, file).toString("utf8"));
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
      throw new Error("Usage: verify-packaged-asar.mjs --asar <path> --expected <version> [--expected-memory <version>] [--memory-root <path>] --platform <platform> --arch <arch>");
    }
    const key = flag.slice(2);
    if (!new Set(["asar", "expected", "expected-memory", "memory-root", "platform", "arch"]).has(key)
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
  if (parsed.platform !== "win32" && Object.hasOwn(parsed, "memory-root")) {
    throw new Error("--memory-root is only supported for win32 packages");
  }
  return {
    asarPath: parsed.asar,
    expected: parsed.expected,
    expectedMemory: parsed["expected-memory"],
    memoryRoot: parsed["memory-root"],
    platform: parsed.platform,
    arch: parsed.arch,
  };
}
