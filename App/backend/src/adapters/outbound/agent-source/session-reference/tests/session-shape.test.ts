import { describe, expect, it } from "vitest";
import type { SourceAdapter } from "@memmy/agent-source-readers/adapters/types";
import { finishSession } from "../session-shape.js";

/**
 * 没问到人能读的提问时，标题退回目录名：Windows 的路径是反斜杠，按 `/` 取末段会把整串路径当成标题。
 */
describe("the title of a session nobody asked anything useful in", () => {
  it("names Windows sessions after their folder", () => {
    const session = finishSession(
      adapter(),
      () => null,
      "c-1",
      {
        workspacePath: "C:\\work\\MemOS_Product\\",
        updatedAt: "2026-11-01T02:00:00.000Z",
        nativeTitle: "",
        // 纯链接不像是人问的话，标题只能退回目录名。
        turns: [{ question: "https://example.com/memmy", reply: "" }]
      }
    );
    expect(session?.title.startsWith("MemOS_Product · ")).toBe(true);
  });
});

function adapter(): SourceAdapter {
  return {
    descriptor: { sourceId: "codex", displayName: "Codex", builtin: true, dataPath: "/nonexistent-memmy-test/codex/sessions" },
    detect: async () => false,
    scan: async function* () {}
  };
}
