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
])("%s packages only the target OCU runtime and unpacks its native files", async (filename, platform) => {
  const config = parse(readFileSync(new URL(`../App/shell/desktop/${filename}`, import.meta.url), "utf8"));
  const root = mkdtempSync(join(tmpdir(), "memmy-ocu-package-"));
  roots.push(root);
  const source = join(root, "source");
  const staged = join(root, "staged");
  const archive = join(root, "app.asar");
  const prefix = "dist/runtime/memmy-agent/node_modules/open-computer-use/";
  const files = [
    ["package.json", true],
    ["LICENSE", true],
    ["dist/Open Computer Use.app/Contents/Info.plist", platform === "darwin"],
    ["dist/Open Computer Use.app/Contents/Resources/AppIcon.icns", platform === "darwin"],
    ["dist/Open Computer Use.app/Contents/MacOS/OpenComputerUse", platform === "darwin"],
    ["dist/windows/amd64/open-computer-use.exe", platform === "win32"],
    ["dist/windows/arm64/open-computer-use.exe", false],
    ["dist/linux/amd64/open-computer-use", false],
    ["dist/linux/arm64/open-computer-use", false],
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
  const unpack = config.asarUnpack.find((pattern) => pattern.includes("open-computer-use"));
  expect(unpack).toBeTruthy();
  await createPackageWithOptions(staged, archive, { unpack });
  for (const [relative, expected] of files.filter(([relative]) => relative.startsWith("dist/"))) {
    expect(existsSync(join(`${archive}.unpacked`, prefix, relative)), relative).toBe(expected);
  }
});
