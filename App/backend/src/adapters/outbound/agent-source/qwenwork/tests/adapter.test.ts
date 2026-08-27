import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createQwenworkSourceAdapter, readQwenworkHistory } from "../index.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("qwenwork source adapter", () => {
  it("reads human-visible messages and skips thinking, tool results, and sidechains", async () => {
    const fixture = createFixture([
      { type: "user", uuid: "user-1", sessionId: "qwen-session", timestamp: "2026-08-01T00:00:01.000Z", cwd: "WORKSPACE", message: { role: "user", content: [{ type: "text", text: "Remember OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN" }] } },
      { type: "assistant", uuid: "thinking-1", sessionId: "qwen-session", timestamp: "2026-08-01T00:00:02.000Z", cwd: "WORKSPACE", message: { role: "assistant", content: [{ type: "thinking", thinking: "private" }] } },
      { type: "assistant", uuid: "assistant-1", sessionId: "qwen-session", timestamp: "2026-08-01T00:00:03.000Z", cwd: "WORKSPACE", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } },
      { type: "user", uuid: "tool-result-1", sessionId: "qwen-session", timestamp: "2026-08-01T00:00:04.000Z", cwd: "WORKSPACE", message: { role: "user", content: [{ type: "tool_result", content: "internal output" }] } },
      { type: "user", uuid: "internal-user-1", sessionId: "qwen-session", timestamp: "2026-08-01T00:00:04.500Z", cwd: "WORKSPACE", origin: { kind: "agent" }, message: { role: "user", content: [{ type: "text", text: "internal prompt" }] } },
      { type: "assistant", uuid: "sidechain-1", sessionId: "qwen-session", timestamp: "2026-08-01T00:00:05.000Z", cwd: "WORKSPACE", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "internal sidechain" }] } }
    ]);

    const raw = await collect(readQwenworkHistory(fixture.sessionFilePath));
    expect(raw.map((message) => message.content)).toEqual([
      "Remember OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN",
      "Done"
    ]);

    const messages = await collect(createQwenworkSourceAdapter({
      rootDirectory: fixture.rootDirectory,
      projectsRoot: fixture.projectsRoot
    }).scan({}));
    expect(messages[0]).toMatchObject({
      sourceId: "qwenwork",
      conversationId: "qwen-session",
      content: "Remember OPENAI_API_KEY=[REDACTED:openai_api_key]",
      workspacePath: fixture.workspacePath,
      gitRoot: fixture.workspacePath
    });
  });

  it("detects an installed qwenwork root before it has history", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-qwenwork-empty-"));
    const rootDirectory = join(tempDir, ".qwenworkcn");
    mkdirSync(rootDirectory, { recursive: true });
    const adapter = createQwenworkSourceAdapter({ rootDirectory });

    await expect(adapter.detect()).resolves.toBe(true);
    await expect(collect(adapter.scan({}))).resolves.toEqual([]);
  });
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function createFixture(records: Array<Record<string, unknown>>) {
  tempDir = mkdtempSync(join(tmpdir(), "memmy-qwenwork-source-"));
  const rootDirectory = join(tempDir, ".qwenworkcn");
  const projectsRoot = join(rootDirectory, "projects");
  const workspacePath = join(tempDir, "workspace");
  const sessionFilePath = join(projectsRoot, "workspace", "session.jsonl");
  mkdirSync(join(workspacePath, ".git"), { recursive: true });
  mkdirSync(join(projectsRoot, "workspace"), { recursive: true });
  writeFileSync(
    sessionFilePath,
    `${records.map((record) => JSON.stringify(replaceWorkspace(record, workspacePath))).join("\n")}\n`,
    "utf8"
  );
  return { rootDirectory, projectsRoot, sessionFilePath, workspacePath };
}

function replaceWorkspace(record: Record<string, unknown>, workspacePath: string): Record<string, unknown> {
  return record.cwd === "WORKSPACE" ? { ...record, cwd: workspacePath } : record;
}
