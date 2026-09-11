import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createWindowsUpdateLauncherFile } from "../src/main/windows-update-launcher.js";

describe("Windows update launcher", () => {
  it("encodes the VBS launcher as UTF-16LE with BOM without losing Chinese paths or arguments", () => {
    const helperPath = "D:\\测试路径\\Memmy\\data\\Memmy\\updates\\install-win-update.ps1";
    const installerPath = "D:\\测试路径\\Memmy\\data\\Memmy\\updates\\Memmy-1.1.0.exe";
    const appPath = "D:\\测试路径\\Memmy\\Memmy.exe";
    const logPath = "D:\\测试路径\\Memmy\\data\\Memmy\\updates\\win-update-install.log";
    const markerPath = "D:\\测试路径\\Memmy\\data\\Memmy\\prepared-required-update.json";
    const command = [
      "powershell.exe",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-File",
      helperPath,
      installerPath,
      appPath,
      logPath,
      "4242",
      "1",
      markerPath,
      "1.1.0"
    ];

    const launcherFile = createWindowsUpdateLauncherFile(command);

    expect([...launcherFile.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    const decoded = launcherFile.toString("utf16le");
    expect(decoded.startsWith("\uFEFF")).toBe(true);
    expect(decoded).toContain('Set shell = CreateObject("WScript.Shell")');
    expect(decoded).toContain('shell.Run """powershell.exe""');
    expect(decoded).toContain(', 0, False');
    expect(decoded).toContain('Set fso = CreateObject("Scripting.FileSystemObject")');
    expect(decoded).toContain("fso.DeleteFile WScript.ScriptFullName, True");
    for (const argument of command) {
      expect(decoded).toContain(argument);
    }
  });

  it.runIf(process.platform === "win32")(
    "launches a PowerShell helper from a Chinese path through cscript",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "memmy-vbs-launcher-"));
      const chineseRoot = join(root, "中文路径");
      const helperPath = join(chineseRoot, "probe.ps1");
      const markerPath = join(chineseRoot, "marker.txt");
      const launcherPath = join(root, "launcher.vbs");
      try {
        await mkdir(chineseRoot, { recursive: true });
        await writeFile(
          helperPath,
          'param([string]$Marker)\n[System.IO.File]::WriteAllBytes($Marker, [System.Text.Encoding]::UTF8.GetBytes($PSCommandPath))\n',
          "utf8"
        );
        await writeFile(launcherPath, createWindowsUpdateLauncherFile([
          "powershell.exe",
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-WindowStyle",
          "Hidden",
          "-File",
          helperPath,
          markerPath
        ]));

        const cscriptPath = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cscript.exe");
        const result = spawnSync(cscriptPath, ["//B", "//Nologo", launcherPath], { encoding: "utf8" });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);

        let markerContent: string | undefined;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          markerContent = await readFile(markerPath, "utf8").catch(() => undefined);
          if (markerContent) break;
          await delay(50);
        }
        expect(markerContent).toBe(helperPath);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );
});
