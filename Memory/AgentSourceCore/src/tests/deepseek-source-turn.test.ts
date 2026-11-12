import { describe, expect, it } from "vitest";
import {
  readDeepseekHarnessEvents,
  readDeepseekHarnessSourceTurn,
  sourceTurnFromMessages,
  turnIdFor
} from "../index.js";

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const value of values) items.push(value);
  return items;
}

const events = [
  { type: "session", id: "session-1", cwd: "/project", agentPreset: "standard" },
  { type: "turn/start", seq: 0, time: 1_780_404_000_000, data: { turn: 1 } },
  {
    type: "user/message",
    seq: 1,
    time: 1_780_404_001_000,
    data: { id: "user-1", source: { kind: "user" }, content: [{ type: "text", text: "Search dsh" }] }
  },
  {
    type: "user/message",
    seq: 2,
    time: 1_780_404_001_100,
    data: { id: "plugin-1", source: { kind: "plugin" }, content: [{ type: "text", text: "injected" }] }
  },
  {
    type: "assistant/message",
    seq: 3,
    time: 1_780_404_002_000,
    data: { message: { id: "assistant-1", content: [{ type: "text", text: "Looking" }] } }
  },
  { type: "tool/call", seq: 4, time: 1_780_404_002_100, data: { callId: "call-1", name: "read", arguments: { path: "a" } } },
  {
    type: "tool/result",
    seq: 5,
    time: 1_780_404_002_200,
    data: { message: { source: { callId: "call-1" }, content: [{ type: "text", text: "ok" }] } }
  },
  {
    type: "assistant/message",
    seq: 6,
    time: 1_780_404_003_000,
    data: { message: { id: "assistant-2", content: [{ type: "text", text: "Done" }] } }
  },
  { type: "turn/end", seq: 7, time: 1_780_404_004_000, data: { turn: 1, reason: { kind: "completed" } } },
  { type: "turn/start", seq: 8, time: 1_780_404_005_000, data: { turn: 2 } },
  {
    type: "user/message",
    seq: 9,
    time: 1_780_404_006_000,
    data: { id: "user-2", source: { kind: "user" }, content: [{ type: "text", text: "cancel this" }] }
  },
  { type: "turn/end", seq: 10, time: 1_780_404_007_000, data: { turn: 2, reason: { kind: "aborted" } } }
];

describe("DeepSeek Harness native source turns", () => {
  it("uses {session}:{turn} and pairs tools by callId", async () => {
    const messages = await collect(readDeepseekHarnessEvents(events));
    const turn = sourceTurnFromMessages(messages.filter((message) => message.rawMeta.sourceTurnId === "session-1:1"));
    expect(turn).toMatchObject({
      source: "deepseek_harness",
      conversationId: "session-1",
      turnId: turnIdFor("session-1", 1),
      profileId: "standard",
      query: "Search dsh",
      answer: "Looking\n\nDone",
      completionEvidence: "turn_end:session-1:1:completed",
      status: "succeeded"
    });
    expect(turn?.toolCalls).toEqual([expect.objectContaining({ id: "call-1", name: "read", input: { path: "a" }, output: "ok" })]);
    expect(messages.some((message) => message.content.includes("injected"))).toBe(false);
  });

  it("does not emit an aborted or incomplete turn", async () => {
    const messages = await collect(readDeepseekHarnessEvents(events));
    expect(sourceTurnFromMessages(messages.filter((message) => message.rawMeta.sourceTurnId === "session-1:2"))).toBeNull();
    const pending = await readDeepseekHarnessSourceTurn(events.slice(0, 4), { conversationId: "session-1", turn: 1 });
    expect(pending).toEqual({ turn: null, reason: "turn_incomplete" });
  });

  it("lets the plugin reread the same turn the scan would write", async () => {
    const parsed = await readDeepseekHarnessSourceTurn(events, { conversationId: "session-1", turn: 1 });
    expect(parsed.turn?.turnId).toBe("session-1:1");
    expect(parsed.turn?.query).toBe("Search dsh");
  });
});
