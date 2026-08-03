import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { posix, win32, type PlatformPath } from "node:path";

type RuntimeEnv = Record<string, string | undefined>;

export interface ResolveMemmyDataRootOptions {
  platform: NodeJS.Platform;
  homeDirectory: string;
  executablePath: string;
  isPackaged: boolean;
  env: RuntimeEnv;
  directoryExists?: (path: string) => boolean;
}

export const resolveMemmyDataRoot = (
  options: ResolveMemmyDataRootOptions
): string => {
  const path = platformPath(options.platform);
  const explicitRoot = options.env.MEMMY_HOME?.trim();
  if (explicitRoot) {
    return resolveHomePath(explicitRoot, options.homeDirectory, path);
  }

  const legacyRoot = path.join(options.homeDirectory, ".memmy");
  if (options.platform !== "win32" || !options.isPackaged) {
    return legacyRoot;
  }

  const directoryExists = options.directoryExists ?? existsSync;
  if (directoryExists(legacyRoot)) {
    return legacyRoot;
  }

  const installationRoot = win32.parse(options.executablePath).root;
  const systemRoot = win32.parse(options.env.SystemDrive || options.homeDirectory).root;
  if (!installationRoot || sameWindowsRoot(installationRoot, systemRoot)) {
    return legacyRoot;
  }

  return win32.join(installationRoot, "MemmyData", ".memmy");
};

export const applyMemmyDataRootEnvironment = (
  dataRoot: string,
  env: RuntimeEnv = process.env,
  platform: NodeJS.Platform = process.platform
): void => {
  const path = platformPath(platform);
  env.MEMMY_HOME = dataRoot;
  env.MEMMY_CONFIG = path.join(dataRoot, "config.yaml");
  env.MEMMY_RUNTIME_CONFIG_PATH = path.join(dataRoot, "runtime.json");
  env.MEMMY_AGENT_DATA_DIR = dataRoot;
  env.MEMMY_AGENT_SESSION_DAG_DIR = path.join(dataRoot, "session-dag");
};

export const assertMemmyDataRootWritable = async (dataRoot: string): Promise<void> => {
  const probePath = platformPath(process.platform).join(
    dataRoot,
    `.memmy-write-probe-${process.pid}-${randomUUID()}`
  );
  try {
    await mkdir(dataRoot, { recursive: true });
    await writeFile(probePath, "", { flag: "wx" });
    await unlink(probePath);
  } catch (error) {
    await unlink(probePath).catch(() => undefined);
    throw new Error(`Memmy data directory is not writable: ${dataRoot}`, { cause: error });
  }
};

const platformPath = (platform: NodeJS.Platform): PlatformPath =>
  platform === "win32" ? win32 : posix;

const resolveHomePath = (
  value: string,
  homeDirectory: string,
  path: PlatformPath
): string => {
  if (value === "~") return homeDirectory;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.resolve(homeDirectory, value.slice(2));
  }
  return path.resolve(value);
};

const sameWindowsRoot = (left: string, right: string): boolean =>
  left.replace(/[\\/]+$/u, "").toLowerCase() ===
  right.replace(/[\\/]+$/u, "").toLowerCase();
