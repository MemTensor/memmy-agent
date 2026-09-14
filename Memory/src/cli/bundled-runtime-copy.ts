import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { cp, lstat, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Copy into the installer's private staging directory, before pointer activation. */
export const copyBundledMemoryRuntime = async (source: string, destination: string): Promise<void> => {
  if (process.platform !== "win32" || !/(?:^|[\\/])WindowsApps[\\/]/i.test(source)) {
    await cp(source, destination, { recursive: true });
    return;
  }

  // WindowsApps payloads can carry EFS attributes. CopyFile attempts to re-encrypt
  // the destination and fails with ERROR_ENCRYPTION_FAILED. Stream only bytes;
  // do not clone package metadata, permissions or links into the user runtime.
  if (!(await lstat(source)).isDirectory()) {
    throw new Error(`Store runtime source must be a directory: ${source}`);
  }
  await copyStoreRuntimeDirectory(source, destination);
};

const copyStoreRuntimeDirectory = async (source: string, destination: string): Promise<void> => {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyStoreRuntimeDirectory(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      await copyStoreRuntimeFile(sourcePath, destinationPath);
    } else {
      throw new Error(`Unsupported Store runtime entry: ${sourcePath}`);
    }
  }
};

const copyStoreRuntimeFile = async (source: string, destination: string): Promise<void> => {
  const sourceHash = createHash("sha256");
  const checksum = new Transform({
    transform(chunk, _encoding, callback) {
      sourceHash.update(chunk);
      callback(null, chunk);
    }
  });
  await pipeline(createReadStream(source), checksum, createWriteStream(destination, { flags: "wx" }));

  const stagedHash = createHash("sha256");
  for await (const chunk of createReadStream(destination)) stagedHash.update(chunk);
  if (sourceHash.digest("hex") !== stagedHash.digest("hex")) {
    throw new Error(`Store runtime copy verification failed: ${source}`);
  }
};
