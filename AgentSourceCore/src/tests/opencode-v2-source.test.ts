import { describe, expect, it } from "vitest";
import {
  readOpencodeSourceTurn,
  toOpencodeV2MessageParts,
  toOpencodeV2MessageView,
  toOpencodeV2Session,
  type OpencodeSource,
  type OpencodeV2MessageRow
} from "../index.js";

describe("OpenCode V2 row mappers", () => {
  it("maps a session_v2 row onto the shared session shape", () => {
    expect(toOpencodeV2Session({
      id: "ses_1",
      parentId: null,
      directory: "/work/project",
      agent: "build",
      revert: "{\"messageID\":\"msg_9\"}"
    })).toEqual({
      id: "ses_1",
      parentId: null,
      directory: "/work/project",
      agent: "build",
      revertMessageId: "msg_9"
    });
    expect(toOpencodeV2Session({ id: "ses_2", parentId: "ses_1", directory: null }).revertMessageId).toBeNull();
  });

  it("groups assistants under the latest preceding user row and drops bookkeeping rows", () => {
    const rows: OpencodeV2MessageRow[] = [
      { id: "a0", type: "assistant", seq: 0, data: { agent: "build", time: { created: 0 }, content: [] } },
      { id: "m1", type: "model-switched", seq: 1, data: {} },
      { id: "u1", type: "user", seq: 2, data: { text: "first", time: { created: 1 } } },
      { id: "a1", type: "assistant", seq: 3, data: { agent: "build", time: { created: 2, completed: 3 }, content: [] } },
      { id: "i1", type: "idle", seq: 4, data: {} },
      { id: "a2", type: "assistant", seq: 5, data: { agent: "build", time: { created: 4, completed: 5 }, content: [] } },
      { id: "u2", type: "user", seq: 6, data: { text: "second", time: { created: 6 } } },
      { id: "a3", type: "assistant", seq: 7, data: { agent: "build", time: { created: 7, completed: 8 }, content: [] } }
    ];
    const view = toOpencodeV2MessageView(rows);
    expect(view.map((row) => row.id)).toEqual(["u1", "a1", "a2", "u2", "a3"]);
    expect(view[1].data).toMatchObject({ role: "assistant", parentID: "u1", agent: "build", finish: "stop" });
    expect(view[4].data).toMatchObject({ role: "assistant", parentID: "u2" });
    expect(view[1].data?.finish).toBe("stop");
  });

  it("marks streaming assistants without a completion timestamp as unfinished", () => {
    const view = toOpencodeV2MessageView([
      { id: "u1", type: "user", seq: 1, data: { text: "q", time: { created: 1 } } },
      { id: "a1", type: "assistant", seq: 2, data: { agent: "build", time: { created: 2 }, content: [] } }
    ]);
    expect(view[1].data?.finish).toBeUndefined();
  });

  it("synthesizes a text part for user rows and maps inline content for assistant rows", () => {
    expect(toOpencodeV2MessageParts({ id: "u1", type: "user", seq: 1, data: { text: "hello" } }))
      .toEqual([{ id: "u1:text", data: { type: "text", text: "hello" } }]);
    expect(toOpencodeV2MessageParts({ id: "u2", type: "user", seq: 2, data: {} })).toEqual([]);
    const parts = toOpencodeV2MessageParts({
      id: "a1",
      type: "assistant",
      seq: 3,
      data: {
        content: [
          { type: "reasoning", text: "internal" },
          { type: "text", text: "done" },
          { type: "tool", id: "call_1", name: "read", state: { status: "completed", input: { path: "/x" }, output: "ok" } },
          { type: "tool", name: "unnamed" },
          { type: "compaction" }
        ]
      }
    });
    expect(parts).toEqual([
      { id: "a1:1", data: { type: "text", text: "done" } },
      {
        id: "a1:2",
        data: {
          type: "tool",
          callID: "call_1",
          tool: "read",
          state: { status: "completed", input: { path: "/x" }, output: "ok" }
        }
      },
      { id: "a1:3", data: { type: "tool", callID: undefined, tool: "unnamed" } },
      { id: "a1:4", data: { type: "compaction" } }
    ]);
  });

  it("feeds the shared turn parser: a completed V2 turn captures with paired tools", async () => {
    const source = createSource({
      main: [
        userRow("u1", "Inspect the configuration and report the result.", 1_000),
        assistantRow("a1", "build", 2_000, 3_000, [{ type: "tool", id: "call_1", name: "read", state: { status: "completed", input: { path: "config" }, output: "Configuration verified." } }]),
        assistantRow("a2", "build", 4_000, 5_000, [{ type: "text", text: "The configuration was verified." }])
      ]
    });
    const result = await readOpencodeSourceTurn(source, { conversationId: "main", turnId: "u1" });
    expect(result.turn).toBeDefined();
    expect(result.turn?.query).toBe("Inspect the configuration and report the result.");
    expect(result.turn?.answer).toBe("The configuration was verified.");
    expect(result.turn?.profileId).toBe("build");
    expect(result.turn?.toolCalls).toHaveLength(1);
    expect(result.turn?.toolCalls[0]).toMatchObject({ name: "read", status: "completed" });
    expect(result.turn?.completionEvidence).toBe("assistant_completed:a2");
  });

  it("feeds the shared turn parser: an unfinished last assistant is left for a later attempt", async () => {
    const source = createSource({
      main: [
        userRow("u1", "still running", 1_000),
        assistantRow("a1", "build", 2_000, undefined, [{ type: "text", text: "partial" }])
      ]
    });
    const result = await readOpencodeSourceTurn(source, { conversationId: "main", turnId: "u1" });
    expect(result.turn).toBeNull();
    expect(result.reason).toBe("turn_incomplete");
  });
});

function userRow(id: string, text: string, created: number): OpencodeV2MessageRow {
  return { id, type: "user", seq: created, data: { text, time: { created } } };
}

function assistantRow(
  id: string,
  agent: string,
  created: number,
  completed: number | undefined,
  content: unknown[]
): OpencodeV2MessageRow {
  return {
    id,
    type: "assistant",
    seq: created,
    data: {
      agent,
      time: completed === undefined ? { created } : { created, completed },
      content
    }
  };
}

function createSource(sessions: Record<string, OpencodeV2MessageRow[]>): OpencodeSource {
  const rowsByMessage = new Map<string, OpencodeV2MessageRow>();
  for (const rows of Object.values(sessions)) {
    for (const row of rows) rowsByMessage.set(row.id, row);
  }
  return {
    sessions: () => Object.keys(sessions).map((id) =>
      toOpencodeV2Session({ id, parentId: null, directory: "/work/project", agent: "build" })),
    messages: (sessionId) => toOpencodeV2MessageView(sessions[sessionId] ?? []),
    parts: (messageId) => {
      const row = rowsByMessage.get(messageId);
      return row ? toOpencodeV2MessageParts(row) : [];
    }
  };
}
