/** Memos sqlite memory client module. */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getLoadablePath as getSqliteVecLoadablePath } from "sqlite-vec";
import type {
  AddMemoryInput,
  AddMemoryOutput,
  CloseSessionInput,
  CloseSessionOutput,
  CompleteTurnInput,
  CompleteTurnOutput,
  DeleteMemoryOutput,
  DeletePanelTaskOutput,
  GetMemoryOutput,
  MemoryApiLogsInput,
  MemoryApiLogsOutput,
  MemoryKind,
  MemoryLayer,
  MemoryListItem,
  MemoryMetrics,
  MemoryStatus,
  OpenSessionInput,
  OpenSessionOutput,
  PanelAnalysisOutput,
  PanelItemsInput,
  PanelItemsOutput,
  PanelOverviewOutput,
  PanelTasksInput,
  PanelTasksOutput,
  RecallHit,
  StartTurnInput,
  StartTurnOutput,
  SearchOutput
} from "@memmy/local-api-contracts";
import { MemoryLayerError } from "./errors.js";
import type { MemoryClient } from "./types.js";

const SOURCE_ID_SEPARATOR = "::";
const DEFAULT_MEMORY_HOME = join(homedir(), ".memmy");
const PANEL_DAILY_ACTIVITY_DAYS = 371;

export interface MemosSqliteSource {
  id: string;
  label: string;
  dbPath: string;
}

export interface CreateMemosSqliteMemoryClientOptions {
  sources: readonly MemosSqliteSource[];
  now?: () => string;
}

interface LocalMemoryRow {
  id: string;
  timeline: string;
  user_id: string;
  conversation_id: string | null;
  session_id: string | null;
  agent_id: string | null;
  app_id: string | null;
  memory_type: string;
  status: MemoryStatus;
  visibility: string;
  memory_key: string | null;
  memory_value: string;
  tags_json: string;
  info_json: string;
  properties_json: string;
  memory_layer: MemoryLayer;
  content_hash: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface LocalRawTurnRow {
  id: string;
  session_id: string | null;
  episode_id: string | null;
  turn_id: string;
  user_id: string;
  conversation_id: string | null;
  user_text: string | null;
  assistant_text: string | null;
  reasoning_summary: string | null;
  tool_calls_json: string;
  tool_results_json: string;
  source_memory_ids_json: string;
  usage_json: string;
  message_payload_json: string;
  status: string;
  redacted_at: string | null;
  deleted_at: string | null;
  created_at: string;
}

interface LocalEpisodeRow {
  id: string;
  session_id: string;
  status: "open" | "closed" | "processing";
  title?: string | null;
  summary?: string | null;
  l1_memory_ids_json: string;
  raw_turn_ids_json?: string;
  skill_memory_ids_json?: string;
  turn_count?: number | null;
  r_task?: number | null;
  reward_detail_json?: string;
  pipeline_status?: "idle" | "running" | "succeeded" | "failed" | string | null;
  pipeline_error?: string | null;
  meta_json?: string;
  opened_at: string;
  closed_at?: string | null;
  updated_at: string;
}

interface LocalApiLogRow {
  id: number;
  tool_name: "memory_add" | "memory_search" | "skill_generate" | "skill_evolve";
  source_agent: string | null;
  input_json: string;
  output_json: string;
  duration_ms: number;
  success: number;
  called_at: string;
}

type MemoryRow = { source: MemosSqliteSource; row: LocalMemoryRow };

interface LocalDeleteResult {
  changeSeq: number;
  syncCursor: string;
  auditId?: string;
  serverTime: string;
}

/** Handles discover memos sqlite sources. */
export function discoverMemosSqliteSources(env: NodeJS.ProcessEnv = process.env): MemosSqliteSource[] {
  const explicitPath = (env.MEMMY_MEMORY_DB_PATH ?? env.MEMMY_MEMOS_DB_PATH ?? "").trim();
  const dbPath = explicitPath
    ? resolve(expandHome(explicitPath))
    : join(resolve(expandHome(env.MEMMY_HOME ?? DEFAULT_MEMORY_HOME)), "memory-service", "memory.sqlite");

  if (!existsSync(dbPath)) {
    return [];
  }

  return [{
    id: "memmy-memory",
    label: sourceLabelFromPath(dbPath),
    dbPath
  }];
}

/** Creates create memos sqlite memory client. */
export function createMemosSqliteMemoryClient(options: CreateMemosSqliteMemoryClientOptions): MemoryClient {
  const now = options.now ?? (() => new Date().toISOString());
  const sources = options.sources.filter((source) => existsSync(source.dbPath));

  return {
    async health() {
      const storageReady = sources.length > 0;
      return {
        ok: storageReady,
        version: "memmy-memory-sqlite",
        uptimeMs: 0,
        mode: "dev",
        activeProfile: "byok",
        storage: {
          backend: "sqlite",
          schemaVersion: "memory-service",
          ready: storageReady
        },
        models: {
          summary: {
            provider: "sqlite-local",
            configured: false,
            remote: false
          },
          evolution: {
            provider: "sqlite-local",
            configured: false,
            remote: false
          },
          embedding: {
            provider: "sqlite-local",
            configured: false,
            remote: false
          }
        },
        capabilities: {
          routes: ["/api/v1/memory/search", "/api/v1/memory/:id", "/api/v1/memory/logs", "/api/v1/panel/overview", "/api/v1/panel/analysis", "/api/v1/panel/items"],
          tools: ["memory.search", "memory.get", "memory.delete"],
          memoryLayers: ["L1", "L2", "L3", "Skill"],
          supportsCli: false
        },
        serverTime: now()
      };
    },

    async reloadConfig() {
      return readOnlyOperationUnavailable();
    },

    async openSession(_input: OpenSessionInput): Promise<OpenSessionOutput> {
      return readOnlyOperationUnavailable();
    },

    async closeSession(_input: CloseSessionInput & { sessionId: string }): Promise<CloseSessionOutput> {
      return readOnlyOperationUnavailable();
    },

    async startTurn(_input: StartTurnInput): Promise<StartTurnOutput> {
      return readOnlyOperationUnavailable();
    },

    async completeTurn(_input: CompleteTurnInput & { turnId: string }): Promise<CompleteTurnOutput> {
      return readOnlyOperationUnavailable();
    },

    async search(input): Promise<SearchOutput> {
      const limit = 8;
      const hits = listMemoryRows(sources)
        .map((row) => ({ row, item: toListItem(row) }))
        .filter(({ item }) => itemMatchesPanelInput(item, { q: input.query }))
        .slice(0, limit)
        .map(({ item }, index): RecallHit => ({
          id: item.id,
          kind: item.kind,
          memoryLayer: item.memoryLayer,
          status: item.status,
          title: item.title,
          snippet: item.summary,
          score: Math.max(0.1, 1 - index * 0.08),
          tags: item.tags,
          updatedAt: item.updatedAt,
          source: item.kind === "skill" ? "skill" : "search"
        }));

      const injectedContext = {
        markdown: hits.map((hit) => `- ${hit.title ?? hit.id}: ${hit.snippet}`).join("\n"),
        sections: hits.map((hit) => ({
          id: hit.id,
          title: hit.title ?? hit.id,
          kind: hit.kind,
          memoryLayer: hit.memoryLayer,
          memoryIds: [hit.id],
          content: hit.snippet
        }))
      };
      if (input.verbose !== true) {
        return { injectedContext: injectedContext.markdown };
      }
      return {
        injectedContext: injectedContext.markdown,
        debug: {
          searchEventId: `sqlite-search-${Date.now()}`,
          hits,
          sourceMemoryIds: hits.map((hit) => hit.id),
          status: [],
          sections: injectedContext.sections,
          serverTime: now()
        }
      };
    },

    async getMemory(input): Promise<GetMemoryOutput> {
      const row = findMemoryRow(sources, input.memoryId);
      if (!row) {
        throw new MemoryLayerError("not_found", 404, `memory not found: ${input.memoryId}`);
      }

      const detail = toDetailItem(row, sources);
      return { item: detail.item, version: detail.version, etag: detail.etag };
    },

    async addMemory(_input: AddMemoryInput): Promise<AddMemoryOutput> {
      return readOnlyOperationUnavailable();
    },

    async deleteMemory(input): Promise<DeleteMemoryOutput> {
      const target = findWritableMemoryRow(sources, input.memoryId);
      if (!target) {
        throw new MemoryLayerError("not_found", 404, `memory not found: ${input.memoryId}`);
      }

      const kind = kindForRow(target.row);
      const deleted = hardDeleteMemoryRow(target, now());
      return {
        ok: true,
        id: encodeId(target.source, target.row.id),
        kind,
        status: "deleted",
        changeSeq: deleted.changeSeq,
        syncCursor: deleted.syncCursor,
        auditId: deleted.auditId,
        serverTime: deleted.serverTime
      };
    },

    async enqueueImportSummaries() {
      return readOnlyOperationUnavailable();
    },

    async runWorker() {
      return readOnlyOperationUnavailable();
    },

    async panelOverview(): Promise<PanelOverviewOutput> {
      const rows = listMemoryRows(sources);
      const dates = lastDateKeys(now(), PANEL_DAILY_ACTIVITY_DAYS);

      return {
        counts: {
          memories: rows.filter((item) => item.row.memory_layer === "L1").length,
          skills: rows.filter((item) => item.row.memory_layer === "Skill").length,
          experiences: rows.filter((item) => item.row.memory_layer === "L2").length,
          worldModels: rows.filter((item) => item.row.memory_layer === "L3").length
        },
        dailyActivity: countRowsByDate(rows, dates, (item) => item.row.created_at),
        sourceDistribution: buildSourceDistribution(rows)
      };
    },

    async panelAnalysis(): Promise<PanelAnalysisOutput> {
      const rows = listMemoryRows(sources);
      const dates = lastSevenDateKeys(now());
      const logs = listApiLogRows(sources, {}, 10_000)
        .filter((row) => dates.includes(dateKey(row.called_at)));
      const skillRows = rows.filter((item) => item.row.memory_layer === "Skill");
      const recallScores = logs
        .filter((row) => row.tool_name === "memory_search")
        .map((row) => recallScoreFromLog(row))
        .filter((score): score is number => score !== undefined);
      const durations = logs.map((row) => nonNegativeInt(row.duration_ms, 0));

      return {
        metrics: {
          avgRecallScore: roundDecimal(average(recallScores) ?? 0, 2),
          recallEvents: logs.filter((row) => row.tool_name === "memory_search").length,
          activeSkills: skillRows.filter((item) => item.row.status === "activated").length,
          recentlyUsedSkills: skillRows.filter((item) => dates.includes(dateKey(item.row.updated_at))).length,
          avgToolLatencyMs: roundInt(average(durations) ?? 0),
          p95ToolLatencyMs: percentile95(durations)
        },
        dailyMemoryWrites: countRowsByDate(rows, dates, (item) => item.row.created_at),
        dailySkillEvolutions: countRowsByDate(skillRows, dates, (item) => item.row.updated_at),
        toolLatency: buildToolLatency(logs, dates)
      };
    },

    async panelItems(input: PanelItemsInput): Promise<PanelItemsOutput> {
      const pageSize = 20;
      const filtered = listMemoryRows(sources)
        .map((row) => ({ item: toListItem(row), sourceAgent: sourceAgentForRow(row) }))
        .filter(({ item, sourceAgent }) => itemMatchesPanelInput(item, input, sourceAgent))
        .map(({ item }) => item)
        .sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt) ||
          b.updatedAt.localeCompare(a.updatedAt) ||
          b.id.localeCompare(a.id)
        );
      const total = filtered.length;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const page = Math.min(normalizePage(input.page), totalPages);
      const offset = (page - 1) * pageSize;
      const items = filtered.slice(offset, offset + pageSize);

      return {
        items,
        page,
        pageSize,
        total,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
        serverTime: now()
      };
    },

    async panelTasks(input: PanelTasksInput): Promise<PanelTasksOutput> {
      const query = input.q?.trim().toLowerCase() ?? "";
      const rows = listEpisodes(sources)
        .map(({ source, row }) => ({ source, row, turns: listRawTurnsForEpisode(source, row.id) }))
        .filter(({ row, turns }) => episodeMatchesQuery(row, turns, query))
        .sort((a, b) =>
          normalizeIsoTime(b.row.opened_at ?? b.row.updated_at ?? "").localeCompare(normalizeIsoTime(a.row.opened_at ?? a.row.updated_at ?? "")) ||
          normalizeIsoTime(b.row.updated_at ?? b.row.opened_at ?? "").localeCompare(normalizeIsoTime(a.row.updated_at ?? a.row.opened_at ?? "")) ||
          b.row.id.localeCompare(a.row.id)
        );
      const pageSize = 20;
      const total = rows.length;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      const page = Math.min(normalizePage(input.page), totalPages);
      const pageRows = rows.slice((page - 1) * pageSize, page * pageSize);

      return {
        tasks: pageRows.map(({ source, row, turns }) => ({
          id: encodeId(source, row.id),
          episode: {
            ...episodeDetailForRow(row),
            id: encodeId(source, row.id)
          } as PanelTasksOutput["tasks"][number]["episode"],
          memoryIds: prefixIds(source, readJsonArray(row.l1_memory_ids_json)),
          turns: turns.map((turn) => rawTurnSummaryForRow(source, row.id, turn)),
          updatedAt: normalizeIsoTime(row.updated_at ?? row.opened_at ?? now())
        })),
        page,
        pageSize,
        total,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
        serverTime: now()
      };
    },

    async deletePanelTask(taskId: string): Promise<DeletePanelTaskOutput> {
      return hardDeletePanelTask(sources, taskId, now());
    },

    async memoryApiLogs(input: MemoryApiLogsInput): Promise<MemoryApiLogsOutput> {
      const limit = normalizeLimit(input.limit);
      const offset = normalizeOffset(input.offset);
      const rows = listApiLogRows(sources, input, limit + offset);

      return {
        logs: rows.slice(offset, offset + limit).map((row) => ({
          id: row.id,
          toolName: row.tool_name,
          ...(row.source_agent ? { sourceAgent: row.source_agent } : {}),
          inputJson: row.input_json,
          outputJson: row.output_json,
          durationMs: nonNegativeInt(row.duration_ms, 0),
          success: row.success !== 0,
          calledAt: normalizeIsoTime(row.called_at)
        })),
        total: countApiLogRows(sources, input),
        limit,
        offset,
        nextOffset: rows.length > offset + limit ? offset + limit : undefined,
        serverTime: now()
      };
    }
  };
}

/**
 * Throws the unified error for write operations not supported by the local SQLite data source.
 */
function readOnlyOperationUnavailable(): never {
  throw new MemoryLayerError("memory_layer_unavailable", 503, "local sqlite memory source does not support this write operation");
}

function listMemoryRows(sources: readonly MemosSqliteSource[]): MemoryRow[] {
  return sources.flatMap((source) => withDb(source, (db) => {
    if (!tableExists(db, "memories")) {
      return [];
    }

    return db
      .prepare("select * from memories where deleted_at is null and status != 'deleted'")
      .all()
      .map((row) => ({ source, row: row as unknown as LocalMemoryRow }));
  }));
}

/**
 * Reads Memory API log rows from local SQLite data sources.
 *
 * @param sources the list of SQLite data sources.
 * @param input the log filter conditions.
 * @param maxRows the maximum number of rows to prefetch for cross-source merge sorting.
 * @returns log rows sorted by call time in descending order.
 */
function listApiLogRows(
  sources: readonly MemosSqliteSource[],
  input: MemoryApiLogsInput,
  maxRows: number
): LocalApiLogRow[] {
  const tools = normalizeApiLogTools(input.tools);
  const placeholders = tools.map(() => "?").join(", ");
  const agentFilter = apiLogSourceAgentFilter(input);
  return sources
    .flatMap((source) => withDb(source, (db) => {
      if (!tableExists(db, "api_logs")) {
        return [];
      }

      return db
        .prepare(
          `SELECT id, tool_name, source_agent, input_json, output_json, duration_ms, success, called_at
           FROM api_logs
           WHERE tool_name IN (${placeholders})
           ${agentFilter.sql}
           ORDER BY called_at DESC, id DESC
           LIMIT ?`
        )
        .all(...tools, ...agentFilter.parameters, maxRows) as unknown as LocalApiLogRow[];
    }))
    .sort((a, b) => b.called_at.localeCompare(a.called_at) || b.id - a.id)
    .slice(0, maxRows);
}

/**
 * Counts the Memory API logs in local SQLite data sources.
 *
 * @param sources the list of SQLite data sources.
 * @param input the log filter conditions.
 * @returns the total number of logs matching the filter conditions.
 */
function countApiLogRows(sources: readonly MemosSqliteSource[], input: MemoryApiLogsInput): number {
  const tools = normalizeApiLogTools(input.tools);
  const placeholders = tools.map(() => "?").join(", ");
  const agentFilter = apiLogSourceAgentFilter(input);
  return sources.reduce((total, source) => total + withDb(source, (db) => {
    if (!tableExists(db, "api_logs")) {
      return 0;
    }

    const row = db
      .prepare(`SELECT COUNT(*) AS count FROM api_logs WHERE tool_name IN (${placeholders}) ${agentFilter.sql}`)
      .get(...tools, ...agentFilter.parameters) as { count: number };
    return nonNegativeInt(row.count, 0);
  }), 0);
}

function apiLogSourceAgentFilter(input: MemoryApiLogsInput): { sql: string; parameters: string[] } {
  const sourceAgent = input.sourceAgent?.trim();
  const excludedSourceAgents = uniqueStrings(
    (input.excludedSourceAgents ?? []).map(normalizeSourceAgentKey).filter(Boolean)
  );
  const excludedPlaceholders = excludedSourceAgents.map(() => "?").join(", ");
  if (sourceAgent) {
    const normalizedSourceAgent = normalizeSourceAgentKey(sourceAgent);
    return {
      sql: `AND lower(replace(replace(TRIM(source_agent), '-', '_'), ' ', '_')) = ?`,
      parameters: [normalizedSourceAgent]
    };
  }
  if (excludedSourceAgents.length > 0) {
    return {
      sql: `AND (
              NULLIF(TRIM(source_agent), '') IS NULL
              OR lower(replace(replace(TRIM(source_agent), '-', '_'), ' ', '_')) NOT IN (${excludedPlaceholders})
            )`,
      parameters: excludedSourceAgents
    };
  }
  return { sql: "", parameters: [] };
}

function buildSourceDistribution(rows: MemoryRow[]): PanelOverviewOutput["sourceDistribution"] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const source = sourceLabelForRow(row);
    counts.set(source, (counts.get(source) ?? 0) + 1);
  }

  const total = rows.length;
  return Array.from(counts.entries())
    .map(([source, count]) => ({
      source,
      count,
      percentage: total > 0 ? roundDecimal((count / total) * 100, 1) : 0
    }))
    .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));
}

function countRowsByDate<T>(
  rows: T[],
  dates: string[],
  getTime: (row: T) => string | null | undefined
): Array<{ date: string; count: number }> {
  const counts = new Map(dates.map((date) => [date, 0]));
  for (const row of rows) {
    const key = dateKey(getTime(row));
    if (counts.has(key)) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  return dates.map((date) => ({ date, count: counts.get(date) ?? 0 }));
}

function buildToolLatency(logs: LocalApiLogRow[], dates: string[]): PanelAnalysisOutput["toolLatency"] {
  const byTool = new Map<LocalApiLogRow["tool_name"], LocalApiLogRow[]>();
  for (const row of logs) {
    const rows = byTool.get(row.tool_name) ?? [];
    rows.push(row);
    byTool.set(row.tool_name, rows);
  }

  const tools = Array.from(byTool.entries())
    .map(([name, rows]) => {
      const durations = rows.map((row) => nonNegativeInt(row.duration_ms, 0));
      return {
        name,
        calls: rows.length,
        avgMs: roundInt(average(durations) ?? 0),
        p95Ms: percentile95(durations)
      };
    })
    .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));

  return {
    tools,
    series: tools.map((tool) => {
      const rows = byTool.get(tool.name as LocalApiLogRow["tool_name"]) ?? [];
      return {
        name: tool.name,
        points: dates.map((date) => {
          const durations = rows
            .filter((row) => dateKey(row.called_at) === date)
            .map((row) => nonNegativeInt(row.duration_ms, 0));
          return { date, avgMs: roundInt(average(durations) ?? 0) };
        })
      };
    })
  };
}

function recallScoreFromLog(row: LocalApiLogRow): number | undefined {
  const output = readJsonObject(row.output_json);
  const score = numberValue(objectAt(output, ["stats"]).topRelevance);
  return score === undefined ? undefined : Math.max(0, score);
}

function lastSevenDateKeys(nowIso: string): string[] {
  return lastDateKeys(nowIso, 7);
}

function lastDateKeys(nowIso: string, days: number): string[] {
  const parsed = Date.parse(nowIso);
  const end = Number.isFinite(parsed) ? new Date(parsed) : new Date();
  return Array.from({ length: days }, (_item, index) => {
    const day = new Date(end);
    day.setUTCDate(end.getUTCDate() - (days - 1 - index));
    return day.toISOString().slice(0, 10);
  });
}

function dateKey(value: string | null | undefined): string {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : "";
}

function roundDecimal(value: number, decimals: number): number {
  return Number(value.toFixed(decimals));
}

function roundInt(value: number): number {
  return Math.max(0, Math.round(value));
}

function percentile95(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
  return roundInt(sorted[index] ?? 0);
}

function listEpisodes(sources: readonly MemosSqliteSource[]): Array<{ source: MemosSqliteSource; row: LocalEpisodeRow }> {
  return sources.flatMap((source) => withDb(source, (db) => {
    if (tableExists(db, "episodes")) {
      return db.prepare("select * from episodes").all().map((row) => ({ source, row: row as unknown as LocalEpisodeRow }));
    }

    if (!tableExists(db, "cloud_episodes")) {
      return [];
    }

    return db.prepare("select * from cloud_episodes").all().map((row) => ({ source, row: row as unknown as LocalEpisodeRow }));
  }));
}

function listRawTurnsForEpisode(source: MemosSqliteSource, episodeId: string): LocalRawTurnRow[] {
  return withDb(source, (db) => {
    if (!tableExists(db, "raw_turns")) {
      return [];
    }

    return db
      .prepare(
        `select * from raw_turns
         where episode_id = ? and redacted_at is null and deleted_at is null
         order by created_at asc, id asc`
      )
      .all(episodeId) as unknown as LocalRawTurnRow[];
  });
}

function episodeMatchesQuery(row: LocalEpisodeRow, turns: readonly LocalRawTurnRow[], query: string): boolean {
  if (!query) {
    return true;
  }

  return [
    row.id,
    row.title,
    row.summary,
    ...turns.flatMap((turn) => [turn.user_text, turn.assistant_text, turn.reasoning_summary])
  ].some((value) => value?.toLowerCase().includes(query));
}

function rawTurnSummaryForRow(
  source: MemosSqliteSource,
  episodeId: string,
  turn: LocalRawTurnRow
): PanelTasksOutput["tasks"][number]["turns"][number] {
  const toolResults = readJson(turn.tool_results_json);
  return removeUndefined({
    rawTurnId: encodeId(source, turn.id),
    episodeId: encodeId(source, episodeId),
    turnId: turn.turn_id,
    userText: turn.user_text ?? undefined,
    assistantText: turn.assistant_text ?? undefined,
    reasoningSummary: turn.reasoning_summary ?? undefined,
    toolCalls: readToolCalls(turn.tool_calls_json),
    toolResults: Array.isArray(toolResults) ? toolResults : [],
    createdAt: normalizeIsoTime(turn.created_at)
  }) as PanelTasksOutput["tasks"][number]["turns"][number];
}

function hardDeletePanelTask(
  sources: readonly MemosSqliteSource[],
  encodedId: string,
  serverTime: string
): DeletePanelTaskOutput {
  const decoded = decodeId(encodedId);
  const candidates = decoded.sourceId ? sources.filter((source) => source.id === decoded.sourceId) : sources;
  const target = listEpisodes(candidates).find(({ source, row }) =>
    row.id === decoded.rawId || encodeId(source, row.id) === encodedId
  );
  if (!target) {
    throw new MemoryLayerError("not_found", 404, `task not found: ${encodedId}`);
  }

  return withWritableDb(target.source, (db) => {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("BEGIN IMMEDIATE");
    try {
      const deletedMemoryIds: string[] = [];
      for (const memoryId of readJsonArray(target.row.l1_memory_ids_json)) {
        const memory = db
          .prepare("select * from memories where id = ? and deleted_at is null and status != 'deleted' limit 1")
          .get(memoryId) as unknown as LocalMemoryRow | undefined;
        if (!memory) {
          continue;
        }

        const memoryTarget = { source: target.source, row: memory };
        deleteMemoryAuxiliaryRows(db, memoryId);
        db.prepare("delete from memories where id = ?").run(memoryId);
        appendDeleteChangeLog(db, memoryTarget, serverTime);
        deletedMemoryIds.push(encodeId(target.source, memoryId));
      }

      const result = db.prepare("delete from episodes where id = ?").run(target.row.id) as { changes?: number | bigint };
      if (Number(result.changes ?? 0) !== 1) {
        throw new MemoryLayerError("not_found", 404, `task not found: ${encodedId}`);
      }

      db.exec("COMMIT");
      return {
        ok: true,
        id: encodeId(target.source, target.row.id),
        deletedMemoryIds,
        serverTime
      };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
}

function findMemoryRow(sources: readonly MemosSqliteSource[], encodedId: string, kind?: MemoryKind): MemoryRow | null {
  const decoded = decodeId(encodedId);
  const candidates = decoded.sourceId ? sources.filter((source) => source.id === decoded.sourceId) : sources;

  return (
    listMemoryRows(candidates).find((row) => {
      if (kind && kindForRow(row.row) !== kind) {
        return false;
      }

      return row.row.id === decoded.rawId || encodeId(row.source, row.row.id) === encodedId;
    }) ?? null
  );
}

function findWritableMemoryRow(sources: readonly MemosSqliteSource[], encodedId: string): MemoryRow | null {
  const decoded = decodeId(encodedId);
  const candidates = decoded.sourceId ? sources.filter((source) => source.id === decoded.sourceId) : sources;

  for (const source of candidates) {
    const row = withDb(source, (db) => {
      if (!tableExists(db, "memories")) {
        return null;
      }

      return db
        .prepare("select * from memories where id = ? and deleted_at is null and status != 'deleted' limit 1")
        .get(decoded.rawId) as unknown as LocalMemoryRow | undefined;
    });

    if (row) {
      return { source, row };
    }
  }

  return null;
}

function hardDeleteMemoryRow(target: MemoryRow, serverTime: string): LocalDeleteResult {
  return withWritableDb(target.source, (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      deleteMemoryAuxiliaryRows(db, target.row.id);
      const result = db
        .prepare("delete from memories where id = ? and deleted_at is null and status != 'deleted'")
        .run(target.row.id) as { changes?: number | bigint };
      if (Number(result.changes ?? 0) !== 1) {
        throw new MemoryLayerError("not_found", 404, `memory not found: ${encodeId(target.source, target.row.id)}`);
      }

      const changeSeq = appendDeleteChangeLog(db, target, serverTime);
      db.exec("COMMIT");
      return {
        changeSeq,
        syncCursor: `sqlite-delete:${target.source.id}:${changeSeq}`,
        serverTime
      };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
}

function deleteMemoryAuxiliaryRows(db: DatabaseSync, memoryId: string): void {
  if (tableExists(db, "memories_fts")) {
    db.prepare("delete from memories_fts where id = ?").run(memoryId);
  }

  if (tableExists(db, "memory_vector_entries")) {
    const vectors = db
      .prepare("select id, embedding_dim from memory_vector_entries where memory_id = ?")
      .all(memoryId) as Array<{ id: number; embedding_dim: number }>;
    for (const vector of vectors) {
      if (!Number.isSafeInteger(vector.embedding_dim) || vector.embedding_dim <= 0) continue;
      const table = `memory_vec_${vector.embedding_dim}`;
      if (tableExists(db, table)) {
        db.prepare(`delete from ${table} where rowid = ?`).run(BigInt(vector.id));
      }
    }
    db.prepare("delete from memory_vector_entries where memory_id = ?").run(memoryId);
  }

  if (tableExists(db, "embedding_retry_queue")) {
    db.prepare("delete from embedding_retry_queue where target_id = ?").run(memoryId);
  }
}

function appendDeleteChangeLog(db: DatabaseSync, target: MemoryRow, createdAt: string): number {
  if (!tableExists(db, "memory_change_log")) {
    return nonNegativeInt(target.row.version, 0) + 1;
  }

  const result = db
    .prepare(
      `insert into memory_change_log (
        memory_id, namespace_id, kind, op, entity_id, user_id,
        change_type, version, before_json, after_json, source, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      target.row.id,
      target.source.id,
      kindForRow(target.row),
      "deleted",
      target.row.id,
      target.row.user_id,
      "delete",
      nonNegativeInt(target.row.version, 0) + 1,
      JSON.stringify(target.row),
      null,
      "panel.delete",
      createdAt
    ) as { lastInsertRowid?: number | bigint };

  return Number(result.lastInsertRowid ?? 0);
}

function toListItem(row: MemoryRow): MemoryListItem {
  const parsed = parsedRow(row.row);
  const source = sourceLabelForRow(row, parsed);
  return {
    id: encodeId(row.source, row.row.id),
    kind: kindForRow(row.row),
    memoryLayer: row.row.memory_layer,
    status: row.row.status,
    title: truncate(firstNonEmpty(titleFromParsed(row.row, parsed), firstLine(row.row.memory_value), row.row.id), 80),
    summary: firstNonEmpty(summaryFromParsed(row.row, parsed), row.row.memory_value),
    tags: withSourceTag(source, tagsForRow(row.row, parsed)),
    metrics: metricsForRow(parsed),
    metadata: { source },
    createdAt: normalizeIsoTime(row.row.created_at),
    updatedAt: normalizeIsoTime(row.row.updated_at),
    version: nonNegativeInt(row.row.version, 1)
  };
}

function toDetailItem(row: MemoryRow, sources?: readonly MemosSqliteSource[]): GetMemoryOutput {
  const item = toListItem(row);
  const parsed = parsedRow(row.row);
  return {
    item: {
      ...item,
      body: row.row.memory_value,
      createdAt: normalizeIsoTime(row.row.created_at),
      sourceMemoryIds: sourceMemoryIds(row),
      metadata: metadataForRow(row, parsed, sources)
    },
    version: item.version,
    etag: `${item.id}-${item.version}`
  };
}

function itemMatchesPanelInput(item: MemoryListItem, input: PanelItemsInput, sourceAgent?: string): boolean {
  if (input.layer && item.memoryLayer !== input.layer) return false;
  if (input.status && item.status !== input.status) return false;
  const selectedSourceAgent = input.sourceAgent?.trim();
  if (selectedSourceAgent && normalizeSourceAgentKey(sourceAgent) !== normalizeSourceAgentKey(selectedSourceAgent)) return false;
  const excludedSourceAgents = new Set((input.excludedSourceAgents ?? []).map(normalizeSourceAgentKey).filter(Boolean));
  if (!selectedSourceAgent && excludedSourceAgents.has(normalizeSourceAgentKey(sourceAgent))) return false;
  return itemMatchesQueryAndTags(item, input.q);
}

function itemMatchesQueryAndTags(item: Pick<MemoryListItem, "id" | "title" | "summary" | "tags">, query?: string, tags?: readonly string[]): boolean {
  const normalizedQuery = query?.trim().toLowerCase();
  if (normalizedQuery) {
    const haystack = `${item.id} ${item.title} ${item.summary} ${item.tags.join(" ")}`.toLowerCase();
    if (!haystack.includes(normalizedQuery)) {
      return false;
    }
  }

  if (tags && tags.length > 0) {
    const itemTags = new Set(item.tags);
    if (!tags.every((tag) => itemTags.has(tag))) {
      return false;
    }
  }

  return true;
}

function kindForRow(row: LocalMemoryRow): MemoryKind {
  const parsedKind = stringValue(objectAt(readJsonObject(row.properties_json), ["internal_info"]).memory_kind);
  if (parsedKind === "trace" || parsedKind === "policy" || parsedKind === "world_model" || parsedKind === "skill") {
    return parsedKind;
  }

  if (row.memory_layer === "L2") return "policy";
  if (row.memory_layer === "L3") return "world_model";
  if (row.memory_layer === "Skill") return "skill";
  return "trace";
}

function titleFromParsed(row: LocalMemoryRow, parsed: ParsedRow): string | undefined {
  const internalInfo = objectAt(parsed.properties, ["internal_info"]);
  const policy = objectAt(internalInfo, ["policy"]);
  const worldModel = objectAt(internalInfo, ["world_model"]);
  const skill = objectAt(internalInfo, ["skill"]);

  return firstDefinedString(
    stringValue(internalInfo.title),
    stringValue(policy.title),
    stringValue(worldModel.title),
    stringValue(skill.title),
    stringValue(parsed.info.title),
    firstReadableMemoryValueLine(row.memory_value),
    humanizeIdentifier(stringValue(skill.name)),
    isInternalMemoryKey(row.memory_key ?? undefined) ? undefined : row.memory_key ?? undefined
  );
}

function summaryFromParsed(row: LocalMemoryRow, parsed: ParsedRow): string | undefined {
  const internalInfo = objectAt(parsed.properties, ["internal_info"]);
  const policy = objectAt(internalInfo, ["policy"]);
  const worldModel = objectAt(internalInfo, ["world_model"]);
  const skill = objectAt(internalInfo, ["skill"]);
  return firstDefinedString(
    stringValue(parsed.info.summary),
    stringValue(internalInfo.summary),
    stringValue(policy.trigger),
    stringValue(policy.procedure),
    stringValue(worldModel.summary),
    stringValue(worldModel.body),
    stringValue(skill.invocation_guide),
    stringValue(skill.invocationGuide),
    firstReadableMemoryValueLine(row.memory_value),
    row.memory_value
  );
}

interface ParsedRow {
  info: Record<string, unknown>;
  properties: Record<string, unknown>;
}

function parsedRow(row: LocalMemoryRow): ParsedRow {
  return {
    info: readJsonObject(row.info_json),
    properties: readJsonObject(row.properties_json)
  };
}

function tagsForRow(row: LocalMemoryRow, parsed: ParsedRow): string[] {
  return uniqueStrings([
    ...readJsonArray(row.tags_json),
    ...stringArray(parsed.info.tags),
    ...stringArray(parsed.properties.tags)
  ]);
}

function metricsForRow(parsed: ParsedRow): MemoryMetrics | undefined {
  const internalInfo = objectAt(parsed.properties, ["internal_info"]);
  const trace = objectAt(internalInfo, ["trace"]);
  const value = numberValue(internalInfo.value) ?? numberValue(trace.value);
  const alpha = numberValue(internalInfo.alpha) ?? numberValue(trace.alpha);
  const reflection = firstDefinedString(
    stringValue(internalInfo.reflection),
    stringValue(trace.reflection)
  );
  if (value === undefined && alpha === undefined && reflection === undefined) {
    return undefined;
  }

  return {
    value,
    alpha,
    reflectionDone: Boolean(reflection)
  };
}

function sourceMemoryIds(row: MemoryRow): string[] {
  const parsed = parsedRow(row.row);
  const internalInfo = objectAt(parsed.properties, ["internal_info"]);
  return prefixIds(row.source, uniqueStrings([
    ...stringArray(parsed.info.source_memory_ids),
    ...stringArray(internalInfo.source_memory_ids),
    ...stringArray(internalInfo.source_l1_memory_ids),
    ...stringArray(internalInfo.source_trace_ids)
  ]));
}

function sourceLabelForRow(row: MemoryRow, parsed: ParsedRow = parsedRow(row.row)): string {
  return sourceAgentForRow(row, parsed) ?? row.source.label;
}

function sourceAgentForRow(row: MemoryRow, parsed: ParsedRow = parsedRow(row.row)): string | undefined {
  return [
    sourceLabelFromParsed(parsed),
    sourceLabelFromSessionId(row.row.session_id),
    sourceLabelFromSessionId(row.row.conversation_id),
    row.row.agent_id?.trim() || undefined,
    row.row.app_id?.trim() || undefined
  ].find((value): value is string => Boolean(value));
}

function normalizeSourceAgentKey(value: string | undefined): string {
  return value?.trim().toLowerCase().replace(/[\s-]+/gu, "_") ?? "";
}

function sourceLabelFromParsed(parsed: ParsedRow): string | undefined {
  const internalInfo = objectAt(parsed.properties, ["internal_info"]);
  return normalizedAgentSource(stringValue(parsed.info.source))
    ?? normalizedAgentSource(stringValue(internalInfo.source));
}

function sourceLabelFromSessionId(value: string | null): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "claude" || normalized.startsWith("claude-")) return "claude-code";
  if (normalized === "open-code" || normalized.startsWith("open-code-")) return "opencode";
  for (const source of ["hermes", "openclaw", "codex", "cursor", "claude-code", "opencode", "workbuddy"]) {
    if (normalized === source || normalized.startsWith(`${source}-`)) return source;
  }
  return undefined;
}

function normalizedAgentSource(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "claude") return "claude-code";
  if (normalized === "open-code") return "opencode";
  return ["hermes", "openclaw", "codex", "cursor", "claude-code", "opencode", "workbuddy"].includes(normalized ?? "")
    ? normalized
    : undefined;
}

function withSourceTag(sourceLabel: string, tags: string[]): string[] {
  return uniqueStrings([sourceLabel, ...tags.filter(Boolean)]);
}

function metadataForRow(row: MemoryRow, parsed: ParsedRow, sources?: readonly MemosSqliteSource[]): Record<string, unknown> {
  return removeUndefined({
    traceDetail: kindForRow(row.row) === "trace" ? traceDetailForRow(row, parsed, sources) : undefined,
    source: sourceLabelForRow(row, parsed),
    sourceId: row.source.id,
    dbPath: row.source.dbPath,
    info: sanitizeMetadataValue(parsed.info),
    properties: sanitizeMetadataValue(parsed.properties),
    raw: sanitizeMetadataValue({
      ...row.row,
      embedding: undefined,
      info_json: undefined,
      properties_json: undefined
    })
  });
}

function traceDetailForRow(row: MemoryRow, parsed: ParsedRow, sources?: readonly MemosSqliteSource[]): Record<string, unknown> | undefined {
  const internalInfo = objectAt(parsed.properties, ["internal_info"]);
  const selectedTrace = traceObject(parsed);
  const turnId = firstDefinedString(
    stringValue(parsed.info.turn_id),
    stringValue(selectedTrace.turn_id),
    row.row.conversation_id ?? undefined
  );
  const rawTurnId = firstDefinedString(
    stringValue(parsed.info.raw_turn_id),
    stringValue(internalInfo.raw_turn_id),
    stringValue(internalInfo.source_raw_turn_id),
    stringValue(selectedTrace.raw_turn_id)
  );
  const rows = siblingTraceRows(row, parsed, sources ?? [row.source], turnId, rawTurnId);
  const parsedRows = rows.map((candidate) => ({ row: candidate, parsed: parsedRow(candidate.row) }));
  const rawTurn = readRawTurn(row.source, rawTurnId, turnId);
  const episodeId = firstDefinedString(
    rawTurn?.episode_id ?? undefined,
    stringValue(parsed.info.episode_id),
    stringValue(selectedTrace.episode_id)
  );
  const episode = readEpisode(row.source, episodeId);
  const traceRows = parsedRows.length > 0 ? parsedRows : [{ row, parsed }];
  const steps = traceRows.map(({ row: candidate, parsed: candidateParsed }) => traceStepForRow(candidate, candidateParsed));
  const values = steps.map((step) => numberValue(step.value)).filter((value): value is number => value !== undefined);
  const alphas = steps.map((step) => numberValue(step.alpha)).filter((value): value is number => value !== undefined);
  const priorities = steps.map((step) => numberValue(step.priority)).filter((value): value is number => value !== undefined);
  const selectedStep = traceStepForRow(row, parsed);
  const agentText = firstDefinedString(
    rawTurn?.assistant_text ?? undefined,
    stringValue(selectedTrace.agent_text),
    firstAgentSpanSummary(traceRows)
  );
  const parsedAgentText = parseBracketToolBlocks(agentText);
  const storedToolCalls = rawTurn
    ? readToolCalls(rawTurn.tool_calls_json)
    : uniqueToolCalls(steps.flatMap((step) => Array.isArray(step.toolCalls) ? step.toolCalls.filter(isRecordValue) : []));
  const toolCalls = storedToolCalls.length > 0 ? storedToolCalls : parsedAgentText.toolCalls;
  const summary = firstNonEmpty(
    stringValue(parsed.info.summary),
    stringValue(selectedTrace.summary),
    stringValue(internalInfo.summary),
    itemSummaryFallback(traceRows)
  );

  return removeUndefined({
    episodeId,
    turnId,
    rawTurnId,
    episode: episode ? episodeDetailForRow(episode) : undefined,
    turn: rawTurn ? removeUndefined({
      id: rawTurn.id,
      turnId: rawTurn.turn_id,
      createdAt: normalizeIsoTime(rawTurn.created_at),
      userText: rawTurn.user_text ?? undefined,
      assistantText: rawTurn.assistant_text ?? undefined,
      toolCalls: readToolCalls(rawTurn.tool_calls_json)
    }) : undefined,
    capturedAt: firstDefinedString(rawTurn ? normalizeIsoTime(rawTurn.created_at) : undefined, traceTimestamp(selectedTrace), normalizeIsoTime(row.row.created_at)),
    value: average(values) ?? numberValue(selectedStep.value),
    alpha: average(alphas) ?? numberValue(selectedStep.alpha),
    priority: priorities.length > 0 ? Math.max(...priorities) : numberValue(selectedStep.priority),
    rHuman: numberValue(parsed.info.r_human) ?? numberValue(internalInfo.r_human),
    summary,
    userQuery: firstDefinedString(rawTurn?.user_text ?? undefined, stringValue(selectedTrace.user_text), firstUserSpanSummary(traceRows)),
    finalResponse: firstDefinedString(parsedAgentText.text, agentText),
    toolCalls,
    steps
  });
}

function episodeDetailForRow(episode: LocalEpisodeRow): Record<string, unknown> {
  const rewardDetail = readJsonObject(episode.reward_detail_json ?? "{}");
  const meta = readJsonObject(episode.meta_json ?? "{}");
  const skillMemoryIds = readJsonArray(episode.skill_memory_ids_json ?? "[]");

  return removeUndefined({
    id: episode.id,
    sessionId: stringValue(episode.session_id),
    title: stringValue(episode.title),
    summary: stringValue(episode.summary),
    status: episode.status,
    startedAt: optionalIsoTime(episode.opened_at),
    endedAt: optionalIsoTime(episode.closed_at ?? undefined),
    turnCount: nonNegativeOptionalInt(episode.turn_count),
    rTask: numberValue(episode.r_task),
    rewardSkipped: booleanValue(rewardDetail.skipped),
    rewardReason: stringValue(rewardDetail.reason),
    closeReason: stringValue(meta.closeReason),
    topicState: stringValue(meta.topicState),
    abandonReason: stringValue(meta.abandonReason),
    pipelineStatus: stringValue(episode.pipeline_status),
    pipelineError: stringValue(episode.pipeline_error),
    skillMemoryIds,
    linkedSkillId: skillMemoryIds[0],
    skillStatus: skillStatusForEpisode(episode),
    skillReason: skillReasonForEpisode(episode)
  });
}

function skillStatusForEpisode(episode: LocalEpisodeRow): string {
  const rewardDetail = readJsonObject(episode.reward_detail_json ?? "{}");
  const meta = readJsonObject(episode.meta_json ?? "{}");
  const rTask = numberValue(episode.r_task);

  if (jsonArrayLength(episode.skill_memory_ids_json) > 0) {
    return "succeeded";
  }

  if (episode.pipeline_status === "running") {
    return "running";
  }

  if (episode.pipeline_status === "failed") {
    return "failed";
  }

  if (rTask !== undefined && rTask <= -0.5) {
    return "skipped";
  }

  if (
    booleanValue(rewardDetail.skipped) === true ||
    stringValue(meta.closeReason) === "abandoned" ||
    (rTask !== undefined && rTask < 0.3)
  ) {
    return "skipped";
  }

  return "queued";
}

function skillReasonForEpisode(episode: LocalEpisodeRow): string | undefined {
  const rewardDetail = readJsonObject(episode.reward_detail_json ?? "{}");
  const meta = readJsonObject(episode.meta_json ?? "{}");
  const rTask = numberValue(episode.r_task);

  if (jsonArrayLength(episode.skill_memory_ids_json) > 0) {
    return "已从该任务沉淀出可复用技能。";
  }

  if (episode.pipeline_error && episode.pipeline_error.trim()) {
    return `技能沉淀失败：${episode.pipeline_error.trim()}`;
  }

  if (rTask !== undefined && rTask <= -0.5) {
    return `任务评分 ${rTask.toFixed(2)}，被视为反例；不会沉淀出新的经验或技能。`;
  }

  if (booleanValue(rewardDetail.skipped) === true) {
    const turnCount = nonNegativeOptionalInt(episode.turn_count) ?? 0;
    if (turnCount < 2) {
      return "对话轮次不足，需要至少 2 轮完整问答才能生成摘要或技能。";
    }

    return "Reward 评分被跳过，暂不生成技能。";
  }

  if (stringValue(meta.closeReason) === "abandoned") {
    return "任务在完成打分前结束，暂不生成技能。";
  }

  if (rTask !== undefined && rTask < 0.3) {
    return `任务评分 ${rTask.toFixed(2)} 未达到沉淀阈值，暂不生成技能。`;
  }

  if (episode.pipeline_status === "running") {
    return "正在沉淀技能。";
  }

  if (episode.pipeline_status === "succeeded" && jsonArrayLength(episode.skill_memory_ids_json) === 0) {
    return "本任务未产出可复用技能。";
  }

  if (episode.status === "open") {
    return "任务仍在进行中，暂未启动技能沉淀。";
  }

  if (episode.pipeline_status === "idle" || !episode.pipeline_status) {
    return "等待评分完成后判断是否沉淀技能。";
  }

  return undefined;
}

function jsonArrayLength(raw: string | null | undefined): number {
  if (!raw) {
    return 0;
  }

  const parsed = readJson(raw);
  return Array.isArray(parsed) ? parsed.length : 0;
}

function readEpisode(source: MemosSqliteSource, episodeId: string | undefined): LocalEpisodeRow | null {
  if (!episodeId) {
    return null;
  }

  return withDb(source, (db) => {
    if (!tableExists(db, "episodes")) {
      return null;
    }

    const row = db.prepare("select * from episodes where id = ? limit 1").get(episodeId);
    return row ? (row as unknown as LocalEpisodeRow) : null;
  });
}

function siblingTraceRows(
  row: MemoryRow,
  parsed: ParsedRow,
  sources: readonly MemosSqliteSource[],
  turnId: string | undefined,
  rawTurnId: string | undefined
): MemoryRow[] {
  const candidates = listMemoryRows(sources.filter((source) => source.id === row.source.id));
  const rows = candidates.filter((candidate) => {
    if (kindForRow(candidate.row) !== "trace") {
      return false;
    }

    const candidateParsed = candidate.row.id === row.row.id ? parsed : parsedRow(candidate.row);
    const candidateInternalInfo = objectAt(candidateParsed.properties, ["internal_info"]);
    const candidateTrace = traceObject(candidateParsed);
    const candidateTurnId = firstDefinedString(
      stringValue(candidateParsed.info.turn_id),
      stringValue(candidateTrace.turn_id),
      candidate.row.conversation_id ?? undefined
    );
    const candidateRawTurnId = firstDefinedString(
      stringValue(candidateParsed.info.raw_turn_id),
      stringValue(candidateInternalInfo.raw_turn_id),
      stringValue(candidateInternalInfo.source_raw_turn_id),
      stringValue(candidateTrace.raw_turn_id)
    );

    return (
      (turnId !== undefined && candidateTurnId === turnId) ||
      (rawTurnId !== undefined && candidateRawTurnId === rawTurnId) ||
      candidate.row.id === row.row.id
    );
  });

  return rows.sort((a, b) => {
    const aTrace = traceObject(parsedRow(a.row));
    const bTrace = traceObject(parsedRow(b.row));
    const aStep = numberValue(aTrace.step_index) ?? 0;
    const bStep = numberValue(bTrace.step_index) ?? 0;
    if (aStep !== bStep) {
      return aStep - bStep;
    }

    return normalizeIsoTime(a.row.created_at).localeCompare(normalizeIsoTime(b.row.created_at));
  });
}

function traceStepForRow(row: MemoryRow, parsed: ParsedRow): Record<string, unknown> {
  const internalInfo = objectAt(parsed.properties, ["internal_info"]);
  const trace = traceObject(parsed);
  const rawSpan = rawSpanForParsed(parsed);
  const toolCalls = toolCallsFromTrace(trace);
  const role = toolCalls.length > 0 ? "tool" : rawSpan.user_text === true ? "user" : rawSpan.agent_text === true ? "assistant" : "assistant";

  return removeUndefined({
    id: encodeId(row.source, row.row.id),
    stepIndex: numberValue(trace.step_index) ?? numberValue(internalInfo.step_index),
    role,
    capturedAt: firstDefinedString(traceTimestamp(trace), normalizeIsoTime(row.row.created_at)),
    summary: firstNonEmpty(
      stringValue(trace.summary),
      stringValue(internalInfo.summary),
      stringValue(parsed.info.summary),
      row.row.memory_value
    ),
    reflection: firstDefinedString(stringValue(trace.reflection), stringValue(internalInfo.reflection)),
    value: numberValue(trace.value) ?? numberValue(internalInfo.value) ?? numberValue(parsed.info.value),
    alpha: numberValue(trace.alpha) ?? numberValue(internalInfo.alpha) ?? numberValue(parsed.info.alpha),
    priority: numberValue(trace.priority) ?? numberValue(internalInfo.priority) ?? numberValue(parsed.info.priority),
    toolCalls,
    rawSpan: removeUndefined({
      userText: rawSpan.user_text === true,
      agentText: rawSpan.agent_text === true,
      toolCallCount: numberValue(rawSpan.tool_call_count)
    })
  });
}

function traceObject(parsed: ParsedRow): Record<string, unknown> {
  const internalInfo = objectAt(parsed.properties, ["internal_info"]);
  return objectAt(internalInfo, ["trace"]);
}

function rawSpanForParsed(parsed: ParsedRow): Record<string, unknown> {
  const internalInfo = objectAt(parsed.properties, ["internal_info"]);
  const trace = traceObject(parsed);
  return firstRecord(trace.raw_span, internalInfo.raw_span);
}

function readRawTurn(source: MemosSqliteSource, rawTurnId: string | undefined, turnId: string | undefined): LocalRawTurnRow | null {
  if (!rawTurnId && !turnId) {
    return null;
  }

  return withDb(source, (db) => {
    if (!tableExists(db, "raw_turns")) {
      return null;
    }

    if (rawTurnId) {
      const row = db.prepare("select * from raw_turns where id = ? limit 1").get(rawTurnId);
      if (row) {
        return row as unknown as LocalRawTurnRow;
      }
    }

    if (turnId) {
      const row = db.prepare("select * from raw_turns where turn_id = ? limit 1").get(turnId);
      if (row) {
        return row as unknown as LocalRawTurnRow;
      }
    }

    return null;
  });
}

function readToolCalls(raw: string): Array<Record<string, unknown>> {
  const parsed = readJson(raw);
  return Array.isArray(parsed)
    ? parsed
      .filter((call): call is Record<string, unknown> => Boolean(call) && typeof call === "object" && !Array.isArray(call))
      .map(normalizeToolCall)
    : [];
}

function toolCallsFromTrace(trace: Record<string, unknown>): Array<Record<string, unknown>> {
  const calls = trace.tool_calls;
  return Array.isArray(calls)
    ? calls
      .filter((call): call is Record<string, unknown> => Boolean(call) && typeof call === "object" && !Array.isArray(call))
      .map(normalizeToolCall)
    : [];
}

function parseBracketToolBlocks(value: string | undefined): { text?: string; toolCalls: Array<Record<string, unknown>> } {
  if (!value || !/^\[tool\]\s*$/im.test(value)) {
    return { text: value, toolCalls: [] };
  }

  const lines = value.split(/\r?\n/);
  const textLines: string[] = [];
  const toolBlocks: string[] = [];

  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? "";
    if (/^\[tool\]\s*$/i.test(line.trim())) {
      index += 1;
      const blockLines: string[] = [];
      let sawToolField = false;
      while (index < lines.length && !/^\[(user|assistant|tool|system)\]\s*$/i.test((lines[index] ?? "").trim())) {
        const currentLine = lines[index] ?? "";
        const nextMeaningfulLine = nextNonEmptyLine(lines, index + 1);
        if (
          sawToolField &&
          currentLine.trim() === "" &&
          nextMeaningfulLine &&
          !isToolFieldLine(nextMeaningfulLine) &&
          !/^\[(user|assistant|tool|system)\]\s*$/i.test(nextMeaningfulLine.trim())
        ) {
          break;
        }

        blockLines.push(currentLine);
        if (isToolFieldLine(currentLine)) {
          sawToolField = true;
        }
        index += 1;
      }
      const block = blockLines.join("\n").trim();
      if (block) {
        toolBlocks.push(block);
      }
      continue;
    }

    textLines.push(line);
    index += 1;
  }

  return {
    text: cleanBracketToolText(textLines.join("\n")),
    toolCalls: toolBlocks.map(parseBracketToolBlock).map(normalizeToolCall)
  };
}

function nextNonEmptyLine(lines: readonly string[], start: number): string | undefined {
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (line?.trim()) {
      return line;
    }
  }
  return undefined;
}

function isToolFieldLine(line: string): boolean {
  return /^(Tool|Call ID|Status|Input|Output|Error):\s*/i.test(line.trim());
}

function parseBracketToolBlock(text: string): Record<string, unknown> {
  const fallbackOutput = toolBlockValue(text, "Input") === undefined && toolBlockValue(text, "Output") === undefined
    ? stripToolHeaderLines(text).trim()
    : "";
  const status = firstToolLineValue(text, "Status");
  const error = firstToolLineValue(text, "Error");
  return removeUndefined({
    id: firstToolLineValue(text, "Call ID"),
    name: firstToolLineValue(text, "Tool") ?? "tool",
    input: toolBlockValue(text, "Input"),
    output: toolBlockValue(text, "Output") ?? (fallbackOutput ? fallbackOutput : undefined),
    error,
    success: error ? false : successFromToolStatus(status)
  });
}

function normalizeToolCall(call: Record<string, unknown>): Record<string, unknown> {
  return removeUndefined({
    id: stringValue(call.id),
    name: firstDefinedString(stringValue(call.name), stringValue(call.tool), stringValue(call.tool_name), "tool"),
    input: sanitizeMetadataValue(call.input ?? call.args ?? call.arguments),
    output: sanitizeMetadataValue(call.output ?? call.result),
    error: stringValue(call.error) ?? stringValue(call.errorCode) ?? stringValue(call.error_code),
    success: typeof call.success === "boolean" ? call.success : undefined,
    startedAt: normalizeToolTime(call.startedAt ?? call.started_at),
    endedAt: normalizeToolTime(call.endedAt ?? call.ended_at)
  });
}

function firstToolLineValue(text: string, label: string): string | undefined {
  const match = text.match(new RegExp(`^${escapeRegExp(label)}:\\s*(.+)$`, "im"));
  return match?.[1]?.trim() || undefined;
}

function toolBlockValue(text: string, label: string): unknown {
  const lines = text.split(/\r?\n/);
  const labelPattern = new RegExp(`^${escapeRegExp(label)}:[\\t ]*(.*)$`, "i");
  const start = lines.findIndex((line) => labelPattern.test(line));
  if (start < 0) {
    return undefined;
  }

  const inlineValue = lines[start]?.match(labelPattern)?.[1]?.trim();
  const nextFieldOffset = lines.slice(start + 1).findIndex((line, offset) =>
    lines[start + offset]?.trim() === "" && isToolFieldLine(line)
  );
  const end = nextFieldOffset < 0 ? lines.length : start + 1 + nextFieldOffset;
  const value = inlineValue || lines.slice(start + 1, end).join("\n").trim();
  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function stripToolHeaderLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^(Tool|Call ID|Status|Error):\s*/i.test(line.trim()))
    .join("\n");
}

function successFromToolStatus(status: string | undefined): boolean | undefined {
  if (!status) {
    return undefined;
  }
  return !/(error|fail|cancel|timeout)/i.test(status);
}

function cleanBracketToolText(value: string): string | undefined {
  const text = value.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return text || undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeToolTime(value: unknown): string | number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
  }

  return undefined;
}

function traceTimestamp(trace: Record<string, unknown>): string | undefined {
  const ts = trace.ts;
  if (typeof ts === "number" && Number.isFinite(ts)) {
    const value = ts > 10_000_000_000 ? ts : ts * 1000;
    return new Date(value).toISOString();
  }

  return optionalIsoTime(stringValue(ts));
}

function firstUserSpanSummary(rows: Array<{ parsed: ParsedRow; row: MemoryRow }>): string | undefined {
  return rows.find(({ parsed }) => rawSpanForParsed(parsed).user_text === true)?.row.row.memory_value;
}

function firstAgentSpanSummary(rows: Array<{ parsed: ParsedRow; row: MemoryRow }>): string | undefined {
  return rows.find(({ parsed }) => rawSpanForParsed(parsed).agent_text === true)?.row.row.memory_value;
}

function itemSummaryFallback(rows: Array<{ parsed: ParsedRow; row: MemoryRow }>): string | undefined {
  return rows.map(({ parsed, row }) => summaryFromParsed(row.row, parsed)).find((summary) => summary && summary.trim());
}

function average(values: number[]): number | undefined {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
}

function uniqueToolCalls(calls: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  return calls.filter((call) => {
    const key = firstDefinedString(stringValue(call.id), `${stringValue(call.name) ?? "tool"}:${JSON.stringify(call.input ?? {})}`) ?? "tool";
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function firstRecord(...values: unknown[]): Record<string, unknown> {
  return values.find((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value)) ?? {};
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)) as T;
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db.prepare("select name from sqlite_master where type = 'table' and name = ?").get(tableName);
  return Boolean(row);
}

function withDb<T>(source: MemosSqliteSource, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(source.dbPath, { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function withWritableDb<T>(source: MemosSqliteSource, write: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(source.dbPath, { allowExtension: true });
  try {
    const extensionPath = getSqliteVecLoadablePath();
    const unpackedPath = extensionPath.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
    db.loadExtension(existsSync(unpackedPath) ? unpackedPath : extensionPath);
    return write(db);
  } finally {
    db.close();
  }
}

function encodeId(source: MemosSqliteSource, rawId: string): string {
  return `${source.id}${SOURCE_ID_SEPARATOR}${rawId}`;
}

function decodeId(id: string): { sourceId?: string; rawId: string } {
  const index = id.indexOf(SOURCE_ID_SEPARATOR);
  if (index <= 0) {
    return { rawId: id };
  }

  return { sourceId: id.slice(0, index), rawId: id.slice(index + SOURCE_ID_SEPARATOR.length) };
}

function prefixIds(source: MemosSqliteSource, ids: string[]): string[] {
  return ids.map((id) => (id.includes(SOURCE_ID_SEPARATOR) ? id : encodeId(source, id)));
}

function readJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readJsonArray(raw: string): string[] {
  return stringArray(readJson(raw));
}

function readJsonObject(raw: string): Record<string, unknown> {
  const parsed = readJson(raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function objectAt(value: unknown, keys: string[]): Record<string, unknown> {
  let current = value;
  for (const key of keys) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return {};
    }

    current = (current as Record<string, unknown>)[key];
  }

  return current && typeof current === "object" && !Array.isArray(current) ? (current as Record<string, unknown>) : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function firstNonEmpty(...values: Array<string | null | undefined>): string {
  return values.find((value) => value && value.trim().length > 0)?.trim() ?? "Untitled memory";
}

function firstDefinedString(...values: Array<string | undefined>): string | undefined {
  return values
    .map((value) => value?.trim())
    .find((value): value is string => Boolean(value && !isWorldSectionHeading(value) && !isInternalMemoryKey(value)));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function nonNegativeInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function nonNegativeOptionalInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

function firstReadableMemoryValueLine(value: string): string | undefined {
  return value
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*#{1,6}\s+/, "").replace(/^\s*[-*]\s+/, "").replace(/\*\*([^*]+)\*\*/g, "$1").trim())
    .find((line) => line && !isWorldSectionHeading(line) && !isInternalMemoryKey(line));
}

function humanizeIdentifier(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.trim();
  if (!/^[a-z0-9_:-]+$/i.test(cleaned)) return cleaned;
  return cleaned
    .replace(/^(skill|policy|trace|world)[:_]/i, "")
    .split(/[_:-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ") || undefined;
}

function isWorldSectionHeading(value: string): boolean {
  return /^(Environment|Inference|Constraints|Environment Knowledge|环境|环境拓扑|行为规律|约束禁忌|结构化认知)$/i.test(value.trim());
}

function isInternalMemoryKey(value: string | undefined): boolean {
  return Boolean(value && /^(trace|policy|world|world_model|skill)[:_]/i.test(value.trim()));
}

function normalizeIsoTime(value: string | null | undefined): string {
  if (!value) {
    return new Date(0).toISOString();
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(0).toISOString();
}

function optionalIsoTime(value: string | undefined): string | undefined {
  return value ? normalizeIsoTime(value) : undefined;
}

/**
 * Normalizes the log tool filter conditions.
 *
 * @param tools the tool-name list provided by the user.
 * @returns a tool-name list containing at least the default displayable tools.
 */
function normalizeApiLogTools(tools: MemoryApiLogsInput["tools"]): Array<LocalApiLogRow["tool_name"]> {
  return tools?.length ? tools : ["memory_add", "memory_search"];
}

/**
 * Normalizes the log pagination count.
 *
 * @param limit the limit provided by the user.
 * @returns a pagination count between 1 and 500.
 */
function normalizeLimit(limit: number | undefined): number {
  return typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 50;
}

/**
 * Normalizes the log pagination offset.
 *
 * @param offset the offset provided by the user.
 * @returns a non-negative integer offset.
 */
function normalizeOffset(offset: number | undefined): number {
  return typeof offset === "number" && Number.isInteger(offset) && offset >= 0 ? offset : 0;
}

function normalizePage(page: number | undefined): number {
  return Number.isFinite(page) && page! > 0 ? Math.floor(page!) : 1;
}

function sourceLabelFromPath(dbPath: string): string {
  const homeName = basename(resolve(dbPath, "..", ".."));
  return homeName && homeName !== "." ? homeName : "Memmy";
}

function expandHome(value: string): string {
  return value === "~" || value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

function sanitizeMetadataValue(value: unknown, key = ""): unknown {
  if (key === "embedding" || key === "vec" || key === "vec_summary" || key === "vec_action") {
    return undefined;
  }

  if (value instanceof Uint8Array) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeMetadataValue(item))
      .filter((item) => item !== undefined);
  }

  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
      const sanitized = sanitizeMetadataValue(entryValue, entryKey);
      if (sanitized !== undefined) {
        result[entryKey] = sanitized;
      }
    }

    return result;
  }

  return value;
}
