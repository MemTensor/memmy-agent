import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const describeOnWindows = process.platform === "win32" ? describe : describe.skip;
const scriptPath = fileURLToPath(new URL("../build/MemmyWindowsStandardUpgradeCheck.ps1", import.meta.url));
const installerIncludePath = fileURLToPath(new URL("../build/installer-win-unsigned.nsh", import.meta.url));
const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describeOnWindows("Windows standard upgrade safety check", () => {
  it("allows a completed external-v1 installation", () => {
    const fixture = createFixture();

    const result = runCheck(fixture);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("standard-upgrade-safe");
  });

  it("routes an existing installation to relay when the final install directory changes", () => {
    const fixture = createFixture();
    fixture.targetInstallDir = join(fixture.root, "other-drive", "Memmy");

    const result = runCheck(fixture);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("relay-required:installation target differs from the installed application");
  });

  it("blocks relocation when the selected target already contains another Memmy executable", () => {
    const fixture = createFixture();
    fixture.targetInstallDir = join(fixture.root, "other-drive", "Memmy");
    mkdirSync(fixture.targetInstallDir, { recursive: true });
    copyFileSync(fixture.installedExePath, join(fixture.targetInstallDir, "Memmy.exe"));

    const result = runCheck(fixture);

    expect(result.status).toBe(2);
    expect(result.stdout).toContain("installation-blocked:selected target already contains Memmy.exe");
  });

  it("blocks relocation when the selected drive already contains runtime data", () => {
    const fixture = createFixture();
    fixture.targetInstallDir = join(fixture.root, "other-drive", "Memmy");
    fixture.targetRuntimeHomePath = join(fixture.root, "other-drive", "MemmyData", ".memmy");
    writeFile(join(fixture.targetRuntimeHomePath, "config.yaml"), "existing-runtime");

    const result = runCheck(fixture);

    expect(result.status).toBe(2);
    expect(result.stdout).toContain("installation-blocked:selected installation drive already contains Memmy runtime data");
  });

  it("allows an empty legacy data directory because it contains no data to preserve", () => {
    const fixture = createFixture();
    mkdirSync(join(fixture.installDir, "data"));

    expect(runCheck(fixture).status).toBe(0);
  });

  it("allows a clean reinstall without an executable when an external-v1 record remains", () => {
    const fixture = createFixture();
    rmSync(fixture.installedExePath);

    const result = runCheck(fixture, true);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("standard-install-safe");
  });

  it("requires relay when no executable remains but an install-local backup record is authoritative", () => {
    const fixture = createFixture();
    const failedBackup = join(`${fixture.installDir}.memmy-migration-failed`, "20260825120000-0123456789abcdef0123456789abcdef", "data-backup");
    rmSync(fixture.installedExePath);
    writeFile(join(failedBackup, "Memmy", "app.sqlite"), "legacy");
    updateRecord(fixture, {
      dataLayoutGeneration: "install-local-v1",
      sourceDataPath: failedBackup,
      sourceGeneration: "legacy-install:test",
    });

    const result = runCheck(fixture, true);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("relay-required:");
  });

  it.each([
    ["missing installation record", (fixture: Fixture) => rmSync(fixture.installationRecordPath)],
    ["damaged installation record", (fixture: Fixture) => writeFileSync(fixture.installationRecordPath, "{broken", "utf8")],
    ["mismatched install directory", (fixture: Fixture) => updateRecord(fixture, { installDir: join(fixture.root, "other-install") })],
    ["account data inside the install directory", (fixture: Fixture) => updateRecord(fixture, { userDataPath: join(fixture.installDir, "data", "Memmy") })],
    ["runtime data inside the install directory", (fixture: Fixture) => updateRecord(fixture, { runtimeHomePath: join(fixture.installDir, "data", ".memmy") })],
    ["unfinished migration state", (fixture: Fixture) => writeJson(fixture.migrationStatePath, { phase: "prepared" })],
    ["installer inside the install directory", (fixture: Fixture) => {
      fixture.installerPath = join(fixture.installDir, "data", "update.exe");
      writeFile(fixture.installerPath, "installer");
    }],
    ["legacy data that still needs preservation", (fixture: Fixture) => writeFile(join(fixture.installDir, "data", "Memmy", "app.sqlite"), "legacy")],
    ["installed version mismatch", (fixture: Fixture) => updateRecord(fixture, { appVersion: "999.0.0" })],
    ["string schema version", (fixture: Fixture) => updateRecord(fixture, { schemaVersion: "1" })],
    ["drive-relative data path", (fixture: Fixture) => updateRecord(fixture, { runtimeHomePath: "C:relative-runtime" })],
    ["rooted-relative data path", (fixture: Fixture) => updateRecord(fixture, { runtimeHomePath: "\\relative-runtime" })],
  ])("requires relay for %s", (_name, mutate) => {
    const fixture = createFixture();
    mutate(fixture);

    const result = runCheck(fixture);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("relay-required:");
  });

  it("requires both recorded external paths to be absolute", () => {
    const fixture = createFixture();
    updateRecord(fixture, { runtimeHomePath: ".memmy" });

    expect(runCheck(fixture).status).toBe(1);
  });

  it("requires the recorded runtime path to match the canonical target", () => {
    const fixture = createFixture();
    const unrelatedPath = join(fixture.root, "unrelated-runtimeHomePath");
    mkdirSync(unrelatedPath, { recursive: true });
    updateRecord(fixture, { runtimeHomePath: unrelatedPath });

    const result = runCheck(fixture);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("recorded runtimeHomePath does not match the expected data layout");
  });

  it("requires the recorded user-data path to match the canonical target", () => {
    const fixture = createFixture();
    const unrelatedPath = join(fixture.root, "unrelated-userDataPath");
    mkdirSync(unrelatedPath, { recursive: true });
    updateRecord(fixture, { userDataPath: unrelatedPath });

    const result = runCheck(fixture);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("recorded userDataPath does not match the expected data layout");
  });

  it("rejects an external path that crosses a junction", () => {
    const fixture = createFixture();
    const target = join(fixture.installDir, "aliased-user-data");
    const junction = join(fixture.root, "junction-user-data");
    mkdirSync(target, { recursive: true });
    symlinkSync(target, junction, "junction");
    updateRecord(fixture, { userDataPath: junction });

    const result = runCheck(fixture);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("reparse point");
  });

  it("keeps relayed children non-recursive and evaluates installed layouts without an --updated gate", () => {
    const source = readFile(installerIncludePath, "utf8");
    const relayedMarker = source.indexOf('${GetOptions} $R0 "--memmy-upgrade-relayed" $R1');
    const safetyCheck = source.indexOf("Call MemmyEvaluateStandardUpgradeSafety");
    const relayLaunch = source.indexOf("ExecShell \"open\" \"$R5\"");

    expect(relayedMarker).toBeGreaterThanOrEqual(0);
    expect(relayedMarker).toBeLessThan(safetyCheck);
    expect(safetyCheck).toBeLessThan(relayLaunch);
    expect(source).not.toContain('${GetOptions} $R0 "--updated" $R1');
    expect(source).not.toContain('IfFileExists "$MemmyInstalledExePath" 0 memmy_relay_done');
    expect(source).toContain('StrCmp $MemmyStandardUpgradeSafe "1" memmy_relay_done');
    expect(source).toContain('StrCmp $MemmyStandardUpgradeSafe "1" memmy_check_app_running_done');
    expect(source).toContain("MemmyWindowsStandardUpgradeCheck.ps1");
    expect(source).toContain("-AllowMissingExecutable");
    expect(source).toMatch(/memmy_standard_check_safe:[\s\S]*StrCmp \$R4 "-AllowMissingExecutable" memmy_standard_check_fresh/u);
  });

  it("evaluates routing after the interactive directory page and keeps relay child UI mode explicit", () => {
    const source = readFile(installerIncludePath, "utf8");
    const pageValidation = source.indexOf("Function MemmyValidateInstallPage");
    const directoryValidation = source.indexOf("Call MemmyValidateSelectedDirectories", pageValidation);
    const finalRoute = source.indexOf("Call MemmyRelayLegacyUpgrade", directoryValidation);

    expect(pageValidation).toBeGreaterThanOrEqual(0);
    expect(directoryValidation).toBeGreaterThan(pageValidation);
    expect(finalRoute).toBeGreaterThan(directoryValidation);
    expect(source).toContain('-TargetInstallDir $\\"$MemmySelectedInstallDir$\\"');
    expect(source).toContain('-SourceInstallDir $\\"$MemmyUpgradeSourceInstallDir$\\"');
    expect(source).toContain("-InstallerMode $MemmyRelayInstallerMode");
  });
});

interface Fixture {
  root: string;
  installDir: string;
  installedExePath: string;
  installerPath: string;
  installationRecordPath: string;
  migrationStatePath: string;
  targetInstallDir: string;
  targetUserDataPath: string;
  targetRuntimeHomePath: string;
  record: Record<string, unknown>;
}

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "memmy-standard-upgrade-check-"));
  fixtureRoots.push(root);
  const installDir = join(root, "install", "Memmy");
  const installedExePath = join(installDir, "Memmy.exe");
  const installerPath = join(root, "downloads", "Memmy-update.exe");
  const installationRecordPath = join(root, "local", "Memmy", "data-layout", "last-install.json");
  const migrationStatePath = join(root, "local", "Memmy", "data-migration", "state.json");
  const userDataPath = join(root, "roaming", "Memmy");
  const runtimeHomePath = join(root, "runtime", ".memmy");
  mkdirSync(installDir, { recursive: true });
  copyFileSync(process.env.ComSpec ?? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"), installedExePath);
  writeFile(installerPath, "installer");
  mkdirSync(userDataPath, { recursive: true });
  mkdirSync(runtimeHomePath, { recursive: true });
  const appVersion = readProductVersion(installedExePath);
  const fixture: Fixture = {
    root,
    installDir,
    installedExePath,
    installerPath,
    installationRecordPath,
    migrationStatePath,
    targetInstallDir: installDir,
    targetUserDataPath: userDataPath,
    targetRuntimeHomePath: runtimeHomePath,
    record: {
      schemaVersion: 1,
      dataLayoutGeneration: "external-v1",
      installDir,
      userDataPath,
      runtimeHomePath,
      appVersion,
    },
  };
  writeJson(installationRecordPath, fixture.record);
  return fixture;
}

function updateRecord(fixture: Fixture, updates: Record<string, unknown>) {
  fixture.record = { ...fixture.record, ...updates };
  writeJson(fixture.installationRecordPath, fixture.record);
}

function runCheck(fixture: Fixture, allowMissingExecutable = false) {
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", scriptPath,
    "-InstallDir", fixture.installDir,
    "-TargetInstallDir", fixture.targetInstallDir,
    "-TargetUserDataPath", fixture.targetUserDataPath,
    "-TargetRuntimeHomePath", fixture.targetRuntimeHomePath,
    "-InstalledExePath", fixture.installedExePath,
    "-InstallerPath", fixture.installerPath,
    "-InstallationRecordPath", fixture.installationRecordPath,
    "-MigrationStatePath", fixture.migrationStatePath,
  ];
  if (allowMissingExecutable) args.push("-AllowMissingExecutable");
  return spawnSync("powershell.exe", args, { encoding: "utf8" });
}

function readProductVersion(executablePath: string): string {
  const escapedPath = executablePath.replaceAll("'", "''");
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `[System.Diagnostics.FileVersionInfo]::GetVersionInfo('${escapedPath}').ProductVersion`,
  ], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(result.stderr || "Cannot read fixture product version");
  }
  return result.stdout.trim();
}

function readFile(path: string): string {
  return readFileSync(path, "utf8");
}

function writeFile(path: string, contents: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

function writeJson(path: string, value: unknown) {
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
