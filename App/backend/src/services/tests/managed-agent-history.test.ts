import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractManagedAgentHistory,
  selectIncrementalManagedMessages
} from "../managed-agent-history.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("managed Agent automatic history extraction", () => {
  it("reuses a JSONL recipe and keeps only complete turns after the initial boundary", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-managed-jsonl-"));
    const historyPath = join(tempDir, "history.jsonl");
    writeFileSync(historyPath, [
      JSON.stringify({ id: "u1", session: "c1", actor: "human", text: "old", at: "2026-07-01T10:00:00.000Z" }),
      JSON.stringify({ id: "a1", session: "c1", actor: "ai", text: "old answer", at: "2026-07-01T10:00:01.000Z" }),
      JSON.stringify({ id: "u2", session: "c1", actor: "human", text: "new", at: "2026-07-02T10:00:00.000Z" }),
      JSON.stringify({ id: "a2", session: "c1", actor: "ai", text: "new answer", at: "2026-07-02T10:00:01.000Z" }),
      JSON.stringify({ id: "u3", session: "c1", actor: "human", text: "unfinished", at: "2026-07-03T10:00:00.000Z" })
    ].join("\n"), "utf8");

    const messages = extractManagedAgentHistory({
      version: 1,
      format: "jsonl",
      path: historyPath,
      fields: {
        messageId: "id",
        conversationId: "session",
        role: "actor",
        content: "text",
        createdAt: "at"
      },
      roleMap: { human: "user", ai: "assistant" },
      timestampFormat: "auto"
    });
    const incremental = selectIncrementalManagedMessages(
      messages,
      "2026-07-01T10:00:00.000Z"
    );

    expect(incremental.map((message) => message.messageId)).toEqual(["u2", "a2"]);
    expect(incremental.map((message) => message.content)).toEqual(["new", "new answer"]);
  });

  it("derives repeatable ids for per-conversation JSON files", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-managed-json-"));
    const historyPath = join(tempDir, "conversation.json");
    writeFileSync(historyPath, JSON.stringify({
      messages: [
        { role: "user", content: "question", timestamp: 1_783_075_200 },
        { role: "assistant", content: [{ text: "answer" }], timestamp: 1_783_075_201 }
      ]
    }), "utf8");
    const recipe = {
      version: 1 as const,
      format: "json" as const,
      path: tempDir,
      fileSuffix: ".json",
      recordsPath: "messages",
      fields: {
        role: "role",
        content: "content",
        createdAt: "timestamp"
      },
      timestampFormat: "unix_seconds" as const
    };

    const first = extractManagedAgentHistory(recipe);
    const second = extractManagedAgentHistory(recipe);

    expect(first.map((message) => message.messageId)).toEqual(
      second.map((message) => message.messageId)
    );
    expect(new Set(first.map((message) => message.conversationId)).size).toBe(1);
    expect(first[1]?.content).toBe("answer");
  });

  it("reads a SQLite recipe through one read-only SELECT", () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-managed-sqlite-"));
    const databasePath = join(tempDir, "history.db");
    const db = new DatabaseSync(databasePath);
    db.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO messages VALUES
        ('u1', 'c1', 'user', 'question', 1783075200000),
        ('a1', 'c1', 'assistant', 'answer', 1783075201000);
    `);
    db.close();

    const messages = extractManagedAgentHistory({
      version: 1,
      format: "sqlite",
      path: databasePath,
      query: "SELECT id, conversation_id, role, content, created_at FROM messages ORDER BY created_at",
      fields: {
        messageId: "id",
        conversationId: "conversation_id",
        role: "role",
        content: "content",
        createdAt: "created_at"
      },
      timestampFormat: "unix_milliseconds"
    });

    expect(messages.map((message) => message.messageId)).toEqual(["u1", "a1"]);
    expect(messages[0]?.createdAt).toBe("2026-07-03T10:40:00.000Z");
  });
});
