import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { win32 } from "node:path";
import { windowsUpdatePowerShellExecutable } from "./windows-update-validation.js";

const guidance = "无法确认此盘的 Memmy 数据属于当前 Windows 账户。请选择 C 盘按用户安装，或使用独立盘；选择同一盘上的其他文件夹无法隔离数据。\nCannot verify that this drive's Memmy data belongs to your Windows account. Choose C: for a per-user installation, or a separate drive. Another folder on this same drive cannot isolate the data.";

export interface WindowsRuntimeOwnershipEvidence {
  currentSid: string;
  ownerSid: string;
  claimOwnerSid: string;
  claimSid: string;
  fresh: boolean;
}

export interface WindowsRuntimeOwnershipDependencies {
  readScript?: () => string;
  inspect?: (encodedScript: string) => { status: number | null; stdout: string; stderr: string; error?: Error };
}

/** Keep existing non-C layouts; refuse sharing them across Windows accounts. */
export function sharedWindowsRuntimeRoot(runtimeHomePath: string): string | null {
  const normalized = win32.normalize(runtimeHomePath).replace(/[\\/]+$/, "");
  const drive = win32.parse(normalized).root;
  if (!/^[A-Za-z]:\\$/.test(drive)) throw new Error(guidance);
  if (drive.toLowerCase() === "c:\\" || normalized.toLowerCase() !== win32.join(drive, "MemmyData", ".memmy").toLowerCase()) return null;
  return win32.join(drive, "MemmyData");
}

export function validateWindowsRuntimeOwnershipEvidence(value: unknown): WindowsRuntimeOwnershipEvidence {
  const evidence = value as Partial<WindowsRuntimeOwnershipEvidence> | null;
  if (!evidence || typeof evidence.currentSid !== "string" || !/^S-1-(?:5-21|12-1)-\d+(?:-\d+)+$/.test(evidence.currentSid)
      || evidence.ownerSid !== evidence.currentSid || evidence.claimOwnerSid !== evidence.currentSid
      || evidence.claimSid !== evidence.currentSid || typeof evidence.fresh !== "boolean") throw new Error(guidance);
  return evidence as WindowsRuntimeOwnershipEvidence;
}

/** Synchronous: runs before app paths, runtime environment, config or database access. */
export function assertWindowsRuntimeOwnership(runtimeHomePath: string, dependencies: WindowsRuntimeOwnershipDependencies = {}): WindowsRuntimeOwnershipEvidence | null {
  if (!sharedWindowsRuntimeRoot(runtimeHomePath)) return null;
  try {
    // Node can read ASAR assets; external PowerShell cannot. Pass the bundled source as Unicode.
    const source = (dependencies.readScript ?? (() => readFileSync(new URL("./MemmyWindowsRuntimeOwnership.ps1", import.meta.url), "utf8")))();
    const command = `& {\n${source}\n} -RuntimeHomePath '${runtimeHomePath.replaceAll("'", "''")}'`;
    const encoded = Buffer.from(command, "utf16le").toString("base64");
    const result = dependencies.inspect ? dependencies.inspect(encoded) : spawnSync(windowsUpdatePowerShellExecutable(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
      windowsHide: true, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0) throw new Error(guidance);
    return validateWindowsRuntimeOwnershipEvidence(JSON.parse(result.stdout.trim()));
  } catch { throw new Error(guidance); }
}
