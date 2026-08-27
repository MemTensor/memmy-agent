/** Adapter tests. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeCodeSourceAdapter } from "../index.js";
import { discoverClaudeCodeSessions } from "../project-discovery.js";
import { readClaudeCodeTranscript } from "../transcript-reader.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("claude code source adapter", () => {
  it("reads only user and assistant transcript rows", async () => {
    const fixture = createFixture();

    const messages = await collect(readClaudeCodeTranscript(fixture.sessionFilePath));

    expect(messages).toEqual([
      expect.objectContaining({
        messageId: "user-uuid",
        conversationId: "session-1",
        role: "user",
        content: "Please use ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN",
        workspacePath: fixture.workspacePath
      }),
      expect.objectContaining({
        messageId: "assistant-uuid",
        role: "assistant",
        content: "I will inspect files.\nThen patch."
      })
    ]);
  });

  it("discovers session files and streams redacted conversation messages", async () => {
    const fixture = createFixture();
    const phases: string[] = [];
    const adapter = createClaudeCodeSourceAdapter({ projectsRoot: fixture.projectsRoot });

    await expect(discoverClaudeCodeSessions({ root: fixture.projectsRoot })).resolves.toEqual([
      expect.objectContaining({ sessionFilePath: fixture.sessionFilePath, workspacePath: fixture.workspacePath })
    ]);

    const messages = await collect(adapter.scan({ onProgress: (progress) => phases.push(progress.phase) }));

    expect(messages).toEqual([
      expect.objectContaining({
        sourceId: "claude_code",
        content: "Please use ANTHROPIC_API_KEY=[REDACTED:anthropic_api_key]"
      }),
      expect.objectContaining({ sourceId: "claude_code", role: "assistant" })
    ]);
    expect(phases).toEqual(expect.arrayContaining(["discover", "read", "redact", "emit", "done"]));
  });

  it("treats a missing projects directory as an empty history", async () => {
    const projectsRoot = join(tmpdir(), `memmy-missing-claude-${crypto.randomUUID()}`);

    await expect(discoverClaudeCodeSessions({ root: projectsRoot })).resolves.toEqual([]);
    await expect(collect(createClaudeCodeSourceAdapter({ projectsRoot }).scan({}))).resolves.toEqual([]);
  });

  it("throws AbortError when scan is aborted before reading", async () => {
    const fixture = createFixture();
    const controller = new AbortController();
    controller.abort();

    await expect(collect(createClaudeCodeSourceAdapter({ projectsRoot: fixture.projectsRoot }).scan({ signal: controller.signal }))).rejects.toMatchObject({
      name: "AbortError"
    });
  });
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) {
    values.push(value);
  }

  return values;
}

function createFixture(): { projectsRoot: string; workspacePath: string; sessionFilePath: string } {
  tempDir = mkdtempSync(join(tmpdir(), "memmy-claude-code-"));
  const projectsRoot = join(tempDir, "projects");
  const workspacePath = join(tempDir, "project");
  const projectSlug = "-tmp-project";
  const projectDirectory = join(projectsRoot, projectSlug);
  const sessionFilePath = join(projectDirectory, "session-1.jsonl");

  mkdirSync(join(workspacePath, ".git"), { recursive: true });
  mkdirSync(projectDirectory, { recursive: true });
  writeFileSync(
    sessionFilePath,
    [
      JSON.stringify({ type: "summary", summary: "skip", sessionId: "session-1" }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "Please use ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN" },
        uuid: "user-uuid",
        timestamp: "2026-05-29T10:00:00.000Z",
        sessionId: "session-1",
        cwd: workspacePath
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I will inspect files." },
            { type: "tool_use", name: "Read" },
            { type: "text", text: "Then patch." }
          ]
        },
        uuid: "assistant-uuid",
        timestamp: "2026-05-29T10:00:01.000Z",
        sessionId: "session-1",
        cwd: workspacePath
      })
    ].join("\n"),
    "utf8"
  );

  return { projectsRoot, workspacePath, sessionFilePath };
}
