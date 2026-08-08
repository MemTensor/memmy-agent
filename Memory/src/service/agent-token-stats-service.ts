import { createReadStream } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";

export type AgentKind = "pi" | "codex" | "claude_code";

export interface AgentTokenStats {
  agent: AgentKind;
  sessions: number;
  apiCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens?: number;
  totalTokens: number;
  cost?: number;
  available: boolean;
}

export interface ProjectTokenStats {
  project: string;
  agents: AgentTokenStats[];
  combinedInputTokens: number;
  combinedOutputTokens: number;
  combinedCacheReadTokens: number;
  combinedTotalTokens: number;
  estimatedCost?: number;
}

export interface MonthlyAgentTokenStats {
  month: string;
  projects: ProjectTokenStats[];
}

export interface AgentTokenStatsResponse {
  projects: ProjectTokenStats[];
  monthly: MonthlyAgentTokenStats[];
  scannedAt: string;
}

export interface AgentTokenStatsService {
  getStats(): Promise<AgentTokenStatsResponse>;
}

export interface CreateAgentTokenStatsServiceOptions {
  homeDir?: string;
  cacheTtlMs?: number;
}

interface PerAgentAccumulator {
  sessions: number;
  apiCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cost: number;
}

interface ProjectAccumulator {
  pi: PerAgentAccumulator;
  codex: PerAgentAccumulator;
  claude_code: PerAgentAccumulator;
}

interface UsageRecord {
  month: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cost: number;
}

interface ScanState {
  projects: Map<string, ProjectAccumulator>;
  monthlyProjects: Map<string, Map<string, ProjectAccumulator>>;
}

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

export function createAgentTokenStatsService(
  options: CreateAgentTokenStatsServiceOptions = {}
): AgentTokenStatsService {
  const homeDir = options.homeDir ?? os.homedir();
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  let cache: { expiresAt: number; value: AgentTokenStatsResponse } | undefined;
  let pending: Promise<AgentTokenStatsResponse> | undefined;

  return {
    async getStats() {
      const now = Date.now();
      if (cache && cache.expiresAt > now) return cache.value;
      if (pending) return pending;

      pending = scanAgentTokenStats(homeDir);
      try {
        const value = await pending;
        cache = { expiresAt: Date.now() + cacheTtlMs, value };
        return value;
      } finally {
        pending = undefined;
      }
    }
  };
}

async function scanAgentTokenStats(homeDir: string): Promise<AgentTokenStatsResponse> {
  const state: ScanState = {
    projects: new Map(),
    monthlyProjects: new Map()
  };
  await scanPiSessions(homeDir, state);
  await scanCodexSessions(homeDir, state);
  await scanClaudeCodeTranscripts(homeDir, state);

  return {
    projects: buildProjectStats(state.projects),
    monthly: [...state.monthlyProjects.entries()]
      .sort(([left], [right]) => right.localeCompare(left))
      .map(([month, projects]) => ({ month, projects: buildProjectStats(projects) })),
    scannedAt: new Date().toISOString()
  };
}

function createEmptyAccumulator(): PerAgentAccumulator {
  return {
    sessions: 0,
    apiCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    cost: 0
  };
}

function getOrCreateProject(
  projects: Map<string, ProjectAccumulator>,
  projectPath: string
): ProjectAccumulator {
  let accumulator = projects.get(projectPath);
  if (!accumulator) {
    accumulator = {
      pi: createEmptyAccumulator(),
      codex: createEmptyAccumulator(),
      claude_code: createEmptyAccumulator()
    };
    projects.set(projectPath, accumulator);
  }
  return accumulator;
}

function getMonthlyProject(state: ScanState, month: string, projectPath: string): ProjectAccumulator {
  let projects = state.monthlyProjects.get(month);
  if (!projects) {
    projects = new Map();
    state.monthlyProjects.set(month, projects);
  }
  return getOrCreateProject(projects, projectPath);
}

async function* readJsonlObjects(filePath: string): AsyncIterable<Record<string, unknown>> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line);
        if (value && typeof value === "object" && !Array.isArray(value)) {
          yield value as Record<string, unknown>;
        }
      } catch {
        // Session files can contain an incomplete final line after an interrupted write.
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

async function scanPiSessions(homeDir: string, state: ScanState): Promise<void> {
  const root = path.join(homeDir, ".pi", "agent", "sessions");
  for (const entry of readDirectories(root)) {
    if (!entry.name.startsWith("--") || !entry.name.endsWith("--")) continue;
    const projectPath = decodePiPath(entry.name);
    for (const file of readJsonlFiles(path.join(root, entry.name))) {
      await processPiSessionFile(file, projectPath, state);
    }
  }
}

async function processPiSessionFile(
  filePath: string,
  projectPath: string,
  state: ScanState
): Promise<void> {
  const usedMonths = new Set<string>();
  let hasUsage = false;
  for await (const object of readJsonlObjects(filePath)) {
    const usage = piUsageFromObject(object, filePath);
    if (!usage) continue;
    addUsage(getOrCreateProject(state.projects, projectPath).pi, usage);
    addUsage(getMonthlyProject(state, usage.month, projectPath).pi, usage);
    usedMonths.add(usage.month);
    hasUsage = true;
  }
  if (!hasUsage) return;
  getOrCreateProject(state.projects, projectPath).pi.sessions += 1;
  for (const month of usedMonths) {
    getMonthlyProject(state, month, projectPath).pi.sessions += 1;
  }
}

function piUsageFromObject(object: Record<string, unknown>, filePath: string): UsageRecord | undefined {
  let usage: Record<string, unknown> | undefined;
  if (
    (object.type === "assistant" || object.type === "compaction" || object.type === "branch_summary")
    && isRecord(object.usage)
  ) {
    usage = object.usage;
  } else if (object.type === "message" && isRecord(object.message)) {
    const message = object.message;
    if (message.role === "assistant" && isRecord(message.usage)) usage = message.usage;
  }
  if (!usage) return undefined;

  const cost = isRecord(usage.cost)
    ? toNumber(usage.cost.total)
    : isRecord(object.cost)
      ? toNumber(object.cost.total)
      : 0;
  return {
    month: monthFromTimestamp(object.timestamp, filePath),
    inputTokens: toNumber(usage.input),
    outputTokens: toNumber(usage.output),
    cacheReadTokens: toNumber(usage.cacheRead),
    cacheWriteTokens: toNumber(usage.cacheWrite),
    reasoningTokens: toNumber(usage.reasoning),
    totalTokens: toNumber(usage.totalTokens),
    cost
  };
}

async function scanCodexSessions(homeDir: string, state: ScanState): Promise<void> {
  const root = path.join(homeDir, ".codex", "sessions");
  for (const dateDirectory of walkDirectoryTree(root, 3)) {
    for (const file of readJsonlFiles(dateDirectory, "rollout-")) {
      await processCodexSessionFile(file, state);
    }
  }
}

async function processCodexSessionFile(filePath: string, state: ScanState): Promise<void> {
  let cwd: string | undefined;
  let lastUsage: UsageRecord | undefined;
  for await (const object of readJsonlObjects(filePath)) {
    if (object.type === "session_meta" && isRecord(object.payload) && typeof object.payload.cwd === "string") {
      cwd = object.payload.cwd;
    }
    if (object.type !== "event_msg" || !isRecord(object.payload)) continue;
    const payload = object.payload;
    if (payload.type !== "token_count" || !isRecord(payload.info) || !isRecord(payload.info.total_token_usage)) continue;
    const usage = payload.info.total_token_usage;
    lastUsage = {
      month: monthFromTimestamp(object.timestamp, filePath),
      inputTokens: toNumber(usage.input_tokens),
      outputTokens: toNumber(usage.output_tokens),
      cacheReadTokens: toNumber(usage.cached_input_tokens),
      cacheWriteTokens: toNumber(usage.cache_write_input_tokens),
      reasoningTokens: toNumber(usage.reasoning_output_tokens),
      totalTokens: toNumber(usage.total_tokens),
      cost: 0
    };
  }
  if (!cwd || !lastUsage) return;
  const overall = getOrCreateProject(state.projects, cwd).codex;
  const monthly = getMonthlyProject(state, lastUsage.month, cwd).codex;
  addUsage(overall, lastUsage);
  addUsage(monthly, lastUsage);
  overall.sessions += 1;
  monthly.sessions += 1;
}

async function scanClaudeCodeTranscripts(homeDir: string, state: ScanState): Promise<void> {
  const root = path.join(homeDir, ".claude", "transcripts");
  for (const file of readJsonlFiles(root)) {
    let cwd: string | undefined;
    let month = monthFromTimestamp(undefined, file);
    for await (const object of readJsonlObjects(file)) {
      if (typeof object.cwd === "string") cwd = object.cwd;
      if (object.timestamp !== undefined) month = monthFromTimestamp(object.timestamp, file);
      if (cwd) break;
    }
    const projectPath = cwd ?? "claude-code-unknown";
    getOrCreateProject(state.projects, projectPath).claude_code.sessions += 1;
    getMonthlyProject(state, month, projectPath).claude_code.sessions += 1;
  }
}

function addUsage(accumulator: PerAgentAccumulator, usage: UsageRecord): void {
  accumulator.apiCalls += 1;
  accumulator.inputTokens += usage.inputTokens;
  accumulator.outputTokens += usage.outputTokens;
  accumulator.cacheReadTokens += usage.cacheReadTokens;
  accumulator.cacheWriteTokens += usage.cacheWriteTokens;
  accumulator.reasoningTokens += usage.reasoningTokens;
  accumulator.totalTokens += usage.totalTokens;
  accumulator.cost += usage.cost;
}

function buildProjectStats(projects: Map<string, ProjectAccumulator>): ProjectTokenStats[] {
  const result = [...projects.entries()].map(([project, accumulator]) => {
    const agents = [
      buildAgentStats("pi", accumulator.pi, true),
      buildAgentStats("codex", accumulator.codex, true),
      buildAgentStats("claude_code", accumulator.claude_code, false)
    ];
    const estimatedCost = agents.reduce((sum, agent) => sum + (agent.cost ?? 0), 0);
    return {
      project,
      agents,
      combinedInputTokens: agents.reduce((sum, agent) => sum + agent.inputTokens, 0),
      combinedOutputTokens: agents.reduce((sum, agent) => sum + agent.outputTokens, 0),
      combinedCacheReadTokens: agents.reduce((sum, agent) => sum + agent.cacheReadTokens, 0),
      combinedTotalTokens: agents.reduce((sum, agent) => sum + agent.totalTokens, 0),
      estimatedCost: estimatedCost > 0 ? estimatedCost : undefined
    };
  });
  return result.sort((left, right) => right.combinedTotalTokens - left.combinedTotalTokens);
}

function buildAgentStats(agent: AgentKind, accumulator: PerAgentAccumulator, available: boolean): AgentTokenStats {
  return {
    agent,
    sessions: accumulator.sessions,
    apiCalls: accumulator.apiCalls,
    inputTokens: accumulator.inputTokens,
    outputTokens: accumulator.outputTokens,
    cacheReadTokens: accumulator.cacheReadTokens,
    cacheWriteTokens: accumulator.cacheWriteTokens,
    reasoningTokens: accumulator.reasoningTokens || undefined,
    totalTokens: accumulator.totalTokens,
    cost: accumulator.cost || undefined,
    available
  };
}

function monthFromTimestamp(timestamp: unknown, filePath: string): string {
  if (typeof timestamp === "string" || typeof timestamp === "number") {
    const date = new Date(timestamp);
    if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 7);
  }
  const match = path.basename(filePath).match(/(20\d{2})[-_/](0[1-9]|1[0-2])/);
  if (match) return `${match[1]}-${match[2]}`;
  try {
    return fs.statSync(filePath).mtime.toISOString().slice(0, 7);
  } catch {
    return "unknown";
  }
}

function decodePiPath(encoded: string): string {
  return "/" + encoded.slice(2, -2).replace(/-/g, "/");
}

function readDirectories(root: string): fs.Dirent[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return [];
  }
}

function readJsonlFiles(root: string, prefix = ""): string[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".jsonl"))
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

function walkDirectoryTree(root: string, depth: number): string[] {
  const results: string[] = [];
  function walk(directory: string, currentDepth: number): void {
    for (const entry of readDirectories(directory)) {
      const fullPath = path.join(directory, entry.name);
      if (currentDepth === depth) results.push(fullPath);
      else walk(fullPath, currentDepth + 1);
    }
  }
  walk(root, 1);
  return results;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}
