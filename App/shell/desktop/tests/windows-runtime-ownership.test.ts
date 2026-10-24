import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { assertWindowsRuntimeOwnership, sharedWindowsRuntimeRoot, validateWindowsRuntimeOwnershipEvidence } from "../src/main/windows-runtime-ownership.js";
import { windowsUpdatePowerShellExecutable } from "../src/main/windows-update-validation.js";

const sid = "S-1-5-21-11-22-33-1001";
const otherSid = "S-1-5-21-11-22-33-1002";
const evidence = { currentSid: sid, ownerSid: sid, claimOwnerSid: sid, claimSid: sid, fresh: false };
const helperPath = fileURLToPath(new URL("../build/MemmyWindowsRuntimeOwnership.ps1", import.meta.url));
const readSource = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");

describe("Windows shared drive runtime ownership", () => {
  it.each(["D:\\MemmyData\\.memmy", "E:\\MemmyData\\.memmy", "d:/MemmyData/.memmy/"])("guards shared runtime %s", (path) => {
    expect(sharedWindowsRuntimeRoot(path)?.toLowerCase()).toMatch(/^[de]:\\memmydata$/);
  });

  it.each(["C:\\Users\\用户\\.memmy", "D:\\用户独立目录\\.memmy"])("keeps private profile %s free of shared-drive mutations", (path) => {
    const inspect = vi.fn();
    const readScript = vi.fn();
    expect(assertWindowsRuntimeOwnership(path, { inspect, readScript })).toBeNull();
    expect(inspect).not.toHaveBeenCalled();
    expect(readScript).not.toHaveBeenCalled();
  });

  it("preserves the supported legacy root and accepts fresh private root evidence", () => {
    expect(validateWindowsRuntimeOwnershipEvidence(evidence)).toEqual(evidence);
    expect(validateWindowsRuntimeOwnershipEvidence({ ...evidence, fresh: true }).fresh).toBe(true);
    const aadSid = "S-1-12-1-11-22-33-44";
    expect(validateWindowsRuntimeOwnershipEvidence({ currentSid: aadSid, ownerSid: aadSid, claimOwnerSid: aadSid, claimSid: aadSid, fresh: false }).currentSid).toBe(aadSid);
  });

  it.each(["ownerSid", "claimOwnerSid", "claimSid"])("refuses another account's %s", (field) => {
    expect(() => validateWindowsRuntimeOwnershipEvidence({ ...evidence, [field]: otherSid })).toThrow("独立盘");
  });

  it.each([null, {}, { ...evidence, ownerSid: null }, { ...evidence, currentSid: "unknown" }, { ...evidence, fresh: "yes" }])("fails closed for missing or unverifiable identity %j", (value) => {
    expect(() => validateWindowsRuntimeOwnershipEvidence(value)).toThrow("同一盘");
  });

  it("passes bundled ASAR source and Unicode paths to OS PowerShell before accepting proof", () => {
    const inspect = vi.fn((encoded: string) => {
      const command = Buffer.from(encoded, "base64").toString("utf16le");
      expect(command).toContain("# bundled guard");
      expect(command).toContain("-RuntimeHomePath 'D:\\MemmyData\\.memmy'");
      return { status: 0, stdout: JSON.stringify(evidence), stderr: "" };
    });
    expect(assertWindowsRuntimeOwnership("D:\\MemmyData\\.memmy", { inspect, readScript: () => "# bundled guard" })).toEqual(evidence);
    expect(inspect).toHaveBeenCalledOnce();
  });

  it.each([
    { status: 5, stdout: "", stderr: "wrong owner" },
    { status: null, stdout: "", stderr: "", error: new Error("timeout") },
    { status: 0, stdout: "not json", stderr: "" },
    { status: 0, stdout: JSON.stringify({ ...evidence, ownerSid: otherSid }), stderr: "" },
  ])("does not continue startup after native ownership verification fails %j", (result) => {
    expect(() => assertWindowsRuntimeOwnership("E:\\MemmyData\\.memmy", { readScript: () => "# guard", inspect: () => result })).toThrow("Choose C:");
  });

  it("refuses missing packaged guard source", () => {
    const inspect = vi.fn();
    expect(() => assertWindowsRuntimeOwnership("D:\\MemmyData\\.memmy", { inspect, readScript: () => { throw new Error("missing asset"); } })).toThrow("独立盘");
    expect(inspect).not.toHaveBeenCalled();
  });

  it("covers installer probes, startup environment, relay reads and recovery entry points", () => {
    const main = readSource("../src/main/main.ts");
    const configure = main.slice(main.indexOf("function configureAppIdentity()"), main.indexOf("function resolveDesktopUserDataPath("));
    expect(configure.indexOf("assertWindowsRuntimeOwnership(")).toBeLessThan(configure.indexOf('app.setPath("userData"'));
    expect(configure.indexOf("assertWindowsRuntimeOwnership(")).toBeLessThan(configure.indexOf("process.env.MEMMY_CONFIG ="));
    expect(configure).toContain("dialog.showErrorBox(");
    expect(configure).toContain("app.exit(1)");
    const nsis = readSource("../build/installer-win-unsigned.nsh");
    const validate = nsis.slice(nsis.indexOf("Function MemmyValidateSelectedDirectories"), nsis.indexOf("Function MemmyExtractDataMigrationScript"));
    expect(validate.indexOf("MemmyWindowsRuntimeOwnership.ps1")).toBeLessThan(validate.indexOf("Call MemmyProbeWritableDirectory"));
    expect(validate).toContain("选择同一盘上的其他文件夹无法隔离数据");
    expect(validate).toContain("我确认风险，仍要继续安装到该盘");
    expect(validate).toContain("MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2");
    expect(validate).toContain("-AcceptDriveRisk");
    expect(validate.indexOf("${If} ${Silent}")).toBeLessThan(validate.indexOf("memmy_validate_ownership_confirm:"));
    const guard = readSource("../build/MemmyWindowsRuntimeOwnership.ps1");
    const freshInit = guard.slice(guard.indexOf("if ($fresh)"), guard.indexOf("$ownerSid = Get-MemmyOwnershipSid"));
    expect(freshInit).toContain("New-Item -ItemType Directory -Path $staging");
    expect(freshInit).toContain("New-MemmyPrivateAccessAcl $currentSid -Directory");
    expect(freshInit).not.toContain("New-MemmyPrivateOwnershipAcl");
    expect(guard).toContain("accepted-shared-drive-risk.json");
    expect(guard).toContain("if ($_.Exception.Message -like '*reparse*') { throw }");
    expect(nsis.match(/File \/oname=MemmyWindowsRuntimeOwnership.ps1/g)).toHaveLength(4);
    const migration = readSource("../build/MemmyWindowsDataMigration.ps1");
    expect(migration).toContain("try {\n  Invoke-MemmyRuntimeOwnershipGuard $TargetRuntimeHomePath\n  if ($AcquireLock)");
    expect(migration).toContain("Invoke-MemmyRuntimeOwnershipGuard $normalizedValue\n        return $normalizedValue");
    expect(migration).toContain("Invoke-MemmyRuntimeOwnershipGuard $Path\n  $configPath");
    const relay = readSource("../build/MemmyWindowsUpgradeRelay.ps1");
    expect(relay).toContain("try {\n  Invoke-MemmyRuntimeOwnershipGuard $targetRuntimeHomePath\n  New-Item");
    const recovery = readSource("../build/MemmyWindowsUpgradeRecovery.ps1");
    expect(recovery).toContain("try {\n  Invoke-MemmyRuntimeOwnershipGuard $expectedTargetRuntimeHomePath\n  if");
    expect(recovery).toContain("Invoke-MemmyRuntimeOwnershipGuard $directExpectedRuntimeHomePath");
    const check = readSource("../build/MemmyWindowsStandardUpgradeCheck.ps1");
    expect(check.indexOf("Invoke-MemmyRuntimeOwnershipGuard $normalizedTargetRuntimeHomePath")).toBeLessThan(check.indexOf("$targetRuntimeHasData ="));
  });

  it("keeps another active Windows helper's lock and prompt intact", () => {
    const main = readSource("../src/main/main.ts");
    const helper = main.slice(main.indexOf("function createWindowsUpdateInstallScript("), main.indexOf("function shouldQuitForManualUpdateInstall("));
    expect(helper).toContain("$lockAcquired = $false");
    expect(helper).toContain("New-Item -ItemType Directory -Path $lockPath -ErrorAction Stop | Out-Null\n      $lockAcquired = $true");
    expect(helper).toContain("if ($lockAcquired -and $lockPath)");
    expect(helper).toContain("if ($lockAcquired -and $promptMarkerPath)");
  });

  it("terminates ownership rejection before source preservation, restore, lock cleanup or reopening", () => {
    const migration = readSource("../build/MemmyWindowsDataMigration.ps1");
    const failure = migration.slice(migration.lastIndexOf("catch {\n  $migrationError"));
    expect(failure.indexOf("if ($ownershipDenied)")).toBeLessThan(failure.indexOf("Preserve-FailedDirectMigrationSource"));
    expect(failure.indexOf("exit 5")).toBeLessThan(failure.indexOf("Preserve-FailedDirectMigrationSource"));
    const relay = readSource("../build/MemmyWindowsUpgradeRelay.ps1");
    expect(relay).toContain("if (-not $ownershipDenied -and -not $upgradeVerified)");
    expect(relay).toContain("if (-not $ownershipDenied -and $lockAcquired");
    const relayFailure = relay.slice(relay.indexOf("} catch {\n  $ownershipDenied ="));
    expect(relayFailure.indexOf("exit 5")).toBeLessThan(relayFailure.indexOf("Restore-MemmyData"));
    const recovery = readSource("../build/MemmyWindowsUpgradeRecovery.ps1");
    const recoveryFailure = recovery.slice(recovery.indexOf("} catch {\n  $ownershipDenied ="));
    expect(recoveryFailure.indexOf("exit 5")).toBeLessThan(recoveryFailure.indexOf("$lockAge ="));
    const check = readSource("../build/MemmyWindowsStandardUpgradeCheck.ps1");
    const checkFailure = check.slice(check.lastIndexOf("} catch {"));
    expect(checkFailure.indexOf("MEMMY_WINDOWS_DATA_OWNERSHIP:")).toBeLessThan(checkFailure.indexOf("relay-required:"));
    expect(checkFailure.indexOf("exit 2")).toBeLessThan(checkFailure.indexOf("relay-required:"));
    expect(recovery).toContain("if ($migrationDetail -like '*MEMMY_WINDOWS_DATA_OWNERSHIP:*') { throw $migrationDetail }");
    expect(relay).toContain("if ($migrationDetail -like '*MEMMY_WINDOWS_DATA_OWNERSHIP:*') { throw $migrationDetail }");
    const guard = readSource("../build/MemmyWindowsRuntimeOwnership.ps1");
    expect(guard.indexOf("$claimHandle = [System.IO.File]::Open")).toBeLessThan(guard.indexOf("$claimOwnerSid = Get-MemmyOwnershipSid"));
    expect(guard).toContain("$claim = $reader.ReadToEnd() | ConvertFrom-Json");
  });
});

describe.runIf(process.platform === "win32")("native Windows SID, ownership claim and private ACL", () => {
  function run(body: string) {
    const command = `$ErrorActionPreference = 'Stop'\n. '${helperPath.replaceAll("'", "''")}' -LibraryOnly\n${body}`;
    return spawnSync(windowsUpdatePowerShellExecutable(), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], { windowsHide: true, encoding: "utf8", timeout: 30_000 });
  }

  it("initializes a genuinely fresh private root, then reuses its protected claim", () => {
    const parent = mkdtempSync(join(tmpdir(), "memmy-sid-fresh-"));
    const root = join(parent, "数据").replaceAll("'", "''");
    try {
      const result = run(`$first = Assert-MemmyRuntimeRootOwnership '${root}'\n$second = Assert-MemmyRuntimeRootOwnership '${root}'\n$acl = Get-Acl -LiteralPath '${root}'\n@{ first=$first; second=$second; protected=$acl.AreAccessRulesProtected } | ConvertTo-Json -Depth 4 -Compress`);
      expect(result.status, result.stderr).toBe(0);
      const parsed = JSON.parse(result.stdout.trim());
      expect(parsed.first.fresh).toBe(true);
      expect(parsed.second.fresh).toBe(false);
      expect(parsed.protected).toBe(true);
      expect(validateWindowsRuntimeOwnershipEvidence(parsed.first).ownerSid).toBe(parsed.first.currentSid);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });

  it("preserves current-user legacy config while adding a claim", () => {
    const parent = mkdtempSync(join(tmpdir(), "memmy-sid-legacy-"));
    const root = join(parent, "legacy").replaceAll("'", "''");
    try {
      const result = run(`[System.IO.Directory]::CreateDirectory('${root}', (New-MemmyPrivateOwnershipAcl ([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value) -Directory)) | Out-Null\n[System.IO.File]::WriteAllText((Join-Path '${root}' 'config.yaml'), 'preserve legacy')\n$proof = Assert-MemmyRuntimeRootOwnership '${root}'\n@{ proof=$proof; config=[System.IO.File]::ReadAllText((Join-Path '${root}' 'config.yaml')) } | ConvertTo-Json -Depth 4 -Compress`);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toMatchObject({ proof: { fresh: false }, config: "preserve legacy" });
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });

  it.each([otherSid, ""])("refuses a legacy root with wrong or missing native owner %s before claiming it", (owner) => {
    const parent = mkdtempSync(join(tmpdir(), "memmy-sid-refuse-"));
    const root = parent.replaceAll("'", "''");
    try {
      const result = run(`function Get-MemmyOwnershipSid([string]$Path) { return '${owner}' }\n$refused=$false\ntry { Assert-MemmyRuntimeRootOwnership '${root}' | Out-Null } catch { $refused=$true }\n@{ refused=$refused; claimExists=(Test-Path -LiteralPath (Join-Path '${root}' '.memmy-windows-owner.json')) } | ConvertTo-Json -Compress`);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({ refused: true, claimExists: false });
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });

  it("refuses another account's claim without overwriting it", () => {
    const parent = mkdtempSync(join(tmpdir(), "memmy-sid-claim-"));
    const root = join(parent, "fresh").replaceAll("'", "''");
    try {
      const result = run(`Assert-MemmyRuntimeRootOwnership '${root}' | Out-Null\n$claimPath=Join-Path '${root}' '.memmy-windows-owner.json'\n[System.IO.File]::WriteAllText($claimPath, '{"schemaVersion":1,"windowsSid":"${otherSid}"}')\n$refused=$false\ntry { Assert-MemmyRuntimeRootOwnership '${root}' | Out-Null } catch { $refused=$true }\n@{ refused=$refused; sid=(Get-Content -LiteralPath $claimPath -Raw | ConvertFrom-Json).windowsSid } | ConvertTo-Json -Compress`);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({ refused: true, sid: otherSid });
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });

  it("rejects a directory junction before writing any claim into its target", () => {
    const parent = mkdtempSync(join(tmpdir(), "memmy-sid-junction-"));
    const path = parent.replaceAll("'", "''");
    try {
      const result = run(`$target=Join-Path '${path}' 'target'\n$alias=Join-Path '${path}' 'alias'\nNew-Item -ItemType Directory -Path $target | Out-Null\nNew-Item -ItemType Junction -Path $alias -Target $target | Out-Null\n$refused=$false\ntry { Assert-MemmyRuntimeRootOwnership $alias | Out-Null } catch { $refused=$true }\n@{ refused=$refused; claimExists=(Test-Path -LiteralPath (Join-Path $target '.memmy-windows-owner.json')) } | ConvertTo-Json -Compress`);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({ refused: true, claimExists: false });
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });

  it.each(["MemmyWindowsDataMigration.ps1", "MemmyWindowsUpgradeRelay.ps1", "MemmyWindowsUpgradeRecovery.ps1"])("injected ownership failure in %s preserves locks and skips all fallback actions", (name) => {
    const parent = mkdtempSync(join(tmpdir(), "memmy-sid-denied-"));
    const sentinel = join(parent, "unsafe-action");
    const lock = join(parent, "active.lock");
    mkdirSync(lock);
    const source = readSource(`../build/${name}`);
    const starts = ["try {\n  Invoke-MemmyRuntimeOwnershipGuard $TargetRuntimeHomePath", "try {\n  Invoke-MemmyRuntimeOwnershipGuard $targetRuntimeHomePath", "try {\n  Invoke-MemmyRuntimeOwnershipGuard $expectedTargetRuntimeHomePath"];
    const index = starts.map((start) => source.indexOf(start)).find((value) => value >= 0)!;
    const escapedSentinel = sentinel.replaceAll("'", "''");
    const escapedLock = lock.replaceAll("'", "''");
    const prefix = `$ErrorActionPreference='Stop'
$TargetRuntimeHomePath='D:\\MemmyData\\.memmy'
$expectedTargetRuntimeHomePath=$TargetRuntimeHomePath
$ownershipDenied=$false
$lockAcquired=$false
$lockAcquiredHere=$false
$upgradeVerified=$false
$migrationPrepared=$false
$migrationCompleted=$false
$migrationRolledBack=$false
$dataRestored=$false
$LockPath='${escapedLock}'
function Invoke-MemmyRuntimeOwnershipGuard { throw 'MEMMY_WINDOWS_DATA_OWNERSHIP: wrong Windows account' }
function Write-MemmyUpgradeLog { }
function Write-MemmyUpgradeRecoveryLog { }
function Write-MigrationLog { }
function Preserve-FailedDirectMigrationSource { [System.IO.File]::WriteAllText('${escapedSentinel}', 'preserved unsafe source') }
function Restore-MemmyData { [System.IO.File]::WriteAllText('${escapedSentinel}', 'restored unsafe source') }
function Start-MemmyInstalledApp { [System.IO.File]::WriteAllText('${escapedSentinel}', 'reopened unsafe app') }
`;
    try {
      const result = spawnSync(windowsUpdatePowerShellExecutable(), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(prefix + source.slice(index), "utf16le").toString("base64")], { windowsHide: true, encoding: "utf8", timeout: 30_000 });
      expect(result.status, result.stderr).toBe(5);
      expect(existsSync(sentinel)).toBe(false);
      expect(existsSync(lock)).toBe(true);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });

  it("a duplicate background updater leaves the active helper's lock and prompt untouched", () => {
    const parent = mkdtempSync(join(tmpdir(), "memmy-update-duplicate-"));
    const marker = join(parent, "marker.json");
    const helperPath = join(parent, "duplicate.ps1");
    mkdirSync(`${marker}.lock`);
    writeFileSync(`${marker}.prompt`, "active prompt");
    const main = readSource("../src/main/main.ts");
    const functionSource = main.slice(main.indexOf("function createWindowsUpdateInstallScript("), main.indexOf("function shouldQuitForManualUpdateInstall("));
    const script = functionSource.slice(functionSource.indexOf("return `") + 8, functionSource.lastIndexOf("`;"))
      .replace("${createWindowsUpdateVerificationScript(verification)}", "$MemmyInstallerVerificationHandle=$null");
    writeFileSync(helperPath, Buffer.from(`\uFEFF${script}`, "utf16le"));
    try {
      const result = spawnSync(windowsUpdatePowerShellExecutable(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helperPath, "-MarkerPath", marker, "-LogPath", join(parent, "update.log")], { windowsHide: true, encoding: "utf8", timeout: 30_000 });
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(`${marker}.lock`)).toBe(true);
      expect(readFileSync(`${marker}.prompt`, "utf8")).toBe("active prompt");
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });
});
