import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import {
  MigrationError,
  type AgentWorkspaceMigrationContext,
  type MigrationDefinition,
  type MigrationResult,
} from "../../types.js";

const MIGRATION_ID = "v1.0.7/0004-add-goal-dag-boundary";

type MigrationHooks = {
  beforeCommit?: (db: Database.Database, filePath: string) => void;
};

function ioError(filePath: string, cause: unknown): MigrationError {
  return new MigrationError("migration_io_failed", `Migration I/O failed for ${filePath}`, {
    migrationId: MIGRATION_ID,
    scope: "session-dag",
    cause,
  });
}

function columns(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map((column) => column.name),
  );
}

function tableSql(db: Database.Database, table: string): string {
  const row = db.prepare(
    "SELECT sql FROM sqlite_schema WHERE type='table' AND name=?",
  ).get(table) as { sql?: string } | undefined;
  return String(row?.sql ?? "");
}

function assertBaseSchema(db: Database.Database, filePath: string): void {
  for (const table of ["dag_turns", "dag_nodes", "dag_edges"]) {
    if (!tableSql(db, table)) throw ioError(filePath, new Error(`Missing ${table}`));
  }
}

function schemaIsFinal(db: Database.Database): boolean {
  const turnColumns = columns(db, "dag_turns");
  const nodeColumns = columns(db, "dag_nodes");
  const edgeSql = tableSql(db, "dag_edges");
  const index = db.prepare(
    "SELECT 1 FROM sqlite_schema WHERE type='index' AND name='idx_dag_nodes_goal_id_unique'",
  ).get();
  return ["goal_id", "goal_objective", "goal_status"].every((name) => turnColumns.has(name))
    && nodeColumns.has("goal_id")
    && /side_branch/.test(edgeSql)
    && Boolean(index);
}

function rebuildEdges(db: Database.Database): void {
  if (/side_branch/.test(tableSql(db, "dag_edges"))) return;
  db.exec(`
    CREATE TABLE dag_edges_goal_migration (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES dag_nodes(id),
      target_id TEXT NOT NULL REFERENCES dag_nodes(id),
      type TEXT NOT NULL CHECK(type IN ('decomposes', 'continues', 'blocks', 'supersedes', 'side_branch')),
      created_turn_id TEXT REFERENCES dag_turns(turn_id),
      created_by TEXT NOT NULL DEFAULT 'llm_patch' CHECK(created_by IN ('llm_patch', 'deterministic_fallback', 'repair')),
      created_at TEXT NOT NULL,
      UNIQUE(source_id, target_id, type),
      CHECK(source_id <> target_id)
    );
    INSERT INTO dag_edges_goal_migration (
      id, source_id, target_id, type, created_turn_id, created_by, created_at
    ) SELECT id, source_id, target_id, type, created_turn_id, created_by, created_at FROM dag_edges;
    DROP TABLE dag_edges;
    ALTER TABLE dag_edges_goal_migration RENAME TO dag_edges;
    CREATE INDEX IF NOT EXISTS idx_dag_edges_source ON dag_edges(source_id);
    CREATE INDEX IF NOT EXISTS idx_dag_edges_target ON dag_edges(target_id);
  `);
}

function migrateDatabase(filePath: string, hooks: MigrationHooks): "changed" | "ignored" {
  let db: Database.Database | null = null;
  try {
    db = new Database(filePath);
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = OFF");
    assertBaseSchema(db, filePath);
    if (schemaIsFinal(db)) return "ignored";
    db.exec("BEGIN IMMEDIATE");
    try {
      const turnColumns = columns(db, "dag_turns");
      if (!turnColumns.has("goal_id")) db.exec("ALTER TABLE dag_turns ADD COLUMN goal_id TEXT");
      if (!turnColumns.has("goal_objective")) db.exec("ALTER TABLE dag_turns ADD COLUMN goal_objective TEXT");
      if (!turnColumns.has("goal_status")) db.exec("ALTER TABLE dag_turns ADD COLUMN goal_status TEXT");
      const nodeColumns = columns(db, "dag_nodes");
      if (!nodeColumns.has("goal_id")) {
        db.exec("ALTER TABLE dag_nodes ADD COLUMN goal_id TEXT CHECK(goal_id IS NULL OR kind = 'task')");
      }
      rebuildEdges(db);
      db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_dag_nodes_goal_id_unique ON dag_nodes(goal_id) WHERE goal_id IS NOT NULL",
      );
      hooks.beforeCommit?.(db, filePath);
      const foreignKeyProblems = db.pragma("foreign_key_check") as unknown[];
      if (foreignKeyProblems.length) throw new Error("Session DAG foreign key check failed");
      if (!schemaIsFinal(db)) throw new Error("Session DAG schema verification failed");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return "changed";
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    throw ioError(filePath, error);
  } finally {
    if (db) {
      try {
        db.pragma("foreign_keys = ON");
      } finally {
        db.close();
      }
    }
  }
}

export async function addGoalDagBoundary(
  context: AgentWorkspaceMigrationContext,
  hooks: MigrationHooks = {},
): Promise<MigrationResult> {
  const result: MigrationResult = { scanned: 0, changed: 0, ignored: 0 };
  let entries;
  try {
    entries = await fs.readdir(context.sessionDagDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw ioError(context.sessionDagDir, error);
  }
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sqlite"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  for (const name of names) {
    result.scanned += 1;
    const outcome = migrateDatabase(path.join(context.sessionDagDir, name), hooks);
    if (outcome === "changed") result.changed += 1;
    else result.ignored += 1;
  }
  return result;
}

export const addGoalDagBoundaryV107: MigrationDefinition = {
  id: MIGRATION_ID,
  introducedIn: "1.0.7",
  scope: "session-dag",
  description: "Add Goal task boundaries and side branches to Session DAG databases",
  up: addGoalDagBoundary,
};
