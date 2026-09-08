import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_MEMMY_CONFIG,
  MemoryDb,
  MemoryService,
  createLlmClient,
  listenMemoryHttpServer,
  type Embedder
} from "../../Memory/src/index.js";
import {
  createAgentSourceExecutor,
  type AgentSourceExecutor
} from "../../Memory/src/agent-source/runtime.js";
import { createClaudeCodeSourceAdapter } from "../../Memory/src/agent-source/adapters/claude-code/index.js";
import { createCodexSourceAdapter } from "../../Memory/src/agent-source/adapters/codex/index.js";
import { createCursorSourceAdapter } from "../../Memory/src/agent-source/adapters/cursor/index.js";
import { createSourceRegistry } from "../../Memory/src/agent-source/adapters/source-registry.js";
import type { SourceAdapter } from "../../Memory/src/agent-source/adapters/types.js";
import { createSkillTargetRegistry } from "../../Memory/src/agent-source/integration/target-registry.js";
import { RequestContext } from "../../App/memmy-agent/dist/core/agent-runtime/tools/context.js";
import { ToolRegistry } from "../../App/memmy-agent/dist/core/agent-runtime/tools/registry.js";
import { MemmyMemoryClient } from "../../App/memmy-agent/dist/memmy-memory/client.js";
import { registerMemmyMemoryTools } from "../../App/memmy-agent/dist/memmy-memory/tools.js";
import type { MemmyMemoryToolRuntime } from "../../App/memmy-agent/dist/memmy-memory/types.js";

const MEMORY_TOKEN = "local-agent-memory-smoke-token";
const DEFAULT_SOURCE_IDS = ["codex", "cursor", "claude_code"] as const;
const SOURCE_ID_SET = new Set<string>(DEFAULT_SOURCE_IDS);
const SHARED_RECALL_QUERY = "Memmy local-Agent smoke release checklist";
const CURSOR_SECRET = "smoke-secret-token-cursor-12345";
const CODEX_SECRET = `sk-proj-${"a".repeat(64)}`;
const CLAUDE_SECRET = `sk-ant-api03-${"b".repeat(64)}`;

export type LocalAgentSourceId = typeof DEFAULT_SOURCE_IDS[number];

interface SyntheticSourceFixture {
  sourceId: LocalAgentSourceId;
  adapter: SourceAdapter;
  rawSecret: string;
  redactionMarker: string;
  expectedAssistantText: string;
}

export interface LocalAgentMemorySmokeResult {
  sources: LocalAgentSourceId[];
  scannedMessages: number;
  memoryId: string;
  memoryIds: string[];
  recallHitCount: number;
  panelItemCount: number;
}

export async function runLocalAgentMemorySmoke(
  requestedSourceIds: readonly string[] = DEFAULT_SOURCE_IDS
): Promise<LocalAgentMemorySmokeResult> {
  const sourceIds = validateSourceIds(requestedSourceIds);
  const root = mkdtempSync(join(tmpdir(), "memmy-local-agent-smoke-"));
  let db: MemoryDb | undefined;
  let executor: AgentSourceExecutor | undefined;
  let server: Awaited<ReturnType<typeof listenMemoryHttpServer>> | undefined;
  let client: MemmyMemoryClient | undefined;
  let memorySessionId: string | undefined;
  let sessionClosed = false;
  let primaryError: unknown;

  try {
    const fixtures = sourceIds.map((sourceId) => createSourceFixture(root, sourceId));
    const memoryDbPath = join(root, "memory.sqlite");
    const configPath = join(root, "config.yaml");
    const statePath = join(root, "agent-sources.json");
    const config: typeof DEFAULT_MEMMY_CONFIG = {
      ...DEFAULT_MEMMY_CONFIG,
      storage: {
        ...DEFAULT_MEMMY_CONFIG.storage,
        sqlitePath: memoryDbPath
      },
      agentAccess: {
        autoScanKnownAgents: false,
        watchFileChanges: false,
        autoInjectSkill: false
      }
    };
    writeFileSync(
      configPath,
      [
        "memmyMemory:",
        "  version: 1",
        "  agentAccess:",
        "    autoScanKnownAgents: false",
        "    watchFileChanges: false",
        "    autoInjectSkill: false",
        ""
      ].join("\n"),
      "utf8"
    );

    db = new MemoryDb({ path: memoryDbPath });
    const llm = createLlmClient(config.summary);
    const service = new MemoryService({
      db,
      mode: "dev",
      config,
      llm,
      skillLlm: llm,
      embedder: createSmokeEmbedder()
    });
    executor = createAgentSourceExecutor({
      service,
      configPath,
      statePath,
      sourceRegistry: createSourceRegistry(fixtures.map((fixture) => fixture.adapter)),
      integrationRegistry: createSkillTargetRegistry([]),
      resolveAgentSkillRoot: () => null
    });

    await assertSourcesAvailable(executor, sourceIds, 0);
    await runScanAndWait(executor, scanSourceId(sourceIds));
    const scannedMessages = await assertSourcesAvailable(executor, sourceIds, 2);
    const memoryIdsBySource = readImportedMemoryIds(service, fixtures);
    const memoryIds = sourceIds.map((sourceId) => requireMapValue(memoryIdsBySource, sourceId));
    assertImportedDetails(service, fixtures, memoryIdsBySource);
    await drainImportedMemoryWorkers(service, memoryIds);

    const firstState = readExecutorState(statePath, sourceIds);
    await runScanAndWait(executor, scanSourceId(sourceIds));
    await assertSourcesAvailable(executor, sourceIds, 2);
    const dedupedMemoryIds = readImportedMemoryIds(service, fixtures);
    for (const sourceId of sourceIds) {
      assert(
        requireMapValue(dedupedMemoryIds, sourceId) === requireMapValue(memoryIdsBySource, sourceId),
        `${sourceId} duplicate scan must preserve the original imported memory id`
      );
    }
    assertExecutorStateDeduplicated(statePath, sourceIds, firstState);

    server = await listenMemoryHttpServer({
      service,
      agentSourceExecutor: executor,
      host: "127.0.0.1",
      port: 0,
      apiKey: MEMORY_TOKEN,
      configPath,
      workerStartupFallbackMs: 60_000,
      workerPostHealthDelayMs: 60_000,
      startAgentSourceAutomation: false
    });
    client = new MemmyMemoryClient({
      baseUrl: server.url,
      token: MEMORY_TOKEN,
      timeoutMs: 20_000,
      timeZone: "UTC"
    });
    const health = await client.health();
    assert(health.ok, "Memory HTTP health must be ready for the local-Agent smoke");

    const opened = await client.openSession({
      requestId: "local-agent-smoke-open",
      adapterId: "memmy-agent",
      source: "memmy-agent",
      sessionId: "memmy-agent::cli:local-agent-smoke"
    });
    memorySessionId = readRequiredString(opened, "sessionId", "session.open");

    const directSearch = await client.search({
      requestId: "local-agent-smoke-search",
      adapterId: "memmy-agent",
      source: "memmy-agent",
      sessionId: memorySessionId,
      query: SHARED_RECALL_QUERY,
      layers: ["L1"],
      verbose: true
    });
    const directHits = readVerboseSearchHits(directSearch);
    for (const memoryId of memoryIds) {
      assert(
        directHits.some((hit) => hit.id === memoryId),
        `Agent client search must recall imported memory ${memoryId}`
      );
    }

    let panelItemCount = 0;
    for (const fixture of fixtures) {
      const memoryId = requireMapValue(memoryIdsBySource, fixture.sourceId);
      const detail = await client.getMemory(memoryId);
      assertSerializedDetailIsRedacted(detail, fixture);
      const panel = await client.get("/api/v1/panel/items", {
        layer: "L1",
        sourceAgent: fixture.sourceId,
        page: 1
      });
      const panelItems = readObjectArray(panel, "items", `${fixture.sourceId} panel`);
      assert(
        panelItems.some((item) => item.id === memoryId),
        `${fixture.sourceId} memory must be visible through the HTTP panel contract`
      );
      panelItemCount += panelItems.length;
    }

    const registry = new ToolRegistry();
    const runtime = createToolRuntime(memorySessionId);
    registerMemmyMemoryTools(registry, client, runtime);
    assert(
      [...registry.toolNames].sort().join(",") === "memmy_memory_get,memmy_memory_search",
      "Agent memory registry must expose exactly search and get"
    );
    const requestContext = new RequestContext({ sessionKey: "cli:local-agent-smoke" });
    setToolContext(registry, "memmy_memory_search", requestContext);
    setToolContext(registry, "memmy_memory_get", requestContext);

    const toolSearch = await registry.execute("memmy_memory_search", {
      query: SHARED_RECALL_QUERY,
      layers: ["L1"]
    });
    assert(
      typeof toolSearch === "string" && toolSearch.includes('<memmy_memory_context source="tool_search">'),
      "Agent search tool must wrap the real HTTP result in a Memmy context packet"
    );
    assert(!toolSearch.includes("No relevant Memmy memories found."), "Agent search tool must expose imported memories");
    assertNoRawSecrets(toolSearch, fixtures, "Agent search tool result");

    const firstMemoryId = memoryIds[0];
    assert(firstMemoryId, "At least one imported memory id is required");
    const toolGet = await registry.execute("memmy_memory_get", { id: firstMemoryId });
    assert(
      typeof toolGet === "string" && toolGet.includes('<memmy_memory_context source="tool_get">'),
      "Agent get tool must wrap the real HTTP result in a Memmy context packet"
    );
    assert(toolGet.includes(`id: ${firstMemoryId}`), "Agent get tool must identify the requested memory");
    assertNoRawSecrets(toolGet, fixtures, "Agent get tool result");

    const closed = await client.closeSession(memorySessionId, {
      requestId: "local-agent-smoke-close",
      adapterId: "memmy-agent",
      source: "memmy-agent"
    });
    assert(closed.ok === true && closed.status === "closed", "Agent client must close its smoke session");
    assert(Array.isArray(closed.closedEpisodeIds), "Session close must preserve the current response contract");
    sessionClosed = true;

    return {
      sources: [...sourceIds],
      scannedMessages,
      memoryId: firstMemoryId,
      memoryIds,
      recallHitCount: directHits.length,
      panelItemCount
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    if (client && memorySessionId && !sessionClosed) {
      try {
        await client.closeSession(memorySessionId, {
          requestId: "local-agent-smoke-cleanup-close",
          adapterId: "memmy-agent",
          source: "memmy-agent"
        });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (server) {
      try {
        await closeHttpServer(server.server);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      executor?.dispose();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (db?.db.open) db.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      if (primaryError === undefined) {
        throw new AggregateError(cleanupErrors, "Local-Agent smoke cleanup failed");
      }
      console.error(`Local-Agent smoke cleanup also failed: ${cleanupErrors.map(errorMessage).join("; ")}`);
    }
  }
}

export function parseSourceIds(args: readonly string[]): LocalAgentSourceId[] {
  let rawValue: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--sources" || argument === "--source") {
      assert(rawValue === undefined, "Only one --sources/--source option is allowed");
      const value = args[index + 1];
      assert(value !== undefined && !value.startsWith("--"), `${argument} requires a value`);
      rawValue = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--sources=") || argument.startsWith("--source=")) {
      assert(rawValue === undefined, "Only one --sources/--source option is allowed");
      rawValue = argument.slice(argument.indexOf("=") + 1);
      continue;
    }
    throw new Error(`Unknown local-Agent smoke argument: ${argument}`);
  }
  if (rawValue === undefined) return [...DEFAULT_SOURCE_IDS];
  return validateSourceIds(rawValue.split(",").map((value) => value.trim()));
}

function validateSourceIds(values: readonly string[]): LocalAgentSourceId[] {
  assert(values.length > 0, "At least one local-Agent source is required");
  const sourceIds: LocalAgentSourceId[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    assert(value.length > 0, "Local-Agent source ids must not be empty");
    assert(SOURCE_ID_SET.has(value), `Unsupported local-Agent source: ${value}`);
    assert(!seen.has(value), `Duplicate local-Agent source: ${value}`);
    seen.add(value);
    sourceIds.push(value as LocalAgentSourceId);
  }
  return sourceIds;
}

function createSourceFixture(root: string, sourceId: LocalAgentSourceId): SyntheticSourceFixture {
  if (sourceId === "cursor") return createCursorFixture(root);
  if (sourceId === "codex") return createCodexFixture(root);
  return createClaudeCodeFixture(root);
}

function createCursorFixture(root: string): SyntheticSourceFixture {
  const workspaceRoot = join(root, "fixtures", "cursor", "workspace");
  const storageRoot = join(root, "fixtures", "cursor", "User", "workspaceStorage");
  const storagePath = join(storageRoot, "smoke-workspace");
  mkdirSync(join(workspaceRoot, ".git"), { recursive: true });
  mkdirSync(storagePath, { recursive: true });
  writeFileSync(
    join(storagePath, "workspace.json"),
    `${JSON.stringify({ folder: pathToFileURL(workspaceRoot).href })}\n`,
    "utf8"
  );
  const stateDb = new Database(join(storagePath, "state.vscdb"));
  try {
    stateDb.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    stateDb.prepare("INSERT INTO ItemTable(key, value) VALUES (?, ?)").run(
      "composerData:cursor-smoke-conversation",
      JSON.stringify({
        conversationId: "cursor-smoke-conversation",
        messages: [
          {
            id: "cursor-smoke-user",
            role: "user",
            content: `${SHARED_RECALL_QUERY} for Cursor. Authorization: Bearer ${CURSOR_SECRET}`,
            createdAt: "2026-09-01T00:00:00.000Z"
          },
          {
            id: "cursor-smoke-assistant",
            role: "assistant",
            content: "Cursor smoke assistant confirms the isolated release checklist.",
            createdAt: "2026-09-01T00:00:01.000Z"
          }
        ]
      })
    );
  } finally {
    stateDb.close();
  }
  return {
    sourceId: "cursor",
    adapter: createCursorSourceAdapter({ storageRoot }),
    rawSecret: CURSOR_SECRET,
    redactionMarker: "[REDACTED:authorization_bearer]",
    expectedAssistantText: "Cursor smoke assistant confirms the isolated release checklist."
  };
}

function createCodexFixture(root: string): SyntheticSourceFixture {
  const fixtureRoot = join(root, "fixtures", "codex");
  const sessionsRoot = join(fixtureRoot, "sessions");
  const workspaceRoot = join(fixtureRoot, "workspace");
  const rolloutDirectory = join(sessionsRoot, "2026", "09", "01");
  const rolloutPath = join(
    rolloutDirectory,
    "rollout-2026-09-01T00-00-00-019e72be-500b-7f02-9400-112c5a194e5c.jsonl"
  );
  mkdirSync(join(workspaceRoot, ".git"), { recursive: true });
  mkdirSync(rolloutDirectory, { recursive: true });
  writeFileSync(
    rolloutPath,
    [
      JSON.stringify({
        timestamp: "2026-09-01T00:01:00.000Z",
        type: "session_meta",
        payload: { cwd: workspaceRoot }
      }),
      JSON.stringify({
        timestamp: "2026-09-01T00:01:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: `${SHARED_RECALL_QUERY} for Codex. OPENAI_API_KEY=${CODEX_SECRET}` }]
        }
      }),
      JSON.stringify({
        timestamp: "2026-09-01T00:01:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Codex smoke assistant confirms the isolated release checklist." }]
        }
      })
    ].join("\n"),
    "utf8"
  );
  return {
    sourceId: "codex",
    adapter: createCodexSourceAdapter({ sessionsRoot }),
    rawSecret: CODEX_SECRET,
    redactionMarker: "[REDACTED:openai_api_key]",
    expectedAssistantText: "Codex smoke assistant confirms the isolated release checklist."
  };
}

function createClaudeCodeFixture(root: string): SyntheticSourceFixture {
  const fixtureRoot = join(root, "fixtures", "claude-code");
  const projectsRoot = join(fixtureRoot, "projects");
  const workspaceRoot = join(fixtureRoot, "workspace");
  const projectDirectory = join(projectsRoot, "-smoke-workspace");
  const transcriptPath = join(projectDirectory, "claude-smoke-session.jsonl");
  mkdirSync(join(workspaceRoot, ".git"), { recursive: true });
  mkdirSync(projectDirectory, { recursive: true });
  writeFileSync(
    transcriptPath,
    [
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: `${SHARED_RECALL_QUERY} for Claude Code. ANTHROPIC_API_KEY=${CLAUDE_SECRET}`
        },
        uuid: "claude-smoke-user",
        timestamp: "2026-09-01T00:02:00.000Z",
        sessionId: "claude-smoke-session",
        cwd: workspaceRoot
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Claude Code smoke assistant confirms the isolated release checklist." }]
        },
        uuid: "claude-smoke-assistant",
        timestamp: "2026-09-01T00:02:01.000Z",
        sessionId: "claude-smoke-session",
        cwd: workspaceRoot
      })
    ].join("\n"),
    "utf8"
  );
  return {
    sourceId: "claude_code",
    adapter: createClaudeCodeSourceAdapter({ projectsRoot }),
    rawSecret: CLAUDE_SECRET,
    redactionMarker: "[REDACTED:anthropic_api_key]",
    expectedAssistantText: "Claude Code smoke assistant confirms the isolated release checklist."
  };
}

async function assertSourcesAvailable(
  executor: AgentSourceExecutor,
  sourceIds: readonly LocalAgentSourceId[],
  expectedMessageCount: number
): Promise<number> {
  const listed = await executor.list();
  assert(listed.sources.length === sourceIds.length, "Executor must expose only the selected synthetic sources");
  let total = 0;
  for (const sourceId of sourceIds) {
    const source = listed.sources.find((item) => item.sourceId === sourceId);
    assert(source, `Executor must expose synthetic source ${sourceId}`);
    assert(source.available, `Synthetic source ${sourceId} must be detected`);
    assert(source.messageCount === expectedMessageCount, `${sourceId} must report ${expectedMessageCount} imported messages`);
    if (expectedMessageCount > 0) {
      assert(typeof source.lastScannedAt === "string" && source.lastScannedAt.length > 0, `${sourceId} must persist lastScannedAt`);
    }
    total += source.messageCount;
  }
  return total;
}

async function runScanAndWait(executor: AgentSourceExecutor, sourceId: string): Promise<void> {
  const started = await executor.startScan({ sourceId, mode: "full" });
  assert(started.accepted && started.jobId.length > 0, "Executor must accept the synthetic source scan");
  const deadline = Date.now() + 10_000;
  for (;;) {
    const status = executor.scanStatus();
    if (!status.running) {
      assert(!status.error, `Agent source scan failed: ${status.error ?? "unknown error"}`);
      assert(status.jobId === started.jobId, "Executor must finish the accepted scan job");
      assert(status.completedAt, "Executor scan must record completedAt");
      assert(status.progress?.phase === "done", "Executor scan must finish in the done phase");
      return;
    }
    if (Date.now() >= deadline) {
      await executor.cancelScan();
      throw new Error(`Agent source scan timed out: ${sourceId}`);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
}

function readImportedMemoryIds(
  service: MemoryService,
  fixtures: readonly SyntheticSourceFixture[]
): Map<LocalAgentSourceId, string> {
  const result = new Map<LocalAgentSourceId, string>();
  for (const fixture of fixtures) {
    const panel = service.panelItems({
      layer: "L1",
      status: "activated",
      tags: ["agent-source", fixture.sourceId],
      sourceAgent: fixture.sourceId,
      limit: 10
    });
    assert(panel.total === 1 && panel.items.length === 1, `${fixture.sourceId} scan must import exactly one L1 memory`);
    const item = panel.items[0];
    assert(item, `${fixture.sourceId} panel item must exist`);
    assert(item.metadata?.source === fixture.sourceId, `${fixture.sourceId} panel metadata must retain source attribution`);
    result.set(fixture.sourceId, item.id);
  }
  return result;
}

function assertImportedDetails(
  service: MemoryService,
  fixtures: readonly SyntheticSourceFixture[],
  memoryIdsBySource: ReadonlyMap<LocalAgentSourceId, string>
): void {
  for (const fixture of fixtures) {
    const detail = service.getMemory(requireMapValue(memoryIdsBySource, fixture.sourceId));
    assertSerializedDetailIsRedacted(detail, fixture);
  }
}

function assertSerializedDetailIsRedacted(detail: unknown, fixture: SyntheticSourceFixture): void {
  const serialized = JSON.stringify(detail);
  assert(serialized.includes(fixture.redactionMarker), `${fixture.sourceId} detail must retain the redaction marker`);
  assert(serialized.includes(fixture.expectedAssistantText), `${fixture.sourceId} detail must retain assistant text`);
  assert(!serialized.includes(fixture.rawSecret), `${fixture.sourceId} detail must not expose the raw synthetic secret`);
}

async function drainImportedMemoryWorkers(service: MemoryService, memoryIds: readonly string[]): Promise<void> {
  for (let cycle = 0; cycle < 12; cycle += 1) {
    const states = service.memoryProcessingStatus(memoryIds).items;
    const failed = states.find((item) => item.state === "failed");
    assert(
      !failed,
      `Imported memory processing failed for ${failed?.memoryId ?? "unknown"}: ${failed?.errorCode ?? "unknown"} ${failed?.errorMessage ?? ""}`
    );
    if (
      states.length === memoryIds.length &&
      states.every((item) => item.state === "ready" || item.state === "ready_text_only")
    ) {
      return;
    }
    const worker = await service.runWorkerOnce(20, { targetMemoryIds: [...memoryIds] });
    assert(worker.failed === 0, "Imported memory worker jobs must not fail");
    assert(worker.embeddingRetries.failed === 0, "Imported memory embedding retries must not fail");
  }
  const states = service.memoryProcessingStatus(memoryIds).items;
  throw new Error(`Imported memories did not reach a ready state: ${JSON.stringify(states)}`);
}

interface ExecutorSourceStateSnapshot {
  messageCount: number;
  latestSeenAt: string | null;
  contentHash: string | null;
}

export function readExecutorState(
  statePath: string,
  sourceIds: readonly LocalAgentSourceId[]
): Map<LocalAgentSourceId, ExecutorSourceStateSnapshot> {
  const parsed = assertRecord(JSON.parse(readFileSync(statePath, "utf8")), "executor state");
  assert(parsed.version === 2, "executor state.version must be 2");
  const sources = assertRecord(parsed.sources, "executor state.sources");
  const result = new Map<LocalAgentSourceId, ExecutorSourceStateSnapshot>();
  for (const sourceId of sourceIds) {
    const source = assertRecord(sources[sourceId], `executor state.sources.${sourceId}`);
    assert(!Object.hasOwn(source, "importedRequestIds"), `${sourceId} must not persist legacy imported request ids`);
    assert(
      typeof source.messageCount === "number" && Number.isInteger(source.messageCount) && source.messageCount >= 0,
      `${sourceId}.messageCount must be a non-negative integer`
    );
    assert(
      typeof source.lastScannedAt === "string" && source.lastScannedAt.length > 0,
      `${sourceId}.lastScannedAt must be a non-empty string`
    );
    assert(
      source.latestSeenAt === null || (typeof source.latestSeenAt === "string" && source.latestSeenAt.length > 0),
      `${sourceId}.latestSeenAt must be null or a non-empty string`
    );
    assert(
      source.contentHash === undefined || (typeof source.contentHash === "string" && source.contentHash.length > 0),
      `${sourceId}.contentHash must be absent or a non-empty string`
    );
    result.set(sourceId, {
      messageCount: source.messageCount,
      latestSeenAt: source.latestSeenAt,
      contentHash: typeof source.contentHash === "string" ? source.contentHash : null
    });
  }
  return result;
}

function assertExecutorStateDeduplicated(
  statePath: string,
  sourceIds: readonly LocalAgentSourceId[],
  firstState: ReadonlyMap<LocalAgentSourceId, ExecutorSourceStateSnapshot>
): void {
  const secondState = readExecutorState(statePath, sourceIds);
  for (const sourceId of sourceIds) {
    const first = requireMapValue(firstState, sourceId);
    const second = requireMapValue(secondState, sourceId);
    assert(
      first.messageCount === second.messageCount &&
        first.latestSeenAt === second.latestSeenAt &&
        first.contentHash === second.contentHash,
      `${sourceId} repeated scan must preserve its persisted source checkpoint`
    );
  }
}

function createToolRuntime(sessionId: string): MemmyMemoryToolRuntime {
  return {
    requestEnvelope: () => ({
      requestId: "local-agent-smoke-tool",
      adapterId: "memmy-agent",
      source: "memmy-agent"
    }),
    currentSessionId: () => sessionId,
    currentEpisodeId: () => null,
    currentTurnId: () => null,
    currentUserText: () => SHARED_RECALL_QUERY
  };
}

function setToolContext(registry: ToolRegistry, name: string, context: RequestContext): void {
  const tool = registry.get(name);
  assert(tool && "setContext" in tool && typeof tool.setContext === "function", `${name} must be context-aware`);
  tool.setContext(context);
}

function readVerboseSearchHits(value: unknown): Array<{ id?: string }> {
  const result = assertRecord(value, "verbose search result");
  const debug = assertRecord(result.debug, "verbose search result.debug");
  return readObjectArray(debug, "hits", "verbose search result.debug");
}

function readObjectArray(value: unknown, field: string, label: string): Array<Record<string, unknown>> {
  const record = assertRecord(value, label);
  const items = record[field];
  assert(Array.isArray(items), `${label}.${field} must be an array`);
  return items.map((item, index) => assertRecord(item, `${label}.${field}[${index}]`));
}

function readRequiredString(value: unknown, field: string, label: string): string {
  const record = assertRecord(value, label);
  const item = record[field];
  assert(typeof item === "string" && item.length > 0, `${label}.${field} must be a non-empty string`);
  return item;
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value as Record<string, unknown>;
}

function assertNoRawSecrets(
  value: string,
  fixtures: readonly SyntheticSourceFixture[],
  label: string
): void {
  for (const fixture of fixtures) {
    assert(!value.includes(fixture.rawSecret), `${label} must not expose the raw ${fixture.sourceId} synthetic secret`);
  }
}

function scanSourceId(sourceIds: readonly LocalAgentSourceId[]): LocalAgentSourceId | "all" {
  return sourceIds.length === 1 ? sourceIds[0]! : "all";
}

function requireMapValue<K, V>(map: ReadonlyMap<K, V>, key: K): V {
  const value = map.get(key);
  assert(value !== undefined, `Missing map value for ${String(key)}`);
  return value;
}

async function closeHttpServer(server: Awaited<ReturnType<typeof listenMemoryHttpServer>>["server"]): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
    server.closeAllConnections?.();
  });
}

function createSmokeEmbedder(): Embedder {
  return {
    config: {
      ...DEFAULT_MEMMY_CONFIG.embedding,
      provider: "local",
      model: "local-agent-smoke-embedding"
    },
    isRemote: () => false,
    async embed(texts: string[]) {
      return texts.map(() => [1, 0, 0]);
    },
    async embedOne() {
      return [1, 0, 0];
    },
    status() {
      return {
        provider: "local",
        model: "local-agent-smoke-embedding",
        configured: true,
        remote: false
      };
    }
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : "";
if (entrypoint === fileURLToPath(import.meta.url)) {
  runLocalAgentMemorySmoke(parseSourceIds(process.argv.slice(2)))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exitCode = 1;
    });
}
