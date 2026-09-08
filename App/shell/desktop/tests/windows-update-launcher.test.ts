import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createWindowsUpdateLauncherFile } from "../src/main/windows-update-launcher.js";

const decodePowerShellEncodedCommand = (script: string): string => {
  const match = script.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/u);
  if (!match) {
    throw new Error("EncodedCommand payload not found in launcher script");
  }
  return Buffer.from(match[1], "base64").toString("utf16le");
};

describe("Windows update launcher", () => {
  it("emits a CMD launcher that hands off to PowerShell without Windows Script Host", () => {
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
    const script = launcherFile.toString("utf8");

    expect(script).not.toMatch(/\.vbs\b/u);
    expect(script).not.toContain("WScript");
    expect(script).not.toContain("wscript.exe");
    expect(script.startsWith("@echo off")).toBe(true);
    expect(script).toContain('WindowsPowerShell\\v1.0\\powershell.exe');
    expect(script).toContain("-NoProfile");
    expect(script).toContain("-ExecutionPolicy Bypass");
    expect(script).toContain("-WindowStyle Hidden");
    expect(script).toContain("-EncodedCommand");
    expect(script).toContain('(goto) 2>nul & del "%~f0"');

    const decoded = decodePowerShellEncodedCommand(script);
    expect(decoded).toContain("Start-Process");
    expect(decoded).toContain("-FilePath 'powershell.exe'");
    expect(decoded).toContain("-WindowStyle Hidden");
    // -ArgumentList must be an explicit PowerShell array literal so Start-Process
    // unpacks each element as a separate argument, not one concatenated string.
    expect(decoded).toMatch(/-ArgumentList @\('/u);
    for (const argument of command.slice(1)) {
      expect(decoded).toContain(argument);
    }
  });

  it.runIf(process.platform === "win32")(
    "launches a PowerShell helper from a Chinese path without depending on VBScript",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "memmy-cmd-launcher-"));
      const chineseRoot = join(root, "中文路径");
      const helperPath = join(chineseRoot, "probe.ps1");
      const markerPath = join(chineseRoot, "marker.txt");
      const launcherPath = join(root, "launcher.cmd");
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

        const cmdPath = process.env.ComSpec ?? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
        const result = spawnSync(cmdPath, ["/D", "/C", launcherPath], { encoding: "utf8" });
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
