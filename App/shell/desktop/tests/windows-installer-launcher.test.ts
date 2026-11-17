import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const installer = readFileSync(new URL("../build/installer-win-unsigned.nsh", import.meta.url), "utf8");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Exercise the script the installer actually writes, without building or running
// an installer. Expand NSIS strings once so path data never becomes script code.
function installedFile(name: string, installDir: string, launcherDir: string): Buffer {
  const marker = `FileOpen $1 "$0\\${name}" w`;
  const offset = installer.indexOf(marker);
  if (offset < 0) throw new Error(`Missing generated installer file: ${name}`);
  const body = installer.slice(offset + marker.length).split("FileClose $1", 1)[0]!;
  const variables: Record<string, string> = {
    "$": "$", INSTDIR: installDir, "0": launcherDir, "{PRODUCT_FILENAME}": "Memmy",
    "\\r": "\r", "\\n": "\n", "\\t": "\t", '\\"': '"',
  };
  const chunks: Buffer[] = [];
  for (const line of body.split("\n")) {
    const byte = /^\s*FileWriteByte \$1 "(\d+)"\s*$/.exec(line);
    if (byte) chunks.push(Buffer.from([Number(byte[1])]));
    const text = /^\s*FileWriteUTF16LE \$1 "(.*)"\s*$/.exec(line);
    if (text) chunks.push(Buffer.from(text[1]!.replace(/\$(\$|INSTDIR|0|\{PRODUCT_FILENAME\}|\\[rnt"])/g,
      (_match, key: string) => variables[key]!), "utf16le"));
  }
  return Buffer.concat(chunks);
}

describe.runIf(process.platform === "win32")("installed PowerShell launch proxy", () => {
  it.each(["中文 Path", "中文 $USERNAME `tick O'Brien"])(
    "preserves literal installation and launcher paths containing %s",
    (pathPart) => {
      const root = mkdtempSync(join(tmpdir(), "memmy-installer-launcher-"));
      roots.push(root);
      const installDir = join(root, pathPart, "Program Files", "Memmy");
      const launcherDir = join(root, pathPart, "Local AppData", "Memmy", "launcher");
      mkdirSync(installDir, { recursive: true });
      mkdirSync(launcherDir, { recursive: true });
      writeFileSync(join(installDir, "Memmy.exe"), "fixture: not executed");
      writeFileSync(join(launcherDir, "MemmyLauncher.path"), installedFile("MemmyLauncher.path", installDir, launcherDir));

      // Capture the final launch boundary; never start an app or touch real data.
      const capture = `function Start-Process {
  param([string]$FilePath, [string]$WorkingDirectory)
  @{ appExe = $FilePath; workingDirectory = $WorkingDirectory;
     promptPath = $script:promptPath; recoveryPath = $script:recoveryPath;
     migrationRecoveryPath = $script:migrationRecoveryPath;
     legacyUserDataRoot = $script:legacyUserDataRoot } |
    ConvertTo-Json -Compress | Set-Content -LiteralPath $env:MEMMY_INSTALLER_LAUNCH_RESULT -Encoding UTF8
}\r\n`;
      const generated = installedFile("MemmyLauncher.ps1", installDir, launcherDir).toString("utf16le").replace(/^\uFEFF/, "");
      const scriptPath = join(launcherDir, "MemmyLauncher.ps1");
      writeFileSync(scriptPath, Buffer.from("\uFEFF" + capture + generated, "utf16le"));
      const resultPath = join(root, "launch-result.json");
      const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const result = spawnSync(powershell,
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
          encoding: "utf8", windowsHide: true, timeout: 30_000,
          env: { ...process.env, APPDATA: join(root, "Roaming"), LOCALAPPDATA: join(root, "Local"),
            MEMMY_INSTALLER_LAUNCH_RESULT: resultPath },
        });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr || result.stdout).toBe(0);
      const launched = JSON.parse(readFileSync(resultPath, "utf8").replace(/^\uFEFF/, ""));
      expect(launched).toEqual({
        appExe: join(installDir, "Memmy.exe"), workingDirectory: installDir,
        promptPath: join(launcherDir, "MemmyUpdatePrompt.ps1"),
        recoveryPath: join(launcherDir, "MemmyWindowsUpgradeRecovery.ps1"),
        migrationRecoveryPath: join(launcherDir, "MemmyWindowsDataMigration.ps1"),
        legacyUserDataRoot: join(installDir, "data", "Memmy"),
      });
    }, 60_000,
  );
});
