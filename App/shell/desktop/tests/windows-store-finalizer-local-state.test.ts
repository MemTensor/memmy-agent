import { execFile as execFileCallback } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);

describe.runIf(process.platform === "win32")(
  "native Store finalizer profile path validation",
  () => {
    let fixtureRoot: string;
    let fixtureExecutable: string;

    beforeAll(async () => {
      fixtureRoot = await mkdtemp(
        join(tmpdir(), "memmy-finalizer-local-state-"),
      );
      fixtureExecutable = join(fixtureRoot, "finalizer-local-state-test.exe");
      const compileScript = join(fixtureRoot, "compile.ps1");
      await writeFile(
        compileScript,
        `
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
& cl.exe /nologo /std:c++20 /EHsc /MT /DUNICODE /D_UNICODE /utf-8 ('/I' + $env:MEMMY_FINALIZER_TEST_INCLUDE) $env:MEMMY_FINALIZER_TEST_SOURCE ('/Fe:' + $env:MEMMY_FINALIZER_TEST_EXE) ('/Fo:' + (Join-Path $PSScriptRoot 'fixture.obj')) /link windowsapp.lib advapi32.lib ole32.lib oleaut32.lib shell32.lib user32.lib
if ($LASTEXITCODE -ne 0) { throw 'native finalizer path fixture compilation failed' }
`,
      );
      await execFile(
        join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", compileScript],
        {
          windowsHide: true,
          timeout: 45_000,
          env: {
            ...process.env,
            MEMMY_FINALIZER_TEST_INCLUDE: resolve(
              import.meta.dirname,
              "../native/windows-store-update",
            ),
            MEMMY_FINALIZER_TEST_SOURCE: resolve(
              import.meta.dirname,
              "fixtures/windows-store-finalizer-local-state.cpp",
            ),
            MEMMY_FINALIZER_TEST_EXE: fixtureExecutable,
          },
        },
      );
    }, 50_000);

    afterAll(async () => {
      if (fixtureRoot) {
        await rm(fixtureRoot, { recursive: true, force: true });
      }
    });

    it("follows only the profile root junction and rejects child junction and encrypted attributes without writing the target", async () => {
      const physicalProfile = join(fixtureRoot, "physical-profile");
      const profileAlias = join(fixtureRoot, "profile-alias");
      const childTarget = join(fixtureRoot, "child-target");
      const childAlias = join(physicalProfile, ".memmy");
      const sentinelPath = join(childTarget, "sentinel.txt");
      const sentinelContents = "must-remain-unchanged";

      await mkdir(physicalProfile);
      await mkdir(childTarget);
      await writeFile(sentinelPath, sentinelContents);
      await symlink(physicalProfile, profileAlias, "junction");
      await symlink(childTarget, childAlias, "junction");

      expect((await lstat(profileAlias)).isSymbolicLink()).toBe(true);
      expect((await lstat(childAlias)).isSymbolicLink()).toBe(true);
      const entriesBefore = await readdir(childTarget);

      const result = await execFile(
        fixtureExecutable,
        [profileAlias, physicalProfile, childAlias],
        { windowsHide: true, timeout: 5_000 },
      );

      expect(result.stdout).toContain(
        "profile-root-junction-resolved profile-path-bound child-junction-rejected encrypted-directory-rejected hresult=0x80070005",
      );
      expect(await readdir(childTarget)).toEqual(entriesBefore);
      expect(await readFile(sentinelPath, "utf8")).toBe(sentinelContents);
    });

    it("binds staging and both handoff processes to FOLDERID_Profile while keeping direct CREATE_NEW streaming", async () => {
      const nativeSource = await readFile(
        resolve(
          import.meta.dirname,
          "../native/windows-store-update/MemmyStoreUpdate.cpp",
        ),
        "utf8",
      );

      expect(nativeSource).toContain("FOLDERID_Profile");
      expect(nativeSource).toContain('L".memmy"');
      expect(nativeSource).toContain(
        "FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_ENCRYPTED",
      );
      expect(nativeSource).toContain("CREATE_NEW");
      expect(nativeSource).toContain("ReadFile(");
      expect(nativeSource).toContain("WriteFile(");
      expect(nativeSource).toContain("FlushFileBuffers(");
      expect(nativeSource).toContain("sha256_file_hex(");
      expect(nativeSource).toContain(
        "resolve_store_finalizer_attempt_directory(\n" +
          "                    resolved_profile_root,",
      );
      const handoffEntry = nativeSource.slice(
        nativeSource.lastIndexOf("if (command == Command::HandoffInstall)"),
        nativeSource.lastIndexOf(
          "if (command == Command::LaunchStoreUpdateFinalizer)",
        ),
      );
      const launcherEntry = nativeSource.slice(
        nativeSource.lastIndexOf(
          "if (command == Command::LaunchStoreUpdateFinalizer)",
        ),
        nativeSource.lastIndexOf(
          "if (command == Command::FinalizeStoreUpdate)",
        ),
      );
      const finalizerEntry = nativeSource.slice(
        nativeSource.lastIndexOf(
          "if (command == Command::FinalizeStoreUpdate)",
        ),
        nativeSource.lastIndexOf("if (has_handoff_options(options))"),
      );
      expect(handoffEntry).toContain(
        "validate_store_install_handoff_options(options, true)",
      );
      expect(launcherEntry).toContain(
        "validate_store_install_handoff_options(options, true)",
      );
      expect(finalizerEntry).toContain(
        "validate_store_install_handoff_options(options, true)",
      );
      expect(nativeSource).not.toContain(
        "ApplicationData::Current().LocalFolder()",
      );
      expect(nativeSource).not.toContain("ensure_decrypted_store_finalizer");
      expect(nativeSource).not.toContain(
        "DecryptFileW could not remove inherited EFS from the staged Store finalizer",
      );
    });
  },
);
