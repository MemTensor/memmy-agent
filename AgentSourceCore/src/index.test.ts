import { describe, expect, it } from "vitest";
import { conversationContentHash, orderedTurns, splitTurn, type ConversationMessage } from "./index.js";

const message = (id: string, role: ConversationMessage["role"], content: string, createdAt: string): ConversationMessage => ({
  messageId: id, sourceId: "fixture", conversationId: "conversation", role, content, createdAt,
  workspacePath: null, gitRoot: null, rawMeta: {}
});

describe("agent source core", () => {
  it("emits stable turns across page boundaries", async () => {
    const pages = (async function*() {
      yield message("u1", "user", "hello", "2026-01-01T00:00:00Z");
      yield message("t1", "tool", "tool", "2026-01-01T00:00:01Z");
      yield message("a1", "assistant", "world", "2026-01-01T00:00:02Z");
      yield message("u2", "user", "next", "2026-01-01T00:00:03Z");
      yield message("a2", "assistant", "done", "2026-01-01T00:00:04Z");
    })();
    const turns = [];
    for await (const turn of orderedTurns(pages)) turns.push(turn);
    expect(turns).toHaveLength(2);
    expect(turns.map((turn) => turn.messages[0]?.messageId)).toEqual(["u1", "u2"]);
  });

  it("splits oversized content with unique part hashes", () => {
    const turn = { sourceId: "fixture", conversationId: "conversation", turnIndex: 0, messages: [message("u", "user", "x".repeat(30_000), "2026-01-01T00:00:00Z"), message("a", "assistant", "ok", "2026-01-01T00:00:01Z")] };
    const parts = splitTurn(turn, 4000, 1_000_000);
    expect(parts.length).toBeGreaterThan(1);
    expect(new Set(parts.map((part) => part.contentHash)).size).toBe(parts.length);
    expect(parts.every((part) => Buffer.byteLength(part.content) <= 1_000_000)).toBe(true);
    expect(conversationContentHash(turn.messages)).toHaveLength(64);
  });
});
