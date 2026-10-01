import { describe, expect, it } from "vitest";
import { buildSourceTurnRequest, readOpencodeSourceTurn } from "@memmy/agent-source-core";
import { createMemoryServiceFixture } from "../../fixtures/memory-service-fixture.js";

const STRUCTURED_OUTPUT = { verified: true, result: "The configuration was verified and documented." };
const CASES = ["structured-final-tool-calls", "structured-final-stop", "structured-final-unknown"] as const;

describe("OpenCode StructuredOutput source captures", () => {
  it.each(CASES)("reuses one capture for %s in both channel orders", async (finishName) => {
    const finish = finishName.replace("structured-final-", "");
    const hook = await readOpencodeSourceTurn(structuredSource(finish), {
      conversationId: finishName,
      turnId: "u"
    });
    const scan = await readOpencodeSourceTurn(structuredSource(finish), {
      conversationId: finishName,
      turnId: "u"
    });
    expect(hook.turn?.answer).toBe("");
    expect(hook.turn?.toolCalls[0]).toMatchObject({ name: "StructuredOutput", input: STRUCTURED_OUTPUT });
    expect(scan.turn).toEqual(hook.turn);
    for (const order of ["hook-first", "scan-first"] as const) {
      const fixture = createMemoryServiceFixture();
      try {
        const { db, service } = fixture.createTestService();
        const hookRequest = {
          ...buildSourceTurnRequest(hook.turn!, "hook"),
          namespace: { source: "opencode", profileId: hook.turn!.profileId!, userId: "source-user" }
        };
        const scanRequest = {
          ...buildSourceTurnRequest(scan.turn!, "agent_source_scan"),
          namespace: { source: "opencode", profileId: scan.turn!.profileId!, userId: "source-user" }
        };
        const first = order === "hook-first" ? hookRequest : scanRequest;
        const second = order === "hook-first" ? scanRequest : hookRequest;
        expect(service.completeSourceTurn(first).status).toBe("stored");
        expect(service.completeSourceTurn(second).status).toBe("existing");
        expect(db.db.prepare("SELECT COUNT(*) AS count FROM source_turn_captures").get()).toEqual({ count: 1 });
      } finally {
        fixture.cleanup();
      }
    }
  });
});

function structuredSource(finish: string) {
  return {
    sessions: () => [{ id: `structured-final-${finish}`, parentId: null, directory: null, agent: "mutable-session-agent" }],
    messages: () => [
      {
        id: "u",
        data: {
          role: "user",
          agent: "build",
          time: { created: 4_070_944_800_000 },
          format: { type: "json_schema", schema: { type: "object" } }
        }
      },
      {
        id: "a",
        data: {
          role: "assistant",
          parentID: "u",
          agent: "build",
          finish,
          structured: STRUCTURED_OUTPUT,
          time: { created: 4_070_944_801_000, completed: 4_070_944_802_000 }
        }
      }
    ],
    parts: (messageId: string) => messageId === "u"
      ? [{ id: "pu", data: { type: "text", text: "Inspect the configuration and report the verified result." } }]
      : [{
        id: "pt",
        data: {
          type: "tool",
          callID: "call1",
          tool: "StructuredOutput",
          state: {
            status: "completed",
            input: STRUCTURED_OUTPUT,
            output: "Structured output captured successfully.",
            metadata: { valid: true }
          }
        }
      }]
  };
}
