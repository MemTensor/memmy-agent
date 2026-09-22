import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MEMMY_CONFIG,
  MemoryDb,
  MemoryService,
  type Embedder,
  type LlmClient
} from "../../src/index.js";
import type { ActualModelContext } from "../../src/contracts/index.js";

export function createMemoryServiceFixture(): {
  cleanup: () => void;
  createTestMemoryService: (
    options: ConstructorParameters<typeof MemoryService>[0]
  ) => MemoryService;
  createTestRoot: (prefix?: string) => string;
  createTestService: (options?: {
    mode?: "local" | "cloud" | "dev";
    config?: typeof DEFAULT_MEMMY_CONFIG;
    llm?: LlmClient;
    skillLlm?: LlmClient;
    embedder?: Embedder;
    fetchAppMemoryBudget?: ConstructorParameters<typeof MemoryService>[0]["fetchAppMemoryBudget"];
    configLoader?: ConstructorParameters<typeof MemoryService>[0]["configLoader"];
  }) => {
    root: string;
    db: MemoryDb;
    service: MemoryService;
  };
} {
  const roots: string[] = [];
  const databases: MemoryDb[] = [];
  const services: MemoryService[] = [];

  function createTestRoot(prefix = "mindock-memory-"): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    roots.push(root);
    return root;
  }

  function createTestMemoryService(
    options: ConstructorParameters<typeof MemoryService>[0]
  ): MemoryService {
    if (options.db) {
      databases.push(options.db);
    }
    const service = new MemoryService({
      ...options,
      fetchAppMemoryBudget: options.fetchAppMemoryBudget ?? (async () => null),
      skillLlm: options.skillLlm ?? options.llm,
      embedder: options.embedder ?? createCapturingEmbedder([])
    });
    services.push(service);
    return service;
  }

  function createTestService(options: {
    mode?: "local" | "cloud" | "dev";
    config?: typeof DEFAULT_MEMMY_CONFIG;
    llm?: LlmClient;
    skillLlm?: LlmClient;
    embedder?: Embedder;
    fetchAppMemoryBudget?: ConstructorParameters<typeof MemoryService>[0]["fetchAppMemoryBudget"];
    configLoader?: ConstructorParameters<typeof MemoryService>[0]["configLoader"];
  } = {}): {
    root: string;
    db: MemoryDb;
    service: MemoryService;
  } {
    const root = createTestRoot();
    const db = new MemoryDb({
      path: join(root, "memory.sqlite")
    });
    return {
      root,
      db,
      service: createTestMemoryService({
        db,
        mode: options.mode ?? "dev",
        config: options.config,
        configLoader: options.configLoader,
        fetchAppMemoryBudget: options.fetchAppMemoryBudget,
        llm: options.llm,
        skillLlm: options.skillLlm,
        embedder: options.embedder ?? createCapturingEmbedder([])
      })
    };
  }

  function cleanup(): void {
    for (const service of services.splice(0)) {
      void service.stop();
    }
    for (const database of databases.splice(0)) {
      if (database.db.open) {
        database.close();
      }
    }
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }

  return {
    cleanup,
    createTestMemoryService,
    createTestRoot,
    createTestService
  };
}

export async function runWorkerRounds(
  service: MemoryService,
  rounds: number,
  limit = 100
): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await service.runWorkerOnce(limit);
  }
}

export function addAgentSourceImport(
  service: MemoryService,
  namespace: { source: string; profileId: string; userId: string },
  userText: string,
  requestId: string,
  createdAt?: string
): ReturnType<MemoryService["addMemory"]> {
  return service.addMemory({
    namespace,
    adapterId: "agent-source:codex",
    requestId,
    layer: "L1",
    source: "codex",
    tags: ["agent-source", "codex"],
    title: `codex turn ${requestId}`,
    turnId: `codex:${requestId}:0`,
    content: [
      `## user\n\n${userText}`,
      `## assistant\n\nack ${userText}`
    ].join("\n\n"),
    createdAt
  });
}

export function configWithMemoryGates(gates: {
  enableMemoryAdd?: boolean;
  enableMemorySearch?: boolean;
  enableQueryRewrite?: boolean;
}): typeof DEFAULT_MEMMY_CONFIG {
  return {
    ...DEFAULT_MEMMY_CONFIG,
    algorithm: {
      ...DEFAULT_MEMMY_CONFIG.algorithm,
      ...gates
    }
  };
}

function testModelContext(
  source: "account" | "byok",
  capability: "memory_summary" | "memory_evolution" | "embedding"
): ActualModelContext {
  return {
    presetId: `${source}-${capability}`,
    provider: source === "account" ? "memmy_account" : "openai",
    endpointId: "endpoint-test",
    protocol: "openai-chat-completions",
    model: capability,
    source,
    ownerAccountId: source === "account" ? "acct-test" : null,
    capability,
    capabilities: [capability]
  };
}

export function accountRuntimeConfig(): typeof DEFAULT_MEMMY_CONFIG {
  const endpoint = "https://apigw-pre.memtensor.cn/api/agentExternal/v1";
  const apiKey = "cloud-uuid";
  return {
    ...DEFAULT_MEMMY_CONFIG,
    roleRouting: {
      summary: "follow",
      evolution: "follow"
    },
    summary: {
      ...DEFAULT_MEMMY_CONFIG.summary,
      provider: "openai_compatible",
      sourceProvider: "memmy_account",
      endpoint,
      model: "memory_summary",
      apiKey,
      actualModelContext: testModelContext("account", "memory_summary")
    },
    evolution: {
      ...DEFAULT_MEMMY_CONFIG.evolution,
      provider: "openai_compatible",
      sourceProvider: "memmy_account",
      endpoint,
      model: "memory_evolution",
      apiKey,
      actualModelContext: testModelContext("account", "memory_evolution")
    },
    embedding: {
      ...DEFAULT_MEMMY_CONFIG.embedding,
      mode: "cloud",
      sourceProvider: "memmy_account",
      provider: "openai_compatible",
      endpoint,
      model: "embedding",
      apiKey,
      actualModelContext: testModelContext("account", "embedding")
    }
  };
}

export function byokRuntimeConfig(
  overrides: Partial<typeof DEFAULT_MEMMY_CONFIG> = {}
): typeof DEFAULT_MEMMY_CONFIG {
  const endpoint = "https://api.openai.com/v1";
  const apiKey = "sk-test";
  return {
    ...DEFAULT_MEMMY_CONFIG,
    ...overrides,
    roleRouting: {
      summary: "fixed",
      evolution: "fixed",
      ...overrides.roleRouting
    },
    summary: {
      ...DEFAULT_MEMMY_CONFIG.summary,
      provider: "openai_compatible",
      sourceProvider: "openai",
      endpoint,
      model: "memory_summary",
      apiKey,
      actualModelContext: testModelContext("byok", "memory_summary"),
      ...overrides.summary
    },
    evolution: {
      ...DEFAULT_MEMMY_CONFIG.evolution,
      provider: "openai_compatible",
      sourceProvider: "openai",
      endpoint,
      model: "memory_evolution",
      apiKey,
      actualModelContext: testModelContext("byok", "memory_evolution"),
      ...overrides.evolution
    },
    embedding: {
      ...DEFAULT_MEMMY_CONFIG.embedding,
      mode: "custom",
      sourceProvider: "openai",
      provider: "openai_compatible",
      endpoint,
      model: "embedding",
      apiKey,
      actualModelContext: testModelContext("byok", "embedding"),
      ...overrides.embedding
    },
    tokenBudget: {
      ...DEFAULT_MEMMY_CONFIG.tokenBudget,
      ...overrides.tokenBudget
    }
  };
}

export function countRows(db: MemoryDb, table: string): number {
  const row = db.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

export function setRawTurnActivityAt(
  db: MemoryDb,
  rawTurnId: string,
  at: string
): void {
  db.db.prepare(
    `UPDATE raw_turns
     SET created_at = ?,
         message_payload_json = json_set(
           message_payload_json,
           '$.turn_complete.completed_at',
           ?
         )
     WHERE id = ?`
  ).run(at, at, rawTurnId);
  db.db.prepare(
    `UPDATE episodes
     SET updated_at = ?
     WHERE id = (
       SELECT episode_id
       FROM raw_turns
       WHERE id = ?
     )`
  ).run(at, rawTurnId);
}

export function tableCounts(db: MemoryDb, tables: string[]): Record<string, number> {
  return Object.fromEntries(tables.map((table) => [table, countRows(db, table)]));
}

export function createCapturingEmbedder(
  seenTexts: string[],
  seenRoles?: Array<"query" | "document" | undefined>
): Embedder {
  return {
    config: {
      ...DEFAULT_MEMMY_CONFIG.embedding,
      provider: "local",
      model: "capturing-test-embedding"
    },
    isRemote() {
      return false;
    },
    async embed(texts: string[], role?: "query" | "document") {
      seenTexts.push(...texts);
      seenRoles?.push(...texts.map(() => role));
      return texts.map((_, index) => index === 0 ? [1, 0, 0] : [0, 1, 0]);
    },
    async embedOne(text: string, role?: "query" | "document") {
      seenTexts.push(text);
      seenRoles?.push(role);
      return [1, 0, 0];
    },
    status() {
      return {
        provider: "local",
        model: "capturing-test-embedding",
        configured: true,
        remote: false
      };
    }
  };
}

export function createFailingLlm(): LlmClient {
  return {
    config: {
      ...DEFAULT_MEMMY_CONFIG.summary,
      provider: "host",
      endpoint: "http://127.0.0.1/failing-filter",
      model: "failing-filter"
    },
    isConfigured() {
      return true;
    },
    async complete() {
      throw new Error("llm filter unavailable");
    },
    async completeJson() {
      throw new Error("llm filter unavailable");
    },
    status() {
      return {
        provider: "host",
        model: "failing-filter",
        configured: true,
        remote: true,
        lastError: "llm filter unavailable"
      };
    }
  };
}

export function createBatchReflectionLlm(calls: Array<{
  messages: Array<{ role: string; content: string }>;
  options: { operation: string; thinkingMode?: "inherit" | "enabled" | "disabled" };
}>, captureSummary = "LLM batch summary", model = "reflection-batch"): LlmClient {
  return {
    config: {
      ...DEFAULT_MEMMY_CONFIG.summary,
      provider: "host",
      endpoint: "http://127.0.0.1/reflection-batch",
      model
    },
    isConfigured() {
      return true;
    },
    async complete(_messages, options) {
      // Episode titling runs for every captured turn, and a job that keeps failing
      // would hold the top priority cohort and starve the rest of the queue.
      return options.operation.startsWith("episode_title")
        ? JSON.stringify({ title: "测试任务标题", summary: "测试任务摘要。" })
        : "unused";
    },
    async completeJson<T extends Record<string, unknown>>(
      messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
      options: { operation: string; thinkingMode?: "inherit" | "enabled" | "disabled" }
    ): Promise<T> {
      calls.push({ messages, options });
      if (options.operation === "capture.reflection.batch.v13") {
        const payload = JSON.parse(messages.find((message) => message.role === "user")?.content ?? "{}") as {
          steps?: Array<{ idx: number }>;
        };
        return {
          scores: (payload.steps ?? []).map((step) => ({
            idx: step.idx,
            relevance: step.idx === 0 ? "PIVOTAL" : "RELATED",
            reason: "batch scored"
          }))
        } as unknown as T;
      }
      if (options.operation === "capture.summarize") {
        const decisionCall = messages[0]?.content.includes("Judge L1 and User Memory") === true;
        if (!decisionCall) return { title: "测试捕获标题", summary: captureSummary } as unknown as T;
        const payload = messages.find((message) => message.role === "user")?.content ?? "";
        const userQuote = payload.match(/\bUSER:\s*(.*?)\s+ASSISTANT:/)?.[1]?.trim() ?? "";
        return {
          l1: {
            title: "测试捕获标题",
            summary: captureSummary,
            evidence: [{ quote: userQuote, role: "user", kind: "task_outcome" }]
          },
          user: null
        } as unknown as T;
      }
      return {
        summary: "fallback single reflection",
        reflection: "fallback single reflection",
        alpha: 0.5,
        usable: true,
        tags: []
      } as unknown as T;
    },
    status() {
      return {
        provider: "host",
        model: "reflection-batch",
        configured: true,
        remote: true
      };
    }
  };
}

export function stableTestVector(text: string): number[] {
  return [text.length % 7, text.length % 11, text.length % 13];
}
