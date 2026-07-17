/** Memory runtime fixtures tests. */
import type {
  CloseSessionOutput,
  CompleteTurnOutput,
  DeleteMemoryOutput,
  GetMemoryOutput,
  MemoryApiLogsOutput,
  MemoryHealthSnapshot,
  MemoryKind,
  MemoryReloadConfigOutput,
  OpenSessionOutput,
  PanelAnalysisOutput,
  PanelItemsInput,
  PanelItemsOutput,
  PanelOverviewOutput,
  RecallHit,
  SearchOutput,
  StartTurnOutput,
  AddMemoryOutput
} from "@memmy/local-api-contracts";
import { MEMORY_RUNTIME_ENDPOINTS, type MemoryRuntimeClient } from "../../../api/memory-runtime-client.js";

const now = "2026-06-03T10:00:00.000Z";

const mockDailyActivity: PanelOverviewOutput["dailyActivity"] = Array.from({ length: 31 }, (_item, index) => {
  const date = new Date(Date.UTC(2026, 4, 4 + index));
  return {
    date: date.toISOString().slice(0, 10),
    count: [0, 1, 2, 0, 4, 3, 0][index % 7]!
  };
});

/** Memory runtime fixtures tests. */
export const mockMemoryItems: PanelItemsOutput["items"] = [
  {
    id: "memory-policy-1",
    kind: "policy",
    memoryLayer: "L2",
    status: "activated",
    title: "用户偏好中文注释",
    summary: "写代码前后要 review 语言规范和设计原则，并补中文文件级、函数级、字段注释。",
    tags: ["偏好", "工程规范"],
    createdAt: "2026-06-03T09:10:00.000Z",
    updatedAt: "2026-06-03T09:20:00.000Z",
    version: 3
  },
  {
    id: "memory-trace-1",
    kind: "trace",
    memoryLayer: "L1",
    status: "activated",
    title: "Memmy 记忆管理模块执行规范",
    summary: "按照 codex 规范补齐 MemoryPage 页壳、MemOS Local View 子页和接入源管理复用。",
    tags: ["Memmy", "记忆管理"],
    metrics: { value: 0.74, alpha: 0.5, reflectionDone: true },
    createdAt: "2026-06-03T09:40:00.000Z",
    updatedAt: "2026-06-03T09:45:00.000Z",
    version: 1
  },
  {
    id: "memory-world-1",
    kind: "world_model",
    memoryLayer: "L3",
    status: "resolving",
    title: "Memmy 是跨 Agent 记忆 sidecar",
    summary: "Memmy 当前定位是本地记忆/召回 sidecar，不负责调度外部 Agent 任务队列。",
    tags: ["架构", "Memmy"],
    createdAt: "2026-06-03T08:20:00.000Z",
    updatedAt: "2026-06-03T08:30:00.000Z",
    version: 2
  },
  {
    id: "skill-memory-1",
    kind: "skill",
    memoryLayer: "Skill",
    status: "activated",
    title: "中文注释生成",
    summary: "根据仓库真实代码补齐中文文件级、函数级和字段含义注释。",
    tags: ["skill", "注释"],
    createdAt: "2026-06-02T17:50:00.000Z",
    updatedAt: "2026-06-02T18:00:00.000Z",
    version: 4
  }
];

/** Memory runtime fixtures tests. */
export const mockMemoryDetails: Record<string, GetMemoryOutput> = {
  "policy:memory-policy-1": {
    item: {
      ...mockMemoryItems[0]!,
      body: "完整正文：用户要求每次写代码前后都 review 语言规范、设计原则和优化空间，并补中文注释。",
      createdAt: "2026-06-03T08:00:00.000Z",
      sourceMemoryIds: ["memory-trace-1"],
      metadata: {
        source: "codex",
        confidence: 0.94
      }
    },
    version: 3,
    etag: "panel-detail-policy-1"
  },
  "trace:memory-trace-1": {
    item: {
      ...mockMemoryItems[1]!,
      body: "完整正文：规范要求新增 `/memory`，并将接入源管理作为 sources 子页挂入。",
      createdAt: "2026-06-03T09:00:00.000Z",
      sourceMemoryIds: [],
      metadata: {
        document: "docs/codex-spec-memory-management-module-260603.md",
        traceDetail: {
          episodeId: "episode-memory-page",
          turnId: "turn-memory-page",
          rawTurnId: "raw-turn-memory-page",
          episode: {
            id: "episode-memory-page",
            sessionId: "session-memory-page",
            summary: "记忆管理页面接入真实数据",
            status: "closed",
            startedAt: "2026-06-03T09:00:00.000Z",
            endedAt: "2026-06-03T09:45:00.000Z",
            turnCount: 1,
            rTask: 0.735,
            pipelineStatus: "idle",
            skillStatus: "queued",
            skillReason: "技能沉淀待评估。"
          },
          turn: {
            id: "raw-turn-memory-page",
            turnId: "turn-memory-page",
            createdAt: "2026-06-03T09:00:00.000Z",
            userText: "请把 **记忆管理** 页面接入真实数据。",
            assistantText: "已完成：\n- 接入 `listPanelItems`\n- 保留真实记忆列表\n- 点击后展示详情",
            toolCalls: [
              {
                id: "tool-call-1",
                name: "read_file",
                input: { path: "App/frontend/desktop/src/pages/memory-page.tsx" },
                output: "读取 MemoryPage 页面结构。",
                success: true,
                startedAt: "2026-06-03T09:01:00.000Z",
                endedAt: "2026-06-03T09:01:01.000Z"
              }
            ]
          },
          capturedAt: "2026-06-03T09:00:00.000Z",
          value: 0.735,
          alpha: 0.9,
          priority: 0.5,
          summary: "按照 codex 规范补齐 MemoryPage 页壳、MemOS Local View 子页和接入源管理复用。",
          userQuery: "请把 **记忆管理** 页面接入真实数据。",
          finalResponse: "已完成：\n- 接入 `listPanelItems`\n- 保留真实记忆列表\n- 点击后展示详情",
          toolCalls: [
            {
              id: "tool-call-1",
              name: "read_file",
              input: { path: "App/frontend/desktop/src/pages/memory-page.tsx" },
              output: "读取 MemoryPage 页面结构。",
              success: true,
              startedAt: "2026-06-03T09:01:00.000Z",
              endedAt: "2026-06-03T09:01:01.000Z"
            }
          ],
          steps: [
            {
              id: "memory-trace-1",
              stepIndex: 0,
              role: "user",
              summary: "用户要求记忆管理页面接入真实数据",
              value: 0.735,
              alpha: 0.9,
              priority: 0.5,
              toolCalls: []
            }
          ]
        }
      }
    },
    version: 1,
    etag: "panel-detail-trace-1"
  },
  "world_model:memory-world-1": {
    item: {
      ...mockMemoryItems[2]!,
      body: "完整正文：Memmy 与 multica 的区别在于前者是 memory sidecar，后者是 task-execution control plane。",
      createdAt: "2026-06-02T16:00:00.000Z",
      sourceMemoryIds: ["memory-trace-1"],
      metadata: {
        confidence: 0.88
      }
    },
    version: 2,
    etag: "panel-detail-world-1"
  },
  "skill:skill-memory-1": {
    item: {
      ...mockMemoryItems[3]!,
      body: "完整正文：先读文件、理解字段语义，再补文件级和函数级中文注释。",
      createdAt: "2026-06-02T12:00:00.000Z",
      sourceMemoryIds: ["memory-policy-1"],
      metadata: {
        reliabilityScore: 0.91
      }
    },
    version: 4,
    etag: "panel-detail-skill-1"
  }
};

/** Memory runtime fixtures tests. */
export const mockPanelOverview: PanelOverviewOutput = {
  counts: {
    memories: 9,
    skills: 2,
    experiences: 4,
    worldModels: 3
  },
  sourceDistribution: [
    { source: "Cursor", count: 6, percentage: 33.3 },
    { source: "Codex", count: 5, percentage: 27.8 },
    { source: "Claude Code", count: 4, percentage: 22.2 },
    { source: "Manual", count: 3, percentage: 16.7 }
  ],
  dailyActivity: mockDailyActivity
};

export const mockPanelAnalysis: PanelAnalysisOutput = {
  metrics: {
    avgRecallScore: 0.82,
    recallEvents: 246,
    activeSkills: 31,
    recentlyUsedSkills: 18,
    avgToolLatencyMs: 142,
    p95ToolLatencyMs: 380
  },
  dailyMemoryWrites: [
    { date: "2026-05-28", count: 34 },
    { date: "2026-05-29", count: 41 },
    { date: "2026-05-30", count: 28 },
    { date: "2026-05-31", count: 63 },
    { date: "2026-06-01", count: 47 },
    { date: "2026-06-02", count: 72 },
    { date: "2026-06-03", count: 58 }
  ],
  dailySkillEvolutions: [
    { date: "2026-05-28", count: 2 },
    { date: "2026-05-29", count: 4 },
    { date: "2026-05-30", count: 1 },
    { date: "2026-05-31", count: 6 },
    { date: "2026-06-01", count: 3 },
    { date: "2026-06-02", count: 7 },
    { date: "2026-06-03", count: 5 }
  ],
  toolLatency: {
    tools: [
      { name: "memory_search", calls: 186, avgMs: 118, p95Ms: 296 },
      { name: "memory_add", calls: 74, avgMs: 171, p95Ms: 410 }
    ],
    series: [
      {
        name: "memory_search",
        points: [
          { date: "2026-05-28", avgMs: 126 },
          { date: "2026-05-29", avgMs: 104 },
          { date: "2026-05-30", avgMs: 132 },
          { date: "2026-05-31", avgMs: 116 },
          { date: "2026-06-01", avgMs: 98 },
          { date: "2026-06-02", avgMs: 144 },
          { date: "2026-06-03", avgMs: 118 }
        ]
      },
      {
        name: "memory_add",
        points: [
          { date: "2026-05-28", avgMs: 188 },
          { date: "2026-05-29", avgMs: 162 },
          { date: "2026-05-30", avgMs: 174 },
          { date: "2026-05-31", avgMs: 196 },
          { date: "2026-06-01", avgMs: 151 },
          { date: "2026-06-02", avgMs: 182 },
          { date: "2026-06-03", avgMs: 171 }
        ]
      }
    ]
  }
};

/** Creates create mock memory runtime client. */
export function createMockMemoryRuntimeClient(): MemoryRuntimeClient {
  return {
    async health(): Promise<MemoryHealthSnapshot> {
      return {
        ok: true,
        version: "mock-memory-runtime",
        uptimeMs: 1000,
        mode: "dev",
        storage: { backend: "sqlite", schemaVersion: "mock", ready: true },
        capabilities: { routes: [...MEMORY_RUNTIME_ENDPOINTS], tools: ["memmy_memory_search"], memoryLayers: ["L1", "L2", "L3", "Skill"], supportsCli: true },
        activeProfile: "byok",
        models: {
        summary: { provider: "openai_compatible", model: "memory_summary", configured: true, remote: true },
          evolution: { provider: "openai_compatible", model: "memory_evolution", configured: true, remote: true },
          embedding: { provider: "local", model: "hash-embedding-v1", configured: true, remote: false }
        },
        serverTime: now
      };
    },
    async reloadConfig(): Promise<MemoryReloadConfigOutput> {
      return {
        activeProfile: "byok",
        changed: false,
        requiresRestart: false,
        models: {
        summary: { provider: "openai_compatible", model: "memory_summary", configured: true, remote: true },
          evolution: { provider: "openai_compatible", model: "memory_evolution", configured: true, remote: true },
          embedding: { provider: "local", model: "hash-embedding-v1", configured: true, remote: false }
        },
        reloadedAt: now
      };
    },
    async openSession(): Promise<OpenSessionOutput> {
      return { sessionId: "mock-session", status: "open", episodeId: "mock-episode", resumed: false, serverTime: now };
    },
    async closeSession(): Promise<CloseSessionOutput> {
      return { ok: true, sessionId: "mock-session", status: "closed", closedEpisodeIds: ["mock-episode"], serverTime: now };
    },
    async startTurn(input): Promise<StartTurnOutput> {
      const hits = filterMemoryItems({ q: input.query }).items.slice(0, 8).map(toRecallHit);
      return {
        turnId: input.turnId ?? "mock-turn",
        contextPacketId: "context-1",
        sessionId: input.sessionId,
        episodeId: "mock-episode",
        injectedContext: { markdown: "- 用户偏好中文注释", sections: [] },
	        searchEventId: "search-1",
	        sourceMemoryIds: hits.map((hit) => hit.id),
	        hits,
	        status: [],
	        serverTime: now
	      };
	    },
    async completeTurn(): Promise<CompleteTurnOutput> {
      return {
        turnId: "mock-turn",
        sessionId: "mock-session",
        l1MemoryId: "memory-trace-1",
        rawTurnId: "raw-turn-1",
        episodeId: "mock-episode",
        scheduledEvolution: true,
        jobs: [{ jobId: "job-skill-1", jobType: "skill_crystallization", status: "succeeded", targetMemoryId: "memory-policy-1" }],
        changeSeq: 42,
        serverTime: now
      };
    },
    async search(input): Promise<SearchOutput> {
      const hits = filterMemoryItems({ q: input.query }).items.slice(0, 8).map(toRecallHit);
      const injectedContext = {
        markdown: hits.map((hit) => `- ${hit.snippet}`).join("\n"),
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
          searchEventId: "search-1",
          hits,
          sourceMemoryIds: hits.map((hit) => hit.id),
          status: [],
          sections: injectedContext.sections,
          serverTime: now
        }
      };
    },
    async addMemory(input): Promise<AddMemoryOutput> {
      return {
        id: "memory-added-1",
        kind: "trace",
        memoryLayer: input.layer ?? "L1",
        status: "activated",
        title: input.title ?? input.content.slice(0, 20),
        summary: input.content,
        tags: input.tags ?? [],
        createdAt: now,
        serverTime: now
      };
    },
    async getMemory(id): Promise<GetMemoryOutput> {
      const detail = findMemoryDetail(id);
      return { item: detail.item, refs: {}, version: detail.version, etag: detail.etag };
    },

    async deleteMemory(id): Promise<DeleteMemoryOutput> {
      return {
        ok: true,
        id,
        kind: findMemoryDetail(id).item.kind,
        status: "deleted",
        changeSeq: 46,
        syncCursor: "cursor-change-46",
        auditId: "audit-delete-1",
        serverTime: now
      };
    },

    async listMemoryLogs(input): Promise<MemoryApiLogsOutput> {
      const logs: MemoryApiLogsOutput["logs"] = [
        {
          id: 3,
          toolName: "skill_generate",
          inputJson: JSON.stringify({ phase: "done" }),
          outputJson: JSON.stringify({ skillId: "skill-memory-1", kind: "skill.crystallized", name: "中文注释技能" }),
          durationMs: 42,
          success: true,
          calledAt: "2026-06-03T10:30:00.000Z"
        },
        {
          id: 2,
          toolName: "memory_search",
          inputJson: JSON.stringify({ query: "中文注释规范", sessionId: "session-memory-page" }),
          outputJson: JSON.stringify({
            candidates: [
              { refKind: "policy", refId: "memory-policy-1", score: 0.913, snippet: "写代码前后要 review 语言规范和设计原则。", origin: "rule" }
            ],
            filtered: [
              { refKind: "policy", refId: "memory-policy-1", score: 0.913, snippet: "写代码前后要 review 语言规范和设计原则。", origin: "rule" }
            ],
            stats: { raw: 4, ranked: 1, droppedByThreshold: 0, topRelevance: 0.913, llmFilter: { outcome: "kept", kept: 1, dropped: 0 }, finalReturned: 1 }
          }),
          durationMs: 12,
          success: true,
          calledAt: "2026-06-03T10:00:00.000Z"
        },
        {
          id: 1,
          toolName: "memory_add",
          inputJson: JSON.stringify({ sessionId: "session-memory-page", layer: "L1", source: "manual" }),
          outputJson: JSON.stringify({
            stored: 1,
            details: [
              { role: "trace", action: "stored", summary: "按照 codex 规范补齐 MemoryPage 页壳。", content: "按照 codex 规范补齐 MemoryPage 页壳。", traceId: "memory-trace-1" }
            ]
          }),
          durationMs: 8,
          success: true,
          calledAt: "2026-06-03T09:45:00.000Z"
        }
      ];
      const offset = input.offset ?? 0;
      const limit = input.limit ?? 50;
      const filtered = input.tools?.length ? logs.filter((log) => input.tools!.includes(log.toolName)) : logs;
      return {
        logs: filtered.slice(offset, offset + limit),
        total: filtered.length,
        limit,
        offset,
        nextOffset: offset + limit < filtered.length ? offset + limit : undefined,
        serverTime: now
      };
    },

    async getPanelOverview(): Promise<PanelOverviewOutput> {
      return mockPanelOverview;
    },
    async getPanelAnalysis(): Promise<PanelAnalysisOutput> {
      return mockPanelAnalysis;
    },
    async listPanelItems(input): Promise<PanelItemsOutput> {
      return filterMemoryItems(input);
    },
    async listPanelTasks(input) {
      const page = Math.max(1, Math.floor(input.page ?? 1));
      return {
        tasks: [],
        page,
        pageSize: 20,
        total: 0,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
        serverTime: now
      };
    },
    async deletePanelTask(id) {
      return { ok: true, id, deletedMemoryIds: [], serverTime: now };
    }
  };
}

function findMemoryDetail(id: string): GetMemoryOutput {
  const detail = Object.values(mockMemoryDetails).find((item) => item.item.id === id);
  if (!detail) {
    throw new Error(`Mock memory item not found: ${id}`);
  }
  return detail;
}

/**
 * Filters mock memories by the panel input.
 *
 * @param input The panel list input.
 * @returns The filtered memory list.
 */
function filterMemoryItems(input: PanelItemsInput): PanelItemsOutput {
  const q = input.q?.trim().toLowerCase();
  const page = Number.isFinite(input.page) && input.page! > 0 ? Math.floor(input.page!) : 1;
  const pageSize = 20;

  const filtered = mockMemoryItems
    .filter((item) => !input.layer || item.memoryLayer === input.layer)
    .filter((item) => !input.status || item.status === input.status)
    .filter((item) => {
      const metadataSource = typeof item.metadata?.source === "string" ? item.metadata.source : "";
      const sourceAgent = metadataSource || item.tags.find((tag) => [
        "memmy",
        "memmy_agent",
        "cursor",
        "claude_code",
        "codex",
        "opencode",
        "openclaw",
        "hermes"
      ].includes(normalizeSourceAgentKey(tag))) || "";
      if (input.sourceAgent) {
        return normalizeSourceAgentKey(sourceAgent) === normalizeSourceAgentKey(input.sourceAgent);
      }
      const excludedSourceAgents = new Set((input.excludedSourceAgents ?? []).map(normalizeSourceAgentKey));
      return !excludedSourceAgents.has(normalizeSourceAgentKey(sourceAgent));
    })
    .filter((item) => !q || [item.id, item.title, item.summary, ...item.tags].some((value) => value.toLowerCase().includes(q)));
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return {
    items: filtered.slice((page - 1) * pageSize, page * pageSize),
    page,
    pageSize,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
    serverTime: now
  };
}

function normalizeSourceAgentKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/gu, "_");
}

/**
 * Converts a list item into a recall hit.
 *
 * @param item The memory list item.
 * @returns The recall hit structure.
 */
function toRecallHit(item: PanelItemsOutput["items"][number]): RecallHit {
  return {
    id: item.id,
    kind: item.kind as MemoryKind,
    memoryLayer: item.memoryLayer,
    status: item.status,
    title: item.title,
    snippet: item.summary,
    score: item.kind === "policy" ? 0.92 : 0.78,
    tags: item.tags,
    updatedAt: item.updatedAt,
    source: item.kind === "skill" ? "skill" : "search"
  };
}
