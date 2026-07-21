/** Agent sources contracts tests. */
import { describe, expect, it } from "vitest";
import {
  AddManualInputSchema,
  AgentSourceIdParamsSchema,
  AgentSourceScanInputSchema,
  AgentSourceScanJobResponseSchema,
  AgentSourceViewSchema,
  OkResponseSchema,
  ScanCompletedSseEventSchema,
  ScanProgressSseEventSchema,
  ScanResultSchema,
  SseEventSchema
} from "@memmy/local-api-contracts";

describe("agent source contracts", () => {
  it("parses agent source views, scan results, and manual add input", () => {
    expect(
      AgentSourceViewSchema.parse({
        sourceId: "cursor",
        displayName: "Cursor",
        dataPath: "/Users/test/Library/Application Support/Cursor",
        builtin: true,
        available: true,
        status: "skill_installed",
        messageCount: 12,
        lastScannedAt: "2026-05-28T10:00:00.000Z"
      })
    ).toMatchObject({
      sourceId: "cursor",
      status: "skill_installed",
      messageCount: 12
    });

    expect(
      ScanResultSchema.parse({
        sourceId: "cursor",
        discoveredConversations: 2,
        emittedMessages: 10,
        skipped: 1,
        errors: [{ conversationId: "conv-1", reason: "bad row" }]
      })
    ).toMatchObject({
      emittedMessages: 10,
      skipped: 1
    });

    expect(
      AddManualInputSchema.parse({
        displayName: "Custom Agent",
        dataPath: "/tmp/custom-agent"
      })
    ).toEqual({
      displayName: "Custom Agent",
        dataPath: "/tmp/custom-agent"
      });

    expect(AgentSourceIdParamsSchema.parse({ sourceId: "cursor" })).toEqual({ sourceId: "cursor" });
    expect(AgentSourceScanInputSchema.parse(undefined)).toEqual({ sourceId: "all" });
    expect(AgentSourceScanInputSchema.parse({ sourceId: "openclaw" })).toEqual({ sourceId: "openclaw" });
    expect(AgentSourceScanJobResponseSchema.parse({ jobId: "job-1" })).toEqual({ jobId: "job-1" });
    expect(OkResponseSchema.parse({ ok: true })).toEqual({ ok: true });
  });

  it("includes agent source scan progress and completion in the SSE union", () => {
    const progress = ScanProgressSseEventSchema.parse({
      id: "event-1",
      type: "agent_source.scan_progress",
      timestamp: "2026-05-28T10:00:00.000Z",
      payload: {
        jobId: "job-1",
        sourceId: "cursor",
        phase: "scan",
        current: 1,
        total: 3,
        message: "reading workspace"
      }
    });

    const completed = ScanCompletedSseEventSchema.parse({
      id: "event-2",
      type: "agent_source.scan_completed",
      timestamp: "2026-05-28T10:00:01.000Z",
      payload: {
        jobId: "job-1",
        sourceId: "cursor",
        results: [
          {
            sourceId: "cursor",
            discoveredConversations: 1,
            emittedMessages: 2,
            skipped: 0,
            errors: []
          }
        ]
      }
    });

    expect(SseEventSchema.parse(progress).type).toBe("agent_source.scan_progress");
    expect(SseEventSchema.parse(completed).type).toBe("agent_source.scan_completed");
  });
});
