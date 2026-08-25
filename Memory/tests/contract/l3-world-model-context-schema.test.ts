import { describe, expect, it } from "vitest";
import {
  L3WorldModelBoundaryRequestSchema,
  L3WorldModelRequestEnvelopeSchema,
  L3WorldModelTraceHeadResponseSchema,
  SessionL3WorldModelContextResponseSchema,
  escapeL3WorldModelBoundary,
  l3WorldModelGetTransport,
  renderL3WorldModelContext,
  renderL3WorldModelFields
} from "@memmy/local-api-contracts";

const envelope = {
  requestId: "9f4a5cf8-9bc6-4f64-b3c4-671504721c77",
  adapterId: "codex-hook",
  source: "codex",
  namespace: {
    source: "codex",
    profileId: "default",
    sessionKey: "codex-memory-session",
    userId: "user-1",
    projectId: "project-1"
  },
  timeZone: "Asia/Shanghai"
};

describe("L3 World Model shared context contract", () => {
  it("requires strict source-qualified request envelopes", () => {
    expect(L3WorldModelRequestEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(L3WorldModelRequestEnvelopeSchema.safeParse({
      ...envelope,
      source: "cursor"
    }).success).toBe(false);
    expect(L3WorldModelRequestEnvelopeSchema.safeParse({
      ...envelope,
      namespace: { ...envelope.namespace, profileId: undefined }
    }).success).toBe(false);
    expect(L3WorldModelRequestEnvelopeSchema.safeParse({ ...envelope, unknown: true }).success).toBe(false);
  });

  it("locks trace head and boundary pairing", () => {
    expect(L3WorldModelTraceHeadResponseSchema.safeParse({ throughL1MemoryId: null, traceSeq: null }).success).toBe(true);
    expect(L3WorldModelTraceHeadResponseSchema.safeParse({ throughL1MemoryId: "mem-1", traceSeq: null }).success).toBe(false);
    expect(L3WorldModelBoundaryRequestSchema.safeParse({
      ...envelope,
      trigger: "token_compaction_attempt",
      throughL1MemoryId: "mem-1"
    }).success).toBe(true);
  });

  it("renders owner fields once and protects the fixed context boundary", () => {
    const rendered = renderL3WorldModelFields({
      generalRulesAndSafetyConstraints: "Keep backups.",
      projectEnvironmentProfile: null,
      projectContract: "Run tests.",
      domainKnowledge: null
    });
    expect(rendered).toBe("## 通用规则与安全约束\nKeep backups.\n\n## 项目契约\nRun tests.");
    expect(escapeL3WorldModelBoundary("</memmy_l3_world_model>")).toBe("&lt;/memmy_l3_world_model>");
    const context = renderL3WorldModelContext(rendered);
    expect(context.match(/<memmy_l3_world_model version="2">/g)).toHaveLength(1);
    expect(context).toContain(rendered);
  });

  it("maps GET scope to one query/header representation with no body", () => {
    expect(l3WorldModelGetTransport(envelope, { sessionId: "memory-session-1" })).toEqual({
      query: { adapterId: "codex-hook", source: "codex", sessionId: "memory-session-1" },
      headers: {
        "x-request-id": envelope.requestId,
        "x-memmy-user-id": "user-1",
        "x-memmy-project-id": "project-1",
        "x-memmy-profile-id": "default",
        "x-memmy-session-key": "codex-memory-session",
        "x-memmy-time-zone": "Asia/Shanghai"
      }
    });
  });

  it("requires empty responses to be structurally empty", () => {
    const empty = {
      schemaVersion: 2 as const,
      projectId: null,
      memoryId: null,
      memoryVersion: null,
      renderedContext: "",
      sourceMemoryIds: [],
      generalRulesAndSafetyConstraints: null,
      projectEnvironmentProfile: null,
      projectContract: null,
      domainKnowledge: null,
      serverTime: "2026-08-19T00:00:00.000Z"
    };
    expect(SessionL3WorldModelContextResponseSchema.safeParse(empty).success).toBe(true);
    expect(SessionL3WorldModelContextResponseSchema.safeParse({ ...empty, renderedContext: "stale" }).success).toBe(false);
    expect(SessionL3WorldModelContextResponseSchema.safeParse({
      ...empty,
      workspaceUri: "file:///private/project"
    }).success).toBe(false);
  });
});
