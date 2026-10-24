import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { win32 } from "node:path";
import { compareVersionSegments } from "./version-compare.js";

const execFile = promisify(execFileCallback);
const SEMANTIC_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export interface WindowsUpdateFileInspection {
  signatureStatus: string;
  signerSubject: string | null;
  productName: string;
  productVersion: string;
  fileVersion: string;
}

export interface WindowsUpdateInspection {
  current: WindowsUpdateFileInspection;
  installer: WindowsUpdateFileInspection;
}

export interface WindowsUpdateVerification {
  sha256: string;
  signerSubject: string | null;
  /** Full ProductVersion, preserving the prerelease suffix. */
  version: string;
}

export interface WindowsUpdateValidationOptions {
  installerPath: string;
  currentExecutable: string;
  currentVersion: string;
  expectedVersion?: string;
  /** The manifest written into the application at packaging time. */
  packagedManifest: string | null;
}

export interface WindowsUpdateValidationDependencies {
  inspect?: (script: string) => Promise<unknown>;
  sha256?: (path: string) => Promise<string>;
}

/** Windows numeric FileVersion's optional zero revision is not a prerelease. */
export function normalizeWindowsUpdateVersion(value: string): string | null {
  const normalized = value.trim().replace(/^(\d+\.\d+\.\d+)\.0$/, "$1");
  const match = normalized.match(SEMANTIC_VERSION_PATTERN);
  if (!match) return null;
  const numericParts = [...match.slice(1, 4), ...(match[4]?.split(".").filter((part) => /^\d+$/.test(part)) ?? [])];
  return numericParts.every((part) => Number.isSafeInteger(Number(part))) ? normalized : null;
}

/** Only the explicit unsigned package marker permits an unsigned local installer. */
export function unsignedWindowsTestPackage(manifest: string | null): boolean {
  try { return (JSON.parse(manifest ?? "{}") as { signing?: unknown })?.signing === "unsigned"; }
  catch { return false; }
}

export function validateWindowsUpdateInspection(
  inspection: WindowsUpdateInspection,
  options: WindowsUpdateValidationOptions
): Omit<WindowsUpdateVerification, "sha256"> {
  if (!validInspection(inspection)) throw new Error("Windows update inspection is incomplete");
  const current = inspection.current;
  const installer = inspection.installer;
  if (current.productName !== "Memmy" || installer.productName !== "Memmy") {
    throw new Error("Windows update is not a Memmy installer");
  }
  let signerSubject: string | null;
  if (current.signatureStatus === "Valid" && current.signerSubject) {
    if (installer.signatureStatus !== "Valid" || installer.signerSubject !== current.signerSubject) {
      throw new Error("Windows update signature must match the installed Memmy publisher");
    }
    signerSubject = current.signerSubject;
  } else if (unsignedWindowsTestPackage(options.packagedManifest) && current.signatureStatus === "NotSigned") {
    if (installer.signatureStatus !== "NotSigned" && !(installer.signatureStatus === "Valid" && installer.signerSubject)) {
      throw new Error("Windows local test update has an invalid signature");
    }
    signerSubject = installer.signatureStatus === "Valid" ? installer.signerSubject : null;
  } else {
    throw new Error("Cannot verify the installed Windows Memmy signing identity");
  }

  const currentVersion = normalizeWindowsUpdateVersion(options.currentVersion);
  // electron-builder preserves the executable's prerelease only in FileVersion.
  // The NSIS installer's ProductVersion retains the exact release identifier.
  const actualCurrentVersion = normalizeWindowsUpdateVersion(current.fileVersion || current.productVersion);
  const version = normalizeWindowsUpdateVersion(installer.productVersion);
  const expectedVersion = options.expectedVersion === undefined ? undefined : normalizeWindowsUpdateVersion(options.expectedVersion);
  if (!currentVersion || !actualCurrentVersion || !version || expectedVersion === null) {
    throw new Error("Windows update contains an invalid version");
  }
  if (compareVersionSegments(currentVersion, actualCurrentVersion) !== 0) {
    throw new Error("Installed Windows Memmy version does not match the running app");
  }
  if (expectedVersion && compareVersionSegments(version, expectedVersion) !== 0) {
    throw new Error(`Windows installer version ${version} does not match expected ${expectedVersion}`);
  }
  if (compareVersionSegments(version, currentVersion) <= 0) {
    throw new Error(`Refusing a Windows update from ${currentVersion} to ${version}`);
  }
  return { signerSubject, version };
}

/** Inspect and pin the same installer bytes before any quit or installer launch. */
export async function validateWindowsUpdateInstaller(
  options: WindowsUpdateValidationOptions,
  dependencies: WindowsUpdateValidationDependencies = {}
): Promise<WindowsUpdateVerification> {
  const hash = dependencies.sha256 ?? sha256File;
  const beforeHash = await hash(options.installerPath);
  const raw = await (dependencies.inspect ?? inspectWithPowerShell)(createWindowsUpdateInspectionScript(options));
  if (!validInspection(raw)) throw new Error("Windows update inspection is incomplete");
  const verified = validateWindowsUpdateInspection(raw, options);
  const afterHash = await hash(options.installerPath);
  if (!/^[a-f0-9]{64}$/i.test(beforeHash) || beforeHash.toLowerCase() !== afterHash.toLowerCase()) {
    throw new Error("Windows installer changed during signature inspection");
  }
  return { ...verified, sha256: afterHash.toLowerCase() };
}

function powershellString(value: string): string { return "'" + value.replaceAll("'", "''") + "'"; }

/** Windows PowerShell 5 otherwise reads a BOM-less helper with the system code page. */
export function windowsUpdatePowerShellFile(script: string): Buffer {
  return Buffer.from(`\uFEFF${script}`, "utf16le");
}

/** Signature inspection must use the OS command, rather than user PATH resolution. */
export function windowsUpdatePowerShellExecutable(systemRoot = process.env.SystemRoot ?? "C:\\Windows"): string {
  if (!/^[A-Za-z]:[\\/]/.test(systemRoot)) throw new Error("Windows system directory must be an absolute local path");
  return win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export function createWindowsUpdateInspectionScript(options: Pick<WindowsUpdateValidationOptions, "installerPath" | "currentExecutable">): string {
  return `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
function Read-MemmyUpdateFile([string]$FilePath) {
  $item = Get-Item -LiteralPath $FilePath -Force -ErrorAction Stop
  if ($item.PSIsContainer) { throw 'Windows update executable is not a file' }
  $parent = $item
  while ($null -ne $parent) {
    if (($parent.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Windows update path crosses a reparse point' }
    $parent = if ($parent.PSIsContainer) { $parent.Parent } else { $parent.Directory }
  }
  $signature = Get-AuthenticodeSignature -LiteralPath $FilePath -ErrorAction Stop
  $metadata = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($FilePath)
  return @{
    signatureStatus = $signature.Status.ToString()
    signerSubject = if ($null -ne $signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }
    productName = $metadata.ProductName
    productVersion = $metadata.ProductVersion
    fileVersion = $metadata.FileVersion
  }
}
@{
  current = Read-MemmyUpdateFile ${powershellString(options.currentExecutable)}
  installer = Read-MemmyUpdateFile ${powershellString(options.installerPath)}
} | ConvertTo-Json -Depth 4 -Compress
`;
}

/** Recheck the pinned file while holding a read handle through installer execution. */
export function createWindowsUpdateVerificationScript(verification: WindowsUpdateVerification): string {
  return `$MemmyExpectedInstallerHash = ${powershellString(verification.sha256)}
$MemmyExpectedSignerSubject = ${powershellString(verification.signerSubject ?? "")}
$MemmyVerifiedUpdateVersion = ${powershellString(verification.version)}
$MemmyInstallerVerificationHandle = $null

function Assert-MemmyUpdateInstaller([string]$FilePath) {
  $ErrorActionPreference = 'Stop'
  $script:MemmyInstallerVerificationHandle = [System.IO.File]::Open($FilePath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
  $hash = (Get-FileHash -LiteralPath $FilePath -Algorithm SHA256 -ErrorAction Stop).Hash
  if ($hash -ine $MemmyExpectedInstallerHash) { throw 'Windows installer changed after verification' }
  $signature = Get-AuthenticodeSignature -LiteralPath $FilePath -ErrorAction Stop
  if ($MemmyExpectedSignerSubject) {
    if ($signature.Status.ToString() -ne 'Valid' -or $null -eq $signature.SignerCertificate -or $signature.SignerCertificate.Subject -cne $MemmyExpectedSignerSubject) { throw 'Windows update signature does not match the verified publisher' }
  } elseif ($signature.Status.ToString() -ne 'NotSigned') {
    throw 'Unsigned local Windows installer changed its signing identity'
  }
}

function Normalize-MemmyUpdateVersion([string]$Value) {
  $value = $Value.Trim()
  if ($value -match '^(\\d+\\.\\d+\\.\\d+)\\.0$') { $value = $Matches[1] }
  if ($value -cnotmatch '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$') { return $null }
  return ($value -split '\\+', 2)[0]
}

function Test-MemmyExactUpdateVersion([string]$Actual, [string]$Expected) {
  $actualVersion = Normalize-MemmyUpdateVersion $Actual
  $expectedVersion = Normalize-MemmyUpdateVersion $Expected
  return ($null -ne $actualVersion -and $null -ne $expectedVersion -and $actualVersion -ceq $expectedVersion)
}

function Get-MemmyUpdateExecutableVersion($Metadata) {
  return @($Metadata.FileVersion, $Metadata.ProductVersion) | Where-Object { $_ } | Select-Object -First 1
}
`;
}

async function inspectWithPowerShell(script: string): Promise<unknown> {
  const result = await execFile(windowsUpdatePowerShellExecutable(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024,
  });
  return JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim()) as unknown;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function validInspection(value: unknown): value is WindowsUpdateInspection {
  if (!isRecord(value)) return false;
  return [value.current, value.installer].every((file) => isRecord(file)
    && typeof file.signatureStatus === "string"
    && (file.signerSubject === null || typeof file.signerSubject === "string")
    && typeof file.productName === "string" && typeof file.productVersion === "string"
    && typeof file.fileVersion === "string");
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
