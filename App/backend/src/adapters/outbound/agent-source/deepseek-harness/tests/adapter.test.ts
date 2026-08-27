import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { createDeepseekHarnessSourceAdapter, readDeepseekHarnessSession } from "../index.js";

const openAiKeyFixture = ["sk-", "abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJKLMN"].join("");
const secretMessageFixture = `Remember OPENAI_API_KEY=${openAiKeyFixture}`;
let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("DeepSeek Harness source adapter", () => {
  it("reads independently compressed Zstandard frames and ignores plugin context", async () => {
    const fixture = createFixture("session.jsonl.zstd");

    const messages = await readDeepseekHarnessSession(fixture.sessionFilePath);

    expect(messages).toEqual([
      expect.objectContaining({
        messageId: "user-1",
        conversationId: "dsh-session-1",
        role: "user",
        content: secretMessageFixture,
        workspacePath: fixture.workspacePath
      }),
      expect.objectContaining({
        messageId: "assistant-1",
        conversationId: "dsh-session-1",
        role: "assistant",
        content: "Done from DeepSeek Harness",
        workspacePath: fixture.workspacePath
      })
    ]);
  });

  it("ignores an incomplete trailing Zstandard frame", async () => {
    const fixture = createFixture("session.jsonl.zstd");
    const incompleteFrame = zstdCompressSync(Buffer.from(JSON.stringify({
      type: "user/message",
      seq: 4,
      time: 1780404003000,
      data: {
        id: "incomplete-user",
        role: "user",
        source: { kind: "user" },
        content: [{ type: "text", text: "This frame is still being written" }]
      }
    }) + "\n"));
    appendFileSync(fixture.sessionFilePath, incompleteFrame.subarray(0, incompleteFrame.length - 8));

    const messages = await readDeepseekHarnessSession(fixture.sessionFilePath);

    expect(messages.map((message) => message.messageId)).toEqual(["user-1", "assistant-1"]);
  });

  it("discovers sessions and redacts secrets during source scans", async () => {
    const fixture = createFixture("session.jsonl");
    const adapter = createDeepseekHarnessSourceAdapter({ rootDirectory: fixture.rootDirectory });

    await expect(adapter.detect()).resolves.toBe(true);
    const messages = await collect(adapter.scan({}));

    expect(messages).toEqual([
      expect.objectContaining({
        sourceId: "deepseek_harness",
        role: "user",
        content: "Remember OPENAI_API_KEY=[REDACTED:openai_api_key]",
        workspacePath: fixture.workspacePath
      }),
      expect.objectContaining({
        sourceId: "deepseek_harness",
        role: "assistant",
        content: "Done from DeepSeek Harness",
        workspacePath: fixture.workspacePath
      })
    ]);
  });

  it("does not detect a missing DeepSeek Harness home", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-dsh-source-missing-"));
    const rootDirectory = join(tempDir, ".dsh");
    const adapter = createDeepseekHarnessSourceAdapter({ rootDirectory });

    await expect(adapter.detect()).resolves.toBe(false);
    await expect(collect(adapter.scan({}))).resolves.toEqual([]);
  });
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function createFixture(fileName: "session.jsonl" | "session.jsonl.zstd"): {
  rootDirectory: string;
  sessionFilePath: string;
  workspacePath: string;
} {
  tempDir = mkdtempSync(join(tmpdir(), "memmy-dsh-source-"));
  const rootDirectory = join(tempDir, ".dsh");
  const workspacePath = join(tempDir, "project");
  const sessionDirectory = join(rootDirectory, "sessions", "encoded-workspace", "dsh-session-1");
  const sessionFilePath = join(sessionDirectory, fileName);
  mkdirSync(sessionDirectory, { recursive: true });
  mkdirSync(workspacePath, { recursive: true });
  const rows = [
    { type: "session", id: "dsh-session-1", createdAt: 1780404000000, cwd: workspacePath },
    {
      type: "turn/start",
      seq: 0,
      time: 1780404000000,
      data: { turn: 1 }
    },
    {
      type: "user/message",
      seq: 1,
      time: 1780404001000,
      data: {
        id: "user-1",
        role: "user",
        source: { kind: "user" },
        content: [{ type: "text", text: secretMessageFixture }]
      }
    },
    {
      type: "user/message",
      seq: 2,
      time: 1780404001500,
      data: {
        id: "plugin-1",
        role: "user",
        source: { kind: "plugin", plugin: "memmy-memory", form: "recall" },
        content: [{ type: "text", text: "Injected memory must not be imported as user history" }]
      }
    },
    {
      type: "assistant/message",
      seq: 3,
      time: 1780404002000,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: "assistant-1",
          role: "assistant",
          source: { kind: "model", provider: "test", model: "test" },
          content: [{ type: "text", text: "Done from DeepSeek Harness" }]
        }
      }
    }
  ];
  const lines = rows.map((row) => JSON.stringify(row) + "\n");
  writeFileSync(
    sessionFilePath,
    fileName.endsWith(".zstd")
      ? Buffer.concat([zstdCompressSync(Buffer.from(lines.slice(0, 2).join(""))), zstdCompressSync(Buffer.from(lines.slice(2).join("")))])
      : lines.join("")
  );
  return { rootDirectory, sessionFilePath, workspacePath };
}
