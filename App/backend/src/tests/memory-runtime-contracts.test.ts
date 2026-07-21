/** Memory runtime contracts tests. */
import { describe, expect, it } from "vitest";
import {
  AddMemoryInputSchema,
  AddMemoryOutputSchema,
  ApiErrorBodySchema,
  CloseSessionInputSchema,
  CloseSessionOutputSchema,
  CompleteTurnInputSchema,
  CompleteTurnOutputSchema,
  DeleteMemoryInputSchema,
  DeleteMemoryOutputSchema,
  GetMemoryOutputSchema,
  InjectedContextSchema,
  JobRefSchema,
  MemoryDetailItemSchema,
  MemoryHealthSnapshotSchema,
  MemoryListItemSchema,
  MemoryReloadConfigInputSchema,
  MemoryReloadConfigOutputSchema,
  OpenSessionInputSchema,
  OpenSessionOutputSchema,
  PanelAnalysisOutputSchema,
  PanelItemsInputSchema,
  PanelItemsOutputSchema,
  PanelOverviewOutputSchema,
  RawTurnSummarySchema,
  RecallHitSchema,
  SearchInputSchema,
  SearchOutputSchema,
  StartTurnInputSchema,
  StartTurnOutputSchema
} from "@memmy/local-api-contracts";
import type { ZodType } from "zod";

const ISO = "2026-05-29T10:00:00.000Z";

describe("memory runtime contracts", () => {
  const outputCases: Array<{ name: string; schema: ZodType<unknown>; valid: unknown; invalid: unknown }> = [
    { name: "InjectedContext", schema: InjectedContextSchema, valid: injectedContext(), invalid: { markdown: "", sections: [{ id: "sec-1", kind: "bad" }] } },
    { name: "RecallHit", schema: RecallHitSchema, valid: recallHit(), invalid: { ...recallHit(), memoryLayer: "L4" } },
    { name: "MemoryListItem", schema: MemoryListItemSchema, valid: memoryListItem(), invalid: { ...memoryListItem(), status: "draft" } },
    { name: "MemoryDetailItem", schema: MemoryDetailItemSchema, valid: memoryDetailItem(), invalid: { ...memoryDetailItem(), createdAt: "not-a-date" } },
    { name: "RawTurnSummary", schema: RawTurnSummarySchema, valid: rawTurnSummary(), invalid: { ...rawTurnSummary(), rawTurnId: "" } },
    { name: "JobRef", schema: JobRefSchema, valid: jobRef(), invalid: { ...jobRef(), jobType: "unknown" } },
    { name: "MemoryHealthSnapshot", schema: MemoryHealthSnapshotSchema, valid: healthOutput(), invalid: { ...healthOutput(), storage: { backend: "memory", schemaVersion: "3", ready: true } } },
    { name: "MemoryReloadConfigOutput", schema: MemoryReloadConfigOutputSchema, valid: reloadConfigOutput(), invalid: { ...reloadConfigOutput(), activeProfile: "personal" } },
    { name: "OpenSessionOutput", schema: OpenSessionOutputSchema, valid: openSessionOutput(), invalid: { sessionId: "session-1", status: "closed", resumed: false, serverTime: ISO } },
    { name: "CloseSessionOutput", schema: CloseSessionOutputSchema, valid: closeSessionOutput(), invalid: { ok: false, sessionId: "session-1", status: "closed", closedEpisodeIds: [], serverTime: ISO } },
    { name: "StartTurnOutput", schema: StartTurnOutputSchema, valid: startTurnOutput(), invalid: { contextPacketId: "context-1", sessionId: "session-1" } },
    { name: "CompleteTurnOutput", schema: CompleteTurnOutputSchema, valid: completeTurnOutput(), invalid: { l1MemoryId: "memory-1", rawTurnId: "raw-1", episodeId: "episode-1" } },
    { name: "SearchOutput", schema: SearchOutputSchema, valid: searchOutput(), invalid: { hits: [recallHit()], searchEventId: "search-1", sourceMemoryIds: [] } },
    { name: "AddMemoryOutput", schema: AddMemoryOutputSchema, valid: addMemoryOutput(), invalid: { ...addMemoryOutput(), memoryLayer: "L4" } },
    { name: "GetMemoryOutput", schema: GetMemoryOutputSchema, valid: getMemoryOutput(), invalid: { item: memoryDetailItem(), version: "1" } },
    { name: "DeleteMemoryOutput", schema: DeleteMemoryOutputSchema, valid: deleteMemoryOutput(), invalid: { ...deleteMemoryOutput(), status: "archived" } },
    { name: "PanelOverviewOutput", schema: PanelOverviewOutputSchema, valid: panelOverviewOutput(), invalid: { ...panelOverviewOutput(), counts: { memories: 1 } } },
    { name: "PanelAnalysisOutput", schema: PanelAnalysisOutputSchema, valid: panelAnalysisOutput(), invalid: { ...panelAnalysisOutput(), dailyMemoryWrites: [{ date: "bad", count: 1 }] } },
    { name: "PanelItemsOutput", schema: PanelItemsOutputSchema, valid: panelItemsOutput(), invalid: { ...panelItemsOutput(), pageSize: 10 } },
    { name: "ApiErrorBody", schema: ApiErrorBodySchema, valid: { error: { code: "invalid_argument", message: "query is required", requestId: "req-1" } }, invalid: { error: { code: "bad_code", message: "x", requestId: "req-1" } } }
  ];

  for (const testCase of outputCases) {
    it(`parses valid ${testCase.name}`, () => {
      expect(() => testCase.schema.parse(testCase.valid)).not.toThrow();
    });

    it(`rejects invalid ${testCase.name}`, () => {
      expect(() => testCase.schema.parse(testCase.invalid)).toThrow();
    });
  }

  const inputCases: Array<{ name: string; schema: ZodType<unknown>; valid: Record<string, unknown>; invalid?: Record<string, unknown> }> = [
    { name: "OpenSessionInput", schema: OpenSessionInputSchema, valid: { sessionId: "host-session-1", workspacePath: "/tmp/project", source: "codex" } },
    { name: "CloseSessionInput", schema: CloseSessionInputSchema, valid: { source: "codex" } },
    { name: "StartTurnInput", schema: StartTurnInputSchema, valid: { sessionId: "session-1", query: "How should I proceed?", turnId: "turn-1", source: "codex" }, invalid: { sessionId: "session-1", userText: "old" } },
    { name: "CompleteTurnInput", schema: CompleteTurnInputSchema, valid: { sessionId: "session-1", query: "Question", answer: "Answer", status: "succeeded", source: "codex" }, invalid: { sessionId: "session-1", userText: "Question", assistantText: "Answer" } },
    { name: "SearchInput", schema: SearchInputSchema, valid: { query: "typescript retry", sessionId: "session-1", layers: ["L1", "L2"], verbose: true, source: "codex" }, invalid: { query: 1 } },
    { name: "AddMemoryInput", schema: AddMemoryInputSchema, valid: { content: "remember this", layer: "L1", source: "codex" }, invalid: { content: "", layer: "L4" } },
    { name: "DeleteMemoryInput", schema: DeleteMemoryInputSchema, valid: { source: "codex" } },
    {
      name: "MemoryReloadConfigInput",
      schema: MemoryReloadConfigInputSchema,
      valid: { reason: "profile_switched", restartFailedProcessing: false },
      invalid: { requestId: "" }
    },
    { name: "PanelItemsInput", schema: PanelItemsInputSchema, valid: { layer: "L1", status: "activated", q: "route", page: 1 }, invalid: { layer: "L4", limit: 20 } }
  ];

  for (const testCase of inputCases) {
    it(`parses valid ${testCase.name}`, () => {
      expect(() => testCase.schema.parse(testCase.valid)).not.toThrow();
    });

    if (testCase.invalid) {
      it(`rejects invalid ${testCase.name}`, () => {
        expect(() => testCase.schema.parse(testCase.invalid)).toThrow();
      });
    }
  }
});

/**
 * Builds an injectable context.
 *
 * Field meanings:
 * - markdown: The full context text.
 * - sections: Traceable context fragments.
 * - tokenEstimate: Estimated token count.
 */
function injectedContext() {
  return {
    markdown: "## Context\n\nUse prior decisions.",
    sections: [
      { id: "section-1", title: "Prior Decision", kind: "trace", memoryLayer: "L1", memoryIds: ["memory-1"], content: "Use existing route patterns.", tokenEstimate: 18 }
    ],
    tokenEstimate: 18
  };
}

/**
 * Builds a search hit.
 *
 * Field meanings:
 * - overrides: Test parameters for overriding kind and memoryLayer.
 */
function recallHit(overrides: Partial<Record<"kind" | "memoryLayer", string>> = {}) {
  return {
    id: "memory-1",
    kind: overrides.kind ?? "trace",
    memoryLayer: overrides.memoryLayer ?? "L1",
    status: "activated",
    title: "Prior route pattern",
    snippet: "Use Fastify inject for local route tests.",
    score: 0.92,
    tags: ["typescript"],
    updatedAt: ISO,
    source: "search"
  };
}

function memoryListItem(overrides: Partial<Record<"kind" | "memoryLayer", string>> = {}) {
  return {
    id: "memory-1",
    kind: overrides.kind ?? "trace",
    memoryLayer: overrides.memoryLayer ?? "L1",
    status: "activated",
    title: "Prior route pattern",
    summary: "Use Fastify inject for local route tests.",
    tags: ["typescript"],
    metadata: { source: "codex" },
    createdAt: ISO,
    updatedAt: ISO,
    version: 1
  };
}

function memoryDetailItem() {
  return {
    ...memoryListItem(),
    body: "Full memory body",
    createdAt: ISO,
    sourceMemoryIds: ["memory-0"],
    metadata: { source: "codex" }
  };
}

function rawTurnSummary() {
  return { rawTurnId: "raw-1", episodeId: "episode-1", turnId: "turn-1", userText: "Question", assistantText: "Answer", toolCalls: [], toolResults: [], createdAt: ISO };
}

function jobRef() {
  return { jobId: "job-1", jobType: "reflection", status: "queued", targetMemoryId: "memory-1" };
}

function healthOutput() {
  return {
    ok: true,
    version: "1.0.0",
    uptimeMs: 1200,
    mode: "local",
    storage: { backend: "sqlite", schemaVersion: "3", ready: true, lastMigrationId: "0003" },
    capabilities: { routes: ["/api/v1/health"], tools: [], memoryLayers: ["L1", "L2", "L3", "Skill"], supportsCli: true },
    activeProfile: "byok",
    models: modelStatuses(),
    serverTime: ISO
  };
}

function reloadConfigOutput() {
  return {
    activeProfile: "account",
    changed: true,
    requiresRestart: false,
    models: modelStatuses(),
    reloadedAt: ISO
  };
}

function modelStatuses() {
  return {
    summary: { provider: "openai_compatible", model: "memory_summary", configured: true, remote: true },
    evolution: { provider: "openai_compatible", model: "memory_evolution", configured: true, remote: true },
    embedding: { provider: "local", model: "hash-embedding-v1", configured: true, remote: false }
  };
}

function openSessionOutput() {
  return { sessionId: "session-1", status: "open", episodeId: "episode-1", resumed: false, serverTime: ISO };
}

function closeSessionOutput() {
  return { ok: true, sessionId: "session-1", status: "closed", closedEpisodeIds: ["episode-1"], changeSeq: 1, syncCursor: "cursor-1", serverTime: ISO };
}

function startTurnOutput() {
  return { turnId: "turn-1", contextPacketId: "context-1", sessionId: "session-1", episodeId: "episode-1", injectedContext: injectedContext(), searchEventId: "search-1", sourceMemoryIds: ["memory-1"], hits: [recallHit()], status: [], serverTime: ISO };
}

function completeTurnOutput() {
  return { turnId: "turn-1", sessionId: "session-1", l1MemoryId: "memory-1", rawTurnId: "raw-1", episodeId: "episode-1", scheduledEvolution: true, jobs: [jobRef()], changeSeq: 3, serverTime: ISO };
}

function searchOutput() {
  return {
    injectedContext: injectedContext().markdown
  };
}

function addMemoryOutput() {
  return { id: "memory-1", kind: "trace", memoryLayer: "L1", status: "activated", title: "remember this", summary: "remember this", tags: ["codex"], createdAt: ISO, serverTime: ISO };
}

function getMemoryOutput() {
  return {
    item: {
      ...memoryDetailItem(),
      trace: { episodeId: "episode-1", rawTurnId: "raw-1", turnId: "turn-1" },
      policy: { evidenceMemoryIds: ["memory-1"], repairHints: ["retry"] },
      worldModel: { sourceMemoryIds: ["memory-1"], confidence: 0.8 },
      skill: { invocationGuide: "Use it", procedure: ["Step 1"], sourcePolicyIds: ["policy-1"], sourceWorldModelIds: ["world-1"], reliabilityScore: 0.9, utilityScore: 0.8, evidenceCount: 2 }
    },
    refs: {
      rawTurn: rawTurnSummary(),
      episode: { id: "episode-1", sessionId: "session-1", status: "closed", startedAt: ISO, endedAt: ISO, turnCount: 2, rTask: 1 },
      policyLinks: [{ policyMemoryId: "policy-1", traceMemoryId: "trace-1", relation: "supports" }],
      skillTrials: [{ trialId: "trial-1", status: "pending", episodeId: "episode-1", reward: 1 }]
    },
    version: 1,
    etag: "etag-1"
  };
}

function deleteMemoryOutput() {
  return { ok: true, id: "memory-1", kind: "trace", status: "deleted", changeSeq: 4, syncCursor: "cursor-4", auditId: "audit-1", serverTime: ISO };
}

function panelOverviewOutput() {
  return {
    counts: { memories: 1, skills: 4, experiences: 2, worldModels: 3 },
    dailyActivity: panelDays(),
    sourceDistribution: [{ source: "codex", count: 10, percentage: 100 }]
  };
}

function panelAnalysisOutput() {
  return {
    metrics: {
      avgRecallScore: 0.82,
      recallEvents: 3,
      activeSkills: 2,
      recentlyUsedSkills: 1,
      avgToolLatencyMs: 120,
      p95ToolLatencyMs: 240
    },
    dailyMemoryWrites: panelDays(),
    dailySkillEvolutions: panelDays(),
    toolLatency: {
      tools: [{ name: "memory_search", calls: 3, avgMs: 120, p95Ms: 240 }],
      series: [{ name: "memory_search", points: panelDays().map((point) => ({ date: point.date, avgMs: 120 })) }]
    }
  };
}

function panelItemsOutput() {
  return { items: [memoryListItem()], page: 1, pageSize: 20, total: 1, totalPages: 1, hasNext: false, hasPrev: false, serverTime: ISO };
}

function panelDays() {
  return [
    "2026-05-23",
    "2026-05-24",
    "2026-05-25",
    "2026-05-26",
    "2026-05-27",
    "2026-05-28",
    "2026-05-29"
  ].map((date) => ({ date, count: 0 }));
}
