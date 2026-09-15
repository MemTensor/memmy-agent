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

export type CliInstallStrategy = "packaged-windows" | "packaged-windows-store" | "posix";

const execFileAsync = promisify(execFile);

export const resolveCliInstallStrategy = (
  platform: string,
  isPackaged: boolean,
  isWindowsStore = false
): CliInstallStrategy => {
  if (platform !== "win32" || !isPackaged) return "posix";
  return isWindowsStore ? "packaged-windows-store" : "packaged-windows";
};

export const installPackagedWindowsCliTools = async (
  resourcesPath: string,
  dependencies: PackagedWindowsCliInstallDependencies = {}
): Promise<CliInstallResult> => {
  return installWindowsCliLaunchers(
    win32.join(resourcesPath, "cli"),
    "Packaged Windows CLI launcher",
    dependencies
  );
};

export const resolvePackagedWindowsStoreCliDirectory = (storeUserDataPath: string): string => {
  const trimmedPath = storeUserDataPath.trim();
  if (!trimmedPath || !win32.isAbsolute(trimmedPath)) {
    throw new Error("Windows Store userData path must be absolute");
  }

  const normalizedUserDataPath = win32.normalize(trimmedPath);
  if (/(?:^|\\)windowsapps(?:\\|$)/iu.test(normalizedUserDataPath)) {
    throw new Error("Windows Store CLI directory must not use a versioned WindowsApps path");
  }

  const localStateDirectory = win32.dirname(normalizedUserDataPath);
  const packageFamilyDirectory = win32.dirname(localStateDirectory);
  const packagesDirectory = win32.dirname(packageFamilyDirectory);
  if (
    win32.basename(normalizedUserDataPath).toLowerCase() !== "memmy"
    || win32.basename(localStateDirectory).toLowerCase() !== "localstate"
    || win32.basename(packagesDirectory).toLowerCase() !== "packages"
    || !win32.basename(packageFamilyDirectory).includes("_")
  ) {
    throw new Error("Windows Store CLI requires a stable Packages\\<PFN>\\LocalState\\Memmy userData path");
  }
  return win32.join(normalizedUserDataPath, "cli");
};

export const installPackagedWindowsStoreCliTools = async (
  storeUserDataPath: string,
  dependencies: PackagedWindowsCliInstallDependencies = {}
): Promise<CliInstallResult> => {
  return installWindowsCliLaunchers(
    resolvePackagedWindowsStoreCliDirectory(storeUserDataPath),
    "Windows Store LocalState CLI launcher",
    dependencies
  );
};

const installWindowsCliLaunchers = async (
  binDirectory: string,
  launcherDescription: string,
  dependencies: PackagedWindowsCliInstallDependencies
): Promise<CliInstallResult> => {
  const accessFile = dependencies.accessFile ?? ((path: string) => access(path, fsConstants.R_OK));
  const ensureUserPath = dependencies.ensureUserPath ?? ensureWindowsCliDirectoryOnPath;
  const entries = [
    { name: "memmy-memory", source: win32.join(binDirectory, "memmy-memory.cmd") },
    { name: "memmy", source: win32.join(binDirectory, "memmy.cmd") }
  ];

  for (const entry of entries) {
    try {
      await accessFile(entry.source);
    } catch (cause) {
      throw new Error(`${launcherDescription} is missing or unreadable: ${entry.source}`, { cause });
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

export const findConflictingWindowsStoreCliPath = (
  pathValue: string,
  directory: string
): string | null => {
  const target = parseWindowsStoreCliDirectory(directory);
  if (!target) return null;

  const expected = normalizeWindowsPathSegment(directory);
  for (const segment of pathValue.split(";")) {
    const trimmedSegment = segment.trim();
    if (!trimmedSegment || normalizeWindowsPathSegment(trimmedSegment) === expected) {
      continue;
    }
    const candidate = parseWindowsStoreCliDirectory(trimmedSegment);
    if (candidate && candidate.packageFamilyName !== target.packageFamilyName) {
      return trimmedSegment;
    }
  }
  return null;
};

export const ensureWindowsCliDirectoryOnPath = async (
  directory: string,
  accessLayer: WindowsUserPathAccess = defaultWindowsUserPathAccess
): Promise<boolean> => {
  const currentUserPath = await accessLayer.readUserPath();
  const currentProcessPath = accessLayer.readProcessPath();
  const conflictingStorePath = findConflictingWindowsStoreCliPath(currentUserPath, directory)
    ?? findConflictingWindowsStoreCliPath(currentProcessPath, directory);
  if (conflictingStorePath) {
    throw new Error(
      `Another Memmy Microsoft Store CLI is already registered in PATH: ${conflictingStorePath}`
    );
  }

  const userPath = mergeWindowsUserPath(currentUserPath, directory);
  if (userPath.changed) {
    await accessLayer.writeUserPath(userPath.value);
  }

  const processPath = mergeWindowsUserPath(currentProcessPath, directory);
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
  const trimmedValue = value.trim();
  const unquotedValue = trimmedValue.length >= 2
    && trimmedValue.startsWith('"')
    && trimmedValue.endsWith('"')
    ? trimmedValue.slice(1, -1)
    : trimmedValue;
  const normalizedSlashes = unquotedValue.replaceAll("/", "\\");
  const withoutTrailingSlashes = normalizedSlashes.length > 3
    ? normalizedSlashes.replace(/\\+$/u, "")
    : normalizedSlashes;
  return withoutTrailingSlashes.toLocaleLowerCase("en-US");
};

const parseWindowsStoreCliDirectory = (
  value: string
): { packageFamilyName: string } | null => {
  const normalizedPath = normalizeWindowsPathSegment(value);
  if (!win32.isAbsolute(normalizedPath)) return null;

  const segments = normalizedPath.split("\\");
  const packagesIndex = segments.lastIndexOf("packages");
  if (packagesIndex < 0 || segments.length !== packagesIndex + 5) return null;
  const packageFamilyName = segments[packagesIndex + 1] ?? "";
  if (!packageFamilyName.includes("_")
      || segments[packagesIndex + 2] !== "localstate"
      || segments[packagesIndex + 3] !== "memmy"
      || segments[packagesIndex + 4] !== "cli") {
    return null;
  }
  return { packageFamilyName };
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
