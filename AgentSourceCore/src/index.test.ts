import { describe, expect, it } from "vitest";
import { conversationContentHash, estimateTokens, orderedTurns, splitTurn, type ConversationMessage } from "./index.js";

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

  it("does not re-emit flushed text when splitting multi-line content", () => {
    const lines = Array.from({ length: 350 }, (_, index) => `line ${index} ${"y".repeat(40)}`);
    const content = lines.join("\n");
    const turn = { sourceId: "fixture", conversationId: "conversation", turnIndex: 0, messages: [message("u", "user", content, "2026-01-01T00:00:00Z"), message("a", "assistant", "ok", "2026-01-01T00:00:01Z")] };
    const parts = splitTurn(turn, 4000, 1_000_000);
    const emitted = parts.reduce((total, part) => total + part.content.length, 0);
    expect(emitted).toBeLessThan(content.length * 2);
    for (const line of lines) expect(parts.filter((part) => part.content.includes(line))).toHaveLength(1);
  });

  it("keeps every multi-line part within the token budget", () => {
    const content = Array.from({ length: 350 }, (_, index) => `line ${index} ${"y".repeat(40)}`).join("\n");
    const turn = { sourceId: "fixture", conversationId: "conversation", turnIndex: 0, messages: [message("u", "user", content, "2026-01-01T00:00:00Z"), message("a", "assistant", "ok", "2026-01-01T00:00:01Z")] };
    const parts = splitTurn(turn, 4000, 1_000_000);
    expect(parts.every((part) => estimateTokens(part.content) <= 4000)).toBe(true);
  });

  it("splits multibyte content on byte boundaries without losing characters", () => {
    const content = Array.from({ length: 200 }, () => "汉字测试").join("\n");
    const turn = { sourceId: "fixture", conversationId: "conversation", turnIndex: 0, messages: [message("u", "user", content, "2026-01-01T00:00:00Z"), message("a", "assistant", "ok", "2026-01-01T00:00:01Z")] };
    const parts = splitTurn(turn, 1_000_000, 512);
    expect(parts.every((part) => Buffer.byteLength(part.content) <= 512)).toBe(true);
    const emitted = parts.reduce((total, part) => total + (part.content.match(/汉/gu) ?? []).length, 0);
    expect(emitted).toBe(200);
  });
});
