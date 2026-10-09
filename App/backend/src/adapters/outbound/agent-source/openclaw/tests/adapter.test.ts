/** Adapter tests. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { sourceTurnFailureReason, sourceTurnFromMessages } from "@memmy/agent-source-core";
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
  it("discovers the agent transcript database as a conversation store", async () => {
    const fixture = createTranscriptFixture();

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

  it("stages one native turn per run with tools paired by tool call id", async () => {
    const fixture = createTranscriptFixture();

    const messages = await collect(readOpenclawDatabase(fixture.databasePath));
    const turn = sourceTurnFromMessages(messages.filter((message) => message.rawMeta.sourceTurnId === "run-1"));

    expect(turn).toMatchObject({
      source: "openclaw",
      conversationId: "agent:main:main",
      turnId: "run-1",
      completionEvidence: "run_terminal:event-final",
      startedAt: "2026-09-08T06:44:31.000Z",
      completedAt: "2026-09-08T06:45:57.000Z",
      answer: "Checked the gateway and the config.",
      status: "succeeded"
    });
    expect(turn?.query).toBe("Please remember OPENAI_API_KEY=[REDACTED:openai_api_key]");
    expect(turn?.toolCalls).toEqual([
      expect.objectContaining({ id: "exec-1", name: "bash", output: "config body" })
    ]);
  });

  it("does not write internal wake runs such as a heartbeat poll", async () => {
    const fixture = createTranscriptFixture({ userText: "[OpenClaw heartbeat poll]" });

    await expect(collect(readOpenclawDatabase(fixture.databasePath))).resolves.toEqual([]);
  });

  it("keeps a run without a terminal answer unsubmitted so the scan can retry it", async () => {
    const fixture = createTranscriptFixture({ runTerminal: false, finalStopReason: "error" });

    const messages = await collect(readOpenclawDatabase(fixture.databasePath));

    expect(sourceTurnFromMessages(messages)).toBeNull();
    expect(sourceTurnFailureReason(messages)).toBe("turn_incomplete");
  });

  it("does not read a dreaming session as a conversation", async () => {
    const fixture = createTranscriptFixture({ sessionKey: "agent:main:dreaming-narrative-1" });

    await expect(collect(readOpenclawDatabase(fixture.databasePath))).resolves.toEqual([]);
  });

  it("reads captured OpenClaw memory chunks from MemOS Local Memory SQLite", async () => {
    const fixture = createMemoryFixture();

    await expect(collect(readOpenclawDatabase(fixture.databasePath))).resolves.toEqual([]);
  });

  it("streams staged ConversationMessage values and reports progress", async () => {
    const fixture = createTranscriptFixture();
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
        role: "user",
        conversationId: "agent:main:main",
        content: "Please remember OPENAI_API_KEY=[REDACTED:openai_api_key]"
      }),
      expect.objectContaining({ sourceId: "openclaw", role: "tool" }),
      expect.objectContaining({ sourceId: "openclaw", role: "tool" }),
      expect.objectContaining({ sourceId: "openclaw", role: "assistant" })
    ]);
    expect(messages.every((message) => message.rawMeta.sourceTurnState === "complete")).toBe(true);
    expect(progressPhases).toEqual(expect.arrayContaining(["discover", "read", "redact", "emit", "done"]));
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
    const fixture = createTranscriptFixture();
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

/** Mirrors the live agent database: session_windows plus transcript_events for one run. */
function createTranscriptFixture(options: {
  sessionKey?: string;
  userText?: string;
  runTerminal?: boolean;
  finalStopReason?: string;
} = {}): { rootDirectory: string; databasePath: string } {
  tempDir = mkdtempSync(join(tmpdir(), "memmy-openclaw-source-"));
  const rootDirectory = join(tempDir, ".openclaw");
  const agentDirectory = join(rootDirectory, "agents", "main", "agent");
  const databasePath = join(agentDirectory, "openclaw-agent.sqlite");
  const sessionKey = options.sessionKey ?? "agent:main:main";
  const windowId = "window-1";

  mkdirSync(agentDirectory, { recursive: true });
  const events: Array<{ seq: number; event: unknown }> = [
    { seq: 0, event: { type: "session", id: "event-session", timestamp: "2026-09-08T06:44:30.000Z" } },
    {
      seq: 1,
      event: {
        type: "message", id: "event-user", timestamp: "2026-09-08T06:44:31.000Z",
        message: {
          role: "user",
          content: options.userText ?? "Please remember OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN",
          __openclaw: { runId: "run-1" }
        }
      }
    },
    {
      seq: 2,
      event: {
        type: "message", id: "event-call", timestamp: "2026-09-08T06:45:00.000Z",
        message: {
          role: "assistant", stopReason: "toolUse", __openclaw: { runId: "run-1" },
          content: [{ type: "toolCall", id: "exec-1", name: "bash", arguments: "{\"command\":\"cat config\"}" }]
        }
      }
    },
    {
      seq: 3,
      event: {
        type: "message", id: "event-result", timestamp: "2026-09-08T06:45:01.000Z",
        message: {
          role: "toolResult", toolCallId: "exec-1", toolName: "bash", __openclaw: { runId: "run-1" },
          content: [{ type: "toolResult", id: "exec-1", toolCallId: "exec-1", content: "config body" }]
        }
      }
    },
    {
      seq: 4,
      event: {
        type: "message", id: "event-final", timestamp: "2026-09-08T06:45:57.000Z",
        message: {
          role: "assistant",
          stopReason: options.finalStopReason ?? "stop",
          __openclaw: { runId: "run-1", runTerminal: options.runTerminal !== false },
          content: options.finalStopReason === "error" ? [] : [{ type: "text", text: "Checked the gateway and the config." }]
        }
      }
    }
  ];

  const db = new DatabaseSync(databasePath);
  try {
    db.exec("CREATE TABLE session_windows (session_id TEXT PRIMARY KEY, session_key TEXT)");
    db.exec("CREATE TABLE transcript_events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT NOT NULL, created_at TEXT)");
    db.prepare("INSERT INTO session_windows (session_id, session_key) VALUES (?, ?)").run(windowId, sessionKey);
    for (const row of events) {
      db.prepare("INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)")
        .run(windowId, row.seq, JSON.stringify(row.event), "2026-09-08T06:45:57.000Z");
    }
  } finally {
    db.close();
  }

  return { rootDirectory, databasePath };
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
