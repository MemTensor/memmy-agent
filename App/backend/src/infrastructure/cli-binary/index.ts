/** Cli binary module. */
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, delimiter } from "node:path";
import type { RuntimeConfig } from "@memmy/local-api-contracts";

/** Handles resolve default runtime config path. */
export function resolveDefaultRuntimeConfigPath(): string {
  return join(homedir(), ".memmy", "runtime.json");
}

/** Handles resolve default cli symlink path. */
export function resolveDefaultCliSymlinkPath(): string {
  return join(homedir(), ".local", "bin", "memmy");
}

/** Checks is directory in path. */
export function isDirectoryInPath(directory: string, pathValue = process.env.PATH ?? ""): boolean {
  return pathValue.split(delimiter).includes(directory);
}

/** Writes write runtime config file. */
export async function writeRuntimeConfigFile(
  runtimeConfig: RuntimeConfig,
  runtimeConfigPath = resolveDefaultRuntimeConfigPath()
): Promise<void> {
  const runtimeConfigDirectory = dirname(runtimeConfigPath);
  const tempPath = join(runtimeConfigDirectory, `.${basename(runtimeConfigPath)}.${process.pid}.${Date.now()}.tmp`);

  await mkdir(runtimeConfigDirectory, { recursive: true, mode: 0o700 });
  await chmod(runtimeConfigDirectory, 0o700);

  try {
    await writeFile(tempPath, `${JSON.stringify(runtimeConfig, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(tempPath, runtimeConfigPath);
    await chmod(runtimeConfigPath, 0o600);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}
