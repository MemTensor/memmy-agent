import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, resolve, win32 } from "node:path";
import {
  resolveWindowsStoreMigrationPolicy,
  type WindowsStoreMigrationPolicy
} from "./windows-store-migration-config.js";

interface WindowsStoreWebInstallerOptions {
  updatesDirectory: string;
  download: (url: string, filePath: string) => Promise<void>;
  verify?: (filePath: string) => Promise<void>;
  launch?: (filePath: string) => Promise<void>;
}

interface InstallerTarget {
  filePath: string;
  url: string;
}

// Factories can be short-lived and own different WebContents progress callbacks.
// Only the caller that starts a download owns its callback; joiners await its result.
const preparations = new Map<string, Promise<string>>();

export const createWindowsStoreWebInstaller = (options: WindowsStoreWebInstallerOptions) => {
  const updatesDirectory = resolve(options.updatesDirectory);
  const verify = options.verify ?? verifyWindowsStoreWebInstaller;
  const launch = options.launch ?? launchWindowsStoreWebInstaller;

  const verifyPrepared = async (filePath: string): Promise<void> => {
    // Hooks are trusted main-process dependencies, never renderer-supplied paths.
    await assertRegularInstallerFile(filePath);
    await verify(filePath);
  };

  const findTarget = async ({ filePath }: InstallerTarget): Promise<string | null> => {
    try {
      await verifyPrepared(filePath);
      return filePath;
    } catch {
      return null;
    }
  };

  const prepareTarget = async (target: InstallerTarget): Promise<string> => {
    const prepared = await findTarget(target);
    if (prepared) return prepared;

    await mkdir(dirname(target.filePath), { recursive: true });
    // Keep an .exe extension for Authenticode, but never expose the ready name early.
    const temporaryPath = resolve(dirname(target.filePath), `Memmy-WebInstall.${randomUUID()}.partial.exe`);
    try {
      await options.download(target.url, temporaryPath);
      await verifyPrepared(temporaryPath);
      await rename(temporaryPath, target.filePath);
      return target.filePath;
    } finally {
      // Never sweep this directory: it can contain a ready exe or another download.
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  };

  return {
    findPrepared: async (policy: WindowsStoreMigrationPolicy): Promise<string | null> =>
      findTarget(resolveInstallerTarget(updatesDirectory, policy)),
    prepare: async (policy: WindowsStoreMigrationPolicy): Promise<string> => {
      const target = resolveInstallerTarget(updatesDirectory, policy);
      const cachePath = process.platform === "win32" ? target.filePath.toLowerCase() : target.filePath;
      const key = `${cachePath}\0${target.url}`;
      const existing = preparations.get(key);
      if (existing) return existing;
      const preparation = prepareTarget(target).finally(() => { preparations.delete(key); });
      preparations.set(key, preparation);
      return preparation;
    },
    launchPrepared: async (policy: WindowsStoreMigrationPolicy): Promise<string> => {
      const { filePath } = resolveInstallerTarget(updatesDirectory, policy);
      // Reverify from disk even after findPrepared/prepare succeeded earlier.
      await verifyPrepared(filePath);
      await launch(filePath);
      return filePath;
    }
  };
};

const resolveInstallerTarget = (
  updatesDirectory: string,
  policy: WindowsStoreMigrationPolicy
): InstallerTarget => {
  if (!policy || policy.kind !== "store-migration" || (policy.edition !== "cn" && policy.edition !== "intl")) {
    throw new Error("Invalid Windows Store Web Install policy");
  }
  const validated = resolveWindowsStoreMigrationPolicy({
    manifestStatus: "latest",
    currentEdition: policy.edition,
    storeDestination: policy
  });
  if (!validated) throw new Error("Invalid Windows Store Web Install policy");
  return {
    filePath: resolve(updatesDirectory, "store-web-install", `${validated.edition}-${validated.storeId}`, "Memmy-WebInstall.exe"),
    url: `https://get.microsoft.com/installer/download/${validated.storeId}`
  };
};

const assertRegularInstallerFile = async (filePath: string): Promise<void> => {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0) {
    throw new Error("Windows Store Web Install is not a complete Windows PE executable");
  }
};

/** Read-only verification, also usable for checking a downloaded Web Install exe. */
export const verifyWindowsStoreWebInstaller = async (filePath: string): Promise<void> => {
  await validatePortableExecutable(filePath);
  const systemRoot = process.env.SystemRoot;
  if (process.platform !== "win32" || !systemRoot || !win32.isAbsolute(systemRoot)) {
    throw new Error("Windows Store Web Install verification requires Windows and an absolute SystemRoot");
  }
  const powerShellPath = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const literalPath = resolve(filePath).replace(/'/g, "''");
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    // A Node process started from pwsh can inherit incompatible PowerShell 7 modules.
    "$env:PSModulePath = [System.IO.Path]::Combine($PSHOME, 'Modules')",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "try {",
    `  $signature = Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath '${literalPath}' -ErrorAction Stop`,
    "  $subject = ''",
    "  if ($null -ne $signature.SignerCertificate) {",
    "    $subject = $signature.SignerCertificate.SubjectName.Decode([System.Security.Cryptography.X509Certificates.X500DistinguishedNameFlags]::UseNewLines)",
    "  }",
    "  [pscustomobject]@{ status = $signature.Status.ToString(); subject = $subject } | ConvertTo-Json -Compress",
    "} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }"
  ].join("\n");
  const stdout = await new Promise<string>((resolveOutput, reject) => {
    execFile(powerShellPath, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 64 * 1024
    }, (error, output) => { if (error) reject(error); else resolveOutput(output); });
  });
  const signature: unknown = JSON.parse(stdout.trim());
  if (
    !signature || typeof signature !== "object"
    || !("status" in signature) || signature.status !== "Valid"
    || !("subject" in signature) || typeof signature.subject !== "string"
    // Decode DN attributes on separate lines; a substring in another CN/O is not a match.
    || !signature.subject.split(/\r?\n/u).some((line) => line.trim() === "O=Microsoft Corporation")
  ) {
    throw new Error("Windows Store Web Install requires a Valid Microsoft Corporation Authenticode signature");
  }
};

const validatePortableExecutable = async (filePath: string): Promise<void> => {
  await assertRegularInstallerFile(filePath);
  const file = await open(filePath, "r");
  const invalid = () => new Error("Windows Store Web Install is not a complete Windows PE executable");
  try {
    const { size } = await file.stat();
    const read = async (offset: number, length: number): Promise<Buffer> => {
      if (offset < 0 || offset + length > size) throw invalid();
      const bytes = Buffer.alloc(length);
      if ((await file.read(bytes, 0, length, offset)).bytesRead !== length) throw invalid();
      return bytes;
    };
    const dos = await read(0, 64);
    if (dos.readUInt16LE(0) !== 0x5a4d) throw invalid();
    const peOffset = dos.readUInt32LE(0x3c);
    if (peOffset < 64) throw invalid();
    const pe = await read(peOffset, 24);
    const sections = pe.readUInt16LE(6);
    const optionalSize = pe.readUInt16LE(20);
    const characteristics = pe.readUInt16LE(22);
    if (pe.readUInt32LE(0) !== 0x00004550 || sections < 1 || sections > 96
      || !(characteristics & 0x0002) || (characteristics & 0x2000) || optionalSize < 96) throw invalid();
    const optional = await read(peOffset + 24, optionalSize);
    const magic = optional.readUInt16LE(0);
    const directoriesOffset = magic === 0x10b ? 96 : magic === 0x20b ? 112 : 0;
    if (!directoriesOffset || optionalSize < directoriesOffset) throw invalid();
    const directoryCount = optional.readUInt32LE(directoriesOffset - 4);
    if (directoryCount > (optionalSize - directoriesOffset) / 8) throw invalid();
    const sectionOffset = peOffset + 24 + optionalSize;
    const headersSize = optional.readUInt32LE(60);
    if (headersSize < sectionOffset + sections * 40 || headersSize > size) throw invalid();
    const sectionTable = await read(sectionOffset, sections * 40);
    for (let index = 0; index < sections; index += 1) {
      const rawSize = sectionTable.readUInt32LE(index * 40 + 16);
      const rawOffset = sectionTable.readUInt32LE(index * 40 + 20);
      if (rawSize > 0 && (rawOffset < headersSize || rawOffset + rawSize > size)) throw invalid();
    }
    // The certificate directory uses file offsets rather than RVAs.
    if (directoryCount > 4) {
      const certificateOffset = optional.readUInt32LE(directoriesOffset + 4 * 8);
      const certificateSize = optional.readUInt32LE(directoriesOffset + 4 * 8 + 4);
      if ((certificateOffset || certificateSize)
        && (certificateOffset < headersSize || certificateSize < 8 || certificateOffset + certificateSize > size)) throw invalid();
    }
  } finally {
    await file.close();
  }
};

const launchWindowsStoreWebInstaller = async (filePath: string): Promise<void> => {
  await new Promise<void>((resolveLaunch, reject) => {
    const child = spawn(filePath, [], { detached: true, stdio: "ignore", windowsHide: false });
    const onSpawn = () => {
      child.unref();
      resolveLaunch();
    };
    child.once("error", (error) => {
      child.removeListener("spawn", onSpawn);
      reject(error);
    });
    child.once("spawn", onSpawn);
  });
};
