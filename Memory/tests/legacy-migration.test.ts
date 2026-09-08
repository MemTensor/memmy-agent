import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MEMMY_CONFIG, MemoryDb, MemoryService } from "../src/index.js";
import { discoverLegacySources, migrateLegacyLocalPlugins } from "../src/cli/legacy-migration.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Local Plugin 2.0 migration", () => {
  it("discovers the three supported legacy runtime homes", () => {
    const root = tempRoot();
    expect(discoverLegacySources(root).map((source) => source.agent)).toEqual(["openclaw", "hermes", "dsh"]);
  });

  it("requires an explicit config source for unattended OpenClaw and Hermes migration", async () => {
    const root = tempRoot();
    await createLegacyFixture(root, "openclaw", "OpenClaw model", "openclaw trace");
    await createLegacyFixture(root, "hermes", "Hermes model", "hermes trace");
    await expect(migrateLegacyLocalPlugins({
      configPath: join(root, ".memmy", "config.yaml"),
      dbPath: join(root, ".memmy", "memory-service", "memory.sqlite"),
      memmyConfigExisted: false,
      legacyRoot: root,
      nonInteractive: true,
      dryRun: true
    })).rejects.toThrow("--config-source openclaw|hermes");
  });

  it("automatically uses the only Local Plugin config when Memmy has no config", async () => {
    const root = tempRoot();
    await createLegacyFixture(root, "hermes", "Hermes model", "hermes trace");
    const configPath = join(root, ".memmy", "config.yaml");
    const report = await migrateLegacyLocalPlugins({
      configPath,
      dbPath: join(root, ".memmy", "memory-service", "memory.sqlite"),
      memmyConfigExisted: false,
      legacyRoot: root,
      nonInteractive: true
    });

    expect(report.configSource).toBe("hermes");
    const config = parseYaml(readFileSync(configPath, "utf8")) as Record<string, any>;
    expect(config.memmyMemory.summary.model).toBe("Hermes model");
  });

  it("merges all databases, remaps conflicting ids, repairs relationships, and is idempotent", async () => {
    const root = tempRoot();
    await createLegacyFixture(root, "openclaw", "OpenClaw model", "openclaw trace");
    await createLegacyFixture(root, "hermes", "Hermes model", "hermes trace");
    const configPath = join(root, ".memmy", "config.yaml");
    const dbPath = join(root, ".memmy", "memory-service", "memory.sqlite");
    const first = await migrateLegacyLocalPlugins({
      configPath,
      dbPath,
      memmyConfigExisted: false,
      configSource: "openclaw",
      legacyRoot: root,
      nonInteractive: true
    });

    expect(first.configSource).toBe("openclaw");
    expect(first.sources).toHaveLength(2);
    expect(first.sources[1]!.remapped).toHaveProperty("sessions:session-shared");
    expect(first.reportPath && existsSync(first.reportPath)).toBe(true);
    const config = parseYaml(readFileSync(configPath, "utf8")) as Record<string, any>;
    expect(config.memmyMemory.summary.model).toBe("OpenClaw model");
    expect(config.memmyMemory.roleRouting).toEqual({ summary: "fixed", evolution: "fixed" });
    expect(config.memmyMemory.algorithm).not.toHaveProperty("lightweightMemory");
    expect(config.memmyMemory).not.toHaveProperty("logging");
    expect(config.memmyMemory.telemetry.enabled).toBe(false);
    expect(config.memmyMemory.hub).toMatchObject({ enabled: true, role: "client", migratedFrom: "openclaw" });
    expect(config.hub).toBeUndefined();
    expect(config.modelAssignments.byok).toMatchObject({
      memorySummary: expect.any(String),
      memoryEvolution: expect.any(String)
    });

    const db = new Database(dbPath, { readonly: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM episodes").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM memories WHERE memory_layer = 'L1'").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM raw_turns").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM legacy_migration_ledger").pluck().get()).toBeGreaterThan(0);
    const broken = db.prepare(`SELECT COUNT(*) AS n FROM raw_turns
      LEFT JOIN sessions ON sessions.id = raw_turns.session_id
      LEFT JOIN episodes ON episodes.id = raw_turns.episode_id
      WHERE sessions.id IS NULL OR episodes.id IS NULL`).pluck().get();
    expect(broken).toBe(0);
    db.close();

    const second = await migrateLegacyLocalPlugins({
      configPath,
      dbPath,
      memmyConfigExisted: true,
      legacyRoot: root,
      nonInteractive: true
    });
    expect(second.sources.every((source) => (source.inserted.memories ?? 0) === 0)).toBe(true);
    const verify = new Database(dbPath, { readonly: true });
    expect(verify.prepare("SELECT COUNT(*) AS n FROM memories WHERE memory_layer = 'L1'").get()).toEqual({ n: 2 });
    verify.close();
  });

  it("keeps existing Memmy config and data while importing every Local Plugin database", async () => {
    const root = tempRoot();
    await createLegacyFixture(root, "openclaw", "OpenClaw model", "plugin trace");
    const configPath = join(root, ".memmy", "config.yaml");
    const dbPath = join(root, ".memmy", "custom", "existing.sqlite");
    await mkdir(join(root, ".memmy", "custom"), { recursive: true });
    writeFileSync(configPath, `memmyMemory:\n  roleRouting:\n    summary: fixed\n    evolution: fixed\n  summary:\n    provider: openai_compatible\n    model: Memmy model\n  embedding:\n    mode: local\n  storage:\n    sqlitePath: ${dbPath}\n`);
    const memmyDb = new MemoryDb({ path: dbPath });
    const service = new MemoryService({
      db: memmyDb,
      mode: "dev",
      config: { ...DEFAULT_MEMMY_CONFIG, userId: "local-user" }
    });
    service.addMemory({ content: "existing Memmy memory", source: "memmy", layer: "L1" });
    memmyDb.close();

    const report = await migrateLegacyLocalPlugins({
      configPath,
      dbPath,
      memmyConfigExisted: true,
      configSource: "openclaw",
      legacyRoot: root,
      nonInteractive: true
    });

    expect(report.configSource).toBeUndefined();
    expect(report.backupPath && existsSync(report.backupPath)).toBe(true);
    const backup = new Database(report.backupPath!, { readonly: true });
    expect(backup.prepare("SELECT COUNT(*) FROM memories WHERE memory_value LIKE '%existing Memmy memory%'").pluck().get()).toBe(1);
    expect(backup.prepare("SELECT COUNT(*) FROM memories WHERE memory_value LIKE '%plugin trace%'").pluck().get()).toBe(0);
    backup.close();
    const config = parseYaml(readFileSync(configPath, "utf8")) as Record<string, any>;
    expect(config.memmyMemory.summary.model).toBe("Memmy model");
    const merged = new Database(dbPath, { readonly: true });
    expect(merged.prepare("SELECT COUNT(*) FROM memories WHERE memory_layer = 'L1'").pluck().get()).toBe(2);
    expect(merged.prepare("SELECT COUNT(*) FROM memories WHERE memory_value LIKE '%existing Memmy memory%'").pluck().get()).toBe(1);
    expect(merged.prepare("SELECT COUNT(*) FROM memories WHERE memory_value LIKE '%plugin trace%'").pluck().get()).toBe(1);
    merged.close();
  });

  it("merges legacy traces that share a session and turn into one raw turn", async () => {
    const root = tempRoot();
    await createLegacyFixture(root, "hermes", "Hermes model", "first user");
    const legacyPath = join(root, ".hermes", "memos-plugin", "data", "memos.db");
    const legacy = new Database(legacyPath);
    const turnId = Number(legacy.prepare("SELECT turn_id FROM traces WHERE id = ?").pluck().get("trace-shared"));
    const timestamp = Number(legacy.prepare("SELECT ts FROM traces WHERE id = ?").pluck().get("trace-shared")) + 1;
    legacy.prepare(`
      INSERT INTO traces (
        id, episode_id, session_id, owner_agent_kind, owner_profile_id, owner_workspace_id,
        ts, user_text, agent_text, summary, tool_calls_json, reflection, agent_thinking,
        value, alpha, r_human, priority, tags_json, error_signatures_json, turn_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "trace-duplicate",
      "episode-shared",
      "session-shared",
      "hermes",
      "default",
      null,
      timestamp,
      "second user",
      "second answer",
      "second summary",
      "[]",
      null,
      null,
      1,
      1,
      1,
      1,
      "[\"duplicate\"]",
      "[]",
      turnId
    );
    legacy.close();

    const dbPath = join(root, ".memmy", "memory-service", "memory.sqlite");
    const first = await migrateLegacyLocalPlugins({
      configPath: join(root, ".memmy", "config.yaml"),
      dbPath,
      memmyConfigExisted: true,
      legacyRoot: root,
      nonInteractive: true
    });

    expect(first.sources[0]?.inserted.raw_turns).toBe(1);
    expect(first.sources[0]?.deduplicated.raw_turns).toBe(1);
    const db = new Database(dbPath, { readonly: true });
    expect(db.prepare("SELECT COUNT(*) FROM raw_turns").pluck().get()).toBe(1);
    const rawTurn = db.prepare("SELECT user_text, assistant_text, message_payload_json FROM raw_turns").get() as {
      user_text: string;
      assistant_text: string;
      message_payload_json: string;
    };
    expect(rawTurn.user_text).toContain("first user");
    expect(rawTurn.user_text).toContain("second user");
    expect(rawTurn.assistant_text).toContain("hermes answer");
    expect(rawTurn.assistant_text).toContain("second answer");
    expect(JSON.parse(rawTurn.message_payload_json).legacyTraceIds).toEqual([
      "trace-shared",
      "trace-duplicate"
    ]);
    expect(db.prepare("SELECT COUNT(*) FROM memories WHERE memory_layer = 'L1'").pluck().get()).toBe(2);
    db.close();

    const second = await migrateLegacyLocalPlugins({
      configPath: join(root, ".memmy", "config.yaml"),
      dbPath,
      memmyConfigExisted: true,
      legacyRoot: root,
      nonInteractive: true
    });
    expect(second.sources[0]?.inserted.raw_turns ?? 0).toBe(0);
    const verify = new Database(dbPath, { readonly: true });
    expect(verify.prepare("SELECT COUNT(*) FROM raw_turns").pluck().get()).toBe(1);
    verify.close();
  });

  it("imports the older chunks/tasks/skills Local Plugin database layout", async () => {
    const root = tempRoot();
    const oldDirectory = join(root, ".openclaw", "memos-local");
    await mkdir(oldDirectory, { recursive: true });
    const oldPath = join(oldDirectory, "memos.db");
    const old = new Database(oldPath);
    old.exec(`
      CREATE TABLE chunks (id TEXT PRIMARY KEY, session_key TEXT, turn_id TEXT, seq INTEGER, role TEXT, content TEXT, summary TEXT, created_at INTEGER);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, session_key TEXT, title TEXT, summary TEXT, status TEXT, started_at INTEGER, ended_at INTEGER);
      CREATE TABLE skills (id TEXT PRIMARY KEY, name TEXT, description TEXT, status TEXT, created_at INTEGER, updated_at INTEGER);
    `);
    const now = Date.now();
    old.prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?)").run("task-old", "session-old", "Old task", "Old summary", "closed", now, now);
    old.prepare("INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("chunk-old", "session-old", "task-old", 1, "user", "old plugin memory", "old memory", now);
    old.prepare("INSERT INTO skills VALUES (?, ?, ?, ?, ?, ?)").run("skill-old", "Old skill", "Old skill guide", "active", now, now);
    old.close();

    const dbPath = join(root, ".memmy", "memory-service", "memory.sqlite");
    const report = await migrateLegacyLocalPlugins({
      configPath: join(root, ".memmy", "config.yaml"),
      dbPath,
      memmyConfigExisted: true,
      legacyRoot: root,
      nonInteractive: true
    });

    expect(report.sources).toHaveLength(1);
    expect(report.sources[0]?.database).toBe(oldPath);
    const db = new Database(dbPath, { readonly: true });
    expect(db.prepare("SELECT COUNT(*) FROM memories WHERE memory_layer = 'L1'").pluck().get()).toBe(1);
    expect(db.prepare("SELECT COUNT(*) FROM memories WHERE memory_layer = 'Skill'").pluck().get()).toBe(1);
    expect(db.prepare("SELECT COUNT(*) FROM episodes").pluck().get()).toBe(1);
    expect(db.prepare("SELECT COUNT(*) FROM raw_turns").pluck().get()).toBe(1);
    db.close();
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-legacy-migration-"));
  roots.push(root);
  return root;
}

async function createLegacyFixture(root: string, agent: "openclaw" | "hermes", model: string, traceText: string): Promise<void> {
  const runtime = join(root, `.${agent}`, "memos-plugin");
  await mkdir(join(runtime, "data"), { recursive: true });
  writeFileSync(join(runtime, "config.yaml"), `llm:\n  provider: openai_compatible\n  endpoint: https://models.example/v1\n  model: ${model}\n  apiKey: secret-${agent}\nembedding:\n  provider: local\n  batchSize: 16\nalgorithm:\n  lightweightMemory:\n    enabled: true\nlogging:\n  detailedView: true\ntelemetry:\n  enabled: false\nhub:\n  enabled: true\n  role: client\n`);
  const db = new Database(join(runtime, "data", "memos.db"));
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, agent TEXT, owner_agent_kind TEXT, owner_profile_id TEXT, owner_workspace_id TEXT, started_at INTEGER, last_seen_at INTEGER, meta_json TEXT);
    CREATE TABLE episodes (id TEXT PRIMARY KEY, session_id TEXT, owner_agent_kind TEXT, owner_profile_id TEXT, owner_workspace_id TEXT, share_scope TEXT, started_at INTEGER, ended_at INTEGER, trace_ids_json TEXT, r_task REAL, status TEXT, meta_json TEXT);
    CREATE TABLE traces (id TEXT PRIMARY KEY, episode_id TEXT, session_id TEXT, owner_agent_kind TEXT, owner_profile_id TEXT, owner_workspace_id TEXT, ts INTEGER, user_text TEXT, agent_text TEXT, summary TEXT, tool_calls_json TEXT, reflection TEXT, agent_thinking TEXT, value REAL, alpha REAL, r_human REAL, priority REAL, tags_json TEXT, error_signatures_json TEXT, turn_id INTEGER);
    CREATE TABLE policies (id TEXT PRIMARY KEY, title TEXT, trigger TEXT, procedure TEXT, verification TEXT, boundary TEXT, support INTEGER, gain REAL, status TEXT, experience_type TEXT, evidence_polarity TEXT, confidence REAL, source_episodes_json TEXT, source_feedback_ids_json TEXT, source_trace_ids_json TEXT, decision_guidance_json TEXT, skill_eligible INTEGER, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE world_model (id TEXT PRIMARY KEY, title TEXT, body TEXT, policy_ids_json TEXT, structure_json TEXT, domain_tags_json TEXT, confidence REAL, source_episodes_json TEXT, created_at INTEGER, updated_at INTEGER, status TEXT);
    CREATE TABLE skills (id TEXT PRIMARY KEY, name TEXT, status TEXT, invocation_guide TEXT, procedure_json TEXT, eta REAL, support INTEGER, gain REAL, trials_attempted INTEGER, trials_passed INTEGER, source_policies_json TEXT, source_world_json TEXT, evidence_anchors_json TEXT, created_at INTEGER, updated_at INTEGER);
  `);
  const now = Date.now();
  db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("session-shared", agent, agent, "default", null, now, now, "{}");
  db.prepare("INSERT INTO episodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("episode-shared", "session-shared", agent, "default", null, "private", now, now, '["trace-shared"]', 1, "closed", json({ title: `${agent} task` }));
  db.prepare("INSERT INTO traces VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("trace-shared", "episode-shared", "session-shared", agent, "default", null, now, traceText, `${agent} answer`, traceText, "[]", null, null, 1, 1, 1, 1, json([agent]), "[]", now);
  db.close();
}

function json(value: unknown): string { return JSON.stringify(value); }
