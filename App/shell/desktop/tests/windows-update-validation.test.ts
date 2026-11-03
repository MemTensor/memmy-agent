import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createWindowsUpdateInspectionScript,
  createWindowsUpdateVerificationScript,
  normalizeWindowsUpdateVersion,
  unsignedWindowsTestPackage,
  validateWindowsUpdateInspection,
  validateWindowsUpdateInstaller,
  windowsUpdatePowerShellFile,
  windowsUpdatePowerShellExecutable,
  type WindowsUpdateInspection,
  type WindowsUpdateValidationOptions,
} from "../src/main/windows-update-validation.js";

const publisher = "CN=MemTensor, O=MemTensor, C=CN";
const digest = "a".repeat(64);
const options: WindowsUpdateValidationOptions = {
  installerPath: "D:\\中文目录\\updates\\Memmy-1.2.2.exe",
  currentExecutable: "D:\\普通用户\\Memmy\\Memmy.exe",
  currentVersion: "1.2.1",
  expectedVersion: "1.2.2",
  packagedManifest: JSON.stringify({ edition: "cn", signing: "signed" }),
};

function inspection(): WindowsUpdateInspection {
  return {
    current: { signatureStatus: "Valid", signerSubject: publisher, productName: "Memmy", productVersion: "1.2.1.0", fileVersion: "1.2.1" },
    installer: { signatureStatus: "Valid", signerSubject: publisher, productName: "Memmy", productVersion: "1.2.2", fileVersion: "1.2.2" },
  };
}

describe("Windows updater identity and exact version checks", () => {
  it("accepts a newer valid installer signed by the installed app's publisher", () => {
    expect(validateWindowsUpdateInspection(inspection(), options)).toEqual({ signerSubject: publisher, version: "1.2.2" });
  });

  it.each(["NotSigned", "HashMismatch", "NotTrusted", "UnknownError", "NotSupportedFileFormat"])(
    "rejects a %s installer for a signed production app", (signatureStatus) => {
      const report = inspection();
      report.installer.signatureStatus = signatureStatus;
      expect(() => validateWindowsUpdateInspection(report, options)).toThrow("signature must match");
    }
  );

  it("rejects a valid signature from another publisher", () => {
    const report = inspection();
    report.installer.signerSubject = "CN=Other Publisher";
    expect(() => validateWindowsUpdateInspection(report, options)).toThrow("signature must match");
  });

  it.each(["NotSigned", "HashMismatch", "NotTrusted"])("fails closed when the installed signing identity is %s", (signatureStatus) => {
    const report = inspection();
    report.current.signatureStatus = signatureStatus;
    expect(() => validateWindowsUpdateInspection(report, options)).toThrow("Cannot verify the installed");
  });

  it("permits unsigned local testing only with the explicit packaged unsigned marker", () => {
    const report = inspection();
    report.current.signatureStatus = "NotSigned";
    report.current.signerSubject = null;
    report.installer.signatureStatus = "NotSigned";
    report.installer.signerSubject = null;
    expect(validateWindowsUpdateInspection(report, { ...options, packagedManifest: '{"signing":"unsigned"}' })).toEqual({ signerSubject: null, version: "1.2.2" });
    for (const manifest of [null, "{}", "malformed", '{"signing":"signed"}']) {
      expect(() => validateWindowsUpdateInspection(report, { ...options, packagedManifest: manifest })).toThrow("Cannot verify");
    }
  });

  it("never weakens a valid signed current app even when its package marker says unsigned", () => {
    const report = inspection();
    report.installer.signatureStatus = "NotSigned";
    expect(() => validateWindowsUpdateInspection(report, { ...options, packagedManifest: '{"signing":"unsigned"}' })).toThrow("signature must match");
  });

  it("rejects a damaged signature even for an unsigned local package", () => {
    const report = inspection();
    report.current.signatureStatus = "NotSigned";
    report.installer.signatureStatus = "HashMismatch";
    expect(() => validateWindowsUpdateInspection(report, { ...options, packagedManifest: '{"signing":"unsigned"}' })).toThrow("invalid signature");
  });

  it("does not consult environment switches for the unsigned exception", () => {
    vi.stubEnv("MEMMY_PACKAGE_SIGNING", "unsigned");
    try { expect(unsignedWindowsTestPackage('{"signing":"signed"}')).toBe(false); }
    finally { vi.unstubAllEnvs(); }
  });

  it.each(["OtherApp", ""])("rejects installer product identity %s", (productName) => {
    const report = inspection();
    report.installer.productName = productName;
    expect(() => validateWindowsUpdateInspection(report, options)).toThrow("not a Memmy installer");
  });

  it.each(["1.2.1", "1.2.0", "1.2.0-rc.10"])("rejects update version %s from installed 1.2.1", (productVersion) => {
    const report = inspection();
    report.installer.productVersion = productVersion;
    expect(() => validateWindowsUpdateInspection(report, { ...options, expectedVersion: undefined })).toThrow("Refusing a Windows update");
  });

  it.each(["1.2.10", "1.2.1-rc.2"])("does not treat actual %s as expected 1.2.1", (productVersion) => {
    const report = inspection();
    report.current.fileVersion = "1.2.0";
    report.installer.productVersion = productVersion;
    expect(() => validateWindowsUpdateInspection(report, { ...options, currentVersion: "1.2.0", expectedVersion: "1.2.1" })).toThrow("does not match expected");
  });

  it.each([
    ["1.2.4", "1.2.401"],
    ["1.2.401", "1.2.402"],
    ["1.2.402", "1.2.5"],
    ["1.2.5", "1.2.6"],
    ["1.2.6", "1.3.0"],
    ["1.2.10", "1.2.9"],
  ])("accepts %s to %s but rejects the reverse update", (older, newer) => {
    const report = inspection();
    report.current.fileVersion = older;
    report.installer.productVersion = newer;
    expect(validateWindowsUpdateInspection(report, { ...options, currentVersion: older, expectedVersion: newer })).toMatchObject({ version: newer });
    report.current.fileVersion = newer;
    report.installer.productVersion = older;
    expect(() => validateWindowsUpdateInspection(report, { ...options, currentVersion: newer, expectedVersion: older })).toThrow("Refusing a Windows update");
  });

  it("preserves prerelease identity and orders RC versions by character", () => {
    const report = inspection();
    report.current.productVersion = "1.2.2.0";
    report.current.fileVersion = "1.2.2-rc.10";
    report.installer.productVersion = "1.2.2-rc.2";
    expect(validateWindowsUpdateInspection(report, { ...options, currentVersion: "1.2.2-rc.10", expectedVersion: "1.2.2-rc.2" })).toMatchObject({ version: "1.2.2-rc.2" });
  });

  it("allows a stable executable to install an exact RC without interpreting numeric ProductVersion as its release", () => {
    const report = inspection();
    report.installer.productVersion = "1.2.2-rc.1";
    report.installer.fileVersion = "1.2.2-rc.1";
    expect(validateWindowsUpdateInspection(report, { ...options, expectedVersion: "1.2.2-rc.1" }))
      .toMatchObject({ version: "1.2.2-rc.1" });
    const installed = { ...report.current, productVersion: "1.2.2.0", fileVersion: "1.2.2-rc.1" };
    report.current = installed;
    report.installer.productVersion = "1.2.2-rc.2";
    expect(validateWindowsUpdateInspection(report, { ...options, currentVersion: "1.2.2-rc.1", expectedVersion: "1.2.2-rc.2" }))
      .toMatchObject({ version: "1.2.2-rc.2" });
  });

  it("normalizes the Windows stable version's zero revision without accepting a prefix", () => {
    const report = inspection();
    report.current.productVersion = "1.2.1.0";
    report.current.fileVersion = "1.2.1.0";
    report.installer.productVersion = "1.2.2.0";
    expect(validateWindowsUpdateInspection(report, options).version).toBe("1.2.2");
    expect(normalizeWindowsUpdateVersion("1.2.2.1")).toBeNull();
    expect(normalizeWindowsUpdateVersion("1.2.2junk")).toBeNull();
    expect(normalizeWindowsUpdateVersion("1.2.2-rc.01")).toBeNull();
  });

  it("rejects an app whose actual installed version differs from the running version", () => {
    const report = inspection();
    report.current.fileVersion = "1.0.0";
    expect(() => validateWindowsUpdateInspection(report, options)).toThrow("does not match the running app");
  });

  it("pins inspected bytes and passes literal Unicode paths to the fake PowerShell inspector", async () => {
    const inspect = vi.fn(async (_script: string) => inspection());
    const sha256 = vi.fn(async (_path: string) => digest);
    const verification = await validateWindowsUpdateInstaller(options, { inspect, sha256 });
    expect(verification).toEqual({ sha256: digest, signerSubject: publisher, version: "1.2.2" });
    expect(sha256.mock.calls).toEqual([[options.installerPath], [options.installerPath]]);
    const script = inspect.mock.calls[0]![0] as string;
    expect(script).toContain(options.installerPath);
    expect(script).toContain(options.currentExecutable);
    expect(script).toContain("Get-AuthenticodeSignature -LiteralPath");
    expect(script).toContain("FileAttributes]::ReparsePoint");
  });

  it("rejects an installer replaced while PowerShell was inspecting its signature", async () => {
    const sha256 = vi.fn().mockResolvedValueOnce(digest).mockResolvedValueOnce("b".repeat(64));
    await expect(validateWindowsUpdateInstaller(options, { inspect: async () => inspection(), sha256 })).rejects.toThrow("changed during signature inspection");
  });

  it("rejects incomplete fake PowerShell output", async () => {
    await expect(validateWindowsUpdateInstaller(options, { inspect: async () => ({}), sha256: async () => digest })).rejects.toThrow("inspection is incomplete");
  });

  it("quotes apostrophes in literal paths without creating a PowerShell command", () => {
    expect(createWindowsUpdateInspectionScript({ installerPath: "D:\\O'Brien\\Memmy.exe", currentExecutable: options.currentExecutable })).toContain("Read-MemmyUpdateFile 'D:\\O''Brien\\Memmy.exe'");
  });

  it("preserves a non-ASCII publisher in the saved PowerShell 5 helper", () => {
    const script = createWindowsUpdateVerificationScript({ sha256: digest, signerSubject: "CN=记忆公司, O=MemTensor", version: "1.2.2" });
    const file = windowsUpdatePowerShellFile(script);
    expect([...file.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(file.subarray(2).toString("utf16le")).toBe(script);
  });

  it("uses an absolute system PowerShell path without consulting PATH", () => {
    vi.stubEnv("PATH", "D:\\untrusted-apps");
    try {
      expect(windowsUpdatePowerShellExecutable("C:\\Windows")).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
      expect(() => windowsUpdatePowerShellExecutable("relative-directory")).toThrow("absolute local path");
    } finally { vi.unstubAllEnvs(); }
  });

  it("runs verification before quit and before the detached helper starts an installer", () => {
    const main = readFileSync(new URL("../src/main/main.ts", import.meta.url), "utf8");
    const installStart = main.indexOf("async function installWindowsUpdateInBackground(");
    const installEnd = main.indexOf("function createWindowsUpdateInstallScript(", installStart);
    const installBody = main.slice(installStart, installEnd);
    expect(installBody.indexOf("await validateWindowsDownloadedUpdate(")).toBeLessThan(installBody.indexOf('spawn("wscript.exe"'));
    expect(installBody.indexOf("await validateWindowsDownloadedUpdate(")).toBeLessThan(installBody.indexOf("scheduleQuitForManualUpdateInstall()"));
    const scriptBody = main.slice(installEnd, main.indexOf("function shouldQuitForManualUpdateInstall(", installEnd));
    expect(scriptBody.indexOf("Assert-MemmyUpdateInstaller $Installer")).toBeLessThan(scriptBody.indexOf("Start-Process -FilePath $Installer"));
    expect(scriptBody).toContain("Test-MemmyExactUpdateVersion $actual $MemmyVerifiedUpdateVersion");
    expect(scriptBody).toContain("$actual = Get-MemmyUpdateExecutableVersion $version");
    expect(createWindowsUpdateVerificationScript({ sha256: digest, signerSubject: publisher, version: "1.2.2-rc.1" }))
      .toContain("@($Metadata.FileVersion, $Metadata.ProductVersion)");
    expect(scriptBody).not.toContain(".StartsWith($ExpectedVersion)");
    expect(scriptBody).not.toContain("-Verb RunAs");
    expect(scriptBody).toContain("$MemmyInstallerVerificationHandle.Dispose()");
    const relay = readFileSync(new URL("../build/MemmyWindowsUpgradeRelay.ps1", import.meta.url), "utf8");
    expect(relay).toContain("@($versionInfo.FileVersion, $versionInfo.ProductVersion)");
    expect(relay).toContain("Test-MemmyRelayInstalledVersion $verifiedInstalledVersion $ExpectedVersion");
    expect(relay).not.toContain("$verifiedInstalledVersion.StartsWith($ExpectedVersion");
  });

  it.runIf(process.platform === "win32")("executes the generated PowerShell exact-version and pinned signature guards", () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-update-verification-"));
    const installer = join(root, "中文 installer.exe");
    writeFileSync(installer, "fixture installer");
    const hash = createHash("sha256").update(readFileSync(installer)).digest("hex");
    const prefix = createWindowsUpdateVerificationScript({ sha256: hash, signerSubject: publisher, version: "1.2.2" });
    const escapedInstaller = installer.replaceAll("'", "''");
    const script = `${prefix}
function Get-AuthenticodeSignature { param([string]$LiteralPath) return @{ Status = 'Valid'; SignerCertificate = @{ Subject = '${publisher}' } } }
try {
  Assert-MemmyUpdateInstaller '${escapedInstaller}'
  $blockedWrite = $false
  try { $writer = [System.IO.File]::OpenWrite('${escapedInstaller}'); $writer.Dispose() } catch { $blockedWrite = $true }
  $results = @{
    stable = (Test-MemmyExactUpdateVersion '1.2.1.0' '1.2.1')
    wrongPatch = (Test-MemmyExactUpdateVersion '1.2.10' '1.2.1')
    wrongRelease = (Test-MemmyExactUpdateVersion '1.2.1-rc.2' '1.2.1')
    correctRc = (Test-MemmyExactUpdateVersion '1.2.2-rc.10' '1.2.2-rc.10')
    wrongRc = (Test-MemmyExactUpdateVersion '1.2.2-rc.2' '1.2.2-rc.10')
    installedRc = (Test-MemmyExactUpdateVersion (Get-MemmyUpdateExecutableVersion @{ FileVersion = '1.2.2-rc.1'; ProductVersion = '1.2.2.0' }) '1.2.2-rc.1')
    blockedWrite = $blockedWrite
  }
  $results | ConvertTo-Json -Compress
} finally { if ($null -ne $MemmyInstallerVerificationHandle) { $MemmyInstallerVerificationHandle.Dispose() } }
`;
    try {
      const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", timeout: 30_000, windowsHide: true });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({ stable: true, wrongPatch: false, wrongRelease: false, correctRc: true, wrongRc: false, installedRc: true, blockedWrite: true });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
