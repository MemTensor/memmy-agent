import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);

describe.runIf(process.platform === "win32")("native Store legacy shutdown convergence", () => {
  let root: string;
  let fixture: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "memmy-native-stop-"));
    fixture = join(root, "stop-test.exe");
    const script = join(root, "compile.ps1");
    await writeFile(script, `
$ErrorActionPreference = 'Stop'
$locator = Join-Path ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) 'Microsoft Visual Studio\\Installer\\vswhere.exe'
$installation = & $locator -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$installation) { throw 'MSVC is required to run the native unit fixture' }
$vcVars = Join-Path $installation 'VC\\Auxiliary\\Build\\vcvars64.bat'
$compilerEnvironment = & $env:ComSpec /d /s /c ('"' + $vcVars + '" >nul && set')
if ($LASTEXITCODE -ne 0) { throw 'vcvars64 failed' }
foreach ($line in $compilerEnvironment) {
  $separator = $line.IndexOf('=')
  if ($separator -gt 0) { [Environment]::SetEnvironmentVariable($line.Substring(0, $separator), $line.Substring($separator + 1), 'Process') }
}
& cl.exe /nologo /std:c++20 /EHsc /MT ('/I' + $env:MEMMY_STOP_TEST_INCLUDE) $env:MEMMY_STOP_TEST_SOURCE ('/Fe:' + $env:MEMMY_STOP_TEST_EXE) ('/Fo:' + (Join-Path $PSScriptRoot 'fixture.obj'))
if ($LASTEXITCODE -ne 0) { throw 'native fixture compilation failed' }
`);
    await execFile(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
        windowsHide: true, timeout: 30_000,
        env: { ...process.env,
          MEMMY_STOP_TEST_INCLUDE: resolve(import.meta.dirname, "../native/windows-store-update"),
          MEMMY_STOP_TEST_SOURCE: resolve(import.meta.dirname, "fixtures/windows-store-process-stop.cpp"),
          MEMMY_STOP_TEST_EXE: fixture
        }
      });
  }, 35_000);
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it.each(["inspection-race", "termination-race", "child-restarts", "access-denied", "permanent-worker"])(
    "handles %s using fresh scans within one deadline", async (scenario) => {
      const result = await execFile(fixture, [scenario], { windowsHide: true, timeout: 5_000 });
      expect(result.stdout).toContain("elapsed=");
    }
  );
});
