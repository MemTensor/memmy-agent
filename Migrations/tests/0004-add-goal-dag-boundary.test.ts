import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addGoalDagBoundary } from "../src/migrations/v1.0.7/0004-add-goal-dag-boundary.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Goal DAG boundary migration", () => {
  it("preserves legacy rows and installs the final columns, edge type, and index", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memmy-goal-dag-migration-"));
    roots.push(root);
    const dagDir = path.join(root, "dag");
    await fs.mkdir(dagDir);
    const file = path.join(dagDir, "cli_test.sqlite");
    const db = new Database(file);
    db.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE dag_turns (
        turn_id TEXT PRIMARY KEY, message_start INTEGER NOT NULL, message_end INTEGER NOT NULL,
        user_text TEXT NOT NULL DEFAULT '', assistant_text TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        dag_status TEXT NOT NULL DEFAULT 'pending', build_mode TEXT, attempt_count INTEGER NOT NULL DEFAULT 0,
        running_started_at TEXT, next_retry_at TEXT, last_error TEXT, processed_at TEXT,
        CHECK(message_end > message_start)
      );
      CREATE TABLE dag_nodes (
        id TEXT PRIMARY KEY, session_key TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
        title TEXT NOT NULL, summary TEXT NOT NULL, detail_json TEXT NOT NULL DEFAULT '{}', importance INTEGER NOT NULL DEFAULT 0,
        created_turn_id TEXT REFERENCES dag_turns(turn_id), updated_turn_id TEXT REFERENCES dag_turns(turn_id),
        first_message_index INTEGER NOT NULL DEFAULT 0, last_message_index INTEGER NOT NULL DEFAULT 0,
        source_refs_json TEXT NOT NULL DEFAULT '[]', created_by TEXT NOT NULL DEFAULT 'llm_patch',
        updated_by TEXT NOT NULL DEFAULT 'llm_patch', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE dag_edges (
        id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES dag_nodes(id), target_id TEXT NOT NULL REFERENCES dag_nodes(id),
        type TEXT NOT NULL CHECK(type IN ('decomposes','continues','blocks','supersedes')),
        created_turn_id TEXT REFERENCES dag_turns(turn_id), created_by TEXT NOT NULL DEFAULT 'llm_patch', created_at TEXT NOT NULL,
        UNIQUE(source_id,target_id,type), CHECK(source_id <> target_id)
      );
      INSERT INTO dag_turns(turn_id,message_start,message_end,created_at,updated_at) VALUES('t1',0,2,'now','now');
      INSERT INTO dag_nodes(id,session_key,kind,status,title,summary,created_turn_id,updated_turn_id,created_at,updated_at)
        VALUES('task','cli:test','task','active','Task','Task','t1','t1','now','now');
      INSERT INTO dag_nodes(id,session_key,kind,status,title,summary,created_turn_id,updated_turn_id,created_at,updated_at)
        VALUES('child','cli:test','subtask','active','Child','Child','t1','t1','now','now');
      INSERT INTO dag_edges(id,source_id,target_id,type,created_turn_id,created_at) VALUES('e1','task','child','decomposes','t1','now');
      CREATE INDEX idx_dag_edges_source ON dag_edges(source_id);
      CREATE INDEX legacy_node_title ON dag_nodes(title);
    `);
    db.close();
    const context = {
      profileWorkspace: root,
      sessionsDir: path.join(root, "sessions"),
      runtimeConfigFile: path.join(root, "config.yaml"),
      sessionDagDir: dagDir,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };

    await expect(addGoalDagBoundary(context)).resolves.toEqual({ scanned: 1, changed: 1, ignored: 0 });
    const migrated = new Database(file);
    expect((migrated.prepare("PRAGMA table_info(dag_turns)").all() as Array<{ name: string }>).map((row) => row.name))
      .toEqual(expect.arrayContaining(["goal_id", "goal_objective", "goal_status"]));
    expect((migrated.prepare("PRAGMA table_info(dag_nodes)").all() as Array<{ name: string }>).map((row) => row.name))
      .toContain("goal_id");
    expect(migrated.prepare("SELECT turn_id,message_start,message_end FROM dag_turns").all())
      .toEqual([{ turn_id: "t1", message_start: 0, message_end: 2 }]);
    expect(migrated.prepare("SELECT id,kind,status,title,summary FROM dag_nodes ORDER BY id").all()).toEqual([
      { id: "child", kind: "subtask", status: "active", title: "Child", summary: "Child" },
      { id: "task", kind: "task", status: "active", title: "Task", summary: "Task" },
    ]);
    expect(migrated.prepare("SELECT type FROM dag_edges WHERE id='e1'").get()).toEqual({ type: "decomposes" });
    expect((migrated.prepare("SELECT name FROM sqlite_schema WHERE type='index'").all() as Array<{ name: string }>).map((row) => row.name))
      .toEqual(expect.arrayContaining(["idx_dag_edges_source", "legacy_node_title", "idx_dag_nodes_goal_id_unique"]));
    expect(() => migrated.prepare(
      "INSERT INTO dag_edges(id,source_id,target_id,type,created_at) VALUES('e2','task','child','side_branch','now')",
    ).run()).not.toThrow();
    expect(migrated.pragma("foreign_key_check")).toEqual([]);
    migrated.close();

    await expect(addGoalDagBoundary(context)).resolves.toEqual({ scanned: 1, changed: 0, ignored: 1 });
  });

  it("is a no-op for a missing or empty Session DAG directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memmy-goal-dag-empty-"));
    roots.push(root);
    const context = migrationContext(root, path.join(root, "missing"));

    await expect(addGoalDagBoundary(context)).resolves.toEqual({ scanned: 0, changed: 0, ignored: 0 });
    await fs.mkdir(context.sessionDagDir);
    await expect(addGoalDagBoundary(context)).resolves.toEqual({ scanned: 0, changed: 0, ignored: 0 });
  });

  it("migrates multiple Session DAG databases independently and ignores non-database files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memmy-goal-dag-multiple-"));
    roots.push(root);
    const dagDir = path.join(root, "dag");
    await fs.mkdir(dagDir);
    const files = [path.join(dagDir, "a.sqlite"), path.join(dagDir, "b.sqlite")];
    for (const [index, file] of files.entries()) createLegacyDatabase(file, String(index + 1));
    await fs.writeFile(path.join(dagDir, "ignored.txt"), "not sqlite");
    const context = migrationContext(root, dagDir);

    await expect(addGoalDagBoundary(context)).resolves.toEqual({ scanned: 2, changed: 2, ignored: 0 });
    for (const file of files) {
      const db = new Database(file);
      expect((db.prepare("PRAGMA table_info(dag_turns)").all() as Array<{ name: string }>).map((row) => row.name))
        .toEqual(expect.arrayContaining(["goal_id", "goal_objective", "goal_status"]));
      expect(db.prepare("SELECT COUNT(*) AS count FROM dag_nodes").get()).toEqual({ count: 2 });
      db.close();
    }
  });

  it("rolls back an interrupted schema transaction and succeeds on retry", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "memmy-goal-dag-rollback-"));
    roots.push(root);
    const dagDir = path.join(root, "dag");
    await fs.mkdir(dagDir);
    const file = path.join(dagDir, "rollback.sqlite");
    createLegacyDatabase(file, "rollback");
    const context = migrationContext(root, dagDir);

    await expect(addGoalDagBoundary(context, {
      beforeCommit: () => {
        throw new Error("injected transaction failure");
      },
    })).rejects.toMatchObject({ code: "migration_io_failed" });

    const rolledBack = new Database(file);
    expect((rolledBack.prepare("PRAGMA table_info(dag_turns)").all() as Array<{ name: string }>).map((row) => row.name))
      .not.toContain("goal_id");
    const edgeTable = rolledBack.prepare(
      "SELECT sql FROM sqlite_schema WHERE type='table' AND name='dag_edges'",
    ).get() as { sql: string };
    expect(edgeTable.sql).not.toContain("side_branch");
    expect(rolledBack.prepare("SELECT COUNT(*) AS count FROM dag_edges").get()).toEqual({ count: 1 });
    rolledBack.close();

    await expect(addGoalDagBoundary(context)).resolves.toEqual({ scanned: 1, changed: 1, ignored: 0 });
    await expect(addGoalDagBoundary(context)).resolves.toEqual({ scanned: 1, changed: 0, ignored: 1 });
  });
});

function migrationContext(root: string, sessionDagDir: string) {
  return {
    profileWorkspace: root,
    sessionsDir: path.join(root, "sessions"),
    runtimeConfigFile: path.join(root, "config.yaml"),
    sessionDagDir,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

function createLegacyDatabase(file: string, suffix: string): void {
  const db = new Database(file);
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE dag_turns (
      turn_id TEXT PRIMARY KEY, message_start INTEGER NOT NULL, message_end INTEGER NOT NULL,
      user_text TEXT NOT NULL DEFAULT '', assistant_text TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, dag_status TEXT NOT NULL DEFAULT 'pending',
      build_mode TEXT, attempt_count INTEGER NOT NULL DEFAULT 0, running_started_at TEXT,
      next_retry_at TEXT, last_error TEXT, processed_at TEXT, CHECK(message_end > message_start)
    );
    CREATE TABLE dag_nodes (
      id TEXT PRIMARY KEY, session_key TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
      title TEXT NOT NULL, summary TEXT NOT NULL, detail_json TEXT NOT NULL DEFAULT '{}', importance INTEGER NOT NULL DEFAULT 0,
      created_turn_id TEXT REFERENCES dag_turns(turn_id), updated_turn_id TEXT REFERENCES dag_turns(turn_id),
      first_message_index INTEGER NOT NULL DEFAULT 0, last_message_index INTEGER NOT NULL DEFAULT 0,
      source_refs_json TEXT NOT NULL DEFAULT '[]', created_by TEXT NOT NULL DEFAULT 'llm_patch',
      updated_by TEXT NOT NULL DEFAULT 'llm_patch', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE dag_edges (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES dag_nodes(id), target_id TEXT NOT NULL REFERENCES dag_nodes(id),
      type TEXT NOT NULL CHECK(type IN ('decomposes','continues','blocks','supersedes')),
      created_turn_id TEXT REFERENCES dag_turns(turn_id), created_by TEXT NOT NULL DEFAULT 'llm_patch', created_at TEXT NOT NULL,
      UNIQUE(source_id,target_id,type), CHECK(source_id <> target_id)
    );
    INSERT INTO dag_turns(turn_id,message_start,message_end,created_at,updated_at) VALUES('turn-${suffix}',0,2,'now','now');
    INSERT INTO dag_nodes(id,session_key,kind,status,title,summary,created_turn_id,updated_turn_id,created_at,updated_at)
      VALUES('task-${suffix}','cli:${suffix}','task','active','Task','Task','turn-${suffix}','turn-${suffix}','now','now');
    INSERT INTO dag_nodes(id,session_key,kind,status,title,summary,created_turn_id,updated_turn_id,created_at,updated_at)
      VALUES('child-${suffix}','cli:${suffix}','subtask','active','Child','Child','turn-${suffix}','turn-${suffix}','now','now');
    INSERT INTO dag_edges(id,source_id,target_id,type,created_turn_id,created_at)
      VALUES('edge-${suffix}','task-${suffix}','child-${suffix}','decomposes','turn-${suffix}','now');
  `);
  db.close();
}
