import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);

describe.runIf(process.platform === "win32")("native Store install shutdown", () => {
  let root: string;
  let fixture: string;
  let failureFixture: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "memmy-store-install-shutdown-"));
    fixture = join(root, "shutdown-test.exe");
    failureFixture = join(root, "shutdown-failure-test.exe");
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
& cl.exe /nologo /std:c++20 /EHsc /MT ('/I' + $env:MEMMY_SHUTDOWN_TEST_INCLUDE) $env:MEMMY_SHUTDOWN_TEST_SOURCE ('/Fe:' + $env:MEMMY_SHUTDOWN_TEST_EXE) ('/Fo:' + (Join-Path $PSScriptRoot 'fixture.obj')) /link user32.lib
if ($LASTEXITCODE -ne 0) { throw 'native fixture compilation failed' }
& cl.exe /nologo /std:c++20 /EHsc /MT /DUNICODE /D_UNICODE /utf-8 ('/I' + $env:MEMMY_SHUTDOWN_TEST_INCLUDE) $env:MEMMY_SHUTDOWN_FAILURE_SOURCE ('/Fe:' + $env:MEMMY_SHUTDOWN_FAILURE_EXE) ('/Fo:' + (Join-Path $PSScriptRoot 'failure.obj')) /link windowsapp.lib advapi32.lib ole32.lib oleaut32.lib shell32.lib user32.lib
if ($LASTEXITCODE -ne 0) { throw 'native failure fixture compilation failed' }
`);
    await execFile(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
        windowsHide: true, timeout: 45_000,
        env: { ...process.env,
          MEMMY_SHUTDOWN_TEST_INCLUDE: resolve(import.meta.dirname, "../native/windows-store-update"),
          MEMMY_SHUTDOWN_TEST_SOURCE: resolve(import.meta.dirname, "fixtures/windows-store-install-shutdown.cpp"),
          MEMMY_SHUTDOWN_TEST_EXE: fixture,
          MEMMY_SHUTDOWN_FAILURE_SOURCE: resolve(import.meta.dirname, "fixtures/windows-store-shutdown-failure.cpp"),
          MEMMY_SHUTDOWN_FAILURE_EXE: failureFixture
        }
      });
  }, 50_000);
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it.each(["manual", "silent"])("waits for the old process before publishing %s watchdog failure", async (mode) => {
    const directory = await mkdtemp(join(root, "failure-"));
    const result = await execFile(failureFixture, [mode, directory], { windowsHide: true, timeout: 5_000 });
    expect(result.stdout).toContain(`recovery-after-old-exit mode=${mode}`);
    expect(Number(/elapsed=(\d+)/u.exec(result.stdout)?.[1])).toBeGreaterThanOrEqual(500);
  });

  it.each(["query-only", "cancelled-shutdown", "before-deployment", "operation-finished", "all-notifications-lost-operation-finished"])(
    "does not release the installer for %s", async (scenario) => {
      const result = await execFile(fixture, [scenario], { windowsHide: true, timeout: 5_000 });
      expect(result.stdout).toContain(`survived=${scenario}`);
      expect(result.stdout).not.toContain("exit=");
    }
  );
  it.each([
    ["end-session", "wm-endsession"], ["close", "wm-close"],
    ["missing-notification", "deployment-timeout"], ["blocked-message-loop", "deployment-timeout"],
    ["window-creation-failed", "deployment-timeout"], ["deadline-not-reset", "deployment-timeout"],
    ["logging-failed", "deployment-timeout"], ["logging-blocked", "deployment-timeout"],
    ["all-notifications-lost", "operation-timeout"],
    ["all-notifications-lost-blocked-sta", "operation-timeout"],
    ["all-notifications-lost-window-creation-failed", "operation-timeout"],
    ["all-notifications-lost-logging-blocked", "operation-timeout"],
    ["deployment-after-total-deadline", "operation-timeout"]
  ])("releases the actual helper process for %s", async (scenario, reason) => {
    const started = performance.now();
    const result = await execFile(fixture, [scenario], { windowsHide: true, timeout: 3_000 });
    expect(performance.now() - started).toBeLessThan(1500);
    expect(result.stdout).toContain(`exit=${reason}`);
    const elapsed = Number(/elapsed=(\d+)/u.exec(result.stdout)?.[1]);
    expect(elapsed).toBeLessThan(1500);
    if (reason.endsWith("-timeout")) expect(elapsed).toBeGreaterThanOrEqual(250);
  });
  it("enforces the production five-second deployment fallback", async () => {
    const result = await execFile(fixture, ["default-timeout"], { windowsHide: true, timeout: 8_000 });
    expect(result.stdout).toContain("exit=deployment-timeout");
    const elapsed = Number(/elapsed=(\d+)/u.exec(result.stdout)?.[1]);
    expect(elapsed).toBeGreaterThanOrEqual(5000);
    expect(elapsed).toBeLessThan(6500);
  }, 10_000);
});

it("limits the release watchdog to handoff-install and retains independent finalization", async () => {
  const source = await readFile(resolve(import.meta.dirname, "../native/windows-store-update/MemmyStoreUpdate.cpp"), "utf8");
  const entry = source.slice(source.indexOf("if (command == Command::HandoffInstall)"), source.indexOf("if (command == Command::LaunchStoreUpdateFinalizer)"));
  expect(entry).toContain("std::make_shared<memmy::StoreInstallShutdown>");
  expect(entry.indexOf("launch_store_update_finalizer_breakaway(options)")).toBeLessThan(entry.indexOf("std::make_shared<memmy::StoreInstallShutdown>"));
  expect(source.match(/std::make_shared<memmy::StoreInstallShutdown>/gu)).toHaveLength(1);
  const operation = source.slice(source.indexOf("fire_and_forget execute_store_install_handoff("), source.indexOf("Command parse_command("));
  expect(operation).toContain("StorePackageUpdateState::Deploying");
  expect(operation).toContain("status.PackageFamilyName == package_family");
  expect(operation).toContain("shutdown->deployment_started()");
  // Keep the independent timer active through result/log writes as well as the
  // Store await: a blocked completion callback must not strand this process.
  expect(operation).not.toContain("shutdown->finish()");
  const guardedEntry = entry.slice(entry.indexOf("std::make_shared<memmy::StoreInstallShutdown>"));
  expect(guardedEntry).toContain("wait_for_old_application_exit(options)");
  expect(guardedEntry).toMatch(/report_store_install_shutdown_unavailable\(options, error.what\(\)\);\s*return 2;[\s\S]*?execute_store_install_handoff/u);
  const finalizer = source.slice(source.indexOf("int finalize_store_update("), source.indexOf("IVector<StorePackageUpdate> copy_updates("));
  expect(finalizer.match(/if \(options.mode == L"manual"\)/gu)).toHaveLength(2);
  expect(source).toContain("installed_package_replaced_baseline(options)");
  expect(source).toContain("activate_store_application_with_retry(options, \"completed\")");
  expect(source).toContain("std::chrono::minutes(15)");
});
