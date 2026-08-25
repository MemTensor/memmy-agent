#!/usr/bin/env node

import { extractFile, listPackage } from "@electron/asar";

const { asarPath, expected } = parseArgs(process.argv.slice(2));
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(expected)) {
  throw new Error("Expected packaged version must use semantic version syntax");
}

const entries = listPackage(asarPath).map((entry) => entry.replaceAll("\\", "/").replace(/^\/+/, ""));
if (entries.some((entry) => /(^|\/)\.env(?:$|\.)/u.test(entry))) {
  throw new Error("Packaged ASAR contains a forbidden environment file");
}

const requiredFiles = [
  "dist/main/desktop-edition.json",
  "package.json",
  "dist/runtime/memory/package.json",
  "dist/runtime/memmy-agent/package.json",
  "dist/runtime/memmy-agent/node_modules/@memmy/local-api-contracts/dist/index.js",
  "node_modules/@memmy/backend/dist/src/adapters/outbound/skill-writer/workspace-bridge/memmy-workspace-bridge.mjs",
];
const entrySet = new Set(entries);
for (const file of requiredFiles) {
  if (!entrySet.has(file)) throw new Error(`Packaged ASAR is missing required runtime file: ${file}`);
}

for (const [file, lock] of [
  ["package.json", false],
  ["dist/runtime/memory/package.json", false],
  ["dist/runtime/memory/package-lock.json", true],
  ["dist/runtime/memmy-agent/package.json", false],
  ["dist/runtime/memmy-agent/package-lock.json", true],
]) {
  // electron-builder excludes npm lockfiles by default. The staged-runtime
  // version guard validates them before packaging; re-check any that are kept.
  if (lock && !entrySet.has(file)) continue;
  const json = readAsarJson(asarPath, file);
  if (json.version !== expected) {
    throw new Error(`Packaged version does not match the requested version: ${file}`);
  }
  if (lock && json.packages?.[""]?.version !== expected) {
    throw new Error(`Packaged lock root does not match the requested version: ${file}`);
  }
}

console.log(`Verified packaged ASAR boundary and version ${expected}`);

function readAsarJson(path, file) {
  try {
    const archiveFile = process.platform === "win32" ? file.replaceAll("/", "\\") : file;
    return JSON.parse(extractFile(path, archiveFile).toString("utf8"));
  } catch {
    throw new Error(`Packaged runtime JSON is invalid: ${file}`);
  }
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error("Usage: verify-packaged-asar.mjs --asar <path> --expected <version>");
    }
    const key = flag.slice(2);
    if (!new Set(["asar", "expected"]).has(key) || parsed[key]) {
      throw new Error(`Unknown or duplicate option: ${flag}`);
    }
    parsed[key] = value;
  }
  if (!parsed.asar || !parsed.expected) {
    throw new Error("--asar and --expected are required");
  }
  return { asarPath: parsed.asar, expected: parsed.expected };
}
