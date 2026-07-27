import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Tool } from "./base.js";

const INITIAL_MEMORY_LIMIT = 500;
const IMPORT_BATCH_TURNS = 100;
const MAX_MANIFEST_BYTES = 100 * 1024 * 1024;
const FULL_MEMORY_SKILL_TEMPLATE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../skills/agent-memory-onboarding/references/full-memory-skill.md"
);

type AgentSourceMessage = {
  messageId: string;
  conversationId: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  createdAt: string;
  workspacePath?: string | null;
  gitRoot?: string | null;
  rawMeta?: Record<string, unknown>;
};

type AgentSourceTurn = {
  createdAt: string;
  messages: AgentSourceMessage[];
};

type RuntimeConfig = {
  baseUrl: string;
  localToken: string;
};

type AgentSourceView = {
  sourceId: string;
  displayName: string;
  syncBoundaryAt?: string | null;
  syncReady?: boolean;
};

type ImportResult = {
  attempted: number;
  written: number;
  deduped: number;
  failed: number;
  memoryIds: string[];
  syncBoundaryAt: string | null;
  errors: Array<{ conversationId: string; reason: string }>;
};

export class AgentSourceTool extends Tool {
  static scopes = new Set(["core"]);
  private readonly workspace: string;

  constructor(options: { workspace?: string } = {}) {
    super();
    this.workspace = path.resolve(options.workspace ?? process.cwd());
  }

  static create(ctx: { workspace?: string }): AgentSourceTool {
    return new AgentSourceTool({ workspace: ctx.workspace });
  }

  get name(): string {
    return "memmy_agent_source";
  }

  get description(): string {
    return "Render an Agent-specific Memmy Skill, import an AI-discovered history manifest, save its reusable sync recipe, or update its installed state. Use only in an explicitly requested agent-memory-onboarding task.";
  }

  override get readOnly(): boolean {
    return false;
  }

  get parameters() {
    return {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["render_skill", "import_manifest", "save_sync_recipe", "set_skill_status"]
        },
        source_id: { type: "string" },
        manifest_path: { type: "string" },
        mode: { type: "string", enum: ["initial_subset", "incremental"] },
        data_path: { type: "string" },
        skill_installed: { type: "boolean" },
        sync_recipe: { type: "object", additionalProperties: true }
      },
      required: ["action", "source_id"]
    };
  }

  async execute(params: Record<string, unknown>): Promise<string> {
    const sourceId = requiredString(params.source_id, "source_id");
    const action = requiredString(params.action, "action");
    const runtime = readRuntimeConfig();

    if (action === "render_skill") {
      const source = await readAgentSource(runtime, sourceId);
      return JSON.stringify(renderFullMemorySkill(
        this.workspace,
        sourceId,
        source.displayName
      ));
    }

    if (action === "set_skill_status") {
      if (typeof params.skill_installed !== "boolean") {
        throw new Error("skill_installed must be a boolean");
      }
      const source = await localApiRequest<AgentSourceView>(
        runtime,
        "PATCH",
        `/api/agent-sources/${encodeURIComponent(sourceId)}/managed`,
        {
          skillInstalled: params.skill_installed,
          ...(optionalString(params.data_path) ? { dataPath: optionalString(params.data_path) } : {})
        }
      );
      return JSON.stringify({
        sourceId: source.sourceId,
        skillInstalled: params.skill_installed,
        dataPath: optionalString(params.data_path) ?? undefined
      });
    }

    if (action === "save_sync_recipe") {
      if (!params.sync_recipe || typeof params.sync_recipe !== "object" || Array.isArray(params.sync_recipe)) {
        throw new Error("sync_recipe must be an object");
      }
      const source = await localApiRequest<AgentSourceView>(
        runtime,
        "PATCH",
        `/api/agent-sources/${encodeURIComponent(sourceId)}/managed`,
        {
          syncRecipe: params.sync_recipe,
          ...(optionalString(params.data_path) ? { dataPath: optionalString(params.data_path) } : {})
        }
      );
      if (!source.syncReady) {
        throw new Error("Managed Agent sync recipe was not persisted");
      }
      return JSON.stringify({
        sourceId: source.sourceId,
        syncReady: true,
        dataPath: optionalString(params.data_path) ?? undefined
      });
    }

    if (action !== "import_manifest") {
      throw new Error(`Unsupported action: ${action}`);
    }

    const mode = requiredString(params.mode, "mode");
    if (mode !== "initial_subset" && mode !== "incremental") {
      throw new Error("mode must be initial_subset or incremental");
    }
    const manifestPath = resolveManifestPath(this.workspace, requiredString(params.manifest_path, "manifest_path"));
    const messages = readManifest(manifestPath);
    const source = await readAgentSource(runtime, sourceId);
    const allTurns = buildCompleteTurns(messages);
    const selectedTurns = selectTurns(allTurns, mode, source.syncBoundaryAt ?? null);
    const syncBoundaryAt = resolveSyncBoundaryAt(mode, selectedTurns, source.syncBoundaryAt ?? null);
    const latestSeenAt = latestMessageTimestamp(selectedTurns);
    const batches = chunk(selectedTurns, IMPORT_BATCH_TURNS);
    const results: ImportResult[] = [];

    if (batches.length === 0) {
      results.push(await importBatch(runtime, sourceId, {
        mode,
        messages: [],
        dataPath: optionalString(params.data_path),
        syncBoundaryAt,
        latestSeenAt,
        final: true
      }));
    } else {
      for (let index = 0; index < batches.length; index += 1) {
        const result = await importBatch(runtime, sourceId, {
          mode,
          messages: batches[index]!.flatMap((turn) => turn.messages),
          dataPath: index === 0 ? optionalString(params.data_path) : undefined,
          syncBoundaryAt,
          latestSeenAt,
          final: index === batches.length - 1
        });
        if (result.errors.length > 0) {
          throw new Error(`Agent history import failed: ${result.errors.map((error) => error.reason).join("; ")}`);
        }
        results.push(result);
      }
    }

    return JSON.stringify({
      sourceId,
      mode,
      manifestMessages: messages.length,
      completeTurns: allTurns.length,
      selectedTurns: selectedTurns.length,
      attempted: sum(results, "attempted"),
      written: sum(results, "written"),
      deduped: sum(results, "deduped"),
      failed: sum(results, "failed"),
      memoryIds: results.flatMap((result) => result.memoryIds),
      syncBoundaryAt: results.at(-1)?.syncBoundaryAt ?? syncBoundaryAt
    });
  }
}

export function renderFullMemorySkill(
  workspace: string,
  sourceId: string,
  agentName: string
): { skillPath: string; memorySource: string } {
  const template = fs.readFileSync(FULL_MEMORY_SKILL_TEMPLATE, "utf8");
  if (!template.includes("{{SOURCE_ARG}}")) {
    throw new Error("Full Memmy Skill template is missing {{SOURCE_ARG}}");
  }
  const targetDir = path.join(
    path.resolve(workspace),
    ".memmy-agent",
    createHash("sha256").update(sourceId).digest("hex").slice(0, 16),
    "memmy-memory"
  );
  const skillPath = path.join(targetDir, "SKILL.md");
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(skillPath, template.replaceAll("{{SOURCE_ARG}}", shellQuote(agentName)), "utf8");
  return { skillPath, memorySource: agentName };
}

export function selectTurns(
  turns: readonly AgentSourceTurn[],
  mode: "initial_subset" | "incremental",
  syncBoundaryAt: string | null
): AgentSourceTurn[] {
  const recentFirst = [...turns].sort((left, right) =>
    Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
    turnKey(left).localeCompare(turnKey(right))
  );
  if (mode === "initial_subset") {
    return recentFirst.slice(0, INITIAL_MEMORY_LIMIT);
  }
  if (!syncBoundaryAt) {
    throw new Error("Incremental sync requires the recorded initial sync boundary");
  }
  const boundary = Date.parse(syncBoundaryAt);
  return recentFirst.filter((turn) => Date.parse(turn.createdAt) > boundary);
}

export function resolveSyncBoundaryAt(
  mode: "initial_subset" | "incremental",
  selectedTurns: readonly AgentSourceTurn[],
  existingBoundary: string | null
): string | null {
  if (mode === "initial_subset" && selectedTurns.length === 0) {
    throw new Error(
      "Initial scan found no complete user/assistant turns, so no sync boundary was recorded. Recheck the active conversation surface and history store, then retry after a completed turn exists."
    );
  }
  return mode === "initial_subset" ? selectedTurns.at(-1)!.createdAt : existingBoundary;
}

export function buildCompleteTurns(messages: readonly AgentSourceMessage[]): AgentSourceTurn[] {
  const byConversation = new Map<string, AgentSourceMessage[]>();
  for (const message of messages) {
    const conversation = byConversation.get(message.conversationId) ?? [];
    conversation.push(message);
    byConversation.set(message.conversationId, conversation);
  }

  const turns: AgentSourceTurn[] = [];
  for (const conversation of byConversation.values()) {
    let current: AgentSourceMessage[] = [];
    for (const message of sortMessages(conversation)) {
      if (message.role === "user") {
        appendCompleteTurn(current, turns);
        current = [message];
      } else if (current.length > 0) {
        current.push(message);
      }
    }
    appendCompleteTurn(current, turns);
  }
  return turns;
}

function appendCompleteTurn(messages: readonly AgentSourceMessage[], turns: AgentSourceTurn[]): void {
  const user = messages.find((message) => message.role === "user");
  if (!user || !messages.some((message) => message.role === "assistant")) return;
  turns.push({ createdAt: user.createdAt, messages: [...messages] });
}

function sortMessages(messages: readonly AgentSourceMessage[]): AgentSourceMessage[] {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((left, right) =>
      Date.parse(left.message.createdAt) - Date.parse(right.message.createdAt) ||
      left.index - right.index
    )
    .map((entry) => entry.message);
}

function turnKey(turn: AgentSourceTurn): string {
  const first = turn.messages[0];
  return `${first?.conversationId ?? ""}:${first?.messageId ?? ""}`;
}

function resolveManifestPath(workspace: string, requested: string): string {
  const target = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(workspace, requested);
  const stat = fs.statSync(target);
  if (!stat.isFile()) throw new Error(`Manifest is not a file: ${target}`);
  if (stat.size > MAX_MANIFEST_BYTES) throw new Error("Agent history manifest exceeds 100 MB");
  return target;
}

function readManifest(filePath: string): AgentSourceMessage[] {
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return [];
  const values = raw.startsWith("[")
    ? parseJsonArray(raw)
    : raw.split(/\r?\n/u).filter(Boolean).map((line, index) => parseJsonLine(line, index + 1));
  return values.map((value, index) => parseMessage(value, index + 1));
}

function parseJsonArray(raw: string): unknown[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Agent history manifest JSON must be an array");
  return parsed;
}

function parseJsonLine(line: string, lineNumber: number): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSONL at line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseMessage(value: unknown, index: number): AgentSourceMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Manifest item ${index} must be an object`);
  }
  const item = value as Record<string, unknown>;
  const role = requiredString(item.role, `item ${index} role`);
  if (role !== "user" && role !== "assistant" && role !== "tool" && role !== "system") {
    throw new Error(`Manifest item ${index} has an unsupported role`);
  }
  const createdAt = requiredString(item.createdAt, `item ${index} createdAt`);
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new Error(`Manifest item ${index} createdAt must be an ISO timestamp`);
  }
  const rawMeta = item.rawMeta;
  if (rawMeta !== undefined && (!rawMeta || typeof rawMeta !== "object" || Array.isArray(rawMeta))) {
    throw new Error(`Manifest item ${index} rawMeta must be an object`);
  }
  return {
    messageId: requiredString(item.messageId, `item ${index} messageId`),
    conversationId: requiredString(item.conversationId, `item ${index} conversationId`),
    role,
    content: requiredString(item.content, `item ${index} content`),
    createdAt: new Date(createdAt).toISOString(),
    workspacePath: nullableString(item.workspacePath),
    gitRoot: nullableString(item.gitRoot),
    rawMeta: rawMeta as Record<string, unknown> | undefined
  };
}

async function readAgentSource(runtime: RuntimeConfig, sourceId: string): Promise<AgentSourceView> {
  const sources = await localApiRequest<AgentSourceView[]>(runtime, "GET", "/api/agent-sources");
  const source = sources.find((candidate) => candidate.sourceId === sourceId);
  if (!source) throw new Error(`Unknown Agent source: ${sourceId}`);
  return source;
}

async function importBatch(
  runtime: RuntimeConfig,
  sourceId: string,
  input: {
    mode: "initial_subset" | "incremental";
    messages: AgentSourceMessage[];
    dataPath?: string;
    syncBoundaryAt: string | null;
    latestSeenAt: string | null;
    final: boolean;
  }
): Promise<ImportResult> {
  return localApiRequest<ImportResult>(
    runtime,
    "POST",
    `/api/agent-sources/${encodeURIComponent(sourceId)}/managed/import`,
    {
      mode: input.mode,
      messages: input.messages,
      ...(input.dataPath ? { dataPath: input.dataPath } : {}),
      syncBoundaryAt: input.syncBoundaryAt,
      latestSeenAt: input.latestSeenAt,
      final: input.final
    }
  );
}

async function localApiRequest<T>(
  runtime: RuntimeConfig,
  method: "GET" | "POST" | "PATCH",
  route: string,
  body?: unknown
): Promise<T> {
  const response = await fetch(new URL(route, runtime.baseUrl), {
    method,
    headers: {
      accept: "application/json",
      "x-memmy-local-token": runtime.localToken,
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(600_000)
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) as unknown : null;
  if (!response.ok) {
    const error = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as { error?: { message?: unknown } }).error?.message
      : undefined;
    throw new Error(typeof error === "string" ? error : `${method} ${route} failed with ${response.status}`);
  }
  return parsed as T;
}

function readRuntimeConfig(): RuntimeConfig {
  const memmyHome = process.env.MEMMY_HOME?.trim()
    ? path.resolve(process.env.MEMMY_HOME)
    : path.join(os.homedir(), ".memmy");
  const configPath = path.join(memmyHome, "runtime.json");
  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
  return {
    baseUrl: requiredString(parsed.baseUrl, "runtime baseUrl"),
    localToken: requiredString(parsed.localToken, "runtime localToken")
  };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nullableString(value: unknown): string | null | undefined {
  return value === null ? null : optionalString(value);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function latestMessageTimestamp(turns: readonly AgentSourceTurn[]): string | null {
  return turns
    .flatMap((turn) => turn.messages)
    .reduce<string | null>((latest, message) => {
      if (!latest || Date.parse(message.createdAt) > Date.parse(latest)) return message.createdAt;
      return latest;
    }, null);
}

function sum(results: readonly ImportResult[], key: "attempted" | "written" | "deduped" | "failed"): number {
  return results.reduce((total, result) => total + result[key], 0);
}
