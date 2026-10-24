import { createRequire } from "node:module";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { createPackage, extractFile } from "@electron/asar";
import { getNodeModuleFileMatcher } from "app-builder-lib/out/fileMatcher.js";
import { parse } from "yaml";
import { afterEach, expect, it } from "vitest";
import { verifyWindowsDesktopSqliteVec, verifyPackagedWindowsDesktopSqliteVec } from "../scripts/internal/win/verify-desktop-sqlite-vec.mjs";
import { windowsPEFixture } from "./fixtures/windows-pe-fixture.mjs";

const roots = [];
const actualWrapperDirectory = new URL("../node_modules/sqlite-vec/", import.meta.url);
const actualWrapper = JSON.parse(readFileSync(new URL("package.json", actualWrapperDirectory), "utf8"));
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() { const value = mkdtempSync(join(tmpdir(), "desktop-win-sqlite-vec-")); roots.push(value); return value; }
function write(file, bytes) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes); }
function fixture(directory = root()) {
  const backendManifestPath = join(directory, "backend.json");
  const wrapperManifestPath = join(directory, "wrapper.json");
  const nativeDirectory = join(directory, "native");
  write(backendManifestPath, JSON.stringify({ dependencies: { "sqlite-vec": actualWrapper.version } }));
  write(wrapperManifestPath, JSON.stringify(actualWrapper));
  write(join(nativeDirectory, "package.json"), JSON.stringify({ name: "sqlite-vec-windows-x64", version: actualWrapper.version,
    os: ["win32"], cpu: ["x64"], exports: { "./vec0.dll": { default: "./vec0.dll" } } }));
  const dll = windowsPEFixture(); dll.writeUInt16LE(0x2022, 0x96);
  write(join(nativeDirectory, "vec0.dll"), dll);
  return { directory, backendManifestPath, wrapperManifestPath, nativeDirectory };
}

it("validates the backend's exact Windows vector version and a real DLL header without changing host modules", () => {
  const value = fixture();
  const before = readFileSync(value.wrapperManifestPath);
  expect(verifyWindowsDesktopSqliteVec(value)).toMatchObject({ package: "sqlite-vec-windows-x64", version: actualWrapper.version });
  expect(readFileSync(value.wrapperManifestPath)).toEqual(before);
});

it.each(["range", "wrapper", "optional target", "native target", "wrong OS"])("rejects %s mismatches before packaging", kind => {
  const value = fixture();
  if (kind === "range") write(value.backendManifestPath, JSON.stringify({ dependencies: { "sqlite-vec": "^" + actualWrapper.version } }));
  else if (kind === "wrapper") write(value.wrapperManifestPath, JSON.stringify({ ...actualWrapper, version: "0.0.0" }));
  else if (kind === "optional target") write(value.wrapperManifestPath, JSON.stringify({ ...actualWrapper, optionalDependencies: {} }));
  else {
    const file = join(value.nativeDirectory, "package.json"); const metadata = JSON.parse(readFileSync(file, "utf8"));
    write(file, JSON.stringify({ ...metadata, ...(kind === "wrong OS" ? { os: ["darwin"] } : { version: "0.0.0" }) }));
  }
  expect(() => verifyWindowsDesktopSqliteVec(value)).toThrow(/exact version|does not match/);
});

it.each(["arm64", "Mach-O", "EXE", "symlink"])("rejects a %s native target", kind => {
  const value = fixture(); const file = join(value.nativeDirectory, "vec0.dll");
  if (kind === "symlink") { const external = join(value.directory, "external.dll"); cpSync(file, external); rmSync(file); symlinkSync(external, file); }
  else if (kind === "Mach-O") write(file, Buffer.from("cffaedfe0c000001", "hex"));
  else { const dll = windowsPEFixture(kind === "arm64" ? 0xaa64 : 0x8664); if (kind !== "EXE") dll.writeUInt16LE(0x2022, 0x96); write(file, dll); }
  expect(() => verifyWindowsDesktopSqliteVec(value)).toThrow(/physical file|PE DLL|x64 PE32\+ DLL/);
});

it.each(["electron-builder.win.yml", "electron-builder.win.unsigned.yml"])(
  "%s keeps the JS wrapper, filters foreign native targets and provides the exact external Windows target", filename => {
    const config = parse(readFileSync(new URL(`../App/shell/desktop/${filename}`, import.meta.url), "utf8"));
    const directory = root();
    const matcher = getNodeModuleFileMatcher(directory, join(directory, "out"), value => value, {}, {
      config, debugLogger: { isEnabled: false },
    }).createFilter();
    for (const name of ["sqlite-vec-darwin-arm64", "sqlite-vec-darwin-x64", "sqlite-vec-linux-x64", "sqlite-vec-linux-arm64", "sqlite-vec-windows-arm64"]) {
      const file = join(directory, "node_modules", name, "vec0.dll"); write(file, "foreign");
      expect(matcher(file, lstatSync(file)), name).toBe(false);
    }
    for (const name of ["sqlite-vec/index.cjs", "sqlite-vec/index.mjs", "sqlite-vec-windows-x64/vec0.dll", "quickjs-wasi/extensions/crypto/crypto.so"]) {
      const file = join(directory, "node_modules", name); write(file, "required");
      expect(matcher(file, lstatSync(file)), name).toBe(true);
    }
    expect(config.extraResources).toContainEqual({ from: "dist/runtime/memory/node_modules/sqlite-vec-windows-x64",
      to: "node_modules/sqlite-vec-windows-x64", filter: ["**/*"] });
  });

it("resolves the actual CJS Windows wrapper from an ASAR through packaged resources/node_modules without loading the DLL", async () => {
  const value = fixture(); const source = join(value.directory, "source"); const resources = join(value.directory, "resources");
  for (const file of ["package.json", "index.cjs", "index.mjs"])
    write(join(source, "node_modules/sqlite-vec", file), readFileSync(new URL(file, actualWrapperDirectory)));
  const nativeDirectory = join(resources, "node_modules/sqlite-vec-windows-x64");
  cpSync(value.nativeDirectory, nativeDirectory, { recursive: true });
  const asarPath = join(resources, "app.asar"); await createPackage(source, asarPath);
  const result = verifyPackagedWindowsDesktopSqliteVec({ backendManifestPath: value.backendManifestPath, asarPath, resourcesRoot: resources });
  const packagedRequire = createRequire(join(asarPath, "node_modules/sqlite-vec/index.cjs"));
  const fakeRequire = name => name === "node:process" ? { platform: "win32", arch: "x64" } : packagedRequire(name);
  fakeRequire.resolve = packagedRequire.resolve;
  const module = { exports: {} };
  runInNewContext(extractFile(asarPath, join("node_modules", "sqlite-vec", "index.cjs")).toString("utf8"), { require: fakeRequire, module });
  expect(realpathSync(module.exports.getLoadablePath())).toBe(realpathSync(join(nativeDirectory, "vec0.dll")));
  expect(realpathSync(result.resolvedNativePath)).toBe(realpathSync(join(nativeDirectory, "vec0.dll")));
});

it("preserves the actual ESM wrapper's normal ancestor resolution with simulated Windows platform and no DLL loading", async () => {
  const value = fixture(); const resources = join(value.directory, "resources");
  const nativeDirectory = join(resources, "node_modules/sqlite-vec-windows-x64");
  cpSync(value.nativeDirectory, nativeDirectory, { recursive: true });
  const esm = join(resources, "app.asar/node_modules/sqlite-vec/index.mjs");
  const original = readFileSync(new URL("index.mjs", actualWrapperDirectory), "utf8");
  const source = original.replace('import { arch, platform } from "node:process";', 'const arch = "x64", platform = "win32";');
  expect(source).not.toBe(original); write(esm, source);
  const wrapper = await import(pathToFileURL(esm).href);
  expect(realpathSync(wrapper.getLoadablePath())).toBe(realpathSync(join(nativeDirectory, "vec0.dll")));
});

it("checks the desktop vector binding before and after Windows packaging", () => {
  const script = readFileSync(new URL("../scripts/internal/win/build-nsis.sh", import.meta.url), "utf8");
  const first = script.indexOf('verify-desktop-sqlite-vec.mjs" staged');
  const second = script.indexOf('verify-desktop-sqlite-vec.mjs" packaged');
  expect(first).toBeGreaterThan(script.indexOf('npm_ci_win_x64 "$RUNTIME_DIR/memory"'));
  expect(first).toBeLessThan(script.indexOf("npx electron-builder"));
  expect(second).toBeGreaterThan(script.indexOf("npx electron-builder"));
  expect(existsSync(new URL("../scripts/internal/win/verify-desktop-sqlite-vec.mjs", import.meta.url))).toBe(true);
});
