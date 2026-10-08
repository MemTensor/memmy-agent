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

export function windowsObserverCommand(): { binary: string; args: string[] } {
  const root = process.env.SystemRoot || "C:\\Windows";
  return {
    binary: path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT],
  };
}

export async function listWindowsApplications(): Promise<Array<{ bundleId: string; name: string }>> {
  if (!isWindows11()) return [];
  const command = windowsObserverCommand();
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
