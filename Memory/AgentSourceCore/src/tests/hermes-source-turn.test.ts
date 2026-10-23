import { describe, expect, it } from "vitest";
import {
  readHermesSession,
  readHermesSourceTurn,
  resolveHermesTurnId,
  sourceTurnFromMessages,
  type HermesRow,
  type HermesSource
} from "../index.js";

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const value of values) items.push(value);
  return items;
}

function source(rows: HermesRow[]): HermesSource {
  return {
    sessions: () => [{ id: "hermes-1", cwd: "/project" }],
    messages: () => rows
  };
}

const row = (
  id: number,
  role: string,
  content: string | null,
  extra: Partial<HermesRow> = {}
): HermesRow => ({
  id,
  role,
  content,
  toolCallId: extra.toolCallId ?? null,
  toolCalls: extra.toolCalls ?? null,
  toolName: extra.toolName ?? null,
  timestamp: extra.timestamp ?? 1_780_404_000 + id,
  finishReason: extra.finishReason ?? null,
  compressedSummary: extra.compressedSummary ?? null,
  active: extra.active ?? 1,
  compacted: extra.compacted ?? null
});

describe("Hermes native source turns", () => {
  it("uses the earliest user row id after compaction copies", async () => {
    const rows = [
      row(7, "user", "look up the site", { timestamp: 100, active: 0, compacted: 1 }),
      row(8, "assistant", "checking", { timestamp: 101, finishReason: "stop", active: 0, compacted: 1 }),
      row(29, "user", "look up the site", { timestamp: 100, active: 1 }),
      row(30, "assistant", "checking", { timestamp: 101, finishReason: "stop", active: 1 })
    ];
    const db = source(rows);
    expect(resolveHermesTurnId(db, "hermes-1", "look up the site")).toBe("hermes-1:7");
    const parsed = await readHermesSourceTurn(db, { conversationId: "hermes-1", userContent: "look up the site" });
    expect(parsed.turn).toMatchObject({
      source: "hermes",
      conversationId: "hermes-1",
      turnId: "hermes-1:7",
      query: "look up the site",
      answer: "checking",
      completionEvidence: "assistant_stop:8"
    });
  });

  it("keeps a compacted turn that lost its replayed user row", async () => {
    const rows = [
      row(14, "user", "official website?", { timestamp: 200, active: 0, compacted: 1 }),
      row(15, "assistant", null, {
        timestamp: 201,
        toolCalls: JSON.stringify([{ id: "toolu_1", function: { name: "web", arguments: { q: "site" } } }]),
        active: 0,
        compacted: 1
      }),
      row(16, "tool", "found it", { timestamp: 202, toolCallId: "toolu_1", active: 0, compacted: 1 }),
      row(17, "assistant", "latest is 1.2", { timestamp: 203, finishReason: "stop", active: 0, compacted: 1 }),
      row(32, "assistant", "[PRIOR CONTEXT — archived]", { timestamp: 204, compressedSummary: 1, active: 1 })
    ];
    const messages = await collect(readHermesSession(source(rows), { id: "hermes-1", cwd: "/project" }));
    const turn = sourceTurnFromMessages(messages);
    expect(turn).toMatchObject({
      turnId: "hermes-1:14",
      query: "official website?",
      answer: "latest is 1.2"
    });
    expect(turn?.toolCalls).toEqual([expect.objectContaining({ id: "toolu_1", name: "web", output: "found it" })]);
    expect(messages.some((message) => message.content.includes("PRIOR CONTEXT"))).toBe(false);
  });

  it("omits missing tool ids and null tool output instead of serializing null", async () => {
    const missingId = await readHermesSourceTurn(source([
      row(1, "user", "Inspect the connection configuration and summarize the problem."),
      row(2, "assistant", null, { toolCalls: JSON.stringify([{ function: { name: "read", arguments: { path: "config" } } }]) }),
      row(3, "tool", "configuration data", { toolCallId: null }),
      row(4, "assistant", "The configuration is now documented.", { finishReason: "stop" })
    ]), { conversationId: "hermes-1", userContent: "Inspect the connection configuration and summarize the problem." });
    const nullOutput = await readHermesSourceTurn(source([
      row(1, "user", "Inspect the connection configuration and summarize the problem."),
      row(2, "assistant", null, { toolCalls: JSON.stringify([{ id: "call1", function: { name: "read", arguments: { path: "config" } } }]) }),
      row(3, "tool", null, { toolCallId: "call1" }),
      row(4, "assistant", "The configuration is now documented.", { finishReason: "stop" })
    ]), { conversationId: "hermes-1", userContent: "Inspect the connection configuration and summarize the problem." });
    expect(missingId.turn?.toolCalls).toEqual([expect.objectContaining({ name: "read" })]);
    expect(missingId.turn?.toolCalls[0]).not.toHaveProperty("id");
    expect(missingId.turn?.toolResults[0]).not.toHaveProperty("id");
    expect(nullOutput.turn?.toolResults[0]).toMatchObject({ id: "call1", status: "completed", success: true });
    expect(nullOutput.turn?.toolResults[0]).not.toHaveProperty("output");
  });

  it("skips an undone turn that has no active copy", async () => {
    const rows = [
      row(25, "user", "undo me", { timestamp: 300, active: 0, compacted: 0 }),
      row(26, "assistant", "gone", { timestamp: 301, finishReason: "stop", active: 0, compacted: 0 })
    ];
    const messages = await collect(readHermesSession(source(rows), { id: "hermes-1", cwd: null }));
    expect(messages).toEqual([]);
    expect(await readHermesSourceTurn(source(rows), { conversationId: "hermes-1", userContent: "undo me" }))
      .toEqual({ turn: null, reason: "identity_unresolved" });
  });
});
