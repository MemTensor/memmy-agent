import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createPackageWithOptions } from "@electron/asar";
import { FileMatcher } from "app-builder-lib/out/fileMatcher.js";
import { parse } from "yaml";
import { afterEach, expect, it } from "vitest";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each([
  ["electron-builder.yml", "darwin"],
  ["electron-builder.unsigned.yml", "darwin"],
  ["electron-builder.win.yml", "win32"],
  ["electron-builder.win.unsigned.yml", "win32"],
])("%s packages only Memmy's source-built Computer Use runtime", async (filename, platform) => {
  const config = parse(readFileSync(new URL(`../App/shell/desktop/${filename}`, import.meta.url), "utf8"));
  const root = mkdtempSync(join(tmpdir(), "memmy-ocu-package-"));
  roots.push(root);
  const source = join(root, "source");
  const staged = join(root, "staged");
  const archive = join(root, "app.asar");
  const prefix = "dist/runtime/memmy-agent/dist/native-computer-use/";
  const files = [
    ["Memmy Computer Use.app/Contents/Info.plist", platform === "darwin"],
    ["Memmy Computer Use.app/Contents/Resources/MemmyComputerUse.icns", platform === "darwin"],
    ["Memmy Computer Use.app/Contents/MacOS/MemmyComputerUse", platform === "darwin"],
    ["windows/amd64/memmy-computer-use.exe", platform === "win32"],
    ["windows/arm64/memmy-computer-use.exe", false],
    ["linux/amd64/memmy-computer-use", false],
  ];
  const include = new FileMatcher(source, staged, (value) => value, config.files).createFilter();
  for (const [relative, expected] of files) {
    const file = join(source, prefix, relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "fixture", { mode: 0o755 });
    expect(include(file, lstatSync(file)), relative).toBe(expected);
    if (expected) {
      const target = join(staged, prefix, relative);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(file, target);
    }
  }
  const upstream = join(source, 'dist/runtime/memmy-agent/node_modules/open-computer-use/dist/windows/amd64/open-computer-use.exe');
  mkdirSync(dirname(upstream), { recursive: true }); writeFileSync(upstream, 'upstream');
  expect(include(upstream, lstatSync(upstream))).toBe(false);
  const unpack = config.asarUnpack.find((pattern) => pattern.includes("native-computer-use"));
  expect(unpack).toBeTruthy();
  await createPackageWithOptions(staged, archive, { unpack });
  for (const [relative, expected] of files) {
    expect(existsSync(join(`${archive}.unpacked`, prefix, relative)), relative).toBe(expected);
  }
});

it.each(['electron-builder.yml', 'electron-builder.unsigned.yml'])('%s preserves only Memmy Computer Use signature', filename => {
  const config = parse(readFileSync(new URL(`../App/shell/desktop/${filename}`, import.meta.url), 'utf8'));
  const ignored = file => config.mac.signIgnore.some(pattern => new RegExp(pattern).test(file));
  const app = '/Applications/Memmy.app/Contents/Resources/app.asar.unpacked/dist/runtime/memmy-agent/dist/native-computer-use/Memmy Computer Use.app';
  expect(ignored(app)).toBe(true);
  expect(ignored(`${app}/Contents/MacOS/MemmyComputerUse`)).toBe(true);
  expect(ignored('/Applications/Memmy.app/Contents/MacOS/Memmy')).toBe(false);
  expect(ignored(`${app}-other/Contents/MacOS/helper`)).toBe(false);
});
