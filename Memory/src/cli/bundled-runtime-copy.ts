import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { cp, lstat, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const STORE_COPY_CONCURRENCY = 8;

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
  // Share the limit across the whole tree, including each file's staged hash
  // verification. Small Store dependency files otherwise pay the I/O cost serially.
  const pending = new Set<Promise<void>>();
  let failed = false;
  let firstError: unknown;
  const recordFailure = (error: unknown) => {
    if (!failed) firstError = error;
    failed = true;
  };
  const visit = async (directory: string, target: string): Promise<void> => {
    if (failed) return;
    await mkdir(target, { recursive: true });
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (failed) return;
      const sourcePath = join(directory, entry.name);
      const destinationPath = join(target, entry.name);
      if (entry.isDirectory()) {
        await visit(sourcePath, destinationPath);
      } else if (entry.isFile()) {
        const task = copyStoreRuntimeFile(sourcePath, destinationPath)
          .catch(recordFailure)
          .finally(() => pending.delete(task));
        pending.add(task);
        if (pending.size === STORE_COPY_CONCURRENCY) await Promise.race(pending);
      } else {
        throw new Error(`Unsupported Store runtime entry: ${sourcePath}`);
      }
    }
  };
  try {
    await visit(source, destination);
  } catch (error) {
    recordFailure(error);
  }
  // File and traversal errors must both drain all started writes before the
  // installer removes staging or rolls back. This set contains at most 8 tasks.
  await Promise.all(pending);
  if (failed) throw firstError;
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
