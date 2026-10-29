import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const script = fileURLToPath(new URL("./win11-observer.ps1", import.meta.url));
const unpackedScript = script.replace(/app\.asar([\\/])/u, "app.asar.unpacked$1");
const SCRIPT = fs.existsSync(unpackedScript) ? unpackedScript : script;

/** Windows 11 retains NT version 10.0 and starts at build 22000. */
export function isWindows11(platform = process.platform, release = os.release()): boolean {
  if (platform !== "win32") return false;
  const match = /^10\.0\.(\d+)/u.exec(release);
  return match !== null && Number(match[1]) >= 22000;
}

const historyRuntimeIdentity = "MemmyWindowsHistoryRuntimeV1";

/** Resolve only the source-built helper for this architecture. Missing or stale
 * resources stop recording rather than falling back to repeated PowerShell UIA
 * reads. Electron cannot execute an EXE inside app.asar. */
export function resolveWindowsHistoryBinary(options: { arch?: string; assetRoot?: string } = {}): string {
  const arch = options.arch ?? process.arch;
  if (arch !== "x64" && arch !== "arm64") throw new Error(`Unsupported Windows History architecture: ${arch}`);
  let root = options.assetRoot ?? fileURLToPath(new URL("../../../native-computer-history", import.meta.url));
  // tsx/source development uses the local build output; installed JS resolves
  // its own dist asset and never searches another checkout or an environment override.
  if (!options.assetRoot && path.basename(path.dirname(root)) === "src") {
    root = path.join(path.dirname(path.dirname(root)), "dist", "native-computer-history");
  }
  const binary = path.join(root, "windows", arch === "x64" ? "amd64" : "arm64", "memmy-computer-history.exe");
  const unpacked = binary.replace(/app\.asar([\\/])/u, "app.asar.unpacked$1");
  const target = binary.includes("app.asar") ? unpacked : binary;
  if (!fs.existsSync(target)) throw new Error("Windows History recorder is missing. Reinstall the complete Memmy package.");
  const bytes = fs.readFileSync(target);
  const pe = bytes.length >= 64 ? bytes.readUInt32LE(0x3c) : 0;
  const machine = arch === "x64" ? 0x8664 : 0xaa64;
  if (bytes.toString("ascii", 0, 2) !== "MZ" || pe < 64 || pe > bytes.length - 26
      || bytes.readUInt32LE(pe) !== 0x00004550 || bytes.readUInt16LE(pe + 4) !== machine
      || bytes.readUInt16LE(pe + 24) !== 0x20b || (bytes.readUInt16LE(pe + 22) & 0x2000) !== 0
      || !bytes.includes(Buffer.from(historyRuntimeIdentity))) {
    throw new Error("Windows History recorder is invalid or incompatible. Reinstall the complete Memmy package.");
  }
  return target;
}

export function windowsObserverCommand(options: { parentPid?: number; wechatConsentPath?: string } = {}): { binary: string; args: string[] } {
  return {
    binary: resolveWindowsHistoryBinary(),
    args: ["--observe", `--parent-pid=${options.parentPid ?? process.pid}`,
      ...(options.wechatConsentPath ? [`--wechat-consent=${options.wechatConsentPath}`] : [])],
  };
}

/** Installed-app enumeration does not observe the desktop and keeps the existing
 * bounded catalog implementation separate from the native recording process. */
export function windowsApplicationCatalogCommand(): { binary: string; args: string[] } {
  const root = process.env.SystemRoot || "C:\\Windows";
  return {
    binary: path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", SCRIPT],
  };
}

export async function listWindowsApplications(): Promise<Array<{ bundleId: string; name: string }>> {
  if (!isWindows11()) return [];
  const command = windowsApplicationCatalogCommand();
  const { stdout } = await execute(command.binary, [...command.args, "-List"], {
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  const parsed: unknown = JSON.parse(stdout.trim());
  if (!Array.isArray(parsed)) throw new Error("invalid Windows application catalog");
  return parsed.filter((row): row is { bundleId: string; name: string } => {
    if (!row || typeof row !== "object") return false;
    const entry = row as Record<string, unknown>;
    return typeof entry.bundleId === "string" && /^win32\.[a-z0-9._-]+$/u.test(entry.bundleId)
      && typeof entry.name === "string" && Boolean(entry.name.trim());
  });
}
