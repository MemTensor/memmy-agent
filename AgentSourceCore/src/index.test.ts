import { describe, expect, it } from "vitest";
import { TURN_CONTENT_MAX_BYTES, conversationContentHash, orderedTurns, renderTurn, renderTurnClipped, type ConversationMessage } from "./index.js";

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

  it("keeps one turn as one memory instead of splitting it", () => {
    const turn = { sourceId: "fixture", conversationId: "conversation", turnIndex: 0, messages: [message("u", "user", "x".repeat(30_000), "2026-01-01T00:00:00Z"), message("a", "assistant", "ok", "2026-01-01T00:00:01Z")] };
    const content = renderTurnClipped(turn.messages);
    expect(content).toContain("x".repeat(30_000));
    expect(content).toContain("## assistant");
    expect(content).not.toContain("truncated");
    expect(conversationContentHash(turn.messages)).toHaveLength(64);
  });

  it("clips an oversized turn on a UTF-8 boundary rather than fanning it out", () => {
    const messages = [message("u", "user", "问题", "2026-01-01T00:00:00Z")];
    for (let index = 0; index < 200; index += 1) {
      messages.push(message(`t${index}`, "tool", Array.from({ length: 200 }, () => "汉字测试").join("\n\n"), "2026-01-01T00:00:01Z"));
    }
    const content = renderTurnClipped(messages, 4096);
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(4096);
    expect(content).toMatch(/\[\.\.\. truncated \d+ bytes of tool output \.\.\.\]$/u);
    expect(content.startsWith("## user\n\n问题")).toBe(true);
  });

  it("leaves the turn untouched when it already fits the byte budget", () => {
    const messages = [message("u", "user", "hello", "2026-01-01T00:00:00Z"), message("a", "assistant", "world", "2026-01-01T00:00:01Z")];
    expect(renderTurnClipped(messages, TURN_CONTENT_MAX_BYTES)).toBe("## user\n\nhello\n\n## assistant\n\nworld");
  });

  it.each([
    ["ASCII", "x".repeat(600_000)],
    ["Chinese and emoji", "汉🙂".repeat(160_000)],
    ["escaped control characters", "\u0001".repeat(400_000)],
  ])("bounds both raw UTF-8 and JSON bytes for %s", (_label, text) => {
    const messages = [message("u", "user", "request", "2026-01-01T00:00:00Z"), message("t", "tool", text, "2026-01-01T00:00:01Z")];
    const content = renderTurnClipped(messages);
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(TURN_CONTENT_MAX_BYTES);
    expect(Buffer.byteLength(JSON.stringify(content))).toBeLessThanOrEqual(1024 * 1024);
    expect(content).not.toContain("\ufffd");
    const truncation = /\n\n\[\.\.\. truncated (\d+) bytes of tool output \.\.\.\]$/u.exec(content);
    expect(truncation).not.toBeNull();
    expect(Number(truncation![1])).toBe(Buffer.byteLength(renderTurn(messages)) - Buffer.byteLength(content.slice(0, truncation!.index)));
  });

  it("preserves quoted text and newlines when both budgets allow the complete turn", () => {
    const messages = [message("u", "user", '"\\\n'.repeat(150_000), "2026-01-01T00:00:00Z")];
    expect(renderTurnClipped(messages)).toBe(renderTurn(messages));
  });

  it.each([0, 1, 8, 48])("includes the truncation marker inside a %i-byte budget", (maxBytes) => {
    const content = renderTurnClipped([message("u", "user", "x".repeat(1000), "2026-01-01T00:00:00Z")], maxBytes);
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(maxBytes);
  });
});
