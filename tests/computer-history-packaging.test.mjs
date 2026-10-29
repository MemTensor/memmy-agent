import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AsarPackager } from "app-builder-lib/out/asar/asarUtil.js";
import { FileMatcher } from "app-builder-lib/out/fileMatcher.js";
import { parse } from "yaml";
import ts from "typescript";
import { afterEach, expect, it } from "vitest";
import { windowsPEFixture } from "./fixtures/windows-pe-fixture.mjs";
import { verifyWindowsComputerHistoryRuntime } from "../scripts/internal/win/verify-computer-history-runtime.mjs";

const roots = [];
const prefix = "dist/runtime/memmy-agent/dist/tools/computer-history/mac";
const windowsPrefix = "dist/runtime/memmy-agent/dist/tools/computer-history/win";
const nativeWindowsPrefix = "dist/runtime/memmy-agent/dist/native-computer-history/windows";
// File paths are test data, including generated EXEs and PowerShell scripts.
// Keep them out of the test runner's import/asset URL transform.
const repoFile = (...parts) => join(dirname(fileURLToPath(import.meta.url)), "..", ...parts);
const builtNativeBinary = repoFile("App", "memmy-agent", "dist", "native-computer-history", "windows", "amd64", "memmy-computer-history.exe");
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function packagedFixture(filename) {
  const config = parse(readFileSync(repoFile("App", "shell", "desktop", filename), "utf8"));
  const root = mkdtempSync(join(tmpdir(), "history-asar-"));
  roots.push(root);
  const source = join(root, "source");
  const staged = join(root, "staged");
  const include = new FileMatcher(source, staged, (value) => value, config.files).createFilter();
  const files = [
    ["native-helper.js", ts.transpileModule(readFileSync(repoFile(
      "App", "memmy-agent", "src", "tools", "computer-history", "mac", "native-helper.ts",
    ), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText],
    ["wechat/connect.py", "# Connection helper fixture"],
    ["wechat/read_messages.py", "# Reader fixture"],
    ["wechat/permission_helper.py", "# Permission fixture"],
    ["wechat/permission_probe.m", "// Probe source fixture"],
    ["wechat/private_storage_bridge.c", "// Bridge source fixture"],
    ["wechat/native/arm64/MemmyWeChatPermissionProbe.dylib", "inert precompiled probe fixture"],
    ["wechat/native/arm64/MemmyWeChatPrivateStorage.dylib", "inert precompiled bridge fixture"],
    ["../wechat_identity.py", "# Shared identity fixture"],
    ...["human-recorder", "app-icon"].flatMap((name) => [
      [`${name}.swift`, "// Source must never be compiled by the packaged application"],
      [`native/${process.arch}/${name}`, "#!/bin/sh\nprintf 'native-helper-ok'\n"],
    ]),
  ];
  for (const [relative, contents] of files) {
    const file = join(source, prefix, relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents, { mode: 0o755 });
    expect(include(file, lstatSync(file)), relative).toBe(true);
    const target = join(staged, prefix, relative);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(file, target);
  }
  // History now imports the shared Computer Use launcher. Stage that module
  // under its real relative path so the ASAR probe catches a missing import.
  const launcherRelative = "dist/runtime/memmy-agent/dist/tools/computer-use/open-computer-use-binary.js";
  const launcherFile = join(source, launcherRelative);
  mkdirSync(dirname(launcherFile), { recursive: true });
  writeFileSync(launcherFile, "exports.managedOcuEnvironment = () => ({}); exports.resolveOpenComputerUseCommand = () => '';\n");
  expect(include(launcherFile, lstatSync(launcherFile)), launcherRelative).toBe(true);
  const stagedLauncher = join(staged, launcherRelative);
  mkdirSync(dirname(stagedLauncher), { recursive: true });
  cpSync(launcherFile, stagedLauncher);
  const archive = join(root, "app.asar");
  // Use electron-builder's actual relative-path matching and ASAR packer.
  const stagedFiles = [...files.map(([relative]) => join(staged, prefix, relative)), stagedLauncher];
  await new AsarPackager({ info: { getWorkspaceRoot: async () => root } }, {
    defaultDestination: staged,
    resourcePath: root,
    options: { smartUnpack: false },
    unpackPattern: new FileMatcher(staged, root, (value) => value, config.asarUnpack).createFilter(),
  }).pack([{ src: staged, destination: staged, files: stagedFiles,
    metadata: new Map(stagedFiles.map((file) => [file, lstatSync(file)])) }]);
  return { root, archive };
}

it.each(["electron-builder.yml", "electron-builder.unsigned.yml"])("%s puts both History executables on disk outside ASAR", async (filename) => {
  const { archive } = await packagedFixture(filename);
  for (const name of ["human-recorder", "app-icon"]) {
    const binary = join(`${archive}.unpacked`, prefix, "native", process.arch, name);
    expect(existsSync(binary)).toBe(true);
    if (process.platform !== "win32") expect(lstatSync(binary).mode & 0o111).not.toBe(0);
  }
  expect(existsSync(join(`${archive}.unpacked`, prefix, "native-helper.js"))).toBe(false);
});

it.each(["electron-builder.yml", "electron-builder.unsigned.yml"])("%s unpacks the complete WeChat reader with precompiled libraries", async (filename) => {
  const { archive } = await packagedFixture(filename);
  for (const relative of ["wechat/connect.py", "wechat/read_messages.py", "wechat/permission_helper.py",
    "wechat/permission_probe.m", "wechat/private_storage_bridge.c",
    "wechat/native/arm64/MemmyWeChatPermissionProbe.dylib", "wechat/native/arm64/MemmyWeChatPrivateStorage.dylib",
    "../wechat_identity.py"]) {
    expect(existsSync(join(`${archive}.unpacked`, prefix, relative)), relative).toBe(true);
  }
});

it.runIf(process.platform === "darwin")("Electron resolves and executes both packaged helpers with Swift unavailable", async () => {
  const { root, archive } = await packagedFixture("electron-builder.unsigned.yml");
  const probe = join(root, "probe.cjs");
  writeFileSync(probe, `
    const path = require('node:path');
    const { execFileSync } = require('node:child_process');
    const { ensureNativeHistoryHelper } = require(${JSON.stringify(join(archive, prefix, "native-helper.js"))});
    (async () => {
      for (const name of ['human-recorder', 'app-icon']) {
        const binary = await ensureNativeHistoryHelper(path.join(${JSON.stringify(join(archive, prefix))}, name + '.swift'), name);
        if (!binary.includes('app.asar.unpacked')) throw new Error('Not an unpacked path');
        console.log(execFileSync(binary, [], { encoding: 'utf8' }));
      }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `);
  const electron = repoFile("App", "shell", "desktop", "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron");
  const stdout = execFileSync(electron, [probe], {
    encoding: "utf8", timeout: 30_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", HOME: root, PATH: join(root, "no-tools") },
  });
  expect(stdout.trim().split("\n")).toEqual(["native-helper-ok", "native-helper-ok"]);
});

it.each(["electron-builder.win.yml", "electron-builder.win.unsigned.yml"])("%s unpacks the Windows 11 observer next to app.asar", async (filename) => {
  const config = parse(readFileSync(repoFile("App", "shell", "desktop", filename), "utf8"));
  const root = mkdtempSync(join(tmpdir(), "history-win-asar-"));
  roots.push(root);
  const source = join(root, "source");
  const staged = join(root, "staged");
  const relative = `${windowsPrefix}/win11-observer.ps1`;
  const script = readFileSync(repoFile("App", "memmy-agent", "src", "tools", "computer-history", "win", "win11-observer.ps1"));
  const file = join(source, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, script);
  const include = new FileMatcher(source, staged, (value) => value, config.files).createFilter();
  expect(include(file, lstatSync(file))).toBe(true);
  const stagedFile = join(staged, relative);
  mkdirSync(dirname(stagedFile), { recursive: true });
  cpSync(file, stagedFile);
  const archive = join(root, "app.asar");
  await new AsarPackager({ info: { getWorkspaceRoot: async () => root } }, {
    defaultDestination: staged,
    resourcePath: root,
    options: { smartUnpack: false },
    unpackPattern: new FileMatcher(staged, root, (value) => value, config.asarUnpack).createFilter(),
  }).pack([{ src: staged, destination: staged, files: [stagedFile],
    metadata: new Map([[stagedFile, lstatSync(stagedFile)]]) }]);
  expect(readFileSync(join(`${archive}.unpacked`, relative))).toEqual(script);
});

it.each(["electron-builder.win.yml", "electron-builder.win.unsigned.yml"])("%s includes and unpacks the x64 native History recorder and excludes arm64", async (filename) => {
  const config = parse(readFileSync(repoFile("App", "shell", "desktop", filename), "utf8"));
  const root = mkdtempSync(join(tmpdir(), "history-native-asar-")); roots.push(root);
  const source = join(root, "source"); const staged = join(root, "staged");
  const include = new FileMatcher(source, staged, (value) => value, config.files).createFilter();
  const fixtureBytes = Buffer.concat([windowsPEFixture(), Buffer.from("MemmyWindowsHistoryRuntimeV1")]);
  const relative = `${nativeWindowsPrefix}/amd64/memmy-computer-history.exe`;
  const file = join(source, relative); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, fixtureBytes);
  expect(include(file, lstatSync(file))).toBe(true);
  const foreign = join(source, nativeWindowsPrefix, "arm64", "memmy-computer-history.exe");
  mkdirSync(dirname(foreign), { recursive: true }); writeFileSync(foreign, fixtureBytes);
  expect(include(foreign, lstatSync(foreign))).toBe(false);
  const stagedFile = join(staged, relative); mkdirSync(dirname(stagedFile), { recursive: true }); cpSync(file, stagedFile);
  const archive = join(root, "app.asar");
  await new AsarPackager({ info: { getWorkspaceRoot: async () => root } }, {
    defaultDestination: staged, resourcePath: root, options: { smartUnpack: false },
    unpackPattern: new FileMatcher(staged, root, (value) => value, config.asarUnpack).createFilter(),
  }).pack([{ src: staged, destination: staged, files: [stagedFile], metadata: new Map([[stagedFile, lstatSync(stagedFile)]]) }]);
  expect(readFileSync(join(`${archive}.unpacked`, relative))).toEqual(fixtureBytes);
});

it.each(["electron-builder.yml", "electron-builder.unsigned.yml"])("%s excludes Windows History binaries from Mac packages", filename => {
  const config = parse(readFileSync(repoFile("App", "shell", "desktop", filename), "utf8"));
  const root = mkdtempSync(join(tmpdir(), "history-native-mac-")); roots.push(root);
  const source = join(root, "source");
  const include = new FileMatcher(source, join(root, "staged"), value => value, config.files).createFilter();
  for (const arch of ["amd64", "arm64"]) {
    const file = join(source, nativeWindowsPrefix, arch, "memmy-computer-history.exe");
    mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, "fixture");
    expect(include(file, lstatSync(file))).toBe(false);
  }
});

it("rejects stale source, wrong architecture and inert History executables in the release verifier", () => {
  const worker = Buffer.from("synthetic worker fixture");
  const binary = Buffer.concat([windowsPEFixture(), Buffer.from("MemmyWindowsHistoryRuntimeV1"), worker]);
  expect(verifyWindowsComputerHistoryRuntime(binary, "x64", worker)).toMatch(/^[a-f0-9]{64}$/u);
  expect(() => verifyWindowsComputerHistoryRuntime(binary, "arm64", worker)).toThrow("arm64 PE32+");
  expect(() => verifyWindowsComputerHistoryRuntime(binary, "x64", Buffer.from("changed worker"))).toThrow("current worker.ps1");
  expect(() => verifyWindowsComputerHistoryRuntime(windowsPEFixture(), "x64")).toThrow("runtime identity");
  expect(() => verifyWindowsComputerHistoryRuntime(Buffer.from("fixture"), "x64")).toThrow("not a PE executable");
});

it.runIf(existsSync(builtNativeBinary))("validates the actual source-built History binary separately from package fixtures", () => {
  const bytes = readFileSync(builtNativeBinary);
  const worker = readFileSync(repoFile("App", "native-computer-history", "apps", "OpenComputerHistoryWindows", "worker.ps1"));
  const identity = JSON.parse(readFileSync(`${builtNativeBinary}.build.json`, "utf8"));
  expect(bytes.length).toBeGreaterThan(1_000_000);
  expect(verifyWindowsComputerHistoryRuntime(bytes, "x64", worker)).toBe(identity.sha256);
  expect(identity).toMatchObject({ platform: "win32", arch: "amd64" });
});

it.each([
  ["electron-builder.yml", true],
  ["electron-builder.unsigned.yml", true],
  ["electron-builder.win.yml", false],
  ["electron-builder.win.unsigned.yml", false],
])("%s stages SQLCipher only as a macOS external resource", (filename, macOS) => {
  const config = parse(readFileSync(repoFile("App", "shell", "desktop", filename), "utf8"));
  const root = mkdtempSync(join(tmpdir(), "history-sqlcipher-package-"));
  roots.push(root);
  const source = join(root, "source");
  const staged = join(root, "staged");
  const library = join(source, "dist/native/sqlcipher/libsqlcipher.dylib");
  mkdirSync(dirname(library), { recursive: true });
  writeFileSync(library, "fixture");
  const include = new FileMatcher(source, staged, (value) => value, config.files).createFilter();
  expect(include(library, lstatSync(library))).toBe(false);
  expect((config.extraResources ?? []).some(({ from, to }) =>
    from === "dist/native/sqlcipher" && to === "native/sqlcipher"
  )).toBe(macOS);
});
