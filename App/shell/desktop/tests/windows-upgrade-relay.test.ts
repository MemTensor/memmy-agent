import { execFile as execFileCallback, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, mkdir, readFile as readFileRaw, rename, rm, symlink, utimes, writeFile as writeFileRaw } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const relayScriptPath = resolve(import.meta.dirname, "../build/MemmyWindowsUpgradeRelay.ps1");
const cleanupScriptPath = resolve(import.meta.dirname, "../build/MemmyWindowsUpgradeCleanup.ps1");
const recoveryScriptPath = resolve(import.meta.dirname, "../build/MemmyWindowsUpgradeRecovery.ps1");
const migrationScriptPath = resolve(import.meta.dirname, "../build/MemmyWindowsDataMigration.ps1");
const temporaryDirectories: string[] = [];
const helperProcesses: ChildProcess[] = [];
const descendantProcessIds: number[] = [];
const describeOnWindows = process.platform === "win32" ? describe : describe.skip;

async function writeFile(path: string, data: string | Uint8Array, encoding?: BufferEncoding): Promise<void> {
  if (path.toLowerCase().endsWith("app.sqlite") && typeof data === "string") {
    const sqliteFixture = Buffer.alloc(4096);
    Buffer.from("SQLite format 3\0", "ascii").copy(sqliteFixture, 0);
    sqliteFixture[16] = 0x10;
    sqliteFixture[17] = 0x00;
    Buffer.from(data, "utf8").copy(sqliteFixture, 100);
    await writeFileRaw(path, sqliteFixture);
    return;
  }
  await writeFileRaw(path, data, encoding);
}

function readFile(path: string, encoding: "utf8"): Promise<string>;
function readFile(path: string): Promise<Buffer>;
async function readFile(path: string, encoding?: "utf8"): Promise<string | Buffer> {
  if (path.toLowerCase().endsWith("app.sqlite") && encoding === "utf8") {
    const contents = await readFileRaw(path);
    const markerEnd = contents.indexOf(0, 100);
    return contents.subarray(100, markerEnd < 0 ? contents.length : markerEnd).toString("utf8");
  }
  return encoding ? readFileRaw(path, encoding) : readFileRaw(path);
}

afterEach(async () => {
  await Promise.all(helperProcesses.splice(0).map(async (process) => {
    if (process.exitCode !== null || process.signalCode !== null) return;
    await new Promise<void>((resolvePromise) => {
      process.once("exit", () => resolvePromise());
      process.kill();
    });
  }));
  for (const processId of descendantProcessIds.splice(0)) {
    try {
      process.kill(processId);
    } catch {
      // The descendant may already have exited.
    }
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        process.kill(processId, 0);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      } catch {
        break;
      }
    }
  }
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100
  })));
});

const createRelayFixture = async (
  installerExitCode: number,
  options: {
    installerDelaySeconds?: number;
    spawnLongLivedDescendant?: boolean;
    failMigrationPrepare?: boolean;
    failMigrationComplete?: boolean;
    failMigrationRollback?: boolean;
    failFirstMigrationRollback?: boolean;
    replaceTargetWithJunctionAfterPrepare?: boolean;
    relocate?: boolean;
  } = {}
) => {
  const root = await mkdtemp(join(tmpdir(), "memmy-upgrade-relay-"));
  temporaryDirectories.push(root);
  const installDir = join(root, "installed Memmy");
  const targetInstallDir = options.relocate ? join(root, "relocated Memmy") : installDir;
  const dataDir = join(installDir, "data", "Memmy");
  const workDir = join(root, "relay-work");
  const backupRoot = join(`${installDir}.memmy-upgrade-backup`, basename(workDir));
  const backupPath = join(backupRoot, "data-backup");
  const logPath = join(root, "logs", "windows-upgrade.log");
  const targetUserDataPath = join(root, "roaming", "Memmy");
  const targetRuntimeHomePath = join(root, "new-runtime", ".memmy");
  const legacyRuntimeHomePath = join(root, "legacy-profile", ".memmy");
  const migrationStatePath = join(root, "local", "Memmy", "data-migration", "state.json");
  const migrationLogPath = join(root, "logs", "data-migration.log");
  const installationRecordPath = join(root, "local", "Memmy", "data-layout", "last-install.json");
  const installerPath = join(workDir, `fake-installer-${installerExitCode}.cmd`);
  const descendantPidPath = join(root, "installer-descendant.pid");
  const descendantScriptPath = join(root, "installer-descendant.ps1");
  await mkdir(dataDir, { recursive: true });
  await mkdir(workDir, { recursive: true });
  await copyFile(cleanupScriptPath, join(workDir, "MemmyWindowsUpgradeCleanup.ps1"));
  await copyFile(migrationScriptPath, join(workDir, "MemmyWindowsDataMigration.ps1"));
  if (options.failMigrationPrepare) {
    await writeFile(join(workDir, "MemmyWindowsDataMigration.ps1"), "Write-Error 'injected migration failure'\r\nexit 5\r\n", "utf8");
  } else if (options.failMigrationComplete
    || options.failMigrationRollback
    || options.failFirstMigrationRollback
    || options.replaceTargetWithJunctionAfterPrepare) {
    const copiedMigrationPath = join(workDir, "MemmyWindowsDataMigration.ps1");
    let copiedMigration = await readFile(copiedMigrationPath, "utf8");
    if (options.failMigrationComplete) {
      copiedMigration = copiedMigration.replace(
        'elseif ($Mode -eq "Complete") {',
        'elseif ($Mode -eq "Complete") {\r\n    throw "injected Complete failure"'
      );
    }
    if (options.failMigrationRollback) {
      copiedMigration = copiedMigration.replace(
        'elseif ($Mode -eq "Rollback") {',
        'elseif ($Mode -eq "Rollback") {\r\n    throw "injected Rollback failure"'
      );
    }
    if (options.failFirstMigrationRollback) {
      const firstRollbackMarker = join(root, "first-rollback-failed.marker").replaceAll("'", "''");
      copiedMigration = copiedMigration.replace(
        'elseif ($Mode -eq "Rollback") {',
        `elseif ($Mode -eq "Rollback") {\r\n    if (-not (Test-Path -LiteralPath '${firstRollbackMarker}')) { Set-Content -LiteralPath '${firstRollbackMarker}' -Value 'failed'; throw "injected first Rollback failure" }`
      );
    }
    if (options.replaceTargetWithJunctionAfterPrepare) {
      const redirectedTarget = join(root, "post-prepare-redirected-target").replaceAll("'", "''");
      await mkdir(redirectedTarget, { recursive: true });
      copiedMigration = copiedMigration.replace(
        'Write-MigrationLog -Message "Migration preparation completed."',
        `Write-MigrationLog -Message "Migration preparation completed."\r\n    New-Item -ItemType Junction -Path $TargetInstallDir -Target '${redirectedTarget}' -ErrorAction Stop | Out-Null`
      );
    }
    await writeFile(copiedMigrationPath, copiedMigration, "utf8");
  }
  await writeFile(join(dataDir, "sentinel.txt"), "keep-me", "utf8");
  await writeFile(join(dataDir, "app.sqlite"), "account-state", "utf8");
  await writeFile(join(dataDir, "prepared-required-update.json"), "{}", "utf8");
  await mkdir(join(dataDir, "prepared-required-update.json.lock"), { recursive: true });
  await writeFile(join(dataDir, "prepared-required-update.json.prompt"), "prompt", "utf8");
  await writeFile(join(dataDir, "prepared-required-update.json.attempt"), "1.0.9", "utf8");
  const windowsDirectory = process.env.SystemRoot ?? "C:\\Windows";
  const appStubPath = join(windowsDirectory, "System32", "where.exe");
  await writeFile(join(installDir, "Memmy.exe"), await readFile(appStubPath));
  const escapedTargetInstallDir = targetInstallDir.replaceAll("%", "%%");
  const escapedAppStubPath = appStubPath.replaceAll("%", "%%");
  const installerLines = [
    "@echo off",
  ];
  if (options.installerDelaySeconds) {
    installerLines.push(`ping 127.0.0.1 -n ${options.installerDelaySeconds + 1} >nul`);
  }
  if (options.spawnLongLivedDescendant) {
    const powershellPath = join(windowsDirectory, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    await writeFile(descendantScriptPath, [
      `$PID | Set-Content -LiteralPath '${descendantPidPath.replaceAll("'", "''")}'`,
      "Start-Sleep -Seconds 20",
      ""
    ].join("\r\n"), "utf8");
    installerLines.push(`start "" /b "${powershellPath.replaceAll("%", "%%")}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${descendantScriptPath.replaceAll("%", "%%")}"`);
  }
  installerLines.push(
    `rmdir /s /q "${escapedTargetInstallDir}"`,
    `mkdir "${escapedTargetInstallDir}"`,
    `copy /y "${escapedAppStubPath}" "${escapedTargetInstallDir}\\Memmy.exe" >nul`,
    "if not defined MEMMY_UPGRADE_WORK_DIR goto installer_done",
    ">\"%MEMMY_UPGRADE_WORK_DIR%\\child-reopen-intent.txt\" echo(%MEMMY_UPGRADE_REOPEN_AFTER_INSTALL%",
    ":installer_done",
    `exit /b ${installerExitCode}`,
    ""
  );
  await writeFile(installerPath, installerLines.join("\r\n"), "utf8");
  return {
    root,
    installDir,
    targetInstallDir,
    dataDir,
    workDir,
    backupRoot,
    backupPath,
    logPath,
    installerPath,
    descendantPidPath,
    targetUserDataPath,
    targetRuntimeHomePath,
    legacyRuntimeHomePath,
    migrationStatePath,
    migrationLogPath,
    installationRecordPath
  };
};

const runRecovery = async (fixture: Awaited<ReturnType<typeof createRelayFixture>>) => {
  const powershellPath = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return execFile(powershellPath, [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    recoveryScriptPath,
    "-InstallDir",
    fixture.installDir,
    "-LockPath",
    join(fixture.root, "active.lock"),
    "-LogPath",
    fixture.logPath,
    "-DirectMigrationStatePath",
    fixture.migrationStatePath,
    "-DirectMigrationScriptPath",
    join(fixture.workDir, "MemmyWindowsDataMigration.ps1"),
    "-DirectMigrationLogPath",
    fixture.migrationLogPath,
    "-TargetUserDataPathOverride",
    fixture.targetUserDataPath,
    "-TargetRuntimeHomePathOverride",
    fixture.targetRuntimeHomePath,
    "-LegacyRuntimeHomePathOverride",
    fixture.legacyRuntimeHomePath,
    "-MigrationStatePathOverride",
    fixture.migrationStatePath
  ], { timeout: 30_000, windowsHide: true });
};

const runDataMigration = async (
  fixture: Awaited<ReturnType<typeof createRelayFixture>>,
  mode: "Prepare" | "Complete" | "Rollback" | "RequireRecovery",
  owner: "relay" | "installer" = "relay",
  sourceDataPath = fixture.backupPath
) => {
  const powershellPath = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return execFile(powershellPath, [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join(fixture.workDir, "MemmyWindowsDataMigration.ps1"),
    "-Mode",
    mode,
    "-SourceDataPath",
    sourceDataPath,
    "-SourceAuthority",
    owner === "relay" ? "relay-backup-authority" : "current-install-authority",
    "-SourceInstallDir",
    fixture.installDir,
    "-LegacyRuntimeHomePath",
    fixture.legacyRuntimeHomePath,
    "-TargetUserDataPath",
    fixture.targetUserDataPath,
    "-TargetRuntimeHomePath",
    fixture.targetRuntimeHomePath,
    "-PointerPath",
    join(fixture.targetUserDataPath, "data-root.txt"),
    "-StatePath",
    fixture.migrationStatePath,
    "-LockPath",
    join(fixture.root, "active.lock"),
    "-LogPath",
    fixture.migrationLogPath,
    "-Owner",
    owner
  ], { timeout: 30_000, windowsHide: true });
};

const runRelay = async (
  fixture: Awaited<ReturnType<typeof createRelayFixture>>,
  options: { appDataPath?: string; legacyHelperPid?: number; reopenAfterInstall?: "0" | "1"; installedVersion?: string; installerMode?: "Silent" | "Interactive" } = {}
) => {
  const powershellPath = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return execFile(powershellPath, buildRelayArguments(fixture, options), {
    timeout: 30_000,
    windowsHide: true,
    env: options.appDataPath ? { ...process.env, APPDATA: options.appDataPath } : process.env
  });
};

const buildRelayArguments = (
  fixture: Awaited<ReturnType<typeof createRelayFixture>>,
  options: { legacyHelperPid?: number; reopenAfterInstall?: "0" | "1"; installedVersion?: string; installerMode?: "Silent" | "Interactive" } = {}
) => [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    relayScriptPath,
    "-InstallerPath",
    fixture.installerPath,
    "-SourceInstallDir",
    fixture.installDir,
    "-TargetInstallDir",
    fixture.targetInstallDir,
    "-OriginalInstallerPid",
    "2147483647",
    "-LegacyHelperPid",
    String(options.legacyHelperPid ?? 2147483647),
    "-ExpectedVersion",
    "10.",
    "-InstalledVersion",
    options.installedVersion ?? "1.0.9",
    "-InstallerMode",
    options.installerMode ?? "Silent",
    "-ReopenAfterInstall",
    options.reopenAfterInstall ?? "0",
    "-ReadyPath",
    join(fixture.workDir, "relay-ready"),
    "-WorkDir",
    fixture.workDir,
    "-LogPath",
    fixture.logPath,
    "-TargetUserDataPathOverride",
    fixture.targetUserDataPath,
    "-TargetRuntimeHomePathOverride",
    fixture.targetRuntimeHomePath,
    "-LegacyRuntimeHomePathOverride",
    fixture.legacyRuntimeHomePath,
    "-MigrationStatePathOverride",
    fixture.migrationStatePath,
    "-MigrationLogPathOverride",
    fixture.migrationLogPath,
    "-InstallationRecordPathOverride",
    fixture.installationRecordPath
  ];

const startLegacyUpdateHelper = async (
  fixture: Awaited<ReturnType<typeof createRelayFixture>>,
  reopenAfterInstall: "0" | "1",
  markerPath = join(fixture.dataDir, "prepared-required-update.json")
) => {
  const powershellPath = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const helperPath = join(fixture.root, "legacy update helper.ps1");
  await writeFile(helperPath, "param($AppPid, $OpenAfterInstall, $MarkerPath)\nStart-Sleep -Seconds 20\n", "utf8");
  const helper = spawn(powershellPath, [
    "-NoProfile",
    "-File",
    helperPath,
    "43188",
    reopenAfterInstall,
    markerPath
  ], { windowsHide: true, stdio: "ignore" });
  helperProcesses.push(helper);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  if (!helper.pid) {
    throw new Error("legacy update helper did not start");
  }
  return helper.pid;
};

const waitForPathAbsent = async (path: string) => {
  const deadline = Date.now() + 10_000;
  while (existsSync(path) && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
};

const waitForPathPresent = async (path: string) => {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
};

describeOnWindows("Windows upgrade relay", () => {
  it("revalidates relocation safety immediately before starting the child installer", async () => {
    const source = await readFile(relayScriptPath, "utf8");
    const safetyCalls = [...source.matchAll(/^\s+Assert-MemmyRelocationTargetIsSafe(?:\s|$)/gmu)];
    const migrationPrepare = source.indexOf("Invoke-MemmyDataMigration -Mode Prepare");
    const childStart = source.indexOf("$installerProcess = Start-Process -FilePath $InstallerPath");

    expect(safetyCalls).toHaveLength(2);
    expect(safetyCalls[1]?.index).toBeGreaterThan(migrationPrepare);
    expect(safetyCalls[1]?.index).toBeLessThan(childStart);
    expect(source).toContain("Assert-MemmyNoReparsePath $normalizedTargetInstallDir 'target installDir'");
    expect(source).toContain("Assert-MemmyNoReparsePath $targetRuntimeHomePath 'target runtimeHomePath'");
  });

  it("rejects a relocation target that crosses a directory junction", async () => {
    const fixture = await createRelayFixture(0, { relocate: true });
    const redirectedTarget = join(fixture.root, "redirected-target");
    await mkdir(redirectedTarget, { recursive: true });
    await symlink(redirectedTarget, fixture.targetInstallDir, "junction");

    await expect(runRelay(fixture)).rejects.toMatchObject({ code: 1 });
    expect(existsSync(join(redirectedTarget, "Memmy.exe"))).toBe(false);
    expect(existsSync(fixture.dataDir)).toBe(true);
    const log = await readFile(fixture.logPath, "utf8");
    expect(log).toContain("target installDir crosses a reparse point");
  }, 15_000);

  it("rejects a relocation target replaced with a junction after migration preparation", async () => {
    const fixture = await createRelayFixture(0, {
      relocate: true,
      replaceTargetWithJunctionAfterPrepare: true
    });
    const redirectedTarget = join(fixture.root, "post-prepare-redirected-target");

    await expect(runRelay(fixture)).rejects.toMatchObject({ code: 1 });
    expect(existsSync(join(redirectedTarget, "Memmy.exe"))).toBe(false);
    expect(existsSync(fixture.dataDir)).toBe(true);
    const log = await readFile(fixture.logPath, "utf8");
    expect(log).toContain("target installDir crosses a reparse point");
  }, 15_000);

  it("rejects a relocation source that crosses a directory junction before moving data", async () => {
    const fixture = await createRelayFixture(0, { relocate: true });
    const realSource = join(fixture.root, "real-source");
    await rename(fixture.installDir, realSource);
    await symlink(realSource, fixture.installDir, "junction");

    await expect(runRelay(fixture)).rejects.toMatchObject({ code: 1 });

    expect(existsSync(join(realSource, "data", "Memmy", "sentinel.txt"))).toBe(true);
    expect(existsSync(fixture.backupRoot)).toBe(false);
    expect(existsSync(join(fixture.targetInstallDir, "Memmy.exe"))).toBe(false);
    const log = await readFile(fixture.logPath, "utf8");
    expect(log).toContain("source installDir crosses a reparse point");
  }, 15_000);

  it("waits for the running source installation before relocating", async () => {
    const fixture = await createRelayFixture(0, { relocate: true });
    const pingPath = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "PING.EXE");
    await copyFile(pingPath, join(fixture.installDir, "Memmy.exe"));
    const sourceProcess = spawn(join(fixture.installDir, "Memmy.exe"), ["127.0.0.1", "-n", "8"], {
      windowsHide: true,
      stdio: "ignore"
    });
    helperProcesses.push(sourceProcess);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    expect(sourceProcess.exitCode).toBeNull();

    await runRelay(fixture);

    expect(sourceProcess.exitCode).not.toBeNull();
    const log = await readFile(fixture.logPath, "utf8");
    expect(log).not.toContain("forcing remaining installed app processes to exit");
  }, 20_000);

  it("keeps interactive relay children visible while silent updates stay hidden", async () => {
    const source = await readFile(relayScriptPath, "utf8");

    expect(source).toContain("[ValidateSet('Silent', 'Interactive')][string]$InstallerMode");
    expect(source).toContain("$arguments = @('--updated', '--memmy-upgrade-relayed', '/currentuser', ('/D=' + $normalizedTargetInstallDir))");
    expect(source).toContain("$arguments = @('/S') + $arguments");
    expect(source).not.toContain("$arguments = @('/S', '--updated') + $arguments");
    expect(source).toMatch(/InstallerMode -eq 'Interactive'[\s\S]*WindowStyle Normal/u);
    expect(source).toMatch(/InstallerMode -eq 'Silent'[\s\S]*'\/S'[\s\S]*WindowStyle Hidden/u);
  });

  it("migrates install-local data outside the installation directory before a verified upgrade", async () => {
    expect(existsSync(relayScriptPath)).toBe(true);
    const fixture = await createRelayFixture(0);
    const sourceRuntimeHomePath = join(fixture.installDir, "data", ".memmy");
    const sourceWorkspacePath = join(sourceRuntimeHomePath, "workspace");
    const sourceSessionPath = join(sourceWorkspacePath, "sessions", "websocket_default.jsonl");
    await mkdir(dirname(sourceSessionPath), { recursive: true });
    await Promise.all([
      writeFile(join(sourceRuntimeHomePath, "config.yaml"), [
        "agents:",
        "  defaults:",
        `    workspace: '${sourceWorkspacePath}'`,
        ""
      ].join("\n"), "utf8"),
      writeFile(sourceSessionPath, `${JSON.stringify({
        key: "websocket:default",
        metadata: {
          webui: true,
          webuiProjectId: null,
          webuiWorkspaceCwd: sourceWorkspacePath
        }
      })}\n{\"role\":\"user\",\"content\":\"keep history\"}\n`, "utf8")
    ]);
    await runRelay(fixture);

    expect(await readFile(join(fixture.targetUserDataPath, "sentinel.txt"), "utf8")).toBe("keep-me");
    expect(existsSync(join(fixture.installDir, "Memmy.exe"))).toBe(true);
    expect(existsSync(join(fixture.installDir, "data"))).toBe(false);
    expect(existsSync(join(fixture.targetUserDataPath, "prepared-required-update.json"))).toBe(false);
    expect(existsSync(join(fixture.targetUserDataPath, "prepared-required-update.json.lock"))).toBe(false);
    expect(existsSync(join(fixture.targetUserDataPath, "prepared-required-update.json.prompt"))).toBe(false);
    expect(existsSync(join(fixture.targetUserDataPath, "prepared-required-update.json.attempt"))).toBe(false);
    const migratedConfig = await readFile(join(fixture.targetRuntimeHomePath, "config.yaml"), "utf8");
    expect(migratedConfig).toContain(join(fixture.targetRuntimeHomePath, "workspace"));
    expect(migratedConfig).not.toContain(sourceWorkspacePath);
    const migratedSessionLines = (await readFile(
      join(fixture.targetRuntimeHomePath, "workspace", "sessions", "websocket_default.jsonl"),
      "utf8"
    )).trim().split(/\r?\n/u);
    expect(JSON.parse(migratedSessionLines[0]).metadata.webuiWorkspaceCwd)
      .toBe(join(fixture.targetRuntimeHomePath, "workspace"));
    expect(JSON.parse(migratedSessionLines[1])).toMatchObject({ content: "keep history" });
    expect(existsSync(fixture.backupPath)).toBe(true);
    const log = await readFile(fixture.logPath, "utf8");
    expect(log).toContain(`data moved to ${fixture.backupPath}`);
    expect(log).toContain("data migration Prepare completed");
    expect(log).toContain("data migration Complete completed");
    expect(log).toContain("upgrade verified");
    expect(log).not.toContain("started app");
    expect(log).not.toContain("relay error");
    await waitForPathAbsent(fixture.workDir);
    expect(existsSync(fixture.workDir)).toBe(false);
  }, 15_000);

  it("relocates a completed external-v1 runtime from the source drive to the selected target drive", async () => {
    const fixture = await createRelayFixture(0, { relocate: true });
    const sourceRuntimeHomePath = fixture.legacyRuntimeHomePath;
    const sourceWorkspacePath = join(sourceRuntimeHomePath, "workspace");
    const targetWorkspacePath = join(fixture.targetRuntimeHomePath, "workspace");
    const sessionPath = join(sourceWorkspacePath, "sessions", "websocket_relocation.jsonl");
    await rm(join(fixture.installDir, "data"), { recursive: true, force: true });
    await Promise.all([
      mkdir(dirname(fixture.installationRecordPath), { recursive: true }),
      mkdir(fixture.targetUserDataPath, { recursive: true }),
      mkdir(dirname(sessionPath), { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(fixture.targetUserDataPath, "app.sqlite"), "external-account", "utf8"),
      writeFile(join(sourceRuntimeHomePath, "config.yaml"), `workspace: '${sourceWorkspacePath}'\n`, "utf8"),
      writeFile(sessionPath, `${JSON.stringify({
        key: "websocket:relocation",
        metadata: { webui: true, webuiProjectId: null, webuiWorkspaceCwd: sourceWorkspacePath }
      })}\n{\"role\":\"user\",\"content\":\"keep relocation history\"}\n`, "utf8"),
      writeFile(fixture.installationRecordPath, JSON.stringify({
        schemaVersion: 1,
        dataLayoutGeneration: "external-v1",
        installDir: fixture.installDir,
        userDataPath: fixture.targetUserDataPath,
        runtimeHomePath: sourceRuntimeHomePath,
        appVersion: "1.1.0"
      }), "utf8"),
      writeFile(
        join(fixture.targetUserDataPath, "data-root.txt"),
        Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${sourceRuntimeHomePath}\r\n`, "utf16le")])
      )
    ]);

    await runRelay(fixture, { installedVersion: "1.1.0" });

    expect(existsSync(join(fixture.targetInstallDir, "Memmy.exe"))).toBe(true);
    await expect(readFile(join(fixture.targetUserDataPath, "app.sqlite"), "utf8"))
      .resolves.toBe("external-account");
    const migratedConfig = await readFile(join(fixture.targetRuntimeHomePath, "config.yaml"), "utf8");
    expect(migratedConfig).toContain(targetWorkspacePath);
    expect(migratedConfig).not.toContain(sourceWorkspacePath);
    const migratedSession = await readFile(
      join(fixture.targetRuntimeHomePath, "workspace", "sessions", "websocket_relocation.jsonl"),
      "utf8"
    );
    expect(migratedSession).toContain("keep relocation history");
    expect(migratedSession).toContain(targetWorkspacePath.replaceAll("\\", "\\\\"));
    expect(existsSync(sourceRuntimeHomePath)).toBe(true);
    expect(JSON.parse(await readFile(fixture.migrationStatePath, "utf8"))).toMatchObject({
      phase: "awaiting-app-verification",
      sourceInstallDir: fixture.installDir,
      targetInstallDir: fixture.targetInstallDir,
      runtimeSourceAuthority: "persisted-external-authority",
      runtimeSourcePath: sourceRuntimeHomePath
    });
  }, 15_000);

  it("rolls an external-v1 relocation back to the source runtime when the child installer fails", async () => {
    const fixture = await createRelayFixture(2, { relocate: true });
    const sourceRuntimeHomePath = fixture.legacyRuntimeHomePath;
    await rm(join(fixture.installDir, "data"), { recursive: true, force: true });
    await Promise.all([
      mkdir(dirname(fixture.installationRecordPath), { recursive: true }),
      mkdir(fixture.targetUserDataPath, { recursive: true }),
      mkdir(sourceRuntimeHomePath, { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(fixture.targetUserDataPath, "app.sqlite"), "external-account", "utf8"),
      writeFile(join(sourceRuntimeHomePath, "config.yaml"), "source-runtime", "utf8"),
      writeFile(fixture.installationRecordPath, JSON.stringify({
        schemaVersion: 1,
        dataLayoutGeneration: "external-v1",
        installDir: fixture.installDir,
        userDataPath: fixture.targetUserDataPath,
        runtimeHomePath: sourceRuntimeHomePath,
        appVersion: "1.1.0"
      }), "utf8"),
      writeFile(
        join(fixture.targetUserDataPath, "data-root.txt"),
        Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${sourceRuntimeHomePath}\r\n`, "utf16le")])
      )
    ]);

    await expect(runRelay(fixture, { installedVersion: "1.1.0" })).rejects.toMatchObject({ code: 2 });

    expect(existsSync(join(fixture.installDir, "Memmy.exe"))).toBe(true);
    expect(existsSync(fixture.targetRuntimeHomePath)).toBe(false);
    await expect(readFile(join(sourceRuntimeHomePath, "config.yaml"), "utf8"))
      .resolves.toBe("source-runtime");
    const pointerBytes = await readFile(join(fixture.targetUserDataPath, "data-root.txt"));
    expect(pointerBytes.subarray(2).toString("utf16le").trim()).toBe(sourceRuntimeHomePath);
    expect(existsSync(fixture.migrationStatePath)).toBe(false);
  }, 15_000);

  it("does not accept an unrelated existing runtime as persisted external authority", async () => {
    const fixture = await createRelayFixture(0, { relocate: true });
    const unrelatedRuntimeHomePath = join(fixture.root, "unrelated-existing-runtime");
    await rm(join(fixture.installDir, "data"), { recursive: true, force: true });
    await Promise.all([
      mkdir(dirname(fixture.installationRecordPath), { recursive: true }),
      mkdir(fixture.targetUserDataPath, { recursive: true }),
      mkdir(unrelatedRuntimeHomePath, { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(fixture.targetUserDataPath, "app.sqlite"), "external-account", "utf8"),
      writeFile(join(unrelatedRuntimeHomePath, "config.yaml"), "unrelated-runtime", "utf8"),
      writeFile(fixture.installationRecordPath, JSON.stringify({
        schemaVersion: 1,
        dataLayoutGeneration: "external-v1",
        installDir: fixture.installDir,
        userDataPath: fixture.targetUserDataPath,
        runtimeHomePath: unrelatedRuntimeHomePath,
        appVersion: "1.1.0"
      }), "utf8"),
      writeFile(
        join(fixture.targetUserDataPath, "data-root.txt"),
        Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${unrelatedRuntimeHomePath}\r\n`, "utf16le")])
      )
    ]);

    await runRelay(fixture, { installedVersion: "1.1.0" });

    expect(existsSync(join(fixture.targetRuntimeHomePath, "config.yaml"))).toBe(false);
    const migrationLog = await readFile(fixture.migrationLogPath, "utf8");
    expect(migrationLog).toContain("Ignoring an invalid external-v1 runtime source");
    expect(migrationLog).not.toContain("authority=persisted-external-authority");
  }, 15_000);

  it("recovers a persisted install-local backup when the executable and install data are gone", async () => {
    const fixture = await createRelayFixture(0);
    const failedBackup = join(
      `${fixture.installDir}.memmy-migration-failed`,
      "20260825120000-0123456789abcdef0123456789abcdef",
      "data-backup",
    );
    await mkdir(dirname(failedBackup), { recursive: true });
    await rename(join(fixture.installDir, "data"), failedBackup);
    await rm(join(fixture.installDir, "Memmy.exe"), { force: true });
    await mkdir(dirname(fixture.installationRecordPath), { recursive: true });
    await writeFile(fixture.installationRecordPath, JSON.stringify({
      schemaVersion: 1,
      dataLayoutGeneration: "install-local-v1",
      installDir: fixture.installDir,
      sourceDataPath: failedBackup,
      sourceGeneration: `legacy-install:${fixture.installDir.toLowerCase()}`,
      sourceAppVersion: "1.0.9",
    }), "utf8");

    await runRelay(fixture);

    await expect(readFile(join(fixture.targetUserDataPath, "sentinel.txt"), "utf8"))
      .resolves.toBe("keep-me");
    await expect(readFile(join(fixture.targetUserDataPath, "app.sqlite"), "utf8"))
      .resolves.toBe("account-state");
    expect(JSON.parse(await readFile(fixture.migrationStatePath, "utf8"))).toMatchObject({
      phase: "awaiting-app-verification",
      sourceAuthority: "persisted-install-authority",
      sourceDataPath: failedBackup,
    });
    const migrationLog = await readFile(fixture.migrationLogPath, "utf8");
    expect(migrationLog).toContain(`Using the persisted trusted install-local source: ${failedBackup}`);
    const relayLog = await readFile(fixture.logPath, "utf8");
    expect(relayLog).not.toContain("data moved to");
  });

  it("runs migration when the previous installer did not record a DisplayVersion", async () => {
    const fixture = await createRelayFixture(0);
    await Promise.all([
      mkdir(fixture.targetUserDataPath, { recursive: true }),
      mkdir(fixture.targetRuntimeHomePath, { recursive: true }),
      mkdir(join(fixture.installDir, "data", ".memmy"), { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(fixture.targetUserDataPath, "app.sqlite"), "stale-appdata-login", "utf8"),
      writeFile(join(fixture.targetRuntimeHomePath, "config.yaml"), "stale-profile-runtime", "utf8"),
      writeFile(join(fixture.installDir, "data", ".memmy", "config.yaml"), "current-install-runtime", "utf8")
    ]);

    await runRelay(fixture, { installedVersion: "" });

    await expect(readFile(join(fixture.targetUserDataPath, "sentinel.txt"), "utf8"))
      .resolves.toBe("keep-me");
    await expect(readFile(join(fixture.targetUserDataPath, "app.sqlite"), "utf8"))
      .resolves.toBe("account-state");
    await expect(readFile(join(fixture.targetRuntimeHomePath, "config.yaml"), "utf8"))
      .resolves.toBe("current-install-runtime");
    expect(existsSync(fixture.migrationStatePath)).toBe(true);
    const log = await readFile(fixture.logPath, "utf8");
    expect(log).toContain("data migration Prepare completed");
    expect(log).not.toContain("Missing an argument for parameter");
  });

  it("keeps a 1.1 external-layout target when relay backup data is only an install residual", async () => {
    const fixture = await createRelayFixture(0);
    await Promise.all([
      mkdir(fixture.targetUserDataPath, { recursive: true }),
      mkdir(dirname(fixture.installationRecordPath), { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(fixture.targetUserDataPath, "app.sqlite"), "verified-external-login", "utf8"),
      writeFile(fixture.installationRecordPath, JSON.stringify({
        schemaVersion: 1,
        dataLayoutGeneration: "external-v1",
        installDir: fixture.installDir,
        appVersion: "1.1.0",
        recordedAt: new Date().toISOString()
      }), "utf8")
    ]);

    await runRelay(fixture, { installedVersion: "1.1.0" });

    await expect(readFile(join(fixture.targetUserDataPath, "app.sqlite"), "utf8"))
      .resolves.toBe("verified-external-login");
    await expect(readFile(join(fixture.backupPath, "Memmy", "app.sqlite"), "utf8"))
      .resolves.toBe("account-state");
    expect(JSON.parse(await readFile(fixture.migrationStatePath, "utf8"))).toMatchObject({
      phase: "awaiting-app-verification",
      sourceAuthority: "untrusted-residual",
      preparedCopies: []
    });
  });

  it("lets a relay-confirmed 1.0.9 install override an earlier external-layout marker", async () => {
    const fixture = await createRelayFixture(0);
    await Promise.all([
      mkdir(fixture.targetUserDataPath, { recursive: true }),
      mkdir(dirname(fixture.installationRecordPath), { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(fixture.targetUserDataPath, "app.sqlite"), "historical-login", "utf8"),
      writeFile(fixture.installationRecordPath, JSON.stringify({
        schemaVersion: 1,
        dataLayoutGeneration: "external-v1",
        installDir: fixture.installDir,
        appVersion: "1.1.0",
        recordedAt: new Date().toISOString()
      }), "utf8")
    ]);

    await runRelay(fixture, { installedVersion: "1.0.9" });

    await expect(readFile(join(fixture.targetUserDataPath, "app.sqlite"), "utf8"))
      .resolves.toBe("account-state");
    expect(JSON.parse(await readFile(fixture.migrationStatePath, "utf8"))).toMatchObject({
      phase: "awaiting-app-verification",
      sourceAuthority: "relay-backup-authority"
    });
  });

  it("restores data and retains update markers when the staged installer exits 2", async () => {
    expect(existsSync(relayScriptPath)).toBe(true);
    const fixture = await createRelayFixture(2);
    await expect(runRelay(fixture)).rejects.toMatchObject({ code: 2 });

    expect(await readFile(join(fixture.dataDir, "sentinel.txt"), "utf8")).toBe("keep-me");
    expect(existsSync(join(fixture.dataDir, "prepared-required-update.json"))).toBe(true);
    expect(existsSync(fixture.targetUserDataPath)).toBe(false);
    expect(existsSync(fixture.migrationStatePath)).toBe(false);
    const log = await readFile(fixture.logPath, "utf8");
    expect(log).toContain("installer exit 2");
    expect(log).toContain("data migration Rollback completed");
    expect(log).toContain("data restore verified");
    expect(log).not.toContain("upgrade verified");
  });

  it("continues a silent relay upgrade when migration fails and retains the original data for manual recovery", async () => {
    const fixture = await createRelayFixture(0, { failMigrationPrepare: true });
    const lockPath = join(fixture.root, "active.lock");
    await mkdir(fixture.targetUserDataPath, { recursive: true });
    await writeFile(join(fixture.targetUserDataPath, "historical.txt"), "keep-existing-target", "utf8");

    await runRelay(fixture);

    expect(existsSync(join(fixture.installDir, "Memmy.exe"))).toBe(true);
    expect(existsSync(join(fixture.installDir, "data"))).toBe(false);
    expect(await readFile(join(fixture.targetUserDataPath, "historical.txt"), "utf8")).toBe("keep-existing-target");
    expect(await readFile(join(fixture.backupPath, "Memmy", "sentinel.txt"), "utf8")).toBe("keep-me");
    expect(existsSync(fixture.migrationStatePath)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
    const log = await readFile(fixture.logPath, "utf8");
    expect(log).toContain("data migration Prepare failed safely; continuing installation without migration");
    expect(log).toContain(`original data retained for manual recovery at ${fixture.backupPath}`);
    expect(log).not.toContain("upgrade not verified");
    await waitForPathAbsent(fixture.workDir);
  });

  it("keeps the installed app when migration completion fails and rolls the targets back", async () => {
    const fixture = await createRelayFixture(0, { failMigrationComplete: true });
    const lockPath = join(fixture.root, "active.lock");

    await runRelay(fixture);

    expect(existsSync(join(fixture.installDir, "Memmy.exe"))).toBe(true);
    expect(existsSync(fixture.targetUserDataPath)).toBe(false);
    expect(await readFile(join(fixture.backupPath, "Memmy", "sentinel.txt"), "utf8")).toBe("keep-me");
    expect(existsSync(fixture.migrationStatePath)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
    const log = await readFile(fixture.logPath, "utf8");
    expect(log).toContain("data migration Complete failed; rolling back migration while retaining the installed app");
    expect(log).toContain("data migration Rollback completed");
    expect(log).toContain("upgrade verified without migration");
  });

  it("retries an interrupted rollback and restores the target on the second attempt", async () => {
    const fixture = await createRelayFixture(0, {
      failMigrationComplete: true,
      failFirstMigrationRollback: true
    });
    const lockPath = join(fixture.root, "active.lock");

    await runRelay(fixture);

    expect(existsSync(join(fixture.installDir, "Memmy.exe"))).toBe(true);
    expect(existsSync(fixture.targetUserDataPath)).toBe(false);
    expect(existsSync(fixture.migrationStatePath)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
    const log = await readFile(fixture.logPath, "utf8");
    expect(log).toContain("rollback attempt 1 after completion failure failed");
    expect(log).toContain("data migration Rollback completed");
    expect(log).not.toContain("migration-recovery-required");
  });

  it("releases the lock and retains an explicit recovery-required state when rollback retries fail", async () => {
    const fixture = await createRelayFixture(0, {
      failMigrationComplete: true,
      failMigrationRollback: true
    });
    const lockPath = join(fixture.root, "active.lock");

    await runRelay(fixture);

    expect(existsSync(join(fixture.installDir, "Memmy.exe"))).toBe(true);
    expect(await readFile(join(fixture.targetUserDataPath, "sentinel.txt"), "utf8")).toBe("keep-me");
    expect(JSON.parse(await readFile(fixture.migrationStatePath, "utf8"))).toMatchObject({
      phase: "recovery-required"
    });
    expect(existsSync(lockPath)).toBe(false);
    const log = await readFile(fixture.logPath, "utf8");
    expect(log).toContain("rollback attempt 1 after completion failure failed");
    expect(log).toContain("rollback attempt 2 after completion failure failed");
    expect(log).toContain("data migration RequireRecovery completed");
    expect(log).toContain("retaining prepared migration state for startup recovery");
    expect(log).not.toContain('"migrationCompleted":true');
  });

  it("uses the legacy helper's explicit manual reopen intent without restoring install-local data", async () => {
    const fixture = await createRelayFixture(0);
    const helperPid = await startLegacyUpdateHelper(fixture, "1");

    await runRelay(fixture, { legacyHelperPid: helperPid, reopenAfterInstall: "0" });

    expect(await readFile(join(fixture.workDir, "child-reopen-intent.txt"), "utf8")).toBe("1\r\n");
    expect(await readFile(join(fixture.workDir, "relay-ready"), "utf8")).toBe("1");
    expect(await readFile(join(fixture.targetUserDataPath, "sentinel.txt"), "utf8")).toBe("keep-me");
    expect(existsSync(join(fixture.installDir, "data"))).toBe(false);
    const log = await readFile(fixture.logPath, "utf8");
    expect(log).toContain(`reopen intent resolved from legacy helper pid ${helperPid}: 1`);
    expect(log).not.toContain("data restore verified by child installer");
    expect(log).toContain("started app");
    await waitForPathAbsent(fixture.workDir);
  }, 10_000);

  it("keeps a silent update closed when the helper references the roaming marker", async () => {
    const fixture = await createRelayFixture(0);
    const roamingMarkerPath = join(fixture.targetUserDataPath, "prepared-required-update.json");
    await mkdir(fixture.targetUserDataPath, { recursive: true });
    await writeFile(roamingMarkerPath, "{}", "utf8");
    const helperPid = await startLegacyUpdateHelper(fixture, "0", roamingMarkerPath);

    await runRelay(fixture, {
      appDataPath: dirname(fixture.targetUserDataPath),
      legacyHelperPid: helperPid,
      reopenAfterInstall: "1"
    });

    const log = await readFile(fixture.logPath, "utf8");
    expect(log).toContain(`reopen intent resolved from legacy helper pid ${helperPid}: 0`);
    expect(await readFile(join(fixture.workDir, "child-reopen-intent.txt"), "utf8")).toBe("0\r\n");
    expect(log).not.toContain("started app");
    await waitForPathAbsent(fixture.workDir);
  }, 10_000);

  it("waits for the installer itself without waiting for its long-lived descendant", async () => {
    const fixture = await createRelayFixture(0, { spawnLongLivedDescendant: true });
    const startedAt = Date.now();

    await runRelay(fixture);

    expect(Date.now() - startedAt).toBeLessThan(10_000);
    await waitForPathPresent(fixture.descendantPidPath);
    expect(existsSync(fixture.descendantPidPath)).toBe(true);
    descendantProcessIds.push(Number.parseInt((await readFile(fixture.descendantPidPath, "utf8")).trim(), 10));
    await waitForPathAbsent(fixture.workDir);
  });

  it("recovers original data and clears a stale active lock after the relay is gone", async () => {
    expect(existsSync(recoveryScriptPath)).toBe(true);
    const fixture = await createRelayFixture(0);
    const lockPath = join(fixture.root, "active.lock");
    const installerDataPath = join(fixture.installDir, "data", "Memmy", "installer-created.txt");

    await mkdir(fixture.backupRoot, { recursive: true });
    await rename(join(fixture.installDir, "data"), fixture.backupPath);
    await mkdir(dirname(installerDataPath), { recursive: true });
    await writeFile(installerDataPath, "preserve-new-data", "utf8");
    await mkdir(lockPath, { recursive: true });
    await writeFile(join(lockPath, "state.json"), JSON.stringify({
      schemaVersion: 2,
      phase: "data-moved",
      stateUpdatedAtUtc: "2000-01-01T00:00:00.0000000Z",
      relayPid: 2147483647,
      relayStartedAtUtc: "2000-01-01T00:00:00.0000000Z",
      installerPid: null,
      installerStartedAtUtc: null,
      installerPath: fixture.installerPath,
      installDir: fixture.installDir,
      workDir: fixture.workDir,
      backupRoot: fixture.backupRoot
    }), "utf8");

    await runRecovery(fixture);

    expect(await readFile(join(fixture.dataDir, "sentinel.txt"), "utf8")).toBe("keep-me");
    expect(await readFile(join(fixture.backupRoot, "installer-created-data", "Memmy", "installer-created.txt"), "utf8"))
      .toBe("preserve-new-data");
    expect(existsSync(join(fixture.dataDir, "prepared-required-update.json"))).toBe(true);
    expect(existsSync(join(fixture.dataDir, "prepared-required-update.json.lock"))).toBe(false);
    expect(existsSync(join(fixture.dataDir, "prepared-required-update.json.prompt"))).toBe(false);
    expect(existsSync(join(fixture.dataDir, "prepared-required-update.json.attempt"))).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(fixture.workDir)).toBe(false);
    const log = await readFile(fixture.logPath, "utf8");
    expect(log).toContain("stale upgrade data restored");
  });

  it("rolls back a prepared migration after restoring data from a crashed relay", async () => {
    const fixture = await createRelayFixture(0);
    const lockPath = join(fixture.root, "active.lock");
    await mkdir(fixture.backupRoot, { recursive: true });
    await rename(join(fixture.installDir, "data"), fixture.backupPath);
    await mkdir(lockPath, { recursive: true });
    await runDataMigration(fixture, "Prepare");
    expect(await readFile(join(fixture.targetUserDataPath, "sentinel.txt"), "utf8")).toBe("keep-me");

    await writeFile(join(lockPath, "state.json"), JSON.stringify({
      schemaVersion: 3,
      phase: "migration-prepared",
      stateUpdatedAtUtc: "2000-01-01T00:00:00.0000000Z",
      relayPid: 2147483647,
      relayStartedAtUtc: "2000-01-01T00:00:00.0000000Z",
      installerPid: null,
      installerStartedAtUtc: null,
      installerPath: fixture.installerPath,
      installDir: fixture.installDir,
      workDir: fixture.workDir,
      backupRoot: fixture.backupRoot,
      migrationStatePath: fixture.migrationStatePath,
      migrationLogPath: fixture.migrationLogPath,
      legacyRuntimeHomePath: fixture.legacyRuntimeHomePath,
      targetUserDataPath: fixture.targetUserDataPath,
      targetRuntimeHomePath: fixture.targetRuntimeHomePath
    }), "utf8");

    await runRecovery(fixture);

    expect(await readFile(join(fixture.dataDir, "sentinel.txt"), "utf8")).toBe("keep-me");
    expect(existsSync(fixture.targetUserDataPath)).toBe(false);
    expect(existsSync(fixture.migrationStatePath)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("rolls back a recovery-required migration after the relay crashes before releasing its lock", async () => {
    const fixture = await createRelayFixture(0);
    const lockPath = join(fixture.root, "active.lock");
    await mkdir(fixture.backupRoot, { recursive: true });
    await rename(join(fixture.installDir, "data"), fixture.backupPath);
    await mkdir(lockPath, { recursive: true });
    await runDataMigration(fixture, "Prepare");
    await runDataMigration(fixture, "RequireRecovery");
    await writeFile(join(lockPath, "state.json"), JSON.stringify({
      schemaVersion: 3,
      phase: "migration-recovery-required",
      stateUpdatedAtUtc: "2000-01-01T00:00:00.0000000Z",
      relayPid: 2147483647,
      relayStartedAtUtc: "2000-01-01T00:00:00.0000000Z",
      installerPid: null,
      installerStartedAtUtc: null,
      installerPath: fixture.installerPath,
      installDir: fixture.installDir,
      workDir: fixture.workDir,
      backupRoot: fixture.backupRoot,
      migrationStatePath: fixture.migrationStatePath,
      migrationLogPath: fixture.migrationLogPath,
      legacyRuntimeHomePath: fixture.legacyRuntimeHomePath,
      targetUserDataPath: fixture.targetUserDataPath,
      targetRuntimeHomePath: fixture.targetRuntimeHomePath
    }), "utf8");

    await runRecovery(fixture);

    expect(await readFile(join(fixture.dataDir, "sentinel.txt"), "utf8")).toBe("keep-me");
    expect(existsSync(fixture.targetUserDataPath)).toBe(false);
    expect(existsSync(fixture.migrationStatePath)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("finishes recovery idempotently when rollback completed before active-lock cleanup", async () => {
    const fixture = await createRelayFixture(0);
    const lockPath = join(fixture.root, "active.lock");
    await mkdir(fixture.backupRoot, { recursive: true });
    await rename(join(fixture.installDir, "data"), fixture.backupPath);
    await mkdir(lockPath, { recursive: true });
    await runDataMigration(fixture, "Prepare");

    await writeFile(join(lockPath, "state.json"), JSON.stringify({
      schemaVersion: 3,
      phase: "migration-prepared",
      stateUpdatedAtUtc: "2000-01-01T00:00:00.0000000Z",
      relayPid: 2147483647,
      relayStartedAtUtc: "2000-01-01T00:00:00.0000000Z",
      installerPid: null,
      installerStartedAtUtc: null,
      installerPath: fixture.installerPath,
      installDir: fixture.installDir,
      workDir: fixture.workDir,
      backupRoot: fixture.backupRoot,
      migrationStatePath: fixture.migrationStatePath,
      migrationLogPath: fixture.migrationLogPath,
      legacyRuntimeHomePath: fixture.legacyRuntimeHomePath,
      targetUserDataPath: fixture.targetUserDataPath,
      targetRuntimeHomePath: fixture.targetRuntimeHomePath
    }), "utf8");

    await rename(fixture.backupPath, join(fixture.installDir, "data"));
    await runDataMigration(fixture, "Rollback");
    expect(existsSync(fixture.migrationStatePath)).toBe(false);
    expect(existsSync(lockPath)).toBe(true);

    await runRecovery(fixture);

    expect(await readFile(join(fixture.dataDir, "sentinel.txt"), "utf8")).toBe("keep-me");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("keeps a completed migration when recovery observes the crash before the relay phase update", async () => {
    const fixture = await createRelayFixture(0);
    const lockPath = join(fixture.root, "active.lock");
    await mkdir(fixture.backupRoot, { recursive: true });
    await rename(join(fixture.installDir, "data"), fixture.backupPath);
    await mkdir(lockPath, { recursive: true });
    await runDataMigration(fixture, "Prepare");
    await runDataMigration(fixture, "Complete");

    await writeFile(join(lockPath, "state.json"), JSON.stringify({
      schemaVersion: 3,
      phase: "installer-starting",
      stateUpdatedAtUtc: "2000-01-01T00:00:00.0000000Z",
      relayPid: 2147483647,
      relayStartedAtUtc: "2000-01-01T00:00:00.0000000Z",
      installerPid: null,
      installerStartedAtUtc: null,
      installerPath: fixture.installerPath,
      installDir: fixture.installDir,
      workDir: fixture.workDir,
      backupRoot: fixture.backupRoot,
      migrationStatePath: fixture.migrationStatePath,
      migrationLogPath: fixture.migrationLogPath,
      legacyRuntimeHomePath: fixture.legacyRuntimeHomePath,
      targetUserDataPath: fixture.targetUserDataPath,
      targetRuntimeHomePath: fixture.targetRuntimeHomePath
    }), "utf8");

    await runRecovery(fixture);

    expect(existsSync(join(fixture.installDir, "data"))).toBe(false);
    expect(await readFile(join(fixture.targetUserDataPath, "sentinel.txt"), "utf8")).toBe("keep-me");
    expect(JSON.parse(await readFile(fixture.migrationStatePath, "utf8"))).toMatchObject({
      phase: "awaiting-app-verification"
    });
    expect(existsSync(lockPath)).toBe(false);
  });

  it("clears only transient prepared-update markers for a stale state-less lock", async () => {
    const fixture = await createRelayFixture(0);
    const lockPath = join(fixture.root, "active.lock");
    await mkdir(lockPath, { recursive: true });
    await mkdir(`${join(fixture.targetUserDataPath, "prepared-required-update.json")}.lock`, { recursive: true });
    await writeFile(join(fixture.targetUserDataPath, "prepared-required-update.json"), "{}", "utf8");
    await writeFile(`${join(fixture.targetUserDataPath, "prepared-required-update.json")}.prompt`, "prompt", "utf8");
    const staleTimestamp = new Date(Date.now() - 3 * 60_000);
    await utimes(lockPath, staleTimestamp, staleTimestamp);

    await runRecovery(fixture);

    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(join(fixture.dataDir, "prepared-required-update.json"))).toBe(true);
    expect(existsSync(join(fixture.dataDir, "prepared-required-update.json.lock"))).toBe(false);
    expect(existsSync(join(fixture.dataDir, "prepared-required-update.json.prompt"))).toBe(false);
    expect(existsSync(join(fixture.dataDir, "prepared-required-update.json.attempt"))).toBe(true);
    expect(existsSync(join(fixture.targetUserDataPath, "prepared-required-update.json"))).toBe(true);
    expect(existsSync(`${join(fixture.targetUserDataPath, "prepared-required-update.json")}.lock`)).toBe(false);
    expect(existsSync(`${join(fixture.targetUserDataPath, "prepared-required-update.json")}.prompt`)).toBe(false);
  });

  it("recovers a stale direct-install lock after the old install data was already removed", async () => {
    const fixture = await createRelayFixture(0);
    const lockPath = join(fixture.root, "active.lock");
    await mkdir(lockPath, { recursive: true });
    await runDataMigration(fixture, "Prepare", "installer", join(fixture.installDir, "data"));
    await runDataMigration(fixture, "RequireRecovery", "installer", join(fixture.installDir, "data"));
    await rm(join(fixture.installDir, "data"), { recursive: true, force: true });
    const staleTimestamp = new Date(Date.now() - 3 * 60_000);
    await utimes(lockPath, staleTimestamp, staleTimestamp);

    await runRecovery(fixture);

    expect(await readFile(join(fixture.targetUserDataPath, "sentinel.txt"), "utf8")).toBe("keep-me");
    expect(JSON.parse(await readFile(fixture.migrationStatePath, "utf8"))).toMatchObject({
      phase: "prepared-for-retry"
    });
    expect(existsSync(lockPath)).toBe(false);
  });

  it("does not recover or clear a direct-install lock while its exact installer is still running", async () => {
    const fixture = await createRelayFixture(0);
    const lockPath = join(fixture.root, "active.lock");
    const pingPath = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "PING.EXE");
    const installer = spawn(pingPath, ["-n", "20", "127.0.0.1"], {
      windowsHide: true,
      stdio: "ignore"
    });
    helperProcesses.push(installer);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    expect(installer.pid).toBeGreaterThan(0);

    await mkdir(lockPath, { recursive: true });
    await writeFile(join(lockPath, "state.json"), JSON.stringify({
      schemaVersion: 3,
      owner: "installer",
      phase: "direct-migration-running",
      installerPid: installer.pid,
      installerPath: pingPath,
      installDir: fixture.installDir,
      targetUserDataPath: fixture.targetUserDataPath,
      targetRuntimeHomePath: fixture.targetRuntimeHomePath,
      createdAt: "2000-01-01T00:00:00.0000000Z"
    }), "utf8");
    const staleTimestamp = new Date(Date.now() - 3 * 60_000);
    await utimes(lockPath, staleTimestamp, staleTimestamp);

    await expect(runRecovery(fixture)).rejects.toMatchObject({ code: 2 });
    expect(existsSync(lockPath)).toBe(true);

    installer.kill();
    await new Promise<void>((resolvePromise) => {
      if (installer.exitCode !== null) {
        resolvePromise();
        return;
      }
      installer.once("exit", () => resolvePromise());
    });
    await runRecovery(fixture);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("keeps recovery locked while an installer from the pre-launch state boundary is running", async () => {
    const fixture = await createRelayFixture(0);
    const lockPath = join(fixture.root, "active.lock");
    const stagedInstallerPath = join(fixture.workDir, "installer-starting-boundary.exe");
    const pingPath = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "PING.EXE");

    await mkdir(fixture.backupRoot, { recursive: true });
    await rename(join(fixture.installDir, "data"), fixture.backupPath);
    await copyFile(pingPath, stagedInstallerPath);
    await mkdir(lockPath, { recursive: true });
    const stagedInstaller = spawn(stagedInstallerPath, ["-n", "20", "127.0.0.1"], { windowsHide: true, stdio: "ignore" });
    helperProcesses.push(stagedInstaller);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    expect(stagedInstaller.pid).toBeGreaterThan(0);

    await writeFile(join(lockPath, "state.json"), JSON.stringify({
      schemaVersion: 2,
      phase: "installer-starting",
      stateUpdatedAtUtc: new Date().toISOString(),
      relayPid: 2147483647,
      relayStartedAtUtc: "2000-01-01T00:00:00.0000000Z",
      installerPid: null,
      installerStartedAtUtc: null,
      installerPath: stagedInstallerPath,
      installDir: fixture.installDir,
      workDir: fixture.workDir,
      backupRoot: fixture.backupRoot
    }), "utf8");

    await expect(runRecovery(fixture)).rejects.toMatchObject({ code: 2 });
    expect(existsSync(fixture.backupPath)).toBe(true);
    expect(existsSync(join(fixture.installDir, "data"))).toBe(false);
    expect(existsSync(lockPath)).toBe(true);

    stagedInstaller.kill();
    await new Promise<void>((resolvePromise) => {
      if (stagedInstaller.exitCode !== null) {
        resolvePromise();
        return;
      }
      stagedInstaller.once("exit", () => resolvePromise());
    });
    await runRecovery(fixture);

    expect(await readFile(join(fixture.dataDir, "sentinel.txt"), "utf8")).toBe("keep-me");
    expect(existsSync(join(fixture.dataDir, "prepared-required-update.json.lock"))).toBe(false);
    expect(existsSync(join(fixture.dataDir, "prepared-required-update.json.prompt"))).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(fixture.workDir)).toBe(false);
  });

  it("recovers automatically after the relay and child installer are force-killed", async () => {
    const fixture = await createRelayFixture(0, { installerDelaySeconds: 20 });
    const powershellPath = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const relay = spawn(powershellPath, buildRelayArguments(fixture), { windowsHide: true, stdio: "ignore" });
    helperProcesses.push(relay);
    const statePath = join(fixture.root, "active.lock", "state.json");
    let installerPid = 0;
    const installerProcessName = basename(fixture.installerPath).replaceAll("'", "''");

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (existsSync(statePath) && existsSync(fixture.backupPath)) {
        try {
          const state = JSON.parse(await readFile(statePath, "utf8"));
          if (state.phase === "installer-starting") {
            const { stdout } = await execFile(powershellPath, [
              "-NoProfile",
              "-Command",
              `(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*${installerProcessName}*' } | Select-Object -First 1 -ExpandProperty ProcessId)`
            ], { timeout: 5_000, windowsHide: true });
            installerPid = Number.parseInt(stdout.trim(), 10);
            if (installerPid > 0) break;
          }
        } catch {
          // The relay updates state.json atomically; retry until the completed file is visible.
        }
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }

    expect(installerPid).toBeGreaterThan(0);
    relay.kill();
    try {
      process.kill(installerPid);
    } catch {
      // The child may have already terminated with the relay.
    }
    await new Promise<void>((resolvePromise) => {
      if (relay.exitCode !== null) {
        resolvePromise();
        return;
      }
      relay.once("exit", () => resolvePromise());
    });

    await runRecovery(fixture);

    expect(await readFile(join(fixture.dataDir, "sentinel.txt"), "utf8")).toBe("keep-me");
    expect(existsSync(join(fixture.root, "active.lock"))).toBe(false);
    expect(existsSync(fixture.workDir)).toBe(false);
    const log = await readFile(fixture.logPath, "utf8");
    expect(log).toContain("stale upgrade data restored");
  }, 30_000);
});
