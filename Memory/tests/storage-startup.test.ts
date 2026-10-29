import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareSqliteStorage } from "../src/server/storage-startup.js";
import { MemoryDb } from "../src/storage/db.js";
import { SCHEMA_VERSION } from "../src/storage/schema.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("SQLite startup preparation", () => {
  it("prepares a database before the main service opens it without rerunning migrations", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-storage-startup-"));
    directories.push(root);
    const path = join(root, "memory.sqlite");
    const phases: string[] = [];
    await prepareSqliteStorage({ sqlitePath: path, onStage: (stage) => phases.push(stage.phase) });
    expect(phases).toContain("migration.completed");
    const database = new MemoryDb({ path, skipMigrations: true });
    expect(database.schemaVersion().version).toBe(SCHEMA_VERSION);
    database.close();
  });
});
