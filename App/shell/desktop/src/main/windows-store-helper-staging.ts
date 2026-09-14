import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface StageWindowsStoreUnpackagedHelperDependencies {
  readStagedFile?: (path: string) => Promise<Buffer>;
}

/**
 * Stages the packaged native helper without cloning WindowsApps file metadata.
 * Package payloads can carry EFS attributes that make CopyFile fail when the
 * destination is a normal LocalAppData directory.
 */
export const stageWindowsStoreUnpackagedHelper = async (
  sourcePath: string,
  destinationPath: string,
  dependencies: StageWindowsStoreUnpackagedHelperDependencies = {}
): Promise<void> => {
  const sourceBytes = await readFile(sourcePath);
  if (sourceBytes.length === 0) {
    throw new Error("Packaged Windows Store cleanup helper is empty");
  }

  await mkdir(dirname(destinationPath), { recursive: true });
  const temporaryPath = `${destinationPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, sourceBytes, { flag: "wx" });
    const stagedBytes = await (
      dependencies.readStagedFile ?? ((path) => readFile(path))
    )(temporaryPath);
    if (!stagedBytes.equals(sourceBytes)) {
      throw new Error("Windows Store cleanup helper staged-byte verification failed");
    }
    await rename(temporaryPath, destinationPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
};
