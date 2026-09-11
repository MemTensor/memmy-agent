import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import Database from "better-sqlite3";
import { parse as parseYaml } from "yaml";
import { syncMemoryModelCatalog } from "../config/model-catalog.js";
import { mutateMemoryConfig } from "../config/writer.js";
import { migrate } from "../storage/schema.js";

export type LegacyAgent = "openclaw" | "hermes" | "dsh";
export type LegacyConfigSource = "openclaw" | "hermes";

export interface LegacyMigrationOptions {
  configPath: string;
  dbPath: string;
  memmyConfigExisted: boolean;
  configSource?: LegacyConfigSource;
  legacyRoot?: string;
  nonInteractive?: boolean;
  dryRun?: boolean;
}

export interface LegacyMigrationReport {
  ok: true;
  configSource?: LegacyAgent;
  detected: Array<{ agent: LegacyAgent; root: string; config: boolean; database: boolean }>;
  sources: Array<{ agent: LegacyAgent; database: string; inserted: Record<string, number>; deduplicated: Record<string, number>; remapped: Record<string, string> }>;
  backupPath?: string;
  reportPath?: string;
  dryRun: boolean;
}

interface LegacySource {
  agent: LegacyAgent;
  root: string;
  configPath: string;
  dbPath: string;
}

type Row = Record<string, unknown>;
type IdMaps = Record<string, Map<string, string>>;

const LEGACY_HOMES: Record<LegacyAgent, string> = {
  openclaw: ".openclaw/memos-plugin",
  hermes: ".hermes/memos-plugin",
  dsh: ".dsh/memos-plugin"
};

export async function migrateLegacyLocalPlugins(options: LegacyMigrationOptions): Promise<LegacyMigrationReport> {
  const sources = discoverLegacySources(options.legacyRoot);
  const detected = sources.map((source) => ({
    agent: source.agent,
    root: source.root,
    config: existsSync(source.configPath),
    database: existsSync(source.dbPath)
  }));
  const configCandidates = sources.filter((source) => existsSync(source.configPath));
  const configSource = options.memmyConfigExisted
    ? undefined
    : await selectConfigSource(configCandidates, options);
  const dataSources = sources.filter((source) => existsSync(source.dbPath));
  const report: LegacyMigrationReport = {
    ok: true,
    ...(configSource ? { configSource: configSource.agent } : {}),
    detected,
    sources: [],
    dryRun: options.dryRun ?? false
  };
  if (options.dryRun) {
    report.sources = dataSources.map((source) => ({ agent: source.agent, database: source.dbPath, inserted: {}, deduplicated: {}, remapped: {} }));
    return report;
  }
  if (dataSources.length === 0) {
    if (configSource) await importLegacyConfig(configSource, options.configPath);
    return report;
  }

  await mkdir(dirname(options.dbPath), { recursive: true });
  const existed = existsSync(options.dbPath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = new Database(options.dbPath);
  try {
    if (existed) {
      report.backupPath = `${options.dbPath}.pre-legacy-${timestamp}.bak`;
      await target.backup(report.backupPath);
    }
    migrate(target);
    createMigrationLedger(target);
    const run = target.transaction(() => {
      for (const source of dataSources) report.sources.push(importLegacyDatabase(target, source));
    });
    run();
  } finally {
    target.close();
  }
  if (configSource) await importLegacyConfig(configSource, options.configPath);
  const reportDirectory = join(dirname(options.dbPath), "migrations");
  await mkdir(reportDirectory, { recursive: true });
  report.reportPath = join(reportDirectory, `legacy-local-plugin-${timestamp}.json`);
  await writeFile(report.reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return report;
}

export function discoverLegacySources(root = homedir()): LegacySource[] {
  const userRoot = resolve(root);
  return (Object.entries(LEGACY_HOMES) as Array<[LegacyAgent, string]>).map(([agent, relative]) => {
    const runtimeRoot = join(userRoot, relative);
    const currentDbPath = join(runtimeRoot, "data", "memos.db");
    const olderDbPath = agent === "openclaw"
      ? join(userRoot, ".openclaw", "memos-local", "memos.db")
      : agent === "hermes"
        ? join(userRoot, ".hermes", "memos-state", "memos-local", "memos.db")
        : undefined;
    return {
      agent,
      root: runtimeRoot,
      configPath: join(runtimeRoot, "config.yaml"),
      dbPath: existsSync(currentDbPath) || !olderDbPath ? currentDbPath : olderDbPath
    };
  });
}

async function selectConfigSource(candidates: LegacySource[], options: LegacyMigrationOptions): Promise<LegacySource | undefined> {
  if (candidates.length === 0) return undefined;
  if (options.configSource) {
    const selected = candidates.find((candidate) => candidate.agent === options.configSource);
    if (!selected) throw new Error(`--config-source ${options.configSource} was requested but no legacy config was found`);
    return selected;
  }
  if (candidates.length === 1) return candidates[0];
  const openClawAndHermes = candidates.some((source) => source.agent === "openclaw") && candidates.some((source) => source.agent === "hermes");
  if (!openClawAndHermes) {
    return candidates.find((candidate) => candidate.agent === "openclaw" || candidate.agent === "hermes")
      ?? candidates[0];
  }
  if (options.nonInteractive ?? !process.stdin.isTTY) {
    const names = candidates.map((source) => source.agent).join(", ");
    throw new Error(`multiple legacy Memory configs were found (${names}); rerun with --config-source openclaw|hermes`);
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await prompt.question("Use legacy Memory config from OpenClaw or Hermes? [openclaw/hermes] ")).trim().toLowerCase();
    const selected = candidates.find((candidate) => candidate.agent === answer);
    if (!selected) throw new Error("config source must be openclaw or hermes");
    return selected;
  } finally {
    prompt.close();
  }
}

async function importLegacyConfig(source: LegacySource, targetPath: string): Promise<void> {
  const parsed = parseYaml(await readFile(source.configPath, "utf8")) as unknown;
  const legacy = record(parsed);
  const llm = record(legacy.llm);
  const skillEvolver = record(legacy.skillEvolver);
  const embedding = record(legacy.embedding);
  const algorithm = record(legacy.algorithm);
  const summary = mapLlm(llm);
  const evolution = mapLlm(Object.keys(skillEvolver).length ? skillEvolver : llm);
  await mutateMemoryConfig(targetPath, (root) => {
    const memory = record(root.memmyMemory);
    const hub = record(legacy.hub);
    const telemetry = record(legacy.telemetry);
    const nextMemory = {
      ...memory,
      roleRouting: {
        ...record(memory.roleRouting),
        summary: summary.provider ? "fixed" : "follow",
        evolution: evolution.provider ? "fixed" : "follow"
      },
      summary,
      evolution,
      embedding: mapEmbedding(embedding),
      algorithm: mergeLegacyAlgorithm(record(memory.algorithm), algorithm),
      ...(Object.keys(telemetry).length ? { telemetry: { ...record(memory.telemetry), ...telemetry } } : {}),
      ...(Object.keys(hub).length ? { hub: { ...hub, migratedFrom: source.agent } } : {}),
      migratedFrom: source.agent
    };
    root.memmyMemory = nextMemory;
    syncMemoryModelCatalog(root, nextMemory, {
      roleRouting: nextMemory.roleRouting,
      summary,
      evolution,
      embedding: nextMemory.embedding
    });
  });
}

function mapLlm(value: Row): Row {
  const provider = string(value.provider);
  return compact({
    provider: provider === "host" ? "" : provider,
    endpoint: string(value.endpoint),
    model: string(value.model),
    apiKey: string(value.apiKey),
    temperature: finite(value.temperature) ?? undefined,
    timeoutMs: finite(value.timeoutMs) ?? undefined,
    maxRetries: finite(value.maxRetries) ?? undefined,
    enableThinking: record(value.reasoning).enabled
  });
}

function mapEmbedding(value: Row): Row {
  const cache = record(value.cache);
  return compact({
    provider: string(value.provider),
    mode: string(value.provider) === "local" ? "local" : "custom",
    endpoint: string(value.endpoint),
    model: string(value.model),
    apiKey: string(value.apiKey),
    maxInputTokens: finite(value.maxInputTokens) ?? undefined,
    batchSize: finite(value.batchSize) ?? undefined,
    cache: typeof cache.enabled === "boolean" ? cache.enabled : undefined
  });
}

function mergeLegacyAlgorithm(current: Row, legacy: Row): Row {
  const result = structuredClone(current);
  for (const section of ["capture", "reward", "feedback", "l2Induction", "l3Abstraction", "skill", "session", "retrieval"]) {
    if (Object.keys(record(legacy[section])).length) result[section] = { ...record(result[section]), ...record(legacy[section]) };
  }
  return result;
}

function importLegacyDatabase(target: Database.Database, source: LegacySource): LegacyMigrationReport["sources"][number] {
  const legacy = new Database(source.dbPath, { readonly: true, fileMustExist: true });
  const inserted: Record<string, number> = {};
  const deduplicated: Record<string, number> = {};
  const remapped: Record<string, string> = {};
  const maps: IdMaps = {};
  const userId = "local-user";
  try {
    if (tableExists(legacy, "chunks") && !tableExists(legacy, "traces")) {
      return importOlderLegacyDatabase(target, legacy, source, maps, userId, inserted, deduplicated, remapped);
    }
    const sessions = rows(legacy, "sessions");
    for (const row of sessions) {
      const sourceId = requiredString(row.id, "sessions.id");
      const startedAt = iso(row.started_at);
      const targetRow = {
        id: sourceId,
        user_id: userId,
        project_id: nullableString(row.owner_workspace_id),
        source: source.agent,
        profile_id: string(row.owner_profile_id) ?? "default",
        profile_label: source.agent,
        workspace_id: nullableString(row.owner_workspace_id),
        workspace_path: null,
        host_session_key: sourceId,
        conversation_id: null,
        status: "closed",
        meta_json: json({ ...jsonRecord(row.meta_json), legacySource: source.agent, legacyOwnerAgent: row.owner_agent_kind }),
        opened_at: startedAt,
        last_seen_at: iso(row.last_seen_at),
        closed_at: iso(row.last_seen_at),
        updated_at: iso(row.last_seen_at)
      };
      mapAndInsert(target, source, "sessions", sourceId, "sessions", targetRow, maps, inserted, deduplicated, remapped);
    }

    const episodes = rows(legacy, "episodes");
    for (const row of episodes) {
      const sourceId = requiredString(row.id, "episodes.id");
      const targetRow = {
        id: sourceId,
        session_id: mapped(maps, "sessions", requiredString(row.session_id, "episodes.session_id")),
        user_id: userId,
        project_id: nullableString(row.owner_workspace_id),
        conversation_id: sourceId,
        status: row.status === "open" ? "open" : "closed",
        title: string(jsonRecord(row.meta_json).title) ?? `${source.agent} task`,
        summary: string(jsonRecord(row.meta_json).summary),
        l1_memory_ids_json: "[]",
        raw_turn_ids_json: "[]",
        feedback_ids_json: "[]",
        decision_repair_ids_json: "[]",
        l2_policy_ids_json: "[]",
        l3_world_model_ids_json: "[]",
        skill_memory_ids_json: "[]",
        turn_count: 0,
        r_task: finite(row.r_task),
        reward_detail_json: "{}",
        pipeline_run_id: null,
        pipeline_status: "succeeded",
        pipeline_error: null,
        meta_json: json({ ...jsonRecord(row.meta_json), legacySource: source.agent, legacyShareScope: row.share_scope }),
        opened_at: iso(row.started_at),
        closed_at: row.ended_at == null ? null : iso(row.ended_at),
        updated_at: iso(row.ended_at ?? row.started_at)
      };
      mapAndInsert(target, source, "episodes", sourceId, "episodes", targetRow, maps, inserted, deduplicated, remapped);
    }

    importTraces(target, legacy, source, maps, userId, inserted, deduplicated, remapped);
    importPolicies(target, legacy, source, maps, userId, inserted, deduplicated, remapped);
    importWorldModels(target, legacy, source, maps, userId, inserted, deduplicated, remapped);
    importSkills(target, legacy, source, maps, userId, inserted, deduplicated, remapped);
    importFeedback(target, legacy, source, maps, userId, inserted, deduplicated, remapped);
    importTracePolicyLinks(target, legacy, source, maps, userId, inserted, deduplicated, remapped);
    importSkillTrials(target, legacy, source, maps, userId, inserted, deduplicated, remapped);
    importHubState(target, legacy, source, inserted, deduplicated);
    finalizeEpisodes(target, legacy, maps);
    return { agent: source.agent, database: source.dbPath, inserted, deduplicated, remapped };
  } finally {
    legacy.close();
  }
}

function importOlderLegacyDatabase(
  target: Database.Database,
  legacy: Database.Database,
  source: LegacySource,
  maps: IdMaps,
  userId: string,
  inserted: Record<string, number>,
  deduplicated: Record<string, number>,
  remapped: Record<string, string>
): LegacyMigrationReport["sources"][number] {
  const tasks = rows(legacy, "tasks");
  const chunks = rows(legacy, "chunks");

  for (const task of tasks) {
    const sourceId = requiredString(task.id, "tasks.id");
    const sessionKey = requiredString(task.session_key, "tasks.session_key");
    const sessionId = ensureSession(sessionKey, task.started_at ?? task.created_at);
    const targetRow = {
      id: sourceId,
      session_id: sessionId,
      user_id: userId,
      project_id: null,
      conversation_id: sourceId,
      status: task.status === "open" ? "open" : "closed",
      title: string(task.title) ?? `${source.agent} task`,
      summary: nullableString(task.summary),
      l1_memory_ids_json: "[]",
      raw_turn_ids_json: "[]",
      feedback_ids_json: "[]",
      decision_repair_ids_json: "[]",
      l2_policy_ids_json: "[]",
      l3_world_model_ids_json: "[]",
      skill_memory_ids_json: "[]",
      turn_count: 0,
      r_task: null,
      reward_detail_json: "{}",
      pipeline_run_id: null,
      pipeline_status: "succeeded",
      pipeline_error: null,
      meta_json: json({ legacySource: source.agent, legacyTable: "tasks" }),
      opened_at: iso(task.started_at ?? task.created_at),
      closed_at: task.ended_at == null ? null : iso(task.ended_at),
      updated_at: iso(task.ended_at ?? task.started_at ?? task.created_at)
    };
    mapAndInsert(target, source, "tasks", sourceId, "episodes", targetRow, maps, inserted, deduplicated, remapped);
  }

  for (const chunk of chunks) {
    const sourceId = requiredString(chunk.id, "chunks.id");
    const sessionKey = requiredString(chunk.session_key, "chunks.session_key");
    const sessionId = ensureSession(sessionKey, chunk.created_at);
    const turnId = chunk.turn_id == null ? "legacy" : String(chunk.turn_id);
    const taskEpisodeId = maps.episodes?.get(turnId);
    const episodeId = taskEpisodeId ?? ensureChunkEpisode(sessionKey, turnId, sessionId, chunk.created_at);
    const role = (string(chunk.role) ?? "assistant").toLowerCase();
    const content = string(chunk.content) ?? "";
    const summary = string(chunk.summary) ?? firstLine(content || "Imported memory");
    const rawRow = {
      id: `${sourceId}:raw`,
      session_id: sessionId,
      episode_id: episodeId,
      turn_id: turnId,
      user_id: userId,
      conversation_id: episodeId,
      user_text: role === "user" ? content : null,
      assistant_text: role === "user" ? null : content,
      reasoning_summary: null,
      tool_calls_json: "[]",
      tool_results_json: "[]",
      source_memory_ids_json: "[]",
      usage_json: "{}",
      message_payload_json: json({ legacySource: source.agent, legacyChunkId: sourceId, role }),
      status: "succeeded",
      redacted_at: null,
      deleted_at: null,
      created_at: iso(chunk.created_at)
    };
    const rawTurnId = mapAndInsert(
      target,
      source,
      "chunks:raw_turn",
      sourceId,
      "raw_turns",
      rawRow,
      maps,
      inserted,
      deduplicated,
      remapped
    );
    const trace = {
      ts: finite(chunk.created_at) ?? Date.now(),
      turn_id: turnId,
      raw_turn_id: rawTurnId,
      episode_id: episodeId,
      summary,
      userText: role === "user" ? content : "",
      agentText: role === "user" ? "" : content,
      tool_calls: [],
      reflection: null,
      alpha: 0,
      value: 0,
      priority: 0,
      error_signatures: []
    };
    const memory = memoryRow({
      id: sourceId,
      source,
      userId,
      sessionId,
      conversationId: episodeId,
      layer: "L1",
      status: "activated",
      title: summary,
      body: content || summary,
      tags: ["legacy-chunk", role],
      createdAt: iso(chunk.created_at),
      info: { summary, value: 0, priority: 0, tags: ["legacy-chunk", role] },
      internal: { trace, source_raw_turn_id: rawTurnId }
    });
    mapAndInsert(target, source, "chunks", sourceId, "memories", memory, maps, inserted, deduplicated, remapped);
  }

  for (const row of rows(legacy, "skills")) {
    const sourceId = requiredString(row.id, "skills.id");
    const name = string(row.name) ?? sourceId;
    const guide = string(row.description) ?? name;
    const status = ["retired", "archived", "deprecated"].includes((string(row.status) ?? "").toLowerCase())
      ? "archived"
      : ["probationary", "candidate", "trial"].includes((string(row.status) ?? "").toLowerCase())
        ? "resolving"
        : "activated";
    const skill = {
      name,
      status: status === "activated" ? "active" : status === "archived" ? "archived" : "candidate",
      invocation_guide: guide,
      procedure_json: null,
      eta: 0,
      support: 0,
      gain: 0,
      trials_attempted: 0,
      trials_passed: 0,
      source_policy_ids: [],
      source_world_model_ids: [],
      evidence_anchor_ids: []
    };
    mapAndInsert(target, source, "legacy_skills", sourceId, "memories", memoryRow({
      id: sourceId,
      source,
      userId,
      layer: "Skill",
      status,
      title: name,
      body: guide,
      tags: ["skill"],
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at ?? row.created_at),
      info: { name, status: skill.status, eta: 0, source_memory_ids: [] },
      internal: { skill, source_memory_ids: [], source_policy_ids: [], source_world_model_ids: [] }
    }), maps, inserted, deduplicated, remapped);
  }

  const episodeIds = [...new Set(maps.episodes?.values() ?? [])];
  for (const episodeId of episodeIds) {
    const memoryIds = target.prepare("SELECT id FROM memories WHERE conversation_id = ? AND memory_layer = 'L1' ORDER BY created_at").pluck().all(episodeId);
    const rawTurnIds = target.prepare("SELECT id FROM raw_turns WHERE episode_id = ? ORDER BY created_at").pluck().all(episodeId);
    target.prepare("UPDATE episodes SET l1_memory_ids_json = ?, raw_turn_ids_json = ?, turn_count = ? WHERE id = ?")
      .run(json(memoryIds), json(rawTurnIds), rawTurnIds.length, episodeId);
  }

  return { agent: source.agent, database: source.dbPath, inserted, deduplicated, remapped };

  function ensureSession(sourceId: string, timestamp: unknown): string {
    const existing = maps.sessions?.get(sourceId);
    if (existing) return existing;
    return mapAndInsert(target, source, "legacy_sessions", sourceId, "sessions", {
      id: sourceId,
      user_id: userId,
      project_id: null,
      source: source.agent,
      profile_id: "default",
      profile_label: source.agent,
      workspace_id: null,
      workspace_path: null,
      host_session_key: sourceId,
      conversation_id: null,
      status: "closed",
      meta_json: json({ legacySource: source.agent, legacyTable: "chunks" }),
      opened_at: iso(timestamp),
      last_seen_at: iso(timestamp),
      closed_at: iso(timestamp),
      updated_at: iso(timestamp)
    }, maps, inserted, deduplicated, remapped);
  }

  function ensureChunkEpisode(sessionKey: string, turnId: string, sessionId: string, timestamp: unknown): string {
    const sourceId = `${sessionKey}:${turnId}`;
    const existing = maps.episodes?.get(sourceId);
    if (existing) return existing;
    return mapAndInsert(target, source, "legacy_chunk_episodes", sourceId, "episodes", {
      id: sourceId,
      session_id: sessionId,
      user_id: userId,
      project_id: null,
      conversation_id: sourceId,
      status: "closed",
      title: `${source.agent} imported conversation`,
      summary: null,
      l1_memory_ids_json: "[]",
      raw_turn_ids_json: "[]",
      feedback_ids_json: "[]",
      decision_repair_ids_json: "[]",
      l2_policy_ids_json: "[]",
      l3_world_model_ids_json: "[]",
      skill_memory_ids_json: "[]",
      turn_count: 0,
      r_task: null,
      reward_detail_json: "{}",
      pipeline_run_id: null,
      pipeline_status: "succeeded",
      pipeline_error: null,
      meta_json: json({ legacySource: source.agent, legacyTable: "chunks" }),
      opened_at: iso(timestamp),
      closed_at: iso(timestamp),
      updated_at: iso(timestamp)
    }, maps, inserted, deduplicated, remapped);
  }
}

function importTraces(target: Database.Database, legacy: Database.Database, source: LegacySource, maps: IdMaps, userId: string, inserted: Record<string, number>, deduplicated: Record<string, number>, remapped: Record<string, string>): void {
  for (const row of rows(legacy, "traces")) {
    const sourceId = requiredString(row.id, "traces.id");
    const episodeId = mapped(maps, "episodes", requiredString(row.episode_id, "traces.episode_id"));
    const sessionId = mapped(maps, "sessions", requiredString(row.session_id, "traces.session_id"));
    const rawId = `${sourceId}:raw`;
    const toolCalls = jsonArray(row.tool_calls_json);
    const rawRow = {
      id: rawId,
      session_id: sessionId,
      episode_id: episodeId,
      turn_id: String(row.turn_id ?? row.ts ?? sourceId),
      user_id: userId,
      conversation_id: episodeId,
      user_text: nullableString(row.user_text),
      assistant_text: nullableString(row.agent_text),
      reasoning_summary: nullableString(row.agent_thinking),
      tool_calls_json: json(toolCalls),
      tool_results_json: "[]",
      source_memory_ids_json: "[]",
      usage_json: "{}",
      message_payload_json: json({ legacySource: source.agent, legacyTraceId: sourceId }),
      status: "succeeded",
      redacted_at: null,
      deleted_at: null,
      created_at: iso(row.ts)
    };
    const mappedRawId = mapAndInsert(target, source, "traces:raw_turn", sourceId, "raw_turns", rawRow, maps, inserted, deduplicated, remapped);
    const tags = jsonArray(row.tags_json).filter((tag): tag is string => typeof tag === "string");
    const summary = string(row.summary) ?? firstLine(string(row.user_text) ?? string(row.agent_text) ?? "Imported trace");
    const trace = {
      ts: finite(row.ts) ?? Date.now(),
      turn_id: String(row.turn_id ?? row.ts ?? sourceId),
      raw_turn_id: mappedRawId,
      episode_id: episodeId,
      summary,
      userText: string(row.user_text) ?? "",
      agentText: string(row.agent_text) ?? "",
      tool_calls: toolCalls,
      reflection: nullableString(row.reflection),
      alpha: finite(row.alpha) ?? 0,
      value: finite(row.value) ?? 0,
      priority: finite(row.priority) ?? 0,
      error_signatures: jsonArray(row.error_signatures_json)
    };
    const memory = memoryRow({
      id: sourceId, source, userId, sessionId, conversationId: episodeId, layer: "L1", status: "activated",
      title: summary,
      body: [`Summary: ${summary}`, `User:\n${string(row.user_text) ?? ""}`, `Assistant:\n${string(row.agent_text) ?? ""}`, string(row.reflection) ? `Reflection: ${string(row.reflection)}` : ""].filter(Boolean).join("\n\n"),
      tags,
      createdAt: iso(row.ts),
      info: { summary, value: trace.value, priority: trace.priority, tags },
      internal: { trace, source_raw_turn_id: mappedRawId }
    });
    mapAndInsert(target, source, "traces", sourceId, "memories", memory, maps, inserted, deduplicated, remapped);
  }
}

function importPolicies(target: Database.Database, legacy: Database.Database, source: LegacySource, maps: IdMaps, userId: string, inserted: Record<string, number>, deduplicated: Record<string, number>, remapped: Record<string, string>): void {
  for (const row of rows(legacy, "policies")) {
    const sourceId = requiredString(row.id, "policies.id");
    const sourceTraceIds = jsonArray(row.source_trace_ids_json).map(String).map((id) => mapped(maps, "memories", id));
    const policy = {
      title: string(row.title) ?? sourceId,
      trigger: string(row.trigger) ?? "",
      procedure: string(row.procedure) ?? "",
      verification: string(row.verification) ?? "",
      boundary: string(row.boundary) ?? "",
      support: finite(row.support) ?? 0,
      gain: finite(row.gain) ?? 0,
      confidence: finite(row.confidence) ?? 0.5,
      status: row.status === "active" ? "active" : row.status === "archived" ? "archived" : "candidate",
      experience_type: string(row.experience_type) ?? "success_pattern",
      evidence_polarity: string(row.evidence_polarity) ?? "positive",
      source_episode_ids: jsonArray(row.source_episodes_json).map(String).map((id) => mapped(maps, "episodes", id)),
      source_trace_ids: sourceTraceIds,
      source_feedback_ids: jsonArray(row.source_feedback_ids_json).map(String),
      decision_guidance: jsonRecord(row.decision_guidance_json),
      skill_eligible: row.skill_eligible !== 0
    };
    const body = [policy.title, `Trigger: ${policy.trigger}`, `Procedure: ${policy.procedure}`, `Verification: ${policy.verification}`, `Boundary: ${policy.boundary}`].join("\n");
    const memory = memoryRow({
      id: sourceId, source, userId, layer: "L2", status: policy.status === "active" ? "activated" : policy.status === "archived" ? "archived" : "resolving",
      title: policy.title, body, tags: [], createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
      info: { support: policy.support, gain: policy.gain, status: policy.status, source_memory_ids: sourceTraceIds },
      internal: { policy, source_memory_ids: sourceTraceIds }
    });
    mapAndInsert(target, source, "policies", sourceId, "memories", memory, maps, inserted, deduplicated, remapped);
  }
}

function importWorldModels(target: Database.Database, legacy: Database.Database, source: LegacySource, maps: IdMaps, userId: string, inserted: Record<string, number>, deduplicated: Record<string, number>, remapped: Record<string, string>): void {
  for (const row of rows(legacy, "world_model")) {
    const sourceId = requiredString(row.id, "world_model.id");
    const policyIds = jsonArray(row.policy_ids_json).map(String).map((id) => mapped(maps, "memories", id));
    const title = string(row.title) ?? sourceId;
    const body = string(row.body) ?? title;
    const worldModel = {
      title,
      body,
      policy_ids: policyIds,
      structure: jsonRecord(row.structure_json),
      domain_tags: jsonArray(row.domain_tags_json),
      confidence: finite(row.confidence) ?? 0.5,
      source_episode_ids: jsonArray(row.source_episodes_json).map(String).map((id) => mapped(maps, "episodes", id)),
      status: row.status === "archived" ? "archived" : "active"
    };
    const memory = memoryRow({
      id: sourceId, source, userId, layer: "L3", status: worldModel.status === "archived" ? "archived" : "activated",
      title, body, tags: worldModel.domain_tags.filter((tag): tag is string => typeof tag === "string"),
      createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
      info: { title, confidence: worldModel.confidence },
      internal: { world_model: worldModel, source_memory_ids: policyIds }
    });
    mapAndInsert(target, source, "world_model", sourceId, "memories", memory, maps, inserted, deduplicated, remapped);
  }
}

function importSkills(target: Database.Database, legacy: Database.Database, source: LegacySource, maps: IdMaps, userId: string, inserted: Record<string, number>, deduplicated: Record<string, number>, remapped: Record<string, string>): void {
  for (const row of rows(legacy, "skills")) {
    const sourceId = requiredString(row.id, "skills.id");
    const policyIds = jsonArray(row.source_policies_json).map(String).map((id) => mapped(maps, "memories", id));
    const worldIds = jsonArray(row.source_world_json).map(String).map((id) => mapped(maps, "memories", id));
    const name = string(row.name) ?? sourceId;
    const guide = string(row.invocation_guide) ?? name;
    const status = row.status === "active" ? "active" : row.status === "archived" ? "archived" : "candidate";
    const skill = {
      name, status, invocation_guide: guide, procedure_json: jsonValue(row.procedure_json, null),
      eta: finite(row.eta) ?? 0, support: finite(row.support) ?? 0, gain: finite(row.gain) ?? 0,
      trials_attempted: finite(row.trials_attempted) ?? 0, trials_passed: finite(row.trials_passed) ?? 0,
      source_policy_ids: policyIds, source_world_model_ids: worldIds,
      evidence_anchor_ids: jsonArray(row.evidence_anchors_json)
    };
    const memory = memoryRow({
      id: sourceId, source, userId, layer: "Skill", status: status === "active" ? "activated" : status === "archived" ? "archived" : "resolving",
      title: name, body: guide, tags: ["skill"], createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
      info: { name, status, eta: skill.eta, source_memory_ids: policyIds },
      internal: { skill, source_memory_ids: policyIds, source_policy_ids: policyIds, source_world_model_ids: worldIds }
    });
    mapAndInsert(target, source, "skills", sourceId, "memories", memory, maps, inserted, deduplicated, remapped);
  }
}

function importFeedback(target: Database.Database, legacy: Database.Database, source: LegacySource, maps: IdMaps, userId: string, inserted: Record<string, number>, deduplicated: Record<string, number>, remapped: Record<string, string>): void {
  for (const row of rows(legacy, "feedback")) {
    const sourceId = requiredString(row.id, "feedback.id");
    const episodeId = optionalMapped(maps, "episodes", string(row.episode_id));
    const traceId = optionalMapped(maps, "memories", string(row.trace_id));
    const rawTurnId = optionalMapped(maps, "raw_turns", string(row.trace_id));
    const targetRow = {
      id: sourceId,
      user_id: userId,
      project_id: nullableString(row.owner_workspace_id),
      conversation_id: episodeId,
      session_id: episodeId ? target.prepare("SELECT session_id FROM episodes WHERE id = ?").pluck().get(episodeId) ?? null : null,
      episode_id: episodeId,
      l1_memory_id: traceId,
      raw_turn_id: rawTurnId,
      channel: row.channel === "implicit" ? "implicit" : "explicit",
      polarity: ["positive", "negative", "neutral"].includes(String(row.polarity)) ? row.polarity : "neutral",
      magnitude: finite(row.magnitude) ?? 0,
      rationale: nullableString(row.rationale),
      raw_payload_json: json({ ...jsonRecord(row.raw_json), legacySource: source.agent }),
      context_hash: null,
      created_at: iso(row.ts)
    };
    mapAndInsert(target, source, "feedback", sourceId, "feedback", targetRow, maps, inserted, deduplicated, remapped);
  }
}

function importTracePolicyLinks(target: Database.Database, legacy: Database.Database, source: LegacySource, maps: IdMaps, userId: string, inserted: Record<string, number>, deduplicated: Record<string, number>, remapped: Record<string, string>): void {
  for (const row of rows(legacy, "trace_policy_links")) {
    const traceId = mapped(maps, "memories", requiredString(row.trace_id, "trace_policy_links.trace_id"));
    const policyId = mapped(maps, "memories", requiredString(row.policy_id, "trace_policy_links.policy_id"));
    const sourceId = `${row.trace_id}:${row.policy_id}`;
    const targetRow = { id: sourceId, user_id: userId, l1_memory_id: traceId, l2_memory_id: policyId, relation: "supports", strength: 1, created_at: iso(row.created_at) };
    mapAndInsert(target, source, "trace_policy_links", sourceId, "trace_policy_links", targetRow, maps, inserted, deduplicated, remapped);
  }
}

function importSkillTrials(target: Database.Database, legacy: Database.Database, source: LegacySource, maps: IdMaps, userId: string, inserted: Record<string, number>, deduplicated: Record<string, number>, remapped: Record<string, string>): void {
  for (const row of rows(legacy, "skill_trials")) {
    const sourceId = requiredString(row.id, "skill_trials.id");
    const targetRow = {
      id: sourceId,
      user_id: userId,
      project_id: nullableString(row.owner_workspace_id),
      skill_memory_id: mapped(maps, "memories", requiredString(row.skill_id, "skill_trials.skill_id")),
      session_id: optionalMapped(maps, "sessions", string(row.session_id)),
      episode_id: mapped(maps, "episodes", requiredString(row.episode_id, "skill_trials.episode_id")),
      l1_memory_id: optionalMapped(maps, "memories", string(row.trace_id)),
      raw_turn_id: optionalMapped(maps, "raw_turns", string(row.trace_id)),
      turn_id: row.turn_id == null ? null : String(row.turn_id),
      tool_call_id: nullableString(row.tool_call_id),
      status: ["pending", "pass", "fail", "unknown"].includes(String(row.status)) ? row.status : "unknown",
      outcome: row.status === "pass" ? "success" : row.status === "fail" ? "failure" : "unknown",
      feedback_id: null,
      created_at: iso(row.created_at),
      resolved_at: row.resolved_at == null ? null : iso(row.resolved_at)
    };
    mapAndInsert(target, source, "skill_trials", sourceId, "skill_trials", targetRow, maps, inserted, deduplicated, remapped);
  }
}

function importHubState(target: Database.Database, legacy: Database.Database, source: LegacySource, inserted: Record<string, number>, deduplicated: Record<string, number>): void {
  for (const table of ["hub_users", "client_hub_connection", "hub_shared_memories", "hub_shared_skills"]) {
    for (const row of rows(legacy, table)) {
      const sourceId = string(row.id) ?? digest(row).slice(0, 20);
      const key = `legacy_hub:${source.agent}:${table}:${sourceId}`;
      const value = json({ source: source.agent, table, sourceId, row: redactHubSecrets(row) });
      const existed = target.prepare("SELECT 1 FROM runtime_kv WHERE key = ?").get(key);
      target.prepare("INSERT OR IGNORE INTO runtime_kv (key, value_json, updated_at) VALUES (?, ?, ?)").run(key, value, new Date().toISOString());
      increment(existed ? deduplicated : inserted, "hub");
    }
  }
}

function finalizeEpisodes(target: Database.Database, legacy: Database.Database, maps: IdMaps): void {
  for (const row of rows(legacy, "episodes")) {
    const sourceId = requiredString(row.id, "episodes.id");
    const episodeId = mapped(maps, "episodes", sourceId);
    const memoryIds = target.prepare("SELECT id FROM memories WHERE conversation_id = ? AND memory_layer = 'L1' ORDER BY created_at").pluck().all(episodeId);
    const rawTurnIds = target.prepare("SELECT id FROM raw_turns WHERE episode_id = ? ORDER BY created_at").pluck().all(episodeId);
    target.prepare("UPDATE episodes SET l1_memory_ids_json = ?, raw_turn_ids_json = ?, turn_count = ? WHERE id = ?")
      .run(json(memoryIds), json(rawTurnIds), rawTurnIds.length, episodeId);
  }
}

function memoryRow(input: {
  id: string; source: LegacySource; userId: string; layer: "L1" | "L2" | "L3" | "Skill"; status: string;
  title: string; body: string; tags: string[]; createdAt: string; updatedAt?: string; sessionId?: string; conversationId?: string;
  info: Row; internal: Row;
}): Row {
  const contentHash = digest({ layer: input.layer, title: input.title, body: input.body });
  return {
    id: input.id,
    timeline: input.createdAt,
    user_id: input.userId,
    conversation_id: input.conversationId ?? null,
    session_id: input.sessionId ?? null,
    agent_id: input.source.agent,
    app_id: "memos-local-plugin-2.0",
    memory_type: "LongTermMemory",
    status: input.status,
    visibility: "private",
    memory_key: input.title,
    memory_value: input.body,
    tags_json: json(input.tags),
    info_json: json(input.info),
    properties_json: json({
      status: input.status,
      tags: input.tags,
      info: input.info,
      internal_info: {
        ...input.internal,
        legacy_import: { source: input.source.agent, source_path: input.source.dbPath, source_id: input.id, content_sha256: contentHash }
      }
    }),
    memory_layer: input.layer,
    content_hash: contentHash,
    version: 1,
    created_at: input.createdAt,
    updated_at: input.updatedAt ?? input.createdAt,
    deleted_at: null
  };
}

function mapAndInsert(
  target: Database.Database,
  source: LegacySource,
  sourceTable: string,
  sourceId: string,
  targetTable: string,
  row: Row,
  maps: IdMaps,
  inserted: Record<string, number>,
  deduplicated: Record<string, number>,
  remapped: Record<string, string>
): string {
  const contentDigest = digest(row);
  const ledger = target.prepare(`SELECT target_id FROM legacy_migration_ledger
    WHERE source_path = ? AND source_table = ? AND source_id = ? AND content_sha256 = ?`)
    .get(source.dbPath, sourceTable, sourceId, contentDigest) as { target_id?: string } | undefined;
  if (ledger?.target_id) {
    setMap(maps, targetTable, sourceId, ledger.target_id);
    increment(deduplicated, targetTable);
    return ledger.target_id;
  }
  if (targetTable === "raw_turns" && typeof row.session_id === "string" && typeof row.turn_id === "string") {
    const existingRawTurn = target.prepare(
      `SELECT id, user_text, assistant_text, reasoning_summary,
              tool_calls_json, tool_results_json, source_memory_ids_json,
              usage_json, message_payload_json
       FROM raw_turns
       WHERE session_id = ? AND turn_id = ?`
    ).get(row.session_id, row.turn_id) as RawTurnRow | undefined;
    if (existingRawTurn) {
      mergeRawTurn(target, existingRawTurn, row);
      target.prepare(`
        INSERT INTO legacy_migration_ledger
          (source_path, source_table, source_id, content_sha256, target_table, target_id, status, migrated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'deduplicated', ?)
      `).run(
        source.dbPath,
        sourceTable,
        sourceId,
        contentDigest,
        targetTable,
        existingRawTurn.id,
        new Date().toISOString()
      );
      setMap(maps, targetTable, sourceId, existingRawTurn.id);
      increment(deduplicated, targetTable);
      return existingRawTurn.id;
    }
  }
  let targetId = String(row.id ?? sourceId);
  const idColumn = targetTable === "runtime_kv" ? "key" : "id";
  const sameMemory = targetTable === "memories"
    ? target.prepare("SELECT id FROM memories WHERE content_hash = ? AND memory_layer = ? LIMIT 1").get(row.content_hash, row.memory_layer) as { id?: string } | undefined
    : undefined;
  if (sameMemory?.id) {
    targetId = sameMemory.id;
  } else if (target.prepare(`SELECT 1 FROM ${targetTable} WHERE ${idColumn} = ?`).get(targetId)) {
    targetId = uniqueTargetId(target, targetTable, idColumn, source.agent, sourceId, contentDigest);
    if (targetId !== sourceId) remapped[`${sourceTable}:${sourceId}`] = targetId;
  }
  if (!sameMemory) {
    row[idColumn] = targetId;
    insertRow(target, targetTable, row);
    increment(inserted, targetTable);
  } else {
    increment(deduplicated, targetTable);
  }
  target.prepare(`INSERT INTO legacy_migration_ledger
    (source_path, source_table, source_id, content_sha256, target_table, target_id, status, migrated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(source.dbPath, sourceTable, sourceId, contentDigest, targetTable, targetId, sameMemory ? "deduplicated" : "inserted", new Date().toISOString());
  setMap(maps, targetTable, sourceId, targetId);
  return targetId;
}

interface RawTurnRow {
  id: string;
  user_text: unknown;
  assistant_text: unknown;
  reasoning_summary: unknown;
  tool_calls_json: unknown;
  tool_results_json: unknown;
  source_memory_ids_json: unknown;
  usage_json: unknown;
  message_payload_json: unknown;
}

function mergeRawTurn(target: Database.Database, existing: RawTurnRow, incoming: Row): void {
  const legacyTraceIds = [...new Set([
    jsonRecord(existing.message_payload_json).legacyTraceId,
    jsonRecord(incoming.message_payload_json).legacyTraceId
  ].filter((value): value is string => typeof value === "string" && value.length > 0))];
  const payload = {
    ...jsonRecord(existing.message_payload_json),
    ...jsonRecord(incoming.message_payload_json),
    ...(legacyTraceIds.length ? { legacyTraceIds } : {})
  };
  target.prepare(`
    UPDATE raw_turns
    SET user_text = ?,
        assistant_text = ?,
        reasoning_summary = ?,
        tool_calls_json = ?,
        tool_results_json = ?,
        source_memory_ids_json = ?,
        usage_json = ?,
        message_payload_json = ?
    WHERE id = ?
  `).run(
    mergeText(existing.user_text, incoming.user_text),
    mergeText(existing.assistant_text, incoming.assistant_text),
    mergeText(existing.reasoning_summary, incoming.reasoning_summary),
    json(mergeJsonArrays(existing.tool_calls_json, incoming.tool_calls_json)),
    json(mergeJsonArrays(existing.tool_results_json, incoming.tool_results_json)),
    json(mergeJsonArrays(existing.source_memory_ids_json, incoming.source_memory_ids_json)),
    json({ ...jsonRecord(existing.usage_json), ...jsonRecord(incoming.usage_json) }),
    json(payload),
    existing.id
  );
}

function mergeText(existing: unknown, incoming: unknown): string | null {
  const first = typeof existing === "string" && existing.trim() ? existing : undefined;
  const second = typeof incoming === "string" && incoming.trim() ? incoming : undefined;
  if (!first) return second ?? null;
  if (!second || second === first) return first;
  return `${first}\n\n${second}`;
}

function mergeJsonArrays(...values: unknown[]): unknown[] {
  const merged: unknown[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    for (const item of jsonArray(value)) {
      const key = stableJson(item);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }
  return merged;
}

function insertRow(target: Database.Database, table: string, row: Row): void {
  const columns = target.prepare(`PRAGMA table_info(${table})`).all().map((item) => String((item as { name: unknown }).name));
  const selected = Object.keys(row).filter((column) => columns.includes(column));
  const placeholders = selected.map(() => "?").join(", ");
  target.prepare(`INSERT INTO ${table} (${selected.join(", ")}) VALUES (${placeholders})`)
    .run(...selected.map((column) => sqlValue(row[column])));
}

function uniqueTargetId(target: Database.Database, table: string, column: string, agent: LegacyAgent, sourceId: string, contentDigest: string): string {
  const base = `legacy_${agent}_${sanitizeId(sourceId)}_${contentDigest.slice(0, 10)}`;
  let candidate = base;
  let suffix = 1;
  while (target.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ?`).get(candidate)) candidate = `${base}_${suffix++}`;
  return candidate;
}

function createMigrationLedger(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS legacy_migration_ledger (
    source_path TEXT NOT NULL,
    source_table TEXT NOT NULL,
    source_id TEXT NOT NULL,
    content_sha256 TEXT NOT NULL,
    target_table TEXT NOT NULL,
    target_id TEXT NOT NULL,
    status TEXT NOT NULL,
    migrated_at TEXT NOT NULL,
    PRIMARY KEY (source_path, source_table, source_id, content_sha256)
  )`);
}

function rows(db: Database.Database, table: string): Row[] {
  return tableExists(db, table) ? db.prepare(`SELECT * FROM ${table}`).all() as Row[] : [];
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function mapped(maps: IdMaps, targetTable: string, sourceId: string): string {
  return maps[targetTable]?.get(sourceId) ?? sourceId;
}

function optionalMapped(maps: IdMaps, targetTable: string, sourceId: string | undefined): string | null {
  return sourceId ? mapped(maps, targetTable, sourceId) : null;
}

function setMap(maps: IdMaps, targetTable: string, sourceId: string, targetId: string): void {
  (maps[targetTable] ??= new Map()).set(sourceId, targetId);
  if (targetTable === "memories") (maps.memories ??= new Map()).set(sourceId, targetId);
  if (targetTable === "raw_turns") (maps.raw_turns ??= new Map()).set(sourceId, targetId);
}

function increment(target: Record<string, number>, key: string): void { target[key] = (target[key] ?? 0) + 1; }
function requiredString(value: unknown, field: string): string { const result = string(value); if (!result) throw new Error(`legacy database field is missing: ${field}`); return result; }
function string(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function nullableString(value: unknown): string | null { return string(value) ?? null; }
function finite(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function record(value: unknown): Row { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {}; }
function json(value: unknown): string { return JSON.stringify(value); }
function jsonValue(value: unknown, fallback: unknown): unknown { if (typeof value !== "string") return value ?? fallback; try { return JSON.parse(value); } catch { return fallback; } }
function jsonRecord(value: unknown): Row { return record(jsonValue(value, {})); }
function jsonArray(value: unknown): unknown[] { const parsed = jsonValue(value, []); return Array.isArray(parsed) ? parsed : []; }
function sqlValue(value: unknown): string | number | Buffer | null { return value === undefined || value === null ? null : Buffer.isBuffer(value) ? value : typeof value === "number" || typeof value === "string" ? value : json(value); }
function iso(value: unknown): string { const numeric = finite(value); const date = numeric === null ? new Date() : new Date(numeric); return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString(); }
function firstLine(value: string): string { return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 160) ?? "Imported memory"; }
function digest(value: unknown): string { return createHash("sha256").update(stableJson(value)).digest("hex"); }
function stableJson(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`; if (value && typeof value === "object" && !Buffer.isBuffer(value)) return `{${Object.keys(value as Row).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Row)[key])}`).join(",")}}`; if (Buffer.isBuffer(value)) return JSON.stringify(value.toString("base64")); return JSON.stringify(value) ?? "null"; }
function sanitizeId(value: string): string { return value.replace(/[^0-9A-Za-z_.-]+/g, "_").slice(0, 48) || "item"; }
function compact(value: Row): Row { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)); }
function redactHubSecrets(row: Row): Row { const next = { ...row }; for (const key of ["token_hash", "user_token", "api_key", "apiKey"]) if (key in next) next[key] = "[REDACTED]"; return next; }
