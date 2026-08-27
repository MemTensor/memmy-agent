import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkbuddySourceAdapter } from "../index.js";
import { readWorkbuddyHistory } from "../history-reader.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("workbuddy source adapter", () => {
  it("reads current WorkBuddy events and skips reasoning, snapshots, and corrupt lines", async () => {
    const fixture = createFixture([
      "not-json",
      JSON.stringify({ type: "message", role: "user", id: "user-1", sessionId: "session-1", timestamp: 1_784_170_058_222, content: [{ type: "input_text", text: "Remember OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN" }] }),
      JSON.stringify({ type: "reasoning", id: "reasoning-1", sessionId: "session-1", timestamp: 1_784_170_059_000, rawContent: [{ type: "reasoning_text", text: "private reasoning" }] }),
      JSON.stringify({ type: "function_call", id: "call-item-1", callId: "call-1", sessionId: "session-1", timestamp: 1_784_170_060_000, name: "read_file", arguments: "{\"path\":\"README.md\"}" }),
      JSON.stringify({ type: "function_call_result", id: "result-1", callId: "call-1", sessionId: "session-1", timestamp: 1_784_170_061_000, name: "read_file", status: "completed", output: { type: "text", text: "README content" } }),
      JSON.stringify({ type: "message", role: "assistant", id: "assistant-1", sessionId: "session-1", timestamp: 1_784_170_062_000, content: [{ type: "output_text", text: "Done" }] }),
      JSON.stringify({ type: "file-history-snapshot", id: "snapshot-1", timestamp: 1_784_170_063_000, snapshot: { trackedFileBackups: {} } })
    ]);

    const raw = await collect(readWorkbuddyHistory(fixture.sessionFilePath));
    expect(raw.map((message) => message.role)).toEqual(["user", "tool", "tool", "assistant"]);
    expect(raw[1]?.content).toContain("Tool: read_file");
    expect(raw[2]?.content).toContain("README content");

    const messages = await collect(createWorkbuddySourceAdapter({
      rootDirectory: fixture.rootDirectory,
      projectsRoot: fixture.projectsRoot
    }).scan({}));
    expect(messages[0]).toMatchObject({
      sourceId: "workbuddy",
      content: "Remember OPENAI_API_KEY=[REDACTED:openai_api_key]",
      workspacePath: fixture.workspacePath,
      gitRoot: fixture.workspacePath
    });
  });

  it("supports migrated and older message shapes without importing internal compact prompts", async () => {
    const fixture = createFixture([
      JSON.stringify({ role: "human", uuid: "legacy-user", conversationId: "legacy-session", createdAt: "2026-07-15T10:00:00.000Z", cwd: "/legacy/project", message: JSON.stringify({ content: [{ type: "text", text: "<system_reminder>ignore</system_reminder><user_query>Legacy question</user_query>" }] }) }),
      JSON.stringify({ type: "message", role: "user", id: "compact-user", sessionId: "legacy-session", timestamp: 1_784_170_058_222, content: "/compact", providerData: { agent: "compact", isCompactInternal: true, skipRun: true } }),
      JSON.stringify({ type: "message", role: "assistant", id: "legacy-assistant", sessionId: "legacy-session", timestamp: "1784170062000", content: "Legacy answer" }),
      JSON.stringify({ type: "function_call_output", id: "legacy-result", call_id: "legacy-call", sessionId: "legacy-session", timestamp: 1_784_170_063, output: [{ type: "text", text: "Legacy tool output" }] })
    ], { writeMeta: false });

    const messages = await collect(readWorkbuddyHistory(fixture.sessionFilePath));

    expect(messages).toEqual([
      expect.objectContaining({ messageId: "legacy-user", conversationId: "legacy-session", role: "user", content: "Legacy question", workspacePath: "/legacy/project" }),
      expect.objectContaining({ messageId: "legacy-assistant", role: "assistant", content: "Legacy answer", createdAt: "2026-07-16T02:47:42.000Z" }),
      expect.objectContaining({ messageId: "legacy-result", role: "tool", content: expect.stringContaining("Legacy tool output") })
    ]);
  });

  it("detects an installed WorkBuddy root even before any history exists", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-workbuddy-empty-"));
    const rootDirectory = join(tempDir, ".workbuddy");
    mkdirSync(rootDirectory, { recursive: true });
    const adapter = createWorkbuddySourceAdapter({ rootDirectory });

    await expect(adapter.detect()).resolves.toBe(true);
    await expect(collect(adapter.scan({}))).resolves.toEqual([]);
  });

  it("treats a missing WorkBuddy home as an empty history", async () => {
    const rootDirectory = join(tmpdir(), `memmy-missing-workbuddy-${crypto.randomUUID()}`);

    await expect(collect(createWorkbuddySourceAdapter({ rootDirectory }).scan({}))).resolves.toEqual([]);
  });
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
}

function createFixture(lines: string[], options: { writeMeta?: boolean } = {}) {
  tempDir = mkdtempSync(join(tmpdir(), "memmy-workbuddy-source-"));
  const rootDirectory = join(tempDir, ".workbuddy");
  const projectsRoot = join(rootDirectory, "projects");
  const sessionDirectory = join(projectsRoot, "compressed-workspace");
  const sessionFilePath = join(sessionDirectory, "session-1.jsonl");
  const workspacePath = join(tempDir, "workspace");
  mkdirSync(join(workspacePath, ".git"), { recursive: true });
  mkdirSync(sessionDirectory, { recursive: true });
  writeFileSync(sessionFilePath, `${lines.join("\n")}\n`, "utf8");
  if (options.writeMeta !== false) {
    writeFileSync(join(sessionDirectory, "session-1.meta.json"), JSON.stringify({ cwd: workspacePath }), "utf8");
  }
  return { rootDirectory, projectsRoot, sessionFilePath, workspacePath };
}
