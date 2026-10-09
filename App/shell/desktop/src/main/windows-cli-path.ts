import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { win32 } from "node:path";
import { promisify } from "node:util";

export const WINDOWS_USER_PATH_LOCATION = "HKCU\\Environment\\Path";

export interface CliInstallResult {
  ok: true;
  binDirectory: string;
  installed: Array<{
    name: string;
    source: string;
    target: string;
  }>;
  pathUpdated: boolean;
  profilePaths: string[];
}

export interface WindowsUserPathAccess {
  readUserPath(): Promise<string>;
  writeUserPath(value: string): Promise<void>;
  broadcastEnvironmentChange(): Promise<void>;
  readProcessPath(): string;
  writeProcessPath(value: string): void;
}

interface PackagedWindowsCliInstallDependencies {
  accessFile?: (path: string) => Promise<void>;
  ensureUserPath?: (directory: string) => Promise<boolean>;
}

export type CliInstallStrategy = "packaged-windows" | "posix";

const execFileAsync = promisify(execFile);

export const resolveCliInstallStrategy = (
  platform: string,
  isPackaged: boolean,
  isWindowsStore = false
): CliInstallStrategy => {
  return platform === "win32" && isPackaged && !isWindowsStore ? "packaged-windows" : "posix";
};

export const installPackagedWindowsCliTools = async (
  resourcesPath: string,
  dependencies: PackagedWindowsCliInstallDependencies = {}
): Promise<CliInstallResult> => {
  const accessFile = dependencies.accessFile ?? ((path: string) => access(path, fsConstants.R_OK));
  const ensureUserPath = dependencies.ensureUserPath ?? ensureWindowsCliDirectoryOnPath;
  const binDirectory = win32.join(resourcesPath, "cli");
  const entries = [
    { name: "memmy-memory", source: win32.join(binDirectory, "memmy-memory.cmd") },
    { name: "memmy", source: win32.join(binDirectory, "memmy.cmd") }
  ];

  for (const entry of entries) {
    try {
      await accessFile(entry.source);
    } catch (cause) {
      throw new Error(`Packaged Windows CLI launcher is missing or unreadable: ${entry.source}`, { cause });
    }
  }

  const pathUpdated = await ensureUserPath(binDirectory);
  return {
    ok: true,
    binDirectory,
    installed: entries.map((entry) => ({ ...entry, target: entry.source })),
    pathUpdated,
    profilePaths: [WINDOWS_USER_PATH_LOCATION]
  };
};

export const mergeWindowsUserPath = (
  currentValue: string,
  directory: string
): { value: string; changed: boolean } => {
  if (!currentValue) {
    return { value: directory, changed: true };
  }

  const expected = normalizeWindowsPathSegment(directory);
  const segments = currentValue.split(";");
  const matchingIndexes = segments
    .map((segment, index) => normalizeWindowsPathSegment(segment) === expected ? index : -1)
    .filter((index) => index >= 0);

  if (matchingIndexes.length === 1) {
    return { value: currentValue, changed: false };
  }
  if (matchingIndexes.length === 0) {
    const separator = currentValue.endsWith(";") ? "" : ";";
    return { value: `${currentValue}${separator}${directory}`, changed: true };
  }

  const firstMatchingIndex = matchingIndexes[0];
  return {
    value: segments.filter((segment, index) => (
      normalizeWindowsPathSegment(segment) !== expected || index === firstMatchingIndex
    )).join(";"),
    changed: true
  };
};

export const ensureWindowsCliDirectoryOnPath = async (
  directory: string,
  accessLayer: WindowsUserPathAccess = defaultWindowsUserPathAccess
): Promise<boolean> => {
  const userPath = mergeWindowsUserPath(await accessLayer.readUserPath(), directory);
  if (userPath.changed) {
    await accessLayer.writeUserPath(userPath.value);
  }

  const processPath = mergeWindowsUserPath(accessLayer.readProcessPath(), directory);
  if (processPath.changed) {
    accessLayer.writeProcessPath(processPath.value);
  }

  try {
    await accessLayer.broadcastEnvironmentChange();
  } catch (cause) {
    const registrationState = userPath.changed
      ? "Windows user PATH was updated"
      : "Windows user PATH already contains the Memmy CLI directory";
    throw new Error(
      `${registrationState}, but the Environment change notification failed. Retry to notify newly opened terminals.`,
      { cause }
    );
  }
  return userPath.changed;
};

const normalizeWindowsPathSegment = (value: string): string => {
  const normalizedSlashes = value.trim().replaceAll("/", "\\");
  const withoutTrailingSlashes = normalizedSlashes.length > 3
    ? normalizedSlashes.replace(/\\+$/u, "")
    : normalizedSlashes;
  return withoutTrailingSlashes.toLocaleLowerCase("en-US");
};

const defaultWindowsUserPathAccess: WindowsUserPathAccess = {
  readUserPath: async () => readWindowsUserPath(),
  writeUserPath: async (value) => writeWindowsUserPath(value),
  broadcastEnvironmentChange: async () => broadcastWindowsEnvironmentChange(),
  readProcessPath: () => process.env.Path ?? process.env.PATH ?? "",
  writeProcessPath: (value) => {
    process.env.Path = value;
  }
};

const readWindowsUserPath = async (): Promise<string> => {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')",
    "$value = ''",
    "if ($null -ne $key) {",
    "  try {",
    "    $raw = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
    "    if ($null -ne $raw) { $value = [string]$raw }",
    "  } finally { $key.Dispose() }",
    "}",
    "$bytes = [Text.Encoding]::Unicode.GetBytes($value)",
    "[Console]::Out.Write([Convert]::ToBase64String($bytes))"
  ].join("\n");
  const stdout = await runWindowsPowerShell(script);
  const encoded = stdout.trim();
  return encoded ? Buffer.from(encoded, "base64").toString("utf16le") : "";
};

const writeWindowsUserPath = async (value: string): Promise<void> => {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')",
    "if ($null -eq $key) { throw 'Unable to open HKCU\\Environment for writing.' }",
    "try {",
    "  $key.SetValue('Path', $env:MEMMY_WINDOWS_USER_PATH_VALUE, [Microsoft.Win32.RegistryValueKind]::ExpandString)",
    "} finally { $key.Dispose() }"
  ].join("\n");
  await runWindowsPowerShell(script, { MEMMY_WINDOWS_USER_PATH_VALUE: value });
};

const broadcastWindowsEnvironmentChange = async (): Promise<void> => {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$signature = '[DllImport(\"user32.dll\", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);'",
    "Add-Type -Namespace Memmy -Name NativeMethods -MemberDefinition $signature",
    "$result = [UIntPtr]::Zero",
    "$sent = [Memmy.NativeMethods]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, 'Environment', 0x0002, 5000, [ref]$result)",
    "if ($sent -eq [IntPtr]::Zero) {",
    "  throw 'WM_SETTINGCHANGE broadcast failed or timed out.'",
    "}"
  ].join("\n");
  await runWindowsPowerShell(script);
};

const runWindowsPowerShell = async (
  script: string,
  environment: Record<string, string> = {}
): Promise<string> => {
  const powershellPath = win32.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const { stdout } = await execFileAsync(powershellPath, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script
  ], {
    encoding: "utf8",
    env: { ...process.env, ...environment },
    windowsHide: true
  });
  return stdout;
};
