import { execFile as execFileCallback } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const execFile = promisify(execFileCallback);
const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

const generatedInstallerScript = async (): Promise<string> => {
  const source = (await readFile(new URL("../src/main/main.ts", import.meta.url), "utf8")).replace(/\r\n/gu, "\n");
  const start = source.indexOf("function createWindowsUpdateInstallScript(): string {");
  const end = source.indexOf("\n`;\n}", start) + "\n`;\n}".length;
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const factory = source.slice(start, end).replace("(): string", "()");
  return new Function("WINDOWS_UPDATE_INSTALL_PROCESS_POLL_MS", "Buffer",
    `${factory}; return createWindowsUpdateInstallScript();`)(250, Buffer) as string;
};

describe.runIf(process.platform === "win32")("Windows update installer wait", () => {
  it.each([0, 7, 1460])("returns installer exit or timeout %i while its background child is still running", async (exitCode) => {
    const root = await mkdtemp(join(tmpdir(), "memmy-installer-wait-"));
    const stubPath = join(root, "installer.ps1");
    const childPath = join(root, "resident-child.ps1");
    const pidPath = join(root, "child.pid");
    const runnerPath = join(root, "runner.ps1");
    const env = {
      ...process.env,
      MEMMY_WAIT_TEST_ROOT: root,
      MEMMY_WAIT_TEST_EXIT_CODE: String(exitCode),
      MEMMY_WAIT_TEST_TIMEOUT: exitCode === 1460 ? "1" : "0"
    };
    try {
      const mainSource = await readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
      const waitBlock = mainSource.match(/    \$installerProcess = Start-Process -FilePath \$Installer -ArgumentList \$arguments[^]*?(?=\r?\n\r?\n)/u)?.[0];
      expect(waitBlock).toBeDefined();
      await writeFile(childPath, "Start-Sleep -Seconds 60\n");
      await writeFile(stubPath, `
[System.IO.File]::WriteAllText((Join-Path $env:MEMMY_WAIT_TEST_ROOT 'installer.pid'), [string]$PID)
$childScript = Join-Path $env:MEMMY_WAIT_TEST_ROOT 'resident-child.ps1'
$child = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $childScript + '"')) -WindowStyle Hidden -RedirectStandardOutput (Join-Path $env:MEMMY_WAIT_TEST_ROOT 'child.stdout.log') -RedirectStandardError (Join-Path $env:MEMMY_WAIT_TEST_ROOT 'child.stderr.log') -PassThru
[System.IO.File]::WriteAllText((Join-Path $env:MEMMY_WAIT_TEST_ROOT 'child.pid'), [string]$child.Id)
if ($env:MEMMY_WAIT_TEST_TIMEOUT -eq '1') { Start-Sleep -Seconds 60 }
exit ([int]$env:MEMMY_WAIT_TEST_EXIT_CODE)
`);
      await writeFile(runnerPath, `
$ErrorActionPreference = 'Stop'
$Installer = Join-Path $PSHOME 'powershell.exe'
$installerWaitTimeoutMs = if ($env:MEMMY_WAIT_TEST_TIMEOUT -eq '1') { 2000 } else { 8000 }
$installTimedOut = $false
function Write-MemmyUpdateLog([string]$Message) {}
function Write-MemmyInstallerLockState {}
$stub = Join-Path $env:MEMMY_WAIT_TEST_ROOT 'installer.ps1'
$arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $stub + '"'))
${waitBlock}
$childId = [int][System.IO.File]::ReadAllText((Join-Path $env:MEMMY_WAIT_TEST_ROOT 'child.pid'))
@{ installExit = $installExit; timedOut = $installTimedOut; installerRunning = -not $installerProcess.HasExited; childRunning = [bool](Get-Process -Id $childId -ErrorAction SilentlyContinue) } | ConvertTo-Json -Compress
`);
      const result = await execFile(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", runnerPath], {
        env, windowsHide: true, timeout: 12_000
      });
      expect(JSON.parse(result.stdout.trim())).toEqual({
        installExit: exitCode, timedOut: exitCode === 1460,
        installerRunning: exitCode === 1460, childRunning: true
      });
    } finally {
      for (const [fixturePidPath, scriptName] of [[pidPath, "resident-child.ps1"], [join(root, "installer.pid"), "installer.ps1"]]) {
        const childPid = await readFile(fixturePidPath, "utf8").catch(() => "");
        if (/^\d+$/u.test(childPid)) {
          // Stop only this fixture's descendant, including after the old tree wait times out.
          await execFile(powershell, ["-NoProfile", "-Command", `
$child = Get-CimInstance Win32_Process -Filter 'ProcessId=${childPid}'
$expected = Join-Path $env:MEMMY_WAIT_TEST_ROOT '${scriptName}'
if ($child -and $child.Name -eq 'powershell.exe' -and $child.CommandLine.Contains($expected)) { Stop-Process -Id $child.ProcessId -Force }
`], { env, windowsHide: true, timeout: 5_000 });
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 25_000);

  it.each([false, true])("runs the full generated helper without removing another installer's lock: existing = %s", async (existingLock) => {
    const root = await mkdtemp(join(tmpdir(), "memmy-update-lock-"));
    const markerPath = join(root, "prepared-required-update.json");
    const lockPath = `${markerPath}.lock`;
    const helperPath = join(root, "helper.ps1");
    const logPath = join(root, "install.log");
    try {
      const script = await generatedInstallerScript();
      await writeFile(helperPath, script);
      if (existingLock) await mkdir(lockPath);
      const outcome = await execFile(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", helperPath,
        join(root, "missing-installer.exe"), join(root, "missing-app.exe"), logPath,
        "not-a-pid", "0", markerPath, "1.1.4"], { windowsHide: true, timeout: 10_000 })
        .then(() => 0, (error: { code?: number }) => error.code);
      expect(outcome).toBe(existingLock ? 0 : 2);
      expect(await access(lockPath).then(() => true, () => false)).toBe(existingLock);
      expect(await readFile(logPath, "utf8")).toContain(existingLock
        ? "another Memmy update installer is already running" : "installer missing");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("never publishes an active guard if the helper crashes before its atomic rename", async () => {
    const root = await mkdtemp(join(tmpdir(), "memmy-update-publish-"));
    const markerPath = join(root, "prepared-required-update.json");
    const scriptPath = join(root, "helper.ps1");
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
      join(root, "missing-installer.exe"), join(root, "Memmy.exe"), join(root, "install.log"), "not-a-pid", "0", markerPath, "1.1.4"];
    try {
      const script = await generatedInstallerScript();
      const crash = script.replace("[System.IO.Directory]::Move($claimPath, $lockPath)", "[Environment]::Exit(78)");
      expect(crash).not.toBe(script);
      await writeFile(scriptPath, crash);
      const firstExit = await execFile(powershell, args, { windowsHide: true, timeout: 5_000 })
        .then(() => 0, (error: { code?: number }) => error.code);
      expect(firstExit).toBe(78);
      expect(await access(`${markerPath}.lock`).then(() => true, () => false)).toBe(false);
      const claims = (await readdir(root)).filter((name) => name.includes(".lock.claim-"));
      expect(claims).toHaveLength(1);
      const state = JSON.parse((await readFile(join(root, claims[0], "state.json"), "utf8")).replace(/^\uFEFF/u, ""));
      expect(state.ownerToken).toBeTruthy();
      // A later attempt can acquire its own complete guard despite the abandoned claim.
      await writeFile(scriptPath, script);
      const nextExit = await execFile(powershell, args, { windowsHide: true, timeout: 5_000 })
        .then(() => 0, (error: { code?: number }) => error.code);
      expect(nextExit).toBe(2);
      expect(await access(`${markerPath}.lock`).then(() => true, () => false)).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 15_000);

  it("ends direct-launch recovery at its deadline even if the child never calls back", async () => {
    const source = await readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
    const start = source.indexOf("async function recoverWindowsPreparedInstallerLock(");
    const end = source.indexOf("\n/**", start);
    const compiled = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const child = { kill: vi.fn(() => false), stdout: { destroy: vi.fn() }, stderr: { destroy: vi.fn() } };
    const spawn = vi.fn(() => child);
    const warn = vi.fn();
    vi.useFakeTimers();
    try {
      const recover = new Function("process", "join", "dirname", "existsSync", "execFile", "setTimeout", "clearTimeout", "console",
        `${compiled}; return recoverWindowsPreparedInstallerLock;`)(process, join, dirname, () => true, spawn, setTimeout, clearTimeout, { warn });
      let returned = false;
      const result = recover("C:\\fixture\\prepared-required-update.json.lock").then(() => { returned = true; });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(returned).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await result;
      expect(child.kill).toHaveBeenCalledOnce();
      expect(child.stdout.destroy).toHaveBeenCalledOnce();
      expect(child.stderr.destroy).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("bounds the actual generated shortcut's recovery wait without launching the application", async () => {
    const root = await mkdtemp(join(tmpdir(), "memmy-shortcut-recovery-"));
    const recoveryPath = join(root, "recovery.ps1");
    const runnerPath = join(root, "launcher.vbs");
    try {
      const source = await readFile(new URL("../build/installer-win-unsigned.nsh", import.meta.url), "utf8");
      const start = source.indexOf('  FileWrite $1 "If fso.FolderExists(lockPath) And fso.FileExists(recoveryPath) Then');
      const end = source.indexOf('  FileWrite $1 "relayLockPath =', start);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const body = [...source.slice(start, end).matchAll(/FileWrite \$1 "(.*)"/gu)]
        .map((match) => match[1].replace(/\$\\"/gu, '"').replace(/\$\\r\$\\n/gu, "\r\n")).join("");
      const literal = (value: string) => `"${value.replace(/"/gu, '""')}"`;
      await writeFile(recoveryPath, `param([switch]$PreparedInstallerLock, [string]$InstallDir, [string]$LockPath, [string]$LogPath)
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'recovery.pid'), [string]$PID)
Start-Sleep -Seconds 60
`);
      await writeFile(runnerPath, `Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
lockPath = ${literal(root)}
recoveryPath = ${literal(recoveryPath)}
powerShellPath = ${literal(powershell)}
appExe = ${literal(join(root, "Memmy.exe"))}
upgradeLogPath = ${literal(join(root, "recovery.log"))}
${body}
Set finished = fso.CreateTextFile(${literal(join(root, "finished.txt"))}, True)
finished.Write "recovery-wait-ended"
finished.Close
`);
      await execFile(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cscript.exe"),
        ["//B", "//Nologo", runnerPath], { windowsHide: true, timeout: 12_000 });
      expect(await readFile(join(root, "finished.txt"), "utf8")).toBe("recovery-wait-ended");
      expect(await readFile(join(root, "recovery.pid"), "utf8")).toMatch(/^\d+$/u);
    } finally {
      const pid = await readFile(join(root, "recovery.pid"), "utf8").catch(() => "");
      if (/^\d+$/u.test(pid)) await execFile(powershell, ["-NoProfile", "-Command", `
$candidate = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'
if ($candidate -and $candidate.Name -eq 'powershell.exe' -and $candidate.CommandLine.Contains($env:MEMMY_RECOVERY_TEST_SCRIPT)) { Stop-Process -Id $candidate.ProcessId -Force }
`], { env: { ...process.env, MEMMY_RECOVERY_TEST_SCRIPT: recoveryPath }, windowsHide: true, timeout: 5_000 });
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("releases its guard once without removing the next updater's guard or prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "memmy-update-owner-"));
    const runnerPath = join(root, "runner.ps1");
    try {
      const source = await readFile(new URL("../src/main/main.ts", import.meta.url), "utf8");
      const release = source.match(/function Clear-MemmyOwnedUpdateLock \{[^]*?(?=\r?\n\r?\nfunction Start-MemmyAfterUpdate)/u)?.[0];
      expect(release).toBeDefined();
      await writeFile(runnerPath, `
$ErrorActionPreference = 'Stop'
$lockPath = Join-Path $PSScriptRoot 'prepared-required-update.json.lock'
$promptMarkerPath = Join-Path $PSScriptRoot 'prepared-required-update.json.prompt'
$ownsLock = $true
$retainInstallerLock = $false
$lockOwnerToken = 'first-owner'
New-Item -ItemType Directory -Path $lockPath | Out-Null
@{ ownerToken = $lockOwnerToken } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $lockPath 'state.json')
${release}
Clear-MemmyOwnedUpdateLock
New-Item -ItemType Directory -Path $lockPath | Out-Null
@{ ownerToken = 'second-owner' } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $lockPath 'state.json')
Set-Content -LiteralPath $promptMarkerPath -Value 'second-owner'
Clear-MemmyOwnedUpdateLock
@{ owner = (Get-Content -LiteralPath (Join-Path $lockPath 'state.json') -Raw | ConvertFrom-Json).ownerToken; prompt = (Get-Content -LiteralPath $promptMarkerPath -Raw).Trim() } | ConvertTo-Json -Compress
`);
      const result = await execFile(powershell, ["-NoProfile", "-File", runnerPath], { windowsHide: true, timeout: 5_000 });
      expect(JSON.parse(result.stdout.trim())).toEqual({ owner: "second-owner", prompt: "second-owner" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["live-installer", "live-helper", "reused-pid", "exited-installer", "installed-target"] as const)(
    "recovers a timed-out installer guard safely: %s", async (scenario) => {
      const root = await mkdtemp(join(tmpdir(), "memmy-update-recovery-"));
      const markerPath = join(root, "prepared-required-update.json");
      const lockPath = `${markerPath}.lock`;
      const appDir = join(root, "Memmy");
      const recoveryPath = new URL("../build/MemmyWindowsUpgradeRecovery.ps1", import.meta.url);
      try {
        await mkdir(lockPath);
        await mkdir(appDir);
        await writeFile(join(appDir, "user-data.txt"), "must remain intact");
        await writeFile(markerPath, "prepared update");
        await writeFile(`${markerPath}.prompt`, "prompt");
        const identity = await execFile(powershell, ["-NoProfile", "-Command",
          `$p = Get-Process -Id ${process.pid}; @{ pid = $p.Id; ticks = [string]$p.StartTime.ToUniversalTime().Ticks; path = $p.Path } | ConvertTo-Json -Compress`
        ], { windowsHide: true, timeout: 5_000 }).then((result) => JSON.parse(result.stdout));
        const state = {
          schemaVersion: 1, ownerToken: "fixture-owner", appExe: join(appDir, "Memmy.exe"),
          expectedVersion: "0.0.1", installerPath: identity.path,
          installerPid: scenario === "live-installer" || scenario === "reused-pid" ? identity.pid : 2147483647,
          installerStartedAtTicks: scenario === "reused-pid" ? "1" : identity.ticks,
          helperPid: scenario === "live-helper" ? identity.pid : 2147483647,
          helperStartedAtTicks: identity.ticks
        };
        if (scenario === "installed-target") await copyFile(powershell, state.appExe);
        await writeFile(join(lockPath, "state.json"), JSON.stringify(state));
        const { fileURLToPath } = await import("node:url");
        const outcome = await execFile(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
          fileURLToPath(recoveryPath), "-PreparedInstallerLock", "-InstallDir", appDir,
          "-LockPath", lockPath, "-LogPath", join(root, "recovery.log")
        ], { windowsHide: true, timeout: 5_000 }).then(() => 0, (error: { code?: number }) => error.code);
        const active = scenario === "live-installer" || scenario === "live-helper";
        expect(outcome).toBe(active ? 10 : 0);
        expect(await access(lockPath).then(() => true, () => false)).toBe(active);
        expect(await readFile(join(appDir, "user-data.txt"), "utf8")).toBe("must remain intact");
        if (active) {
          expect(await readFile(`${markerPath}.prompt`, "utf8")).toBe("prompt");
        } else {
          expect((await readdir(root)).filter((name) => name.startsWith("prepared-required-update.json.lock.released-"))).toHaveLength(1);
          expect(await access(`${markerPath}.prompt`).then(() => true, () => false)).toBe(false);
          if (scenario === "installed-target") {
            expect(await access(markerPath).then(() => true, () => false)).toBe(false);
          } else {
            expect((await readFile(`${markerPath}.attempt`, "utf8")).replace(/^\uFEFF/u, "").trim()).toBe("0.0.1");
          }
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 15_000
  );
});
