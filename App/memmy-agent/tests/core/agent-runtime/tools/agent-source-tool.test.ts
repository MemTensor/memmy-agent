import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCompleteTurns,
  renderFullMemorySkill,
  resolveSyncBoundaryAt,
  selectTurns
} from "../../../../src/core/agent-runtime/tools/agent-source.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("AgentSourceTool history selection", () => {
  it("keeps the latest 500 complete turns and exposes the 500th timestamp as the boundary", () => {
    const messages = Array.from({ length: 505 }, (_, index) => {
      const createdAt = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
      return [
        {
          messageId: `user-${index}`,
          conversationId: `conversation-${index}`,
          role: "user" as const,
          content: `question ${index}`,
          createdAt
        },
        {
          messageId: `assistant-${index}`,
          conversationId: `conversation-${index}`,
          role: "assistant" as const,
          content: `answer ${index}`,
          createdAt
        }
      ];
    }).flat();

    const selected = selectTurns(buildCompleteTurns(messages), "initial_subset", null);

    expect(selected).toHaveLength(500);
    expect(selected[0]?.messages[0]?.messageId).toBe("user-504");
    expect(selected.at(-1)?.messages[0]?.messageId).toBe("user-5");
  });

  it("filters incremental turns after the recorded boundary and ignores incomplete turns", () => {
    const messages = [
      message("old-user", "old", "user", "2026-07-01T09:00:00.000Z"),
      message("old-assistant", "old", "assistant", "2026-07-01T09:00:01.000Z"),
      message("new-user", "new", "user", "2026-07-01T11:00:00.000Z"),
      message("new-assistant", "new", "assistant", "2026-07-01T11:00:01.000Z"),
      message("incomplete-user", "incomplete", "user", "2026-07-01T12:00:00.000Z")
    ];

    const selected = selectTurns(
      buildCompleteTurns(messages),
      "incremental",
      "2026-07-01T10:00:00.000Z"
    );

    expect(selected).toHaveLength(1);
    expect(selected[0]?.messages.map((item) => item.messageId)).toEqual(["new-user", "new-assistant"]);
  });

  it("requires an initial boundary before incremental sync", () => {
    expect(() => selectTurns([], "incremental", null)).toThrow("recorded initial sync boundary");
  });

  it("does not create a synthetic boundary for an empty initial scan", () => {
    expect(() => resolveSyncBoundaryAt("initial_subset", [], null)).toThrow(
      "no sync boundary was recorded"
    );
  });
});

describe("AgentSourceTool Skill rendering", () => {
  it("keeps the onboarding Skill and every bundled reference English-only", () => {
    const skillRoot = path.resolve("src/skills/agent-memory-onboarding");
    const files = listTextFiles(skillRoot);
    const nonEnglish = files.flatMap((file) => {
      const content = fs.readFileSync(file, "utf8");
      return /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u.test(content)
        ? [path.relative(skillRoot, file)]
        : [];
    });

    expect(nonEnglish).toEqual([]);
  });

  it("replaces every source placeholder with the shell-quoted user-entered Agent name", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-agent-source-"));
    tempRoots.push(workspace);
    const result = renderFullMemorySkill(workspace, "manual-id-1", "Agent $HOME's");
    const rendered = fs.readFileSync(result.skillPath, "utf8");

    expect(result.memorySource).toBe("Agent $HOME's");
    expect(result.skillPath.startsWith(workspace)).toBe(true);
    expect(rendered).not.toContain("{{SOURCE_ARG}}");
    expect(rendered).toContain("--source 'Agent $HOME'\"'\"'s'");
  });
});

function listTextFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return listTextFiles(target);
    return entry.isFile() ? [target] : [];
  });
}

function message(
  messageId: string,
  conversationId: string,
  role: "user" | "assistant",
  createdAt: string
) {
  return {
    messageId,
    conversationId,
    role,
    content: messageId,
    createdAt
  };
}
