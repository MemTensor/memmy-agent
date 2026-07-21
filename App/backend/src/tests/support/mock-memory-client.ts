/** Mock memory client tests. */
import { randomUUID } from "node:crypto";
import type { MemoryHealthSnapshot, MemoryKind } from "@memmy/local-api-contracts";
import { MemoryLayerError } from "../../adapters/outbound/memory-client/errors.js";
import type { MemoryClient } from "../../adapters/outbound/memory-client/types.js";

export interface CreateMockMemoryClientOptions {
  /** Health. */
  health?: MemoryHealthSnapshot;
  /** Now. */
  now?: () => string;
  /** Failure rate. */
  failureRate?: number;
}

/** Creates create mock memory client. */
export function createMockMemoryClient(options: CreateMockMemoryClientOptions = {}): MemoryClient {
  const bootedAt = Date.now();
  const now = options.now ?? (() => new Date().toISOString());
  const failureRate = options.failureRate ?? 0;
  let changeSeqCounter = 0;

  const nextChange = () => {
    changeSeqCounter += 1;
    return {
      changeSeq: changeSeqCounter,
      syncCursor: `mock-${changeSeqCounter}`
    };
  };

  const failIfNeeded = () => {
    if (Math.random() < failureRate) {
      throw new MemoryLayerError("internal", 500, "mock-induced failure");
    }
  };

  return {
    async health() {
      failIfNeeded();
      return (
        options.health ?? {
          ok: true,
          version: "mock-0.0.0",
          uptimeMs: Math.max(0, Date.now() - bootedAt),
          mode: "dev",
          activeProfile: "byok",
          storage: {
            backend: "sqlite",
            schemaVersion: "mock",
            ready: true
          },
          models: mockModels(),
          capabilities: {
            routes: ["/api/v1/health"],
            tools: [],
            memoryLayers: ["L1", "L2", "L3", "Skill"],
            supportsCli: true
          },
          serverTime: now()
        }
      );
    },

    async reloadConfig() {
      failIfNeeded();
      return {
        activeProfile: "byok",
        changed: true,
        requiresRestart: false,
        models: mockModels(),
        reloadedAt: now()
      };
    },

    async openSession() {
      failIfNeeded();
      return {
        sessionId: randomUUID(),
        status: "open",
        episodeId: randomUUID(),
        resumed: false,
        serverTime: now()
      };
    },

    async closeSession(input) {
      failIfNeeded();
      return {
        ok: true,
        sessionId: input.sessionId,
        status: "closed",
        closedEpisodeIds: [],
        ...nextChange(),
        serverTime: now()
      };
    },

    async startTurn(input) {
      failIfNeeded();
      return {
        turnId: input.turnId ?? randomUUID(),
        contextPacketId: randomUUID(),
        sessionId: input.sessionId,
        episodeId: randomUUID(),
        injectedContext: {
          markdown: "",
          sections: []
        },
        searchEventId: randomUUID(),
        sourceMemoryIds: [],
        hits: [],
        status: [],
        serverTime: now()
      };
    },

    async completeTurn(input) {
      failIfNeeded();
      return {
        turnId: input.turnId,
        sessionId: input.sessionId,
        episodeId: randomUUID(),
        rawTurnId: randomUUID(),
        l1MemoryId: randomUUID(),
        scheduledEvolution: false,
        jobs: [],
        ...nextChange(),
        serverTime: now()
      };
    },

    async search(input) {
      failIfNeeded();
      const injectedContext = {
        markdown: "",
        sections: []
      };
      if (input.verbose !== true) {
        return { injectedContext: injectedContext.markdown };
      }
      return {
        injectedContext: injectedContext.markdown,
        debug: {
          searchEventId: randomUUID(),
          hits: [],
          sourceMemoryIds: [],
          status: [],
          sections: injectedContext.sections,
          serverTime: now()
        }
      };
    },

    async addMemory(input) {
      failIfNeeded();
      const serverTime = now();
      const layer = input.layer ?? "L1";
      return {
        id: randomUUID(),
        kind: kindForLayer(layer),
        memoryLayer: layer,
        status: "activated",
        title: input.title ?? firstLine(input.content),
        summary: firstLine(input.content),
        tags: input.tags ?? [],
        createdAt: input.createdAt ?? serverTime,
        serverTime
      };
    },

    async getMemory(input) {
      failIfNeeded();
      const serverTime = now();
      const kind: MemoryKind = "trace";
      return {
        item: {
          id: input.memoryId,
          kind,
          memoryLayer: memoryLayerForKind(kind),
          status: "activated",
          title: input.memoryId,
          summary: "",
          tags: [],
          createdAt: serverTime,
          updatedAt: serverTime,
          version: 1,
          body: "",
          createdAt: serverTime,
          sourceMemoryIds: [],
          metadata: {}
        },
        version: 1
      };
    },

    async deleteMemory(input) {
      failIfNeeded();
      return {
        ok: true,
        id: input.memoryId,
        kind: "trace",
        status: "deleted",
        ...nextChange(),
        auditId: randomUUID(),
        serverTime: now()
      };
    },

    async enqueueImportSummaries() {
      failIfNeeded();
      return {
        enqueued: 0,
        memoryIds: [],
        serverTime: now()
      };
    },

    async getMemoryProcessingStatus() {
      failIfNeeded();
      return { items: [], serverTime: now() };
    },

    async retryMemoryProcessing(memoryId) {
      failIfNeeded();
      return {
        accepted: false,
        processing: {
          memoryId,
          state: "ready" as const,
          attemptCount: 0,
          manualRetryCount: 0,
          retryAction: "retry" as const,
          updatedAt: now()
        },
        serverTime: now()
      };
    },

    async runWorker() {
      failIfNeeded();
      return {
        leased: 0,
        succeeded: 0,
        failed: 0,
        jobs: [],
        embeddingRetries: {
          leased: 0,
          succeeded: 0,
          failed: 0,
          items: []
        },
        ...nextChange(),
        serverTime: now()
      };
    },

    async panelOverview() {
      failIfNeeded();
      return {
        counts: { memories: 0, skills: 0, experiences: 0, worldModels: 0 },
        dailyActivity: emptyPanelDays(now()),
        sourceDistribution: []
      };
    },

    async panelAnalysis() {
      failIfNeeded();
      return {
        metrics: {
          avgRecallScore: 0,
          recallEvents: 0,
          activeSkills: 0,
          recentlyUsedSkills: 0,
          avgToolLatencyMs: 0,
          p95ToolLatencyMs: 0
        },
        dailyMemoryWrites: emptyPanelDays(now()),
        dailySkillEvolutions: emptyPanelDays(now()),
        toolLatency: { tools: [], series: [] }
      };
    },

    async panelItems() {
      failIfNeeded();
      return {
        items: [],
        page: 1,
        pageSize: 20,
        total: 0,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
        serverTime: now()
      };
    },

    async memoryApiLogs(input) {
      failIfNeeded();
      const limit = input.limit ?? 50;
      const offset = input.offset ?? 0;
      return {
        logs: [],
        total: 0,
        limit,
        offset,
        serverTime: now()
      };
    }
  };
}

function mockModels() {
  return {
    summary: {
      provider: "mock",
      model: "mock-summary",
      configured: true,
      remote: false
    },
    evolution: {
      provider: "mock",
      model: "mock-skill",
      configured: true,
      remote: false
    },
    embedding: {
      provider: "mock",
      model: "mock-embedding",
      configured: true,
      remote: false
    }
  };
}

/**
 * Maps a memory kind to a memory layer.
 *
 * @param kind Memory kind.
 * @returns The corresponding memory layer.
 */
function memoryLayerForKind(kind: MemoryKind): "L1" | "L2" | "L3" | "Skill" {
  if (kind === "policy") {
    return "L2";
  }

  if (kind === "world_model") {
    return "L3";
  }

  if (kind === "skill") {
    return "Skill";
  }

  return "L1";
}

function emptyPanelDays(nowIso: string): Array<{ date: string; count: number }> {
  const parsed = Date.parse(nowIso);
  const end = Number.isFinite(parsed) ? new Date(parsed) : new Date();
  return Array.from({ length: 7 }, (_item, index) => {
    const day = new Date(end);
    day.setUTCDate(end.getUTCDate() - (6 - index));
    return { date: day.toISOString().slice(0, 10), count: 0 };
  });
}

/**
 * Maps a memory layer to a default memory kind.
 *
 * @param layer Memory layer.
 * @returns The corresponding default memory kind.
 */
function kindForLayer(layer: "L1" | "L2" | "L3" | "Skill"): MemoryKind {
  if (layer === "L2") return "policy";
  if (layer === "L3") return "world_model";
  if (layer === "Skill") return "skill";
  return "trace";
}

/**
 * Takes the first line of the body as the mock title.
 *
 * @param value The original body.
 * @returns The first non-empty line, or a fallback title.
 */
function firstLine(value: string): string {
  return value.split(/\r?\n/).find((line) => line.trim())?.trim() || value.trim() || "Untitled memory";
}
