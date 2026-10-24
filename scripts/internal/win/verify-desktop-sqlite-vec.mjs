#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { extractFile, listPackage } from "@electron/asar";

const nativePackage = "sqlite-vec-windows-x64";

/** Check the backend's exact Windows dependency without changing host modules. */
export function verifyWindowsDesktopSqliteVec({ backendManifestPath, wrapperManifestPath, nativeDirectory }) {
  return verifyBinding(readJson(backendManifestPath), readJson(wrapperManifestPath), nativeDirectory);
}

/** The physical target resolves from the wrapper's normal ASAR module ancestry. */
export function verifyPackagedWindowsDesktopSqliteVec({ backendManifestPath, asarPath, resourcesRoot }) {
  const entries = listPackage(asarPath).map(entry => entry.replaceAll("\\", "/").replace(/^\/+/, ""));
  if (entries.some(entry => /^node_modules\/sqlite-vec-(?:darwin|linux)-|^node_modules\/sqlite-vec-windows-arm64(?:\/|$)/u.test(entry))) {
    throw new Error("Windows desktop ASAR contains a foreign SQLite vector native package");
  }
  for (const file of ["package.json", "index.cjs", "index.mjs"]) {
    if (!entries.includes(`node_modules/sqlite-vec/${file}`)) throw new Error(`Desktop SQLite vector wrapper is missing ${file}`);
  }
  const wrapper = JSON.parse(extractFile(asarPath, join("node_modules", "sqlite-vec", "package.json")).toString("utf8"));
  const nativeDirectory = join(resourcesRoot, "node_modules", nativePackage);
  const result = verifyBinding(readJson(backendManifestPath), wrapper, nativeDirectory);
  // Resolve the DLL path only. Do not load the extension or run Windows code.
  const packagedRequire = createRequire(join(resolve(asarPath), "node_modules/sqlite-vec/index.cjs"));
  const resolved = packagedRequire.resolve(`${nativePackage}/vec0.dll`);
  if (realpathSync(resolved) !== realpathSync(join(nativeDirectory, "vec0.dll"))) {
    throw new Error("Desktop SQLite vector wrapper resolves outside its packaged Windows target");
  }
  return { ...result, resolvedNativePath: resolved };
}

function verifyBinding(backend, wrapper, nativeDirectory) {
  const expected = backend.dependencies?.["sqlite-vec"];
  if (typeof expected !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(expected)) {
    throw new Error("Backend SQLite vector dependency must specify an exact version");
  }
  if (wrapper.name !== "sqlite-vec" || wrapper.version !== expected
      || wrapper.optionalDependencies?.[nativePackage] !== expected) {
    throw new Error("Desktop SQLite vector wrapper version does not match the backend dependency");
  }
  const directory = lstatSync(nativeDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Windows SQLite vector target must be a physical directory");
  const native = readJson(join(nativeDirectory, "package.json"));
  if (native.name !== nativePackage || native.version !== expected
      || !native.os?.includes("win32") || !native.cpu?.includes("x64")) {
    throw new Error("Windows SQLite vector target identity or version does not match the backend dependency");
  }
  const dllPath = join(nativeDirectory, "vec0.dll");
  if (!lstatSync(dllPath).isFile()) throw new Error("Windows SQLite vector DLL must be a physical file");
  const bytes = readFileSync(dllPath);
  if (bytes.length < 64 || bytes.toString("ascii", 0, 2) !== "MZ") throw new Error("Windows SQLite vector target is not a PE DLL");
  const pe = bytes.readUInt32LE(0x3c);
  if (pe < 64 || pe > bytes.length - 26 || bytes.readUInt32LE(pe) !== 0x4550
      || bytes.readUInt16LE(pe + 4) !== 0x8664 || bytes.readUInt16LE(pe + 24) !== 0x20b
      || !(bytes.readUInt16LE(pe + 22) & 0x2000)) {
    throw new Error("Windows SQLite vector target must be an x64 PE32+ DLL");
  }
  return { package: nativePackage, version: expected, bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") };
}

function readJson(file) {
  if (!lstatSync(file).isFile()) throw new Error(`SQLite vector manifest must be a physical file: ${file}`);
  return JSON.parse(readFileSync(file, "utf8"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, backendManifestPath, wrapperOrAsarPath, nativeOrResourcesDirectory] = process.argv.slice(2);
  if (!["staged", "packaged"].includes(mode) || process.argv.length !== 6) {
    throw new Error("Usage: verify-desktop-sqlite-vec.mjs <staged|packaged> <backend-package.json> <wrapper-package.json|app.asar> <native-directory|resources-root>");
  }
  const result = mode === "staged"
    ? verifyWindowsDesktopSqliteVec({ backendManifestPath, wrapperManifestPath: wrapperOrAsarPath, nativeDirectory: nativeOrResourcesDirectory })
    : verifyPackagedWindowsDesktopSqliteVec({ backendManifestPath, asarPath: wrapperOrAsarPath, resourcesRoot: nativeOrResourcesDirectory });
  console.log(`Verified desktop Windows SQLite vector binding: ${JSON.stringify(result)}`);
}
