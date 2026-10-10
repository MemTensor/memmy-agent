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

const roots = [];
const prefix = "dist/runtime/memmy-agent/dist/tools/computer-history/mac";
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function packagedFixture(filename) {
  const config = parse(readFileSync(new URL(`../App/shell/desktop/${filename}`, import.meta.url), "utf8"));
  const root = mkdtempSync(join(tmpdir(), "history-asar-"));
  roots.push(root);
  const source = join(root, "source");
  const staged = join(root, "staged");
  const include = new FileMatcher(source, staged, (value) => value, config.files).createFilter();
  const files = [
    ["native-helper.js", ts.transpileModule(readFileSync(new URL(
      `../App/memmy-agent/src/tools/computer-history/mac/native-helper.ts`, import.meta.url,
    ), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText],
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
  const archive = join(root, "app.asar");
  // Use electron-builder's actual relative-path matching and ASAR packer.
  const stagedFiles = files.map(([relative]) => join(staged, prefix, relative));
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
  const electron = fileURLToPath(new URL("../App/shell/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron", import.meta.url));
  const stdout = execFileSync(electron, [probe], {
    encoding: "utf8", timeout: 30_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", HOME: root, PATH: join(root, "no-tools") },
  });
  expect(stdout.trim().split("\n")).toEqual(["native-helper-ok", "native-helper-ok"]);
});
