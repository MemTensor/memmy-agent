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
  }) => {
    root: string;
    db: MemoryDb;
    service: MemoryService;
  };
} {
  const roots: string[] = [];

  function createTestRoot(prefix = "mindock-memory-"): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    roots.push(root);
    return root;
  }

  function createTestMemoryService(
    options: ConstructorParameters<typeof MemoryService>[0]
  ): MemoryService {
    return new MemoryService({
      ...options,
      embedder: options.embedder ?? createCapturingEmbedder([])
    });
  }

  function createTestService(options: {
    mode?: "local" | "cloud" | "dev";
    config?: typeof DEFAULT_MEMMY_CONFIG;
    llm?: LlmClient;
    skillLlm?: LlmClient;
    embedder?: Embedder;
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
        llm: options.llm,
        skillLlm: options.skillLlm,
        embedder: options.embedder ?? createCapturingEmbedder([])
      })
    };
  }

  function cleanup(): void {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
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

export function accountRuntimeConfig(): typeof DEFAULT_MEMMY_CONFIG {
  const endpoint = "https://apigw-pre.memtensor.cn/api/agentExternal/v1";
  const apiKey = "cloud-uuid";
  return {
    ...DEFAULT_MEMMY_CONFIG,
    activeProfile: "account",
    summary: {
      ...DEFAULT_MEMMY_CONFIG.summary,
      provider: "openai_compatible",
      endpoint,
      model: "memory_summary",
      apiKey
    },
    evolution: {
      ...DEFAULT_MEMMY_CONFIG.evolution,
      provider: "openai_compatible",
      endpoint,
      model: "memory_evolution",
      apiKey
    },
    embedding: {
      ...DEFAULT_MEMMY_CONFIG.embedding,
      provider: "openai_compatible",
      endpoint,
      model: "embedding",
      apiKey
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
    async complete() {
      return "unused";
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
        return {
          summary: captureSummary
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
