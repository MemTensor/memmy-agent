import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPiSourceAdapter, readPiHistory } from "../index.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("Pi source adapter", () => {
  it("reads visible session messages and skips thinking and tool calls", async () => {
    const fixture = createFixture([
      { type: "session", version: 3, id: "pi-session", timestamp: "2026-08-01T00:00:00.000Z", cwd: "WORKSPACE" },
      { type: "message", id: "user-1", timestamp: "2026-08-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "Remember OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN" }] } },
      { type: "message", id: "assistant-1", timestamp: "2026-08-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "toolCall", name: "read", arguments: {} }, { type: "text", text: "Done" }] } },
      { type: "message", id: "tool-1", timestamp: "2026-08-01T00:00:03.000Z", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "README" }] } }
    ]);

    const raw = await collect(readPiHistory(fixture.sessionFilePath));
    expect(raw.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
    expect(raw[1]?.content).toBe("Done");
    expect(raw[2]?.content).toContain("Tool: read");

    const messages = await collect(createPiSourceAdapter({
      rootDirectory: fixture.rootDirectory,
      sessionsRoot: fixture.sessionsRoot
    }).scan({}));
    expect(messages[0]).toMatchObject({
      sourceId: "pi",
      conversationId: "pi-session",
      content: "Remember OPENAI_API_KEY=[REDACTED:openai_api_key]",
      workspacePath: fixture.workspacePath,
      gitRoot: fixture.workspacePath
    });
  });

  it("detects an installed Pi agent before it has sessions", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-pi-empty-"));
    const rootDirectory = join(tempDir, ".pi", "agent");
    mkdirSync(rootDirectory, { recursive: true });
    const adapter = createPiSourceAdapter({ rootDirectory });

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
  tempDir = mkdtempSync(join(tmpdir(), "memmy-pi-source-"));
  const rootDirectory = join(tempDir, ".pi", "agent");
  const sessionsRoot = join(rootDirectory, "sessions");
  const workspacePath = join(tempDir, "workspace");
  const sessionFilePath = join(sessionsRoot, "workspace", "session.jsonl");
  mkdirSync(join(workspacePath, ".git"), { recursive: true });
  mkdirSync(join(sessionsRoot, "workspace"), { recursive: true });
  writeFileSync(
    sessionFilePath,
    `${records.map((record) => JSON.stringify(replaceWorkspace(record, workspacePath))).join("\n")}\n`,
    "utf8"
  );
  return { rootDirectory, sessionsRoot, sessionFilePath, workspacePath };
}

function replaceWorkspace(record: Record<string, unknown>, workspacePath: string): Record<string, unknown> {
  return record.cwd === "WORKSPACE" ? { ...record, cwd: workspacePath } : record;
}
