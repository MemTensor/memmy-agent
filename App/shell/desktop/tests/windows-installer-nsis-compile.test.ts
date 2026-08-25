import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const describeOnWindows = process.platform === "win32" ? describe : describe.skip;
const desktopRoot = resolve(import.meta.dirname, "..");
const electronBuilderCli = resolve(
  desktopRoot,
  "..",
  "..",
  "..",
  "node_modules",
  "electron-builder",
  "out",
  "cli",
  "cli.js"
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describeOnWindows("Windows installer NSIS compilation", () => {
  it("compiles the real installer include with electron-builder's generated NSIS macros", async () => {
    const root = await mkdtemp(join(tmpdir(), "memmy-nsis-compile-"));
    temporaryDirectories.push(root);
    const prepackagedRoot = join(root, "win-unpacked");
    const outputRoot = join(root, "out");
    const artifactPath = join(outputRoot, "Memmy-nsis-compile-check.exe");
    await mkdir(join(prepackagedRoot, "resources"), { recursive: true });
    await copyFile(
      join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe"),
      join(prepackagedRoot, "Memmy.exe")
    );

    await execFile(process.execPath, [
      electronBuilderCli,
      "--config",
      "electron-builder.win.unsigned.yml",
      "--config.extraMetadata.version=1.1.0",
      `--config.directories.output=${outputRoot}`,
      "--config.win.signAndEditExecutable=false",
      "--config.compression=store",
      "--prepackaged",
      prepackagedRoot,
      "--win",
      "nsis",
      "--x64",
      "--config.artifactName=Memmy-nsis-compile-check.exe"
    ], {
      cwd: desktopRoot,
      env: {
        ...process.env,
        CSC_IDENTITY_AUTO_DISCOVERY: "false"
      },
      timeout: 120_000,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024
    });

    expect(existsSync(artifactPath)).toBe(true);
  }, 120_000);
});
