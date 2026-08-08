import {
  AgentKindSchema,
  AgentTokenStatsDtoSchema,
  ProjectTokenStatsDtoSchema,
  AgentTokenStatsResponseSchema,
  type AgentKind,
  type AgentTokenStatsDto,
  type ProjectTokenStatsDto,
  type AgentTokenStatsResponse
} from "@memmy/local-api-contracts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readJsonlObjects, type JsonObject } from "../adapters/outbound/agent-source/jsonl-lines.js";

export interface AgentTokenStatsService {
  getStats(): Promise<AgentTokenStatsResponse>;
}

export interface CreateAgentTokenStatsServiceOptions {
  /** Override home directory for testing. */
  homeDir?: string;
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

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  value: AgentTokenStatsResponse;
  expiresAt: number;
}

export function createAgentTokenStatsService(
  options: CreateAgentTokenStatsServiceOptions = {}
): AgentTokenStatsService {
  const homeDir = options.homeDir ?? os.homedir();
  let cache: CacheEntry | null = null;

  return {
    async getStats() {
      const now = Date.now();
      if (cache && cache.expiresAt > now) {
        return cache.value;
      }

      const projects = new Map<string, ProjectAccumulator>();

      // Scan Pi sessions
      await scanPiSessions(homeDir, projects);

      // Scan Codex sessions
      await scanCodexSessions(homeDir, projects);

      // Scan Claude Code transcripts (session count only, no token data)
      await scanClaudeCodeTranscripts(homeDir, projects);

      // Build response
      const response = buildResponse(projects);
      const validated = AgentTokenStatsResponseSchema.parse(response);

      cache = {
        value: validated,
        expiresAt: now + CACHE_TTL_MS
      };

      return validated;
    }
  };
}

function getOrCreateProject(
  projects: Map<string, ProjectAccumulator>,
  projectPath: string
): ProjectAccumulator {
  let acc = projects.get(projectPath);
  if (!acc) {
    acc = {
      pi: createEmptyAccumulator(),
      codex: createEmptyAccumulator(),
      claude_code: createEmptyAccumulator()
    };
    projects.set(projectPath, acc);
  }
  return acc;
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

async function scanPiSessions(
  homeDir: string,
  projects: Map<string, ProjectAccumulator>
): Promise<void> {
  const piSessionsDir = path.join(homeDir, ".pi", "agent", "sessions");
  if (!fs.existsSync(piSessionsDir)) {
    return;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(piSessionsDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith("--") || !entry.name.endsWith("--")) continue;

    // Decode path: --mnt-d-Project-Miller-memmy-agent-- → /mnt/d/Project/Miller/memmy-agent
    const projectPath = decodePiPath(entry.name);
    const sessionDir = path.join(piSessionsDir, entry.name);
    const acc = getOrCreateProject(projects, projectPath);

    // Find JSONL files in this session directory
    let files: string[];
    try {
      files = fs.readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = path.join(sessionDir, file);
      await processPiSessionFile(filePath, acc.pi);
    }
  }
}

function decodePiPath(encoded: string): string {
  // Remove leading -- and trailing --
  const inner = encoded.slice(2, -2);
  // Replace - with /
  return "/" + inner.replace(/-/g, "/");
}

async function processPiSessionFile(
  filePath: string,
  acc: PerAgentAccumulator
): Promise<void> {
  let hasUsage = false;

  for await (const obj of readJsonlObjects(filePath)) {
    // Look for assistant messages with usage data
    if (obj.type === "assistant" && obj.usage && typeof obj.usage === "object") {
      const usage = obj.usage as JsonObject;
      const input = toNumber(usage.input);
      const output = toNumber(usage.output);
      const cacheRead = toNumber(usage.cacheRead);
      const cacheWrite = toNumber(usage.cacheWrite);
      const total = toNumber(usage.totalTokens);
      const cost = obj.cost && typeof obj.cost === "object"
        ? toNumber((obj.cost as JsonObject).total)
        : 0;

      acc.inputTokens += input;
      acc.outputTokens += output;
      acc.cacheReadTokens += cacheRead;
      acc.cacheWriteTokens += cacheWrite;
      acc.totalTokens += total;
      acc.cost += cost;
      acc.apiCalls += 1;
      hasUsage = true;
    }
    
    // Also check for compaction/branch_summary entries with usage
    if ((obj.type === "compaction" || obj.type === "branch_summary") && obj.usage && typeof obj.usage === "object") {
      const usage = obj.usage as JsonObject;
      const input = toNumber(usage.input);
      const output = toNumber(usage.output);
      const cacheRead = toNumber(usage.cacheRead);
      const cacheWrite = toNumber(usage.cacheWrite);
      const total = toNumber(usage.totalTokens);
      const cost = obj.cost && typeof obj.cost === "object"
        ? toNumber((obj.cost as JsonObject).total)
        : 0;

      acc.inputTokens += input;
      acc.outputTokens += output;
      acc.cacheReadTokens += cacheRead;
      acc.cacheWriteTokens += cacheWrite;
      acc.totalTokens += total;
      acc.cost += cost;
      acc.apiCalls += 1;
      hasUsage = true;
    }
  }

  if (hasUsage) {
    acc.sessions += 1;
  }
}

async function scanCodexSessions(
  homeDir: string,
  projects: Map<string, ProjectAccumulator>
): Promise<void> {
  const codexSessionsDir = path.join(homeDir, ".codex", "sessions");
  if (!fs.existsSync(codexSessionsDir)) {
    return;
  }

  // Structure: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
  const dateDirs = walkDirectoryTree(codexSessionsDir, 3); // YYYY/MM/DD

  for (const dateDir of dateDirs) {
    let files: string[];
    try {
      files = fs.readdirSync(dateDir).filter((f) => f.startsWith("rollout-") && f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = path.join(dateDir, file);
      await processCodexSessionFile(filePath, projects);
    }
  }
}

function walkDirectoryTree(rootDir: string, depth: number): string[] {
  const results: string[] = [];
  
  function walk(dir: string, currentDepth: number) {
    if (currentDepth > depth) return;
    
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(dir, entry.name);
      if (currentDepth === depth) {
        results.push(fullPath);
      } else {
        walk(fullPath, currentDepth + 1);
      }
    }
  }

  walk(rootDir, 1);
  return results;
}

async function processCodexSessionFile(
  filePath: string,
  projects: Map<string, ProjectAccumulator>
): Promise<void> {
  let cwd: string | null = null;
  let lastTokenCount: {
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens: number;
    cache_write_input_tokens: number;
    reasoning_output_tokens: number;
    total_tokens: number;
  } | null = null;

  for await (const obj of readJsonlObjects(filePath)) {
    // Extract cwd from session_meta
    if (obj.type === "session_meta" && obj.payload && typeof obj.payload === "object") {
      const payload = obj.payload as JsonObject;
      if (typeof payload.cwd === "string") {
        cwd = payload.cwd;
      }
    }
    
    // Take the LAST token_count event (values are cumulative)
    if (obj.type === "event_msg" && obj.payload && typeof obj.payload === "object") {
      const payload = obj.payload as JsonObject;
      if (payload.type === "token_count" && payload.info && typeof payload.info === "object") {
        const info = payload.info as JsonObject;
        // Structure: info.total_token_usage.{input_tokens, output_tokens, ...}
        const totalUsage = info.total_token_usage;
        if (totalUsage && typeof totalUsage === "object") {
          const usage = totalUsage as JsonObject;
          lastTokenCount = {
            input_tokens: toNumber(usage.input_tokens),
            output_tokens: toNumber(usage.output_tokens),
            cached_input_tokens: toNumber(usage.cached_input_tokens),
            cache_write_input_tokens: toNumber(usage.cache_write_input_tokens),
            reasoning_output_tokens: toNumber(usage.reasoning_output_tokens),
            total_tokens: toNumber(usage.total_tokens)
          };
        }
      }
    }
  }

  if (!cwd || !lastTokenCount) {
    return;
  }

  const acc = getOrCreateProject(projects, cwd);
  acc.codex.sessions += 1;
  acc.codex.apiCalls += 1;
  acc.codex.inputTokens += lastTokenCount.input_tokens;
  acc.codex.outputTokens += lastTokenCount.output_tokens;
  acc.codex.cacheReadTokens += lastTokenCount.cached_input_tokens;
  acc.codex.cacheWriteTokens += lastTokenCount.cache_write_input_tokens;
  acc.codex.reasoningTokens += lastTokenCount.reasoning_output_tokens;
  acc.codex.totalTokens += lastTokenCount.total_tokens;
}

async function scanClaudeCodeTranscripts(
  homeDir: string,
  projects: Map<string, ProjectAccumulator>
): Promise<void> {
  const claudeTranscriptsDir = path.join(homeDir, ".claude", "transcripts");
  if (!fs.existsSync(claudeTranscriptsDir)) {
    return;
  }

  let files: string[];
  try {
    files = fs.readdirSync(claudeTranscriptsDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return;
  }

  // Claude Code transcripts don't have token data, but we can count sessions
  // We'll attribute them to a generic "claude" project or try to extract from content
  for (const file of files) {
    const filePath = path.join(claudeTranscriptsDir, file);
    await processClaudeCodeTranscript(filePath, projects);
  }
}

async function processClaudeCodeTranscript(
  filePath: string,
  projects: Map<string, ProjectAccumulator>
): Promise<void> {
  let cwd: string | null = null;

  // Try to find cwd or project identifier from the transcript
  for await (const obj of readJsonlObjects(filePath)) {
    if (obj.cwd && typeof obj.cwd === "string") {
      cwd = obj.cwd;
      break;
    }
  }

  if (!cwd) {
    // Use a generic path if we can't determine the project
    cwd = "claude-code-unknown";
  }

  const acc = getOrCreateProject(projects, cwd);
  acc.claude_code.sessions += 1;
  // No token data available for Claude Code
}

function buildResponse(
  projects: Map<string, ProjectAccumulator>
): AgentTokenStatsResponse {
  const projectStats: ProjectTokenStatsDto[] = [];

  for (const [projectPath, acc] of projects) {
    const agents: AgentTokenStatsDto[] = [];

    // Pi
    if (acc.pi.sessions > 0 || acc.codex.sessions > 0 || acc.claude_code.sessions > 0) {
      agents.push(buildAgentDto("pi", acc.pi, true));
      agents.push(buildAgentDto("codex", acc.codex, true));
      agents.push(buildAgentDto("claude_code", acc.claude_code, false));
    }

    if (agents.length === 0) continue;

    const combinedInputTokens = agents.reduce((sum, a) => sum + a.inputTokens, 0);
    const combinedOutputTokens = agents.reduce((sum, a) => sum + a.outputTokens, 0);
    const combinedCacheReadTokens = agents.reduce((sum, a) => sum + (a.cacheReadTokens ?? 0), 0);
    const combinedTotalTokens = agents.reduce((sum, a) => sum + a.totalTokens, 0);
    const estimatedCost = agents.reduce((sum, a) => sum + (a.cost ?? 0), 0);

    projectStats.push(
      ProjectTokenStatsDtoSchema.parse({
        project: projectPath,
        agents,
        combinedInputTokens,
        combinedOutputTokens,
        combinedCacheReadTokens,
        combinedTotalTokens,
        estimatedCost: estimatedCost > 0 ? estimatedCost : undefined
      })
    );
  }

  // Sort by total tokens descending
  projectStats.sort((a, b) => b.combinedTotalTokens - a.combinedTotalTokens);

  return {
    projects: projectStats,
    scannedAt: new Date().toISOString()
  };
}

function buildAgentDto(
  agent: AgentKind,
  acc: PerAgentAccumulator,
  available: boolean
): AgentTokenStatsDto {
  return AgentTokenStatsDtoSchema.parse({
    agent,
    sessions: acc.sessions,
    apiCalls: acc.apiCalls,
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    cacheReadTokens: acc.cacheReadTokens,
    cacheWriteTokens: acc.cacheWriteTokens,
    reasoningTokens: acc.reasoningTokens > 0 ? acc.reasoningTokens : undefined,
    totalTokens: acc.totalTokens,
    cost: acc.cost > 0 ? acc.cost : undefined,
    available
  });
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}
