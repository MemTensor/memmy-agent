/** Installer module. */
import { mkdir, rm, symlink } from "node:fs/promises";
import { dirname } from "node:path";
import { isDirectoryInPath, resolveDefaultCliSymlinkPath } from "./index.js";

/** Contract for install memmy cli binary options. */
export interface InstallMemmyCliBinaryOptions {
  sourceBinaryPath: string;
  symlinkPath?: string;
  pathValue?: string;
  writeStdout?: (text: string) => void;
}

/** Handles install memmy cli binary. */
export async function installMemmyCliBinary(options: InstallMemmyCliBinaryOptions): Promise<void> {
  const symlinkPath = options.symlinkPath ?? resolveDefaultCliSymlinkPath();
  const writeStdout = options.writeStdout ?? ((text: string) => process.stdout.write(text));

  await mkdir(dirname(symlinkPath), { recursive: true });
  await rm(symlinkPath, { force: true });
  await symlink(options.sourceBinaryPath, symlinkPath);

  if (!isDirectoryInPath(dirname(symlinkPath), options.pathValue)) {
    writeStdout(`Add ${dirname(symlinkPath)} to PATH to use memmy globally.\n`);
  }
}
