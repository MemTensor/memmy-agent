import { tmpdir } from "node:os";
import { DEFAULT_MEMMY_CONFIG, MemoryDb, MemoryService } from "../../src/index.js";
import { discoverLegacySources, migrateLegacyLocalPlugins } from "../../src/cli/legacy-migration.js";
import { mkdir } from "node:fs/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

export async function createLegacyFixture(root: string, agent: "openclaw" | "hermes" | "dsh", model: string, traceText: string): Promise<void> {
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

/** Real migration + panel output; only temporary synthetic databases are touched. */
export async function legacyScoringPanel(agent: "openclaw" | "hermes" | "dsh", scenario: "zero" | "historical-zero" | "pending" | "reflection-only" | "nonzero" | "historical-pending") {
  const root = mkdtempSync(join(tmpdir(), "memmy-legacy-score-"));
  let db: MemoryDb | undefined;
  let service: MemoryService | undefined;
  try {
    await createLegacyFixture(root, agent, "Legacy model", "legacy scoring sample");
    const source = discoverLegacySources(root).find(item => item.agent === agent)!;
    const legacy = new Database(source.dbPath);
    try {
      const pending = scenario === "pending" || scenario === "historical-pending";
      legacy.prepare("UPDATE traces SET reflection = ?, value = ?, alpha = ?, r_human = ?")
        .run(pending ? null : "IRRELEVANT", scenario === "nonzero" ? 0.25 : 0,
          scenario === "nonzero" ? 0.5 : 0, pending || scenario === "reflection-only" ? null : 0);
    } finally { legacy.close(); }
    const dbPath = join(root, ".memmy", "memory.sqlite");
    await migrateLegacyLocalPlugins({ configPath: join(root, ".memmy", "config.yaml"), dbPath,
      memmyConfigExisted: true, legacyRoot: root, nonInteractive: true });
    db = new MemoryDb({ path: dbPath });
    const row = db.db.prepare("SELECT properties_json FROM memories WHERE id = 'trace-shared'").get() as { properties_json: string };
    const properties = JSON.parse(row.properties_json);
    const migratedReward = properties.internal_info.trace.r_human;
    if (scenario.startsWith("historical-")) {
      delete properties.internal_info.trace.r_human;
      db.db.prepare("UPDATE memories SET properties_json = ? WHERE id = 'trace-shared'").run(JSON.stringify(properties));
    }
    service = new MemoryService({ db, mode: "dev", config: { ...DEFAULT_MEMMY_CONFIG, userId: "local-user" }, fetchAppMemoryBudget: async () => null });
    return { panel: service.panelItems({ userId: "local-user", layer: "L1" }), migratedReward };
  } finally {
    await service?.stop();
    db?.close();
    rmSync(root, { recursive: true, force: true });
  }
}
