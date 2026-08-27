import { describe, expect, it } from "vitest";
import { FeishuChannel } from "../../../src/integrations/channels/feishu.js";

describe("Feishu mention resolution", () => {
  it("replaces a single mention placeholder", () => {
    const result = FeishuChannel.resolveMentions("hello @_user_1 how are you", [
      { key: "@_user_1", name: "Alice", id: { open_id: "ou_abc123" } },
    ]);

    expect(result).toContain("@Alice (ou_abc123)");
    expect(result).not.toContain("@_user_1");
  });

  it("includes both open_id and user_id when both are available", () => {
    const result = FeishuChannel.resolveMentions("@_user_1 said hi", [
      { key: "@_user_1", name: "Bob", id: { open_id: "ou_abc", user_id: "uid_456" } },
    ]);

    expect(result).toContain("@Bob (ou_abc, user id: uid_456)");
  });

  it("replaces mention placeholders with names and ids", () => {
    const result = FeishuChannel.resolveMentions("@_user_1 and @_user_2", [
      { key: "@_user_1", name: "Alice", id: { open_id: "ou_a" } },
      { key: "@_user_2", name: "Bob", id: { open_id: "ou_b", user_id: "uid_b" } },
    ]);

    expect(result).toContain("@Alice (ou_a)");
    expect(result).toContain("@Bob (ou_b, user id: uid_b)");
    expect(result).not.toContain("@_user_1");
  });

  it("leaves placeholders unchanged when mention ids are missing", () => {
    expect(FeishuChannel.resolveMentions("@_user_1 said hi", [{ key: "@_user_1", name: "Charlie", id: null }])).toBe(
      "@_user_1 said hi",
    );
  });

  it("returns text unchanged when no mentions are supplied", () => {
    expect(FeishuChannel.resolveMentions("hello world", null)).toBe("hello world");
    expect(FeishuChannel.resolveMentions("hello world", [])).toBe("hello world");
  });

  it("returns empty text unchanged", () => {
    expect(FeishuChannel.resolveMentions("", [{ key: "@_user_1", name: "Alice", id: { open_id: "ou_a" } }])).toBe("");
  });

  it("skips mention keys that are not present in the text", () => {
    expect(FeishuChannel.resolveMentions("hello world", [{ key: "@_user_99", name: "Ghost", id: { open_id: "ou_ghost" } }])).toBe(
      "hello world",
    );
  });

  it("leaves text unchanged when mention data is absent or incomplete", () => {
    expect(FeishuChannel.resolveMentions("hello world", null)).toBe("hello world");
    expect(FeishuChannel.resolveMentions("@_user_1 said hi", [{ key: "@_user_1", name: "NoId" }])).toBe("@_user_1 said hi");
  });
});
