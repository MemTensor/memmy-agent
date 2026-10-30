import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const prefix = "dist/runtime/memmy-agent/dist/tools/computer-history/win";
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture(configName, realBinary) {
  const config = parse(readFileSync(new URL(`../App/shell/desktop/${configName}`, import.meta.url), "utf8"));
  const root = mkdtempSync(join(tmpdir(), "history-win-asar-"));
  roots.push(root);
  const staged = join(root, "staged");
  const source = new URL("../App/memmy-agent/src/tools/computer-history/win/native-helper.ts", import.meta.url);
  const files = [
    ["native-helper.cjs", ts.transpileModule(readFileSync(source, "utf8"), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    } }).outputText],
    ["memmy-history-recorder.exe", realBinary ? readFileSync(realBinary) : "layout fixture"],
    ["memmy-history-recorder.NOTICES.md", "MIT license fixture"],
  ].map(([name, contents]) => {
    const file = join(staged, prefix, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
    expect(new FileMatcher(staged, root, (value) => value, config.files).createFilter()(file, lstatSync(file))).toBe(true);
    return file;
  });
  await new AsarPackager({ info: { getWorkspaceRoot: async () => root } }, {
    defaultDestination: staged, resourcePath: root, options: { smartUnpack: false },
    unpackPattern: new FileMatcher(staged, root, (value) => value, config.asarUnpack).createFilter(),
  }).pack([{ src: staged, destination: staged, files, metadata: new Map(files.map((file) => [file, lstatSync(file)])) }]);
  return { root, archive: join(root, "app.asar") };
}
it.each(["electron-builder.win.yml", "electron-builder.win.unsigned.yml"])("%s explicitly unpacks the Windows History executable", async (config) => {
  const { archive } = await fixture(config);
  expect(existsSync(join(`${archive}.unpacked`, prefix, "memmy-history-recorder.exe"))).toBe(true);
  expect(existsSync(join(`${archive}.unpacked`, prefix, "native-helper.cjs"))).toBe(true);
});
const nativeDir = process.env.MEMMY_WINDOWS_HISTORY_TEST_BIN_DIR;
it.runIf(process.platform === "win32" && !!nativeDir)("Electron executes the packaged production EXE without development overrides or compiler PATH", async () => {
  const original = join(nativeDir, "memmy-history-recorder.exe");
  const { root, archive } = await fixture("electron-builder.win.unsigned.yml", original);
  const probe = join(root, "probe.cjs");
  writeFileSync(probe, `
    const { pathToFileURL } = require('node:url');
    const { execFileSync } = require('node:child_process');
    const helperPath = ${JSON.stringify(join(archive, prefix, "native-helper.cjs"))};
    const { resolveNativeCollector } = require(helperPath);
    const binary = resolveNativeCollector(pathToFileURL(helperPath).href, 'C:/missing-explicit.exe');
    if (!binary.includes('app.asar.unpacked')) throw new Error('Not unpacked');
    console.log(execFileSync(binary, ['version'], { encoding: 'utf8', windowsHide: true }));
  `);
  const electron = fileURLToPath(new URL("../App/shell/desktop/node_modules/electron/dist/electron.exe", import.meta.url));
  const stdout = execFileSync(electron, [probe], { encoding: "utf8", timeout: 30_000, windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", MEMMY_WINDOWS_HISTORY_BINARY: "C:/missing-environment.exe", PATH: join(root, "no-tools") } });
  expect(stdout.trim()).toBe("memmy-history-recorder 0.1.0 protocol 1");
  expect(readFileSync(join(`${archive}.unpacked`, prefix, "memmy-history-recorder.exe"))).toEqual(readFileSync(original));
});
