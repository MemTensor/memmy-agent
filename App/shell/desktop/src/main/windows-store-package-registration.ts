import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { win32 } from "node:path";

const execFileAsync = promisify(execFile);
const QUERY_TIMEOUT_MS = 15_000;
const QUERY_MAX_BUFFER_BYTES = 1024 * 1024;

export interface QueryWindowsPackageFamilyRegistrationOptions {
  resourcesPath: string;
  packageFamilyName: string;
}

export interface WindowsPackageFamilyRegistration {
  registered: boolean;
  packageFullNames: string[];
}

export interface QueryWindowsPackageFamilyRegistrationDependencies {
  runHelper?: (helperPath: string, arguments_: string[]) => Promise<{
    stdout: string;
    stderr: string;
  }>;
}

export const queryWindowsPackageFamilyRegistration = async (
  options: QueryWindowsPackageFamilyRegistrationOptions,
  dependencies: QueryWindowsPackageFamilyRegistrationDependencies = {}
): Promise<WindowsPackageFamilyRegistration> => {
  const helperPath = resolveHelperPath(options.resourcesPath);
  const packageFamilyName = normalizePackageFamilyName(options.packageFamilyName);
  const { stdout, stderr } = await (dependencies.runHelper ?? runNativeHelper)(helperPath, [
    "package-family-registration",
    "--package-family-name",
    packageFamilyName
  ]);
  if (stderr.trim()) {
    throw new Error("Windows package-family query returned unexpected stderr output");
  }
  const record = parseRegistrationRecord(stdout);
  if (record.packageFamilyName !== packageFamilyName) {
    throw new Error("Windows package-family query result does not match the requested package family");
  }
  if (record.registered !== (record.packageFullNames.length > 0)) {
    throw new Error("Windows package-family query result is internally inconsistent");
  }
  return {
    registered: record.registered,
    packageFullNames: record.packageFullNames
  };
};

const runNativeHelper = async (
  helperPath: string,
  arguments_: string[]
): Promise<{ stdout: string; stderr: string }> => {
  const result = await execFileAsync(helperPath, arguments_, {
    encoding: "utf8",
    maxBuffer: QUERY_MAX_BUFFER_BYTES,
    timeout: QUERY_TIMEOUT_MS,
    windowsHide: true
  });
  return {
    stdout: String(result.stdout),
    stderr: String(result.stderr)
  };
};

interface PackageFamilyRegistrationRecord {
  type: "package-family-registration";
  packageFamilyName: string;
  registered: boolean;
  packageFullNames: string[];
}

const registrationKeys = [
  "type",
  "packageFamilyName",
  "registered",
  "packageFullNames"
] as const;

const parseRegistrationRecord = (contents: string): PackageFamilyRegistrationRecord => {
  let value: unknown;
  try {
    value = JSON.parse(contents.trim()) as unknown;
  } catch (cause) {
    throw new Error("Windows package-family query returned invalid JSON", { cause });
  }
  if (!isRecord(value)
      || !hasExactKeys(value, registrationKeys)
      || value.type !== "package-family-registration"
      || typeof value.packageFamilyName !== "string"
      || typeof value.registered !== "boolean"
      || !Array.isArray(value.packageFullNames)
      || value.packageFullNames.some((entry) => (
        typeof entry !== "string"
        || !entry
        || entry !== entry.trim()
        || !/^[A-Za-z0-9._-]+$/u.test(entry)
      ))) {
    throw new Error("Windows package-family query result is invalid");
  }
  const packageFullNames = value.packageFullNames as string[];
  if (new Set(packageFullNames.map((entry) => entry.toLowerCase())).size !== packageFullNames.length) {
    throw new Error("Windows package-family query result is invalid");
  }
  return {
    type: value.type,
    packageFamilyName: value.packageFamilyName,
    registered: value.registered,
    packageFullNames
  };
};

const resolveHelperPath = (value: string): string => {
  if (!value || value !== value.trim() || !win32.isAbsolute(value)) {
    throw new Error("Windows package-family query resources path must be absolute");
  }
  const normalized = win32.normalize(value);
  if (normalized === win32.parse(normalized).root) {
    throw new Error("Windows package-family query resources path is invalid");
  }
  return win32.join(normalized, "native", "MemmyStoreUpdate.exe");
};

const normalizePackageFamilyName = (value: string): string => {
  if (!value
      || value !== value.trim()
      || value.length > 161
      || !/^[A-Za-z0-9.-]+_[A-Za-z0-9.-]+$/u.test(value)) {
    throw new Error("Windows package-family name is invalid");
  }
  return value;
};

const hasExactKeys = (value: Record<string, unknown>, expectedKeys: readonly string[]): boolean => {
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length && keys.every((key) => expectedKeys.includes(key));
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
