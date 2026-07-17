/** Adapter tests. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createOpenclawSourceAdapter } from "../index.js";
import { discoverOpenclawDatabases } from "../db-discovery.js";
import { readOpenclawDatabase } from "../db-reader.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("openclaw source adapter", () => {
  it("discovers SQLite databases and classifies conversation schema", async () => {
    const fixture = createFixture();

    await expect(discoverOpenclawDatabases({ root: fixture.rootDirectory })).resolves.toEqual([
      expect.objectContaining({
        databasePath: fixture.databasePath,
        schemaKind: "conversation"
      })
    ]);
  });

  it("discovers MemOS Local Memory chunks as OpenClaw memory schema", async () => {
    const fixture = createMemoryFixture();

    await expect(discoverOpenclawDatabases({ root: fixture.rootDirectory })).resolves.toEqual([
      expect.objectContaining({
        databasePath: fixture.databasePath,
        schemaKind: "memory"
      })
    ]);
  });

  it("reads raw OpenClaw conversation messages from SQLite", async () => {
    const fixture = createFixture();

    const messages = await collect(readOpenclawDatabase(fixture.databasePath));

    expect(messages).toEqual([
      expect.objectContaining({
        messageId: "openclaw-message-1",
        conversationId: "openclaw-conversation-1",
        role: "user",
        content: "Please remember OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN",
        workspacePath: fixture.workspacePath
      }),
      expect.objectContaining({
        messageId: "openclaw-message-2",
        role: "assistant",
        content: "Done from OpenClaw"
      })
    ]);
  });

  it("reads captured OpenClaw memory chunks from MemOS Local Memory SQLite", async () => {
    const fixture = createMemoryFixture();

    const messages = await collect(readOpenclawDatabase(fixture.databasePath));

    expect(messages).toEqual([
      expect.objectContaining({
        messageId: "chunk-user-1",
        conversationId: "openclaw-session-1",
        role: "user",
        content: "Remember OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN from OpenClaw",
        createdAt: "2026-06-02T10:10:01.000Z",
        rawMeta: expect.objectContaining({
          schemaKind: "memory",
          turnId: "turn-1",
          seq: 0,
          summary: "User asked OpenClaw to remember a secret",
          taskId: "task-1",
          owner: "agent:main",
          dedupStatus: "active"
        })
      }),
      expect.objectContaining({
        messageId: "chunk-assistant-1",
        role: "assistant",
        content: "Stored from OpenClaw memory plugin"
      }),
      expect.objectContaining({
        messageId: "chunk-tool-1",
        role: "tool",
        content: "External tool output captured by OpenClaw"
      })
    ]);
  });

  it("streams redacted ConversationMessage values and reports progress", async () => {
    const fixture = createFixture();
    const progressPhases: string[] = [];
    const adapter = createOpenclawSourceAdapter({ rootDirectory: fixture.rootDirectory });

    const messages = await collect(
      adapter.scan({
        onProgress: (progress) => progressPhases.push(progress.phase)
      })
    );

    expect(messages).toEqual([
      expect.objectContaining({
        sourceId: "openclaw",
        content: "Please remember OPENAI_API_KEY=[REDACTED:openai_api_key]",
        workspacePath: fixture.workspacePath
      }),
      expect.objectContaining({ sourceId: "openclaw", role: "assistant" })
    ]);
    expect(progressPhases).toEqual(expect.arrayContaining(["discover", "read", "redact", "emit", "done"]));
  });

  it("streams redacted captured memory chunks without synthetic data", async () => {
    const fixture = createMemoryFixture();
    const adapter = createOpenclawSourceAdapter({ rootDirectory: fixture.rootDirectory });

    const messages = await collect(adapter.scan({}));

    expect(messages).toEqual([
      expect.objectContaining({
        sourceId: "openclaw",
        content: "Remember OPENAI_API_KEY=[REDACTED:openai_api_key] from OpenClaw",
        rawMeta: expect.objectContaining({ schemaKind: "memory", turnId: "turn-1" })
      }),
      expect.objectContaining({ sourceId: "openclaw", role: "assistant" }),
      expect.objectContaining({ sourceId: "openclaw", role: "tool" })
    ]);
  });

  it("detects an initialized OpenClaw home even before a memory database is created", async () => {
    const fixture = createEmptyOpenclawHome();
    const adapter = createOpenclawSourceAdapter({ rootDirectory: fixture.rootDirectory });

    await expect(adapter.detect()).resolves.toBe(true);
    await expect(collect(adapter.scan({}))).resolves.toEqual([]);
  });

  it("treats a missing OpenClaw state directory as an empty history", async () => {
    const rootDirectory = join(tmpdir(), `memmy-missing-openclaw-${crypto.randomUUID()}`);

    await expect(collect(createOpenclawSourceAdapter({ rootDirectory }).scan({}))).resolves.toEqual([]);
  });

  it("throws AbortError when scan is aborted before discovery", async () => {
    const fixture = createFixture();
    const controller = new AbortController();
    controller.abort();

    await expect(
      collect(createOpenclawSourceAdapter({ rootDirectory: fixture.rootDirectory }).scan({ signal: controller.signal }))
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

function createFixture(): { rootDirectory: string; workspacePath: string; databasePath: string } {
  tempDir = mkdtempSync(join(tmpdir(), "memmy-openclaw-source-"));
  const rootDirectory = join(tempDir, ".openclaw");
  const workspacePath = join(tempDir, "project");
  const databasePath = join(rootDirectory, "openclaw.sqlite");

  mkdirSync(join(workspacePath, ".git"), { recursive: true });
  mkdirSync(rootDirectory, { recursive: true });
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(readFileSync(join(import.meta.dirname, "__fixtures__", "openclaw", "conversation.sql"), "utf8").replaceAll("$WORKSPACE_PATH", workspacePath));
  } finally {
    db.close();
  }

  return { rootDirectory, workspacePath, databasePath };
}

function createMemoryFixture(): { rootDirectory: string; databasePath: string } {
  tempDir = mkdtempSync(join(tmpdir(), "memmy-openclaw-source-"));
  const rootDirectory = join(tempDir, ".openclaw");
  const databasePath = join(rootDirectory, "memos-local", "memos.db");

  mkdirSync(join(rootDirectory, "memos-local"), { recursive: true });
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(readFileSync(join(import.meta.dirname, "__fixtures__", "openclaw", "memos-local.sql"), "utf8"));
  } finally {
    db.close();
  }

  return { rootDirectory, databasePath };
}

function createEmptyOpenclawHome(): { rootDirectory: string } {
  tempDir = mkdtempSync(join(tmpdir(), "memmy-openclaw-source-"));
  const rootDirectory = join(tempDir, ".openclaw");
  mkdirSync(rootDirectory, { recursive: true });
  return { rootDirectory };
}
