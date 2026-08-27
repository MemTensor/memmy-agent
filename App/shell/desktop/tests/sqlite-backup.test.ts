import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { backupSqliteDatabase } from "../src/main/sqlite-backup.js";

let tempDirectory: string | undefined;

afterEach(() => {
  if (tempDirectory) {
    rmSync(tempDirectory, { recursive: true, force: true });
    tempDirectory = undefined;
  }
});

describe("backupSqliteDatabase", () => {
  it("includes committed rows that have not been checkpointed out of the WAL", async () => {
    tempDirectory = mkdtempSync(join(tmpdir(), "memmy-sqlite-backup-"));
    const sourcePath = join(tempDirectory, "memory.sqlite");
    const destinationPath = join(tempDirectory, "memory-backup.sqlite");
    const writer = new DatabaseSync(sourcePath);
    writer.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE memories (id TEXT PRIMARY KEY, memory_key TEXT NOT NULL);
      PRAGMA wal_checkpoint(TRUNCATE);
      INSERT INTO memories (id, memory_key) VALUES
        ('memory-1', 'key-1'),
        ('memory-2', 'key-2');
    `);

    expect(existsSync(`${sourcePath}-wal`)).toBe(true);
    const bytes = await backupSqliteDatabase(sourcePath, destinationPath);

    const restored = new DatabaseSync(destinationPath, { readOnly: true });
    const rows = restored.prepare("SELECT id, memory_key FROM memories ORDER BY id").all();
    const integrity = restored.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    restored.close();
    writer.close();

    expect(bytes).toBeGreaterThan(0);
    expect(rows).toEqual([
      { id: "memory-1", memory_key: "key-1" },
      { id: "memory-2", memory_key: "key-2" }
    ]);
    expect(integrity.integrity_check).toBe("ok");
  });

  it("does not replace an existing export when SQLite cannot open the source", async () => {
    tempDirectory = mkdtempSync(join(tmpdir(), "memmy-sqlite-backup-"));
    const destinationPath = join(tempDirectory, "memory-backup.sqlite");
    writeFileSync(destinationPath, "previous-export");

    await expect(
      backupSqliteDatabase(join(tempDirectory, "missing.sqlite"), destinationPath)
    ).rejects.toThrow();

    expect(readFileSync(destinationPath, "utf8")).toBe("previous-export");
  });

  it("rejects exporting over the live source database", async () => {
    tempDirectory = mkdtempSync(join(tmpdir(), "memmy-sqlite-backup-"));
    const sourcePath = join(tempDirectory, "memory.sqlite");
    const database = new DatabaseSync(sourcePath);
    database.close();

    await expect(backupSqliteDatabase(sourcePath, sourcePath)).rejects.toThrow(
      "destination must differ"
    );
  });
});
