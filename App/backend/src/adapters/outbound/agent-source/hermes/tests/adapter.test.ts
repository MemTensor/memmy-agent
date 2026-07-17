/** Adapter tests. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createHermesSourceAdapter } from "../index.js";
import { readHermesRollout } from "../rollout-reader.js";
import { readHermesStateDb } from "../state-db-reader.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("hermes source adapter", () => {
  it("keeps the JSONL reader path for document-compatible sessions", async () => {
    const fixture = createJsonlFixture();

    const messages = await collect(readHermesRollout(fixture.sessionFilePath));

    expect(messages).toEqual([
      expect.objectContaining({
        messageId: "hermes-session-jsonl:2",
        conversationId: "hermes-session-jsonl",
        role: "user",
        content: "Use OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN"
      }),
      expect.objectContaining({
        messageId: "hermes-session-jsonl:3",
        role: "tool",
        content: "Hermes JSONL tool output"
      }),
      expect.objectContaining({
        messageId: "hermes-session-jsonl:4",
        role: "assistant",
        content: "Done from Hermes JSONL"
      })
    ]);
  });

  it("reads probe-discovered Hermes state.db messages with workspace metadata", async () => {
    const fixture = createStateDbFixture();

    const messages = await collect(readHermesStateDb(fixture.stateDbPath));

    expect(messages).toEqual([
      expect.objectContaining({
        messageId: "hermes-db-session:1",
        conversationId: "hermes-db-session",
        role: "user",
        content: "Please remember OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN",
        workspacePath: fixture.workspacePath,
        gitRoot: fixture.workspacePath
      }),
      expect.objectContaining({
        messageId: "hermes-db-session:2",
        role: "tool",
        content: expect.stringContaining("Output:\nignored tool output")
      }),
      expect.objectContaining({
        messageId: "hermes-platform-message-2",
        role: "assistant",
        content: "Done from Hermes state.db"
      })
    ]);
  });

  it("reads Hermes state.db messages when platform_message_id is absent", async () => {
    const fixture = createStateDbFixture({ includePlatformMessageId: false });

    const messages = await collect(readHermesStateDb(fixture.stateDbPath));

    expect(messages).toEqual([
      expect.objectContaining({
        messageId: "hermes-db-session:1",
        role: "user",
        workspacePath: fixture.workspacePath
      }),
      expect.objectContaining({
        messageId: "hermes-db-session:2",
        role: "tool",
        content: expect.stringContaining("Output:\nignored tool output")
      }),
      expect.objectContaining({
        messageId: "hermes-db-session:3",
        role: "assistant",
        content: "Done from Hermes state.db"
      })
    ]);
  });

  it("streams redacted state.db messages and reports progress", async () => {
    const fixture = createStateDbFixture();
    const progressPhases: string[] = [];
    const adapter = createHermesSourceAdapter({ rootDirectory: fixture.rootDirectory });

    const messages = await collect(
      adapter.scan({
        onProgress: (progress) => progressPhases.push(progress.phase)
      })
    );

    expect(messages).toEqual([
      expect.objectContaining({
        sourceId: "hermes",
        content: "Please remember OPENAI_API_KEY=[REDACTED:openai_api_key]",
        workspacePath: fixture.workspacePath
      }),
      expect.objectContaining({ sourceId: "hermes", role: "tool" }),
      expect.objectContaining({ sourceId: "hermes", role: "assistant" })
    ]);
    expect(progressPhases).toEqual(expect.arrayContaining(["discover", "read", "redact", "emit", "done"]));
  });

  it("treats a missing Hermes home as an empty history", async () => {
    const rootDirectory = join(tmpdir(), `memmy-missing-hermes-${crypto.randomUUID()}`);

    await expect(collect(createHermesSourceAdapter({ rootDirectory }).scan({}))).resolves.toEqual([]);
  });

  it("throws AbortError when scan is aborted before discovery", async () => {
    const fixture = createStateDbFixture();
    const controller = new AbortController();
    controller.abort();

    await expect(
      collect(createHermesSourceAdapter({ rootDirectory: fixture.rootDirectory }).scan({ signal: controller.signal }))
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) {
    values.push(value);
  }

  return values;
}

function createJsonlFixture(): { rootDirectory: string; sessionFilePath: string } {
  tempDir = mkdtempSync(join(tmpdir(), "memmy-hermes-jsonl-source-"));
  const rootDirectory = join(tempDir, ".hermes");
  const sessionDirectory = join(rootDirectory, "sessions");
  const sessionFilePath = join(sessionDirectory, "hermes-session-jsonl.jsonl");

  mkdirSync(sessionDirectory, { recursive: true });
  writeFileSync(
    sessionFilePath,
    [
      JSON.stringify({ timestamp: "2026-06-02T10:00:00.000Z", type: "session_meta" }),
      JSON.stringify({ timestamp: "2026-06-02T10:00:01.000Z", type: "message", role: "user", content: [{ text: "Use OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN" }] }),
      JSON.stringify({ timestamp: "2026-06-02T10:00:02.000Z", type: "message", role: "tool", content: "Hermes JSONL tool output" }),
      JSON.stringify({ timestamp: "2026-06-02T10:00:03.000Z", type: "message", role: "assistant", content: "Done from Hermes JSONL" })
    ].join("\n"),
    "utf8"
  );

  return { rootDirectory, sessionFilePath };
}

function createStateDbFixture(options: { includePlatformMessageId?: boolean } = {}): { rootDirectory: string; workspacePath: string; stateDbPath: string } {
  const includePlatformMessageId = options.includePlatformMessageId ?? true;
  tempDir = mkdtempSync(join(tmpdir(), "memmy-hermes-db-source-"));
  const rootDirectory = join(tempDir, ".hermes");
  const workspacePath = join(tempDir, "project");
  const stateDbPath = join(rootDirectory, "state.db");

  mkdirSync(join(workspacePath, ".git"), { recursive: true });
  mkdirSync(rootDirectory, { recursive: true });
  const db = new DatabaseSync(stateDbPath);
  try {
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        cwd TEXT,
        started_at REAL NOT NULL
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        timestamp REAL NOT NULL,
        ${includePlatformMessageId ? "platform_message_id TEXT," : ""}
        active INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO sessions (id, cwd, started_at) VALUES ('hermes-db-session', '${workspacePath}', 1780404000.0);
    `);
    if (includePlatformMessageId) {
      db.exec(`
        INSERT INTO messages (session_id, role, content, timestamp, platform_message_id)
          VALUES ('hermes-db-session', 'user', 'Please remember OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN', 1780404001.0, NULL);
        INSERT INTO messages (session_id, role, content, timestamp, platform_message_id)
          VALUES ('hermes-db-session', 'tool', 'ignored tool output', 1780404002.0, NULL);
        INSERT INTO messages (session_id, role, content, timestamp, platform_message_id)
          VALUES ('hermes-db-session', 'assistant', 'Done from Hermes state.db', 1780404003.0, 'hermes-platform-message-2');
      `);
    } else {
      db.exec(`
        INSERT INTO messages (session_id, role, content, timestamp)
          VALUES ('hermes-db-session', 'user', 'Please remember OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN', 1780404001.0);
        INSERT INTO messages (session_id, role, content, timestamp)
          VALUES ('hermes-db-session', 'tool', 'ignored tool output', 1780404002.0);
        INSERT INTO messages (session_id, role, content, timestamp)
          VALUES ('hermes-db-session', 'assistant', 'Done from Hermes state.db', 1780404003.0);
      `);
    }
  } finally {
    db.close();
  }

  return { rootDirectory, workspacePath, stateDbPath };
}
