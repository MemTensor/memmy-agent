/** Pi source adapter tests. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPiSourceAdapter } from "../index.js";
import { discoverPiSessions } from "../session-discovery.js";
import { readPiSession } from "../session-reader.js";

let tempDirectory: string | undefined;

afterEach(() => {
  if (tempDirectory) {
    rmSync(tempDirectory, { recursive: true, force: true });
    tempDirectory = undefined;
  }
});

describe("Pi source adapter", () => {
  it("reads the active branch with text and tool traces but excludes thinking", async () => {
    const fixture = createFixture();
    const messages = await collect(readPiSession(fixture.sessionPath));

    expect(messages).toEqual([
      expect.objectContaining({ messageId: "pi-session-1:user-1", role: "user", content: expect.stringContaining("sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN") }),
      expect.objectContaining({ role: "assistant", content: expect.stringContaining("Tool: bash") }),
      expect.objectContaining({ role: "tool", content: expect.stringContaining("Tool: bash") }),
      expect.objectContaining({ role: "assistant", content: "Done" })
    ]);
    expect(messages.map((message) => message.content).join("\n")).not.toContain("private reasoning");
    expect(messages.map((message) => message.content).join("\n")).not.toContain("abandoned answer");
  });

  it("discovers nested sessions and streams redacted messages", async () => {
    const fixture = createFixture();
    const adapter = createPiSourceAdapter({ sessionsRoot: fixture.sessionsRoot });

    await expect(discoverPiSessions({ root: fixture.sessionsRoot })).resolves.toEqual([
      expect.objectContaining({ sessionFilePath: fixture.sessionPath, workspacePath: fixture.workspacePath })
    ]);
    const messages = await collect(adapter.scan({}));
    expect(messages[0]).toEqual(expect.objectContaining({
      sourceId: "pi",
      conversationId: "pi-session-1",
      content: "Use OPENAI_API_KEY=[REDACTED:openai_api_key]",
      workspacePath: fixture.workspacePath
    }));
  });

  it("treats a missing sessions directory as empty history", async () => {
    const sessionsRoot = join(tmpdir(), `memmy-missing-pi-${crypto.randomUUID()}`);
    await expect(discoverPiSessions({ root: sessionsRoot })).resolves.toEqual([]);
    await expect(collect(createPiSourceAdapter({ sessionsRoot }).scan({}))).resolves.toEqual([]);
  });

  it("honors scan limits and aborts", async () => {
    const fixture = createFixture();
    const adapter = createPiSourceAdapter({ sessionsRoot: fixture.sessionsRoot });
    await expect(collect(adapter.scan({ maxMessages: 2 }))).resolves.toHaveLength(2);

    const controller = new AbortController();
    controller.abort();
    await expect(collect(adapter.scan({ signal: controller.signal }))).rejects.toThrow("Pi source scan aborted");
  });

  it("skips entries already handled by the live extension", async () => {
    const fixture = createFixture([
      {
        type: "custom",
        id: "capture-1",
        parentId: "assistant-2",
        timestamp: "2026-08-01T00:00:06.000Z",
        customType: "memmy-memory-capture",
        data: { entryIds: ["user-1", "assistant-1", "tool-1", "assistant-2"], status: "succeeded" }
      }
    ]);

    await expect(collect(readPiSession(fixture.sessionPath))).resolves.toEqual([]);
  });
});

function createFixture(extraRows: Array<Record<string, unknown>> = []): { sessionsRoot: string; sessionPath: string; workspacePath: string } {
  tempDirectory = mkdtempSync(join(tmpdir(), "memmy-pi-source-"));
  const sessionsRoot = join(tempDirectory, "sessions");
  const workspacePath = join(tempDirectory, "workspace");
  const sessionDirectory = join(sessionsRoot, "--workspace--");
  const sessionPath = join(sessionDirectory, "2026-08-01T00-00-00-000Z_pi-session-1.jsonl");
  mkdirSync(sessionDirectory, { recursive: true });
  mkdirSync(workspacePath, { recursive: true });
  const rows = [
    { type: "session", version: 3, id: "pi-session-1", timestamp: "2026-08-01T00:00:00.000Z", cwd: workspacePath },
    { type: "message", id: "user-1", parentId: null, timestamp: "2026-08-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "Use OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN" }] } },
    { type: "message", id: "abandoned", parentId: "user-1", timestamp: "2026-08-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "abandoned answer" }] } },
    { type: "message", id: "assistant-1", parentId: "user-1", timestamp: "2026-08-01T00:00:03.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "private reasoning" }, { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } }] } },
    { type: "message", id: "tool-1", parentId: "assistant-1", timestamp: "2026-08-01T00:00:04.000Z", message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "command output" }] } },
    { type: "message", id: "assistant-2", parentId: "tool-1", timestamp: "2026-08-01T00:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } },
    ...extraRows
  ];
  writeFileSync(sessionPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  return { sessionsRoot, sessionPath, workspacePath };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}
