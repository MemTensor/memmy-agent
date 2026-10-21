/** Adapter tests. */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readClaudeCodeSourceTurn, sourceTurnFailureReason, sourceTurnFromMessages } from "@memmy/agent-source-core";
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
  it("stages one native turn per human prompt with tools paired by tool_use id", async () => {
    const fixture = createFixture();

    const messages = await collect(readClaudeCodeTranscript(fixture.sessionFilePath));
    const turn = sourceTurnFromMessages(messages);

    expect(turn).toMatchObject({
      source: "claude_code",
      conversationId: "session-1",
      turnId: "prompt-1",
      completionEvidence: "end_turn:assistant-final",
      startedAt: "2026-05-29T10:00:00.000Z",
      completedAt: "2026-05-29T10:00:03.000Z",
      answer: "I will inspect files.\nThen patch.\n\nDone.",
      status: "succeeded"
    });
    expect(turn?.query).toBe("Please use ANTHROPIC_API_KEY=[REDACTED:anthropic_api_key]");
    expect(turn?.toolCalls).toEqual([
      expect.objectContaining({ id: "toolu_read_1", name: "Read", output: "file body" })
    ]);
    const hookResult = await readClaudeCodeSourceTurn(fixture.sessionFilePath, {
      conversationId: "session-1", promptId: "prompt-1", stop: true
    });
    expect(hookResult.turn).toEqual(turn);
  });

  it("keeps a turn with an unanswered tool call unsubmitted so the scan can retry it", async () => {
    const fixture = createFixture({ withToolResult: false });

    const messages = await collect(readClaudeCodeTranscript(fixture.sessionFilePath));

    expect(sourceTurnFromMessages(messages)).toBeNull();
    expect(sourceTurnFailureReason(messages)).toBe("turn_incomplete");
  });

  it.each(["tool_use", "max_tokens", "pause_turn", null])(
    "does not treat assistant stop_reason %s as successful completion",
    async (stopReason) => {
      const fixture = createFixture({ stopReason });

      const messages = await collect(readClaudeCodeTranscript(fixture.sessionFilePath));

      expect(sourceTurnFromMessages(messages)).toBeNull();
      expect(sourceTurnFailureReason(messages)).toBe("turn_incomplete");
    }
  );

  it("does not use turn_duration as completion evidence without end_turn", async () => {
    const fixture = createFixture({ stopReason: null });
    appendFileSync(fixture.sessionFilePath, `\n${JSON.stringify({
      type: "system", subtype: "turn_duration", sessionId: "session-1",
      uuid: "duration-uuid", timestamp: "2026-05-29T10:00:04.000Z"
    })}`);

    const messages = await collect(readClaudeCodeTranscript(fixture.sessionFilePath));

    expect(sourceTurnFromMessages(messages)).toBeNull();
    expect(sourceTurnFailureReason(messages)).toBe("turn_incomplete");
  });

  it("does not reuse an earlier end_turn when the SDK continues the same human turn", async () => {
    const fixture = createFixture({ stopReason: "end_turn" });
    appendFileSync(fixture.sessionFilePath, `\n${JSON.stringify({
      type: "assistant",
      sessionId: "session-1",
      uuid: "assistant-continuation",
      timestamp: "2026-05-29T10:00:04.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Still working." }], stop_reason: null }
    })}`);

    const messages = await collect(readClaudeCodeTranscript(fixture.sessionFilePath));

    expect(sourceTurnFromMessages(messages)).toBeNull();
    expect(sourceTurnFailureReason(messages)).toBe("turn_incomplete");
  });

  it("does not stage sidechain rows as main session turns", async () => {
    const fixture = createFixture({ sidechain: true });

    await expect(collect(readClaudeCodeTranscript(fixture.sessionFilePath))).resolves.toEqual([]);
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
        role: "user",
        content: "Please use ANTHROPIC_API_KEY=[REDACTED:anthropic_api_key]",
        workspacePath: fixture.workspacePath
      }),
      expect.objectContaining({ sourceId: "claude_code", role: "assistant" }),
      expect.objectContaining({ sourceId: "claude_code", role: "tool" }),
      expect.objectContaining({ sourceId: "claude_code", role: "tool" }),
      expect.objectContaining({ sourceId: "claude_code", role: "assistant", content: "Done." })
    ]);
    expect(messages.every((message) => message.rawMeta.sourceTurnState === "complete")).toBe(true);
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

/** Mirrors a Claude Code session file ending with an assistant end_turn after the tool exchange. */
function createFixture(options: { withToolResult?: boolean; sidechain?: boolean; stopReason?: string | null } = {}): {
  projectsRoot: string;
  workspacePath: string;
  sessionFilePath: string;
} {
  tempDir = mkdtempSync(join(tmpdir(), "memmy-claude-code-"));
  const projectsRoot = join(tempDir, "projects");
  const workspacePath = join(tempDir, "project");
  const projectDirectory = join(projectsRoot, "-tmp-project");
  const sessionFilePath = join(projectDirectory, "session-1.jsonl");
  const shared = { sessionId: "session-1", cwd: workspacePath, isSidechain: options.sidechain === true };

  mkdirSync(join(workspacePath, ".git"), { recursive: true });
  mkdirSync(projectDirectory, { recursive: true });
  const rows: unknown[] = [
    { type: "summary", summary: "skip", sessionId: "session-1" },
    {
      ...shared,
      type: "user",
      origin: { kind: "human" },
      promptId: "prompt-1",
      message: { role: "user", content: "Please use ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN" },
      uuid: "user-uuid",
      timestamp: "2026-05-29T10:00:00.000Z"
    },
    {
      ...shared,
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "I will inspect files." },
          { type: "thinking", thinking: "internal reasoning that never becomes the answer" },
          { type: "tool_use", id: "toolu_read_1", name: "Read", input: { file_path: "/tmp/example.md" } },
          { type: "text", text: "Then patch." }
        ]
      },
      uuid: "assistant-uuid",
      timestamp: "2026-05-29T10:00:01.000Z"
    }
  ];
  if (options.withToolResult !== false) {
    rows.push({
      ...shared,
      type: "user",
      promptId: "prompt-1",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_read_1", content: "file body" }] },
      uuid: "tool-result-uuid",
      timestamp: "2026-05-29T10:00:02.000Z"
    });
  }
  rows.push({
    ...shared,
    type: "assistant",
    uuid: "assistant-final",
    timestamp: "2026-05-29T10:00:03.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "Done." }],
      stop_reason: options.stopReason === undefined ? "end_turn" : options.stopReason }
  });
  writeFileSync(sessionFilePath, rows.map((row) => JSON.stringify(row)).join("\n"), "utf8");

  return { projectsRoot, workspacePath, sessionFilePath };
}
