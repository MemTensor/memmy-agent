import { describe, expect, it } from "vitest";
import { collectConversationWindow } from "../conversation-window.js";

describe("collectConversationWindow", () => {
  it("keeps the complete conversation when only its final message crosses the incremental cursor", async () => {
    const messages = [
      { conversationId: "old", createdAt: "2026-05-28T09:00:00.000Z", id: "old-user" },
      { conversationId: "old", createdAt: "2026-05-28T09:01:00.000Z", id: "old-assistant" },
      { conversationId: "updated", createdAt: "2026-05-28T09:30:00.000Z", id: "updated-user" },
      { conversationId: "updated", createdAt: "2026-05-28T10:01:00.000Z", id: "updated-assistant" }
    ];

    const selected = await collectConversationWindow(
      toAsyncIterable(messages),
      "2026-05-28T10:00:00.000Z"
    );

    expect(selected.map((message) => message.id)).toEqual(["updated-user", "updated-assistant"]);
  });

  it("does not split the first selected conversation at a message limit", async () => {
    const messages = [
      { conversationId: "one", createdAt: "2026-05-28T10:00:00.000Z", id: "one-user" },
      { conversationId: "one", createdAt: "2026-05-28T10:00:01.000Z", id: "one-tool" },
      { conversationId: "one", createdAt: "2026-05-28T10:00:02.000Z", id: "one-assistant" },
      { conversationId: "two", createdAt: "2026-05-28T10:00:03.000Z", id: "two-user" }
    ];

    const selected = await collectConversationWindow(toAsyncIterable(messages), undefined, undefined, 1);

    expect(selected.map((message) => message.id)).toEqual(["one-user", "one-tool", "one-assistant"]);
  });

  it("does not read another target after the source-wide message budget is exhausted", async () => {
    const selected = await collectConversationWindow(
      toAsyncIterable([{ conversationId: "one", createdAt: "2026-05-28T10:00:00.000Z", id: "one-user" }]),
      undefined,
      undefined,
      0
    );

    expect(selected).toEqual([]);
  });
});

async function* toAsyncIterable<T>(items: readonly T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}
