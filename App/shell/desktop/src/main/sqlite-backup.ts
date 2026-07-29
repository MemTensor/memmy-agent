import { randomUUID } from "node:crypto";
import { copyFile, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

/**
 * Creates a consistent single-file SQLite snapshot, including committed WAL data.
 *
 * The online backup is written to a temporary sibling first. Copying that closed
 * snapshot to the user-selected path is safe and preserves the existing export
 * until SQLite has finished producing the replacement.
 */
export async function backupSqliteDatabase(sourcePath: string, destinationPath: string): Promise<number> {
  const source = resolve(sourcePath);
  const destination = resolve(destinationPath);
  if (source === destination) {
    throw new Error("SQLite backup destination must differ from the source database");
  }

  const temporaryPath = join(
    dirname(destination),
    `.${basename(destination)}.${randomUUID()}.tmp`
  );

  try {
    const sourceDatabase = new DatabaseSync(source, { readOnly: true });
    try {
      await backup(sourceDatabase, temporaryPath);
    } finally {
      sourceDatabase.close();
    }

    await copyFile(temporaryPath, destination);
    return (await stat(destination)).size;
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}
