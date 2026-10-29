import { execFile } from "node:child_process";
import { randomUUID, X509Certificate } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getDataDir } from "../../config/paths.js";
import { excelAddinManifest } from "./excel-addin-server.js";

const execFileAsync = promisify(execFile);
const ADDIN_ID = "9d36b812-9514-4f28-93fd-5c293a8746e2";
const WINDOWS_DEVELOPER_KEY = "HKCU\\Software\\Microsoft\\Office\\16.0\\WEF\\Developer";
/** OpenSSL 3 (Electron 38 / Node 22) cannot load the TripleDES PFX that Export-PfxCertificate writes by default. */
const WINDOWS_PFX_FORMAT = "AES256_SHA256";

export type LocalExcelTls = { certPath?: string; keyPath?: string; pfxPath?: string; pfxPassword?: string };
type Runner = (file: string, args: string[]) => Promise<void>;
type CopyFile = (source: string, destination: string) => Promise<void>;
type SetupOptions = { platform?: NodeJS.Platform; dataDir?: string; homeDir?: string; port?: number; run?: Runner; copyFile?: CopyFile };

function windowsTool(file: string): string {
  if (process.platform !== "win32") return file;
  const root = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
  const candidate = file === "powershell.exe"
    ? path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : file === "reg.exe"
      ? path.win32.join(root, "System32", "reg.exe")
      : "";
  return candidate && existsSync(candidate) ? candidate : file;
}

/** Prefer the command's own stderr. execFile otherwise repeats the full command line. */
export function excelSetupFailureMessage(error: unknown): string {
  const record = error as { stderr?: unknown; message?: unknown };
  const stderr = Buffer.isBuffer(record?.stderr)
    ? record.stderr.toString("utf8")
    : typeof record?.stderr === "string" ? record.stderr : "";
  const line = (text: string) => text.split(/\r?\n/).map(item => item.trim()).filter(item => item && !item.startsWith("Command failed:")).at(-1);
  const detail = (line(stderr) || line(String(record?.message ?? error)) || "Excel add-in setup failed")
    .replace(/\s+/g, " ").slice(0, 240);
  const prefixed = detail.startsWith("Excel add-in setup failed:") ? detail : `Excel add-in setup failed: ${detail}`;
  return prefixed.slice(0, 300);
}

async function runCommand(file: string, args: string[]): Promise<void> {
  // The trust dialog is a Windows certificate prompt, not a PowerShell prompt.
  // Hide the console, but do not pass -NonInteractive or that prompt is auto-cancelled.
  const trustingCertificate = file === "powershell.exe" || file === "/usr/bin/security";
  try {
    await execFileAsync(windowsTool(file), args, {
      windowsHide: true, timeout: trustingCertificate ? 180_000 : 60_000, maxBuffer: 64 * 1024, encoding: "utf8",
    });
  } catch (error) {
    throw new Error(excelSetupFailureMessage(error));
  }
}

function setupDir(dataDir: string): string { return path.join(dataDir, "computer-use", "excel-addin"); }

function macExcelWef(home: string): string {
  return path.join(home, "Library", "Containers", "com.microsoft.Excel", "Data", "Documents", "wef");
}

/** Returns whether Excel can see the manifest. Its container rejects other apps with EPERM. */
async function publishMacExcelManifest(manifestPath: string, home: string, copyFile: CopyFile = fs.copyFile): Promise<boolean> {
  const wef = macExcelWef(home);
  try {
    await fs.mkdir(wef, { recursive: true });
    await copyFile(manifestPath, path.join(wef, "Memmy-Excel.xml"));
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EACCES") throw error;
    return false;
  }
}

async function usableCertificate(certPath: string, options: { requireCa?: boolean } = {}): Promise<boolean> {
  try {
    const cert = new X509Certificate(await fs.readFile(certPath));
    return new Date(cert.validTo).getTime() > Date.now() + 24 * 60 * 60 * 1000
      && (!options.requireCa || cert.ca === true)
      && (cert.subjectAltName ?? "").includes("DNS:localhost");
  } catch {
    return false;
  }
}

/** Only an explicit settings action calls this. Certificate trust is scoped to the current user. */
export async function prepareLocalExcelAddin(options: SetupOptions = {}): Promise<{ tls: LocalExcelTls; manifestPath: string }> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "win32") throw new Error("Excel add-in setup supports macOS and Windows only");
  const dir = setupDir(options.dataDir ?? getDataDir());
  const home = options.homeDir ?? os.homedir();
  const port = options.port ?? Number(process.env.MEMMY_EXCEL_ADDIN_PORT || 32177);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid Excel add-in port");
  const run = options.run ?? runCommand;
  const copyFile = options.copyFile ?? fs.copyFile;
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  let tls: LocalExcelTls;
  if (platform === "darwin") {
    const certPath = path.join(dir, "localhost.crt");
    const keyPath = path.join(dir, "localhost.key");
    const keyPresent = await fs.access(keyPath).then(() => true, () => false);
    if (!keyPresent || !await usableCertificate(certPath, { requireCa: true })) {
      // macOS rejects trustRoot/trustAsRoot for a leaf-only certificate.  The
      // local development certificate is intentionally a scoped localhost CA;
      // it is trusted only for the current user's SSL policy and never leaves
      // the local Excel bridge.
      await run("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "365",
        "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost",
        "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
        "-addext", "keyUsage=critical,keyCertSign,digitalSignature,keyEncipherment",
        "-addext", "extendedKeyUsage=serverAuth", "-keyout", keyPath, "-out", certPath]);
    }
    await fs.chmod(keyPath, 0o600);
    // The user has just consented in Memmy's settings. Keychain may request their password.
    await run("/usr/bin/security", ["add-trusted-cert", "-r", "trustRoot", "-p", "ssl", "-s", "localhost", "-k",
      path.join(home, "Library", "Keychains", "login.keychain-db"), certPath]);
    tls = { certPath, keyPath };
  } else {
    const scriptPath = path.join(dir, "setup-localhost.ps1");
    // CurrentUser\Root always asks the signed-in user to confirm trust. -NonInteractive
    // auto-cancels that dialog (0x800704c7), so this host stays interactive on purpose.
    const script = String.raw`$ErrorActionPreference = 'Stop'
try {
  $dir = $args[0]
  if (-not $dir) { throw 'Excel add-in setup directory is missing' }
  $pfx = Join-Path $dir 'localhost.pfx'
  $cer = Join-Path $dir 'localhost.cer'
  $passwordFile = Join-Path $dir 'pfx-password.txt'
  $formatFile = Join-Path $dir 'pfx-format.txt'
  $format = '${WINDOWS_PFX_FORMAT}'
  $fresh = (Test-Path $pfx) -and (Test-Path $cer) -and (Test-Path $passwordFile) -and (Test-Path $formatFile)
  if ($fresh) { $fresh = (Get-Content -Raw -Path $formatFile).Trim() -eq $format }
  if ($fresh) { $fresh = ([System.Security.Cryptography.X509Certificates.X509Certificate2]::new($cer).NotAfter -gt (Get-Date).AddDays(1)) }
  if (-not $fresh) {
    Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.FriendlyName -eq 'Memmy Excel localhost' } | ForEach-Object { Remove-Item $_.PSPath -Force }
    Remove-Item -Force -ErrorAction SilentlyContinue $pfx, $cer, $passwordFile, $formatFile
    $cert = New-SelfSignedCertificate -DnsName 'localhost' -CertStoreLocation 'Cert:\CurrentUser\My' -KeyAlgorithm RSA -KeyLength 2048 -KeyExportPolicy Exportable -Type SSLServerAuthentication -FriendlyName 'Memmy Excel localhost' -NotAfter (Get-Date).AddDays(365)
    $password = [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')
    $secure = ConvertTo-SecureString -String $password -AsPlainText -Force
    Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $secure -CryptoAlgorithmOption AES256_SHA256 -Force | Out-Null
    Export-Certificate -Cert $cert -FilePath $cer | Out-Null
    $utf8 = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($passwordFile, $password, $utf8)
    [System.IO.File]::WriteAllText($formatFile, $format, $utf8)
  }
  $publicCert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($cer)
  $store = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root', 'CurrentUser')
  $store.Open('ReadWrite')
  try {
    $existing = $store.Certificates.Find([System.Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint, $publicCert.Thumbprint, $false)
    if ($existing.Count -eq 0) { $store.Add($publicCert) }
  } finally { $store.Close() }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;
    await fs.writeFile(scriptPath, script, { mode: 0o600 });
    await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, dir]);
    const pfxPassword = (await fs.readFile(path.join(dir, "pfx-password.txt"), "utf8")).trim();
    const format = (await fs.readFile(path.join(dir, "pfx-format.txt"), "utf8")).trim();
    if (!pfxPassword || format !== WINDOWS_PFX_FORMAT) throw new Error("Excel add-in certificate must be exported with AES-256");
    tls = { pfxPath: path.join(dir, "localhost.pfx"), pfxPassword };
  }

  const manifestPath = path.join(dir, "Memmy-Excel.xml");
  await fs.writeFile(manifestPath, excelAddinManifest(port), { mode: 0o600 });
  let containerSideload = true;
  if (platform === "darwin") {
    containerSideload = await publishMacExcelManifest(manifestPath, home, copyFile);
  } else {
    // This is Microsoft's per-user Office developer registration for XML add-ins.
    await run("reg.exe", ["ADD", WINDOWS_DEVELOPER_KEY, "/v", ADDIN_ID, "/t", "REG_SZ", "/d", manifestPath, "/f"]);
  }
  await fs.writeFile(path.join(dir, "setup.json"), JSON.stringify({ platform, manifestPath, consented: true, enabled: true,
    containerSideload, setupId: randomUUID() }), { mode: 0o600 });
  return { tls, manifestPath };
}

/** Persist the live-control switch without deleting the user's local sideload setup. */
export async function setLocalExcelAddinEnabled(enabled: boolean, dataDir = getDataDir()): Promise<void> {
  const setupPath = path.join(setupDir(dataDir), "setup.json");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await fs.readFile(setupPath, "utf8")) as Record<string, unknown>;
  } catch (error: any) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (parsed.consented !== true) return;
  await fs.writeFile(setupPath, JSON.stringify({ ...parsed, enabled }), { mode: 0o600 });
}

/** Refresh only the sideload registration after a desktop restart or upgrade.
 *
 * Explicit setup owns certificate creation and trust prompts. Once consent has
 * been recorded, restarting Memmy must still publish the current manifest so
 * Office does not keep an older cached XML (for example, one without ribbon
 * commands). This refresh never creates or trusts a certificate.
 */
export async function refreshLocalExcelAddinManifest(options: {
  dataDir?: string; port?: number; platform?: NodeJS.Platform; homeDir?: string; run?: Runner; copyFile?: CopyFile;
} = {}): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  const dataDir = options.dataDir ?? getDataDir();
  const home = options.homeDir ?? os.homedir();
  const port = options.port ?? Number(process.env.MEMMY_EXCEL_ADDIN_PORT || 32177);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid Excel add-in port");
  if (platform !== "darwin" && platform !== "win32") return null;
  const run = options.run ?? runCommand;
  const copyFile = options.copyFile ?? fs.copyFile;
  const dir = setupDir(dataDir);
  const setupPath = path.join(dir, "setup.json");
  let parsed: { platform?: string; consented?: boolean; enabled?: boolean; manifestPath?: string; containerSideload?: boolean };
  try {
    parsed = JSON.parse(await fs.readFile(setupPath, "utf8")) as typeof parsed;
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (parsed.platform !== platform || parsed.consented !== true || parsed.enabled === false) return null;
  const manifestPath = parsed.manifestPath || path.join(dir, "Memmy-Excel.xml");
  await fs.writeFile(manifestPath, excelAddinManifest(port), { mode: 0o600 });
  if (platform === "darwin") {
    const containerSideload = await publishMacExcelManifest(manifestPath, home, copyFile);
    if (parsed.containerSideload !== containerSideload) {
      await fs.writeFile(setupPath, JSON.stringify({ ...parsed, manifestPath, containerSideload }), { mode: 0o600 });
    }
  } else {
    await run("reg.exe", ["ADD", WINDOWS_DEVELOPER_KEY, "/v", ADDIN_ID, "/t", "REG_SZ", "/d", manifestPath, "/f"]);
  }
  return manifestPath;
}

export async function revealExcelManifestFile(dataDir = getDataDir()): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  const manifest = await readExcelManifestPath(dataDir);
  if (!manifest) return false;
  await runCommand("/usr/bin/open", ["-R", manifest]);
  return true;
}

async function readExcelManifestPath(dataDir: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(setupDir(dataDir), "setup.json"), "utf8")) as {
      consented?: boolean; enabled?: boolean; manifestPath?: string;
    };
    if (parsed.consented !== true || parsed.enabled === false) return null;
    return parsed.manifestPath || path.join(setupDir(dataDir), "Memmy-Excel.xml");
  } catch {
    return null;
  }
}

/** A Mac setup whose manifest could not be copied into Excel. The user uploads this file from Excel. */
export async function readExcelManualInstallPath(dataDir = getDataDir()): Promise<string | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(setupDir(dataDir), "setup.json"), "utf8")) as {
      platform?: string; consented?: boolean; enabled?: boolean; containerSideload?: boolean; manifestPath?: string;
    };
    if (parsed.platform !== "darwin" || parsed.consented !== true || parsed.enabled === false || parsed.containerSideload !== false) return null;
    return parsed.manifestPath || path.join(setupDir(dataDir), "Memmy-Excel.xml");
  } catch {
    return null;
  }
}

/** A successful explicit setup persists across ordinary desktop restarts. */
export async function readLocalExcelTls(dataDir = getDataDir()): Promise<LocalExcelTls | null> {
  try {
    const dir = setupDir(dataDir);
    const parsed = JSON.parse(await fs.readFile(path.join(dir, "setup.json"), "utf8")) as {
      platform?: string; consented?: boolean; enabled?: boolean;
    };
    if (parsed.platform !== process.platform || parsed.consented !== true || parsed.enabled === false) return null;
    if (process.platform === "darwin") {
      const certPath = path.join(dir, "localhost.crt");
      const keyPath = path.join(dir, "localhost.key");
      await Promise.all([fs.access(certPath), fs.access(keyPath)]);
      if (!await usableCertificate(certPath, { requireCa: true })) return null;
      return { certPath, keyPath };
    }
    if (process.platform === "win32") {
      const pfxPath = path.join(dir, "localhost.pfx");
      const pfxPassword = (await fs.readFile(path.join(dir, "pfx-password.txt"), "utf8")).trim();
      const format = (await fs.readFile(path.join(dir, "pfx-format.txt"), "utf8")).trim();
      await fs.access(pfxPath);
      if (!pfxPassword || format !== WINDOWS_PFX_FORMAT || !await usableCertificate(path.join(dir, "localhost.cer"))) return null;
      return { pfxPath, pfxPassword };
    }
    return null;
  } catch {
    return null;
  }
}
