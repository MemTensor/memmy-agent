/** Adapter tests. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { selectSourceTurn, sourceTurnFailureReason, sourceTurnFromMessages } from "@memmy/agent-source-core";
import { createOpencodeSourceAdapter } from "../index.js";
import { readOpencodeDatabase } from "../db-reader.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("opencode source adapter", () => {
  it("stages one native turn per user message, unwrapping the recall packet", async () => {
    const fixture = createDatabaseFixture();

    const messages = await collect(readOpencodeDatabase(fixture.databasePath));
    const turn = sourceTurnFromMessages(messages.filter((message) => message.rawMeta.sourceTurnId === "opencode-db-message-user"));

    expect(turn).toMatchObject({
      source: "opencode",
      conversationId: "opencode-db-session-1",
      turnId: "opencode-db-message-user",
      profileId: "build",
      completionEvidence: "assistant_completed:opencode-db-message-assistant",
      answer: "Done from Opencode SQLite",
      workspacePath: fixture.workspacePath,
      status: "succeeded"
    });
    expect(turn?.query).toBe("Please remember OPENAI_API_KEY=[REDACTED:openai_api_key]");
    expect(turn?.toolCalls).toEqual([
      expect.objectContaining({ id: "toolu_read_1", name: "read", output: "file body" })
    ]);
  });

  it("does not stage compaction rows, subagent sessions, or an unanswered question", async () => {
    const fixture = createDatabaseFixture();

    const messages = await collect(readOpencodeDatabase(fixture.databasePath));
    const stagedTurnIds = new Set(messages.map((message) => message.rawMeta.sourceTurnId));
    const unanswered = messages.filter((message) => message.rawMeta.sourceTurnId === "opencode-db-message-unanswered");

    expect(stagedTurnIds).toEqual(new Set(["opencode-db-message-user", "opencode-db-message-unanswered"]));
    expect(sourceTurnFromMessages(unanswered)).toBeNull();
    expect(sourceTurnFailureReason(unanswered)).toBe("turn_incomplete");
  });

  it("streams staged ConversationMessage values when the real Opencode database exists", async () => {
    const fixture = createDatabaseFixture();
    const adapter = createOpencodeSourceAdapter({
      databasePath: fixture.databasePath
    });

    const messages = await collect(adapter.scan({}));

    expect(messages).toEqual([
      expect.objectContaining({
        sourceId: "opencode",
        role: "user",
        content: "Please remember OPENAI_API_KEY=[REDACTED:openai_api_key]",
        workspacePath: fixture.workspacePath
      }),
      expect.objectContaining({ sourceId: "opencode", role: "tool" }),
      expect.objectContaining({ sourceId: "opencode", role: "assistant" }),
      expect.objectContaining({ sourceId: "opencode", role: "user", content: "still thinking?" })
    ]);
  });

  it("does not capture OpenCode turns hidden by session.revert", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-opencode-revert-"));
    const databasePath = join(tempDir, "opencode.db");
    const db = new DatabaseSync(databasePath);
    try {
      db.exec(`
        CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, agent TEXT, time_created INTEGER, revert TEXT);
        CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL);
        CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL);
        INSERT INTO session (id, parent_id, directory, title, agent, time_created, revert)
        VALUES ('ses1', NULL, '/tmp', 'Reverted', 'build', 1, '{"messageID":"u"}');
        INSERT INTO message (id, session_id, time_created, time_updated, data)
        VALUES ('u', 'ses1', 1, 1, '{"role":"user","time":{"created":1}}');
        INSERT INTO message (id, session_id, time_created, time_updated, data)
        VALUES ('a', 'ses1', 2, 2, '{"role":"assistant","parentID":"u","time":{"created":2,"completed":3}}');
        INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
        VALUES ('pu', 'u', 'ses1', 1, 1, '{"type":"text","text":"Implement the configuration reader."}');
        INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
        VALUES ('pa', 'a', 'ses1', 2, 2, '{"type":"text","text":"Done."}');
      `);
    } finally {
      db.close();
    }
    const messages = await collect(readOpencodeDatabase(databasePath));
    expect(sourceTurnFromMessages(messages)).toBeNull();
    expect(messages.some((message) => message.rawMeta.sourceTurnId === "u")).toBe(false);
  });

  it("captures completed StructuredOutput turns from the SQLite reader", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-opencode-structured-"));
    for (const entry of OPENCODE_TERMINAL_CASES) {
      const databasePath = join(tempDir, `${entry.name}.sqlite`);
      writeOpencodeTerminalDatabase(databasePath, entry);
      const result = await selectSourceTurn(readOpencodeDatabase(databasePath), {
        conversationId: entry.name,
        turnId: "u"
      });
      expect(Boolean(result.turn), entry.name).toBe(entry.expectCapture);
      if (entry.tool === "structured" && entry.expectCapture) {
        expect(result.turn?.answer).toBe("");
        expect(result.turn?.toolCalls[0]).toMatchObject({ name: "StructuredOutput", input: STRUCTURED_OUTPUT });
      }
    }
  });

  it("treats a missing OpenCode database as an empty history", async () => {
    const databasePath = join(tmpdir(), `memmy-missing-opencode-${crypto.randomUUID()}`, "opencode.db");

    await expect(collect(createOpencodeSourceAdapter({ databasePath }).scan({}))).resolves.toEqual([]);
  });

  it("throws AbortError when scan is aborted before discovery", async () => {
    const fixture = createDatabaseFixture();
    const controller = new AbortController();
    controller.abort();

    await expect(
      collect(
        createOpencodeSourceAdapter({
          databasePath: fixture.databasePath
        }).scan({ signal: controller.signal })
      )
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

function createDatabaseFixture(): { workspacePath: string; databasePath: string } {
  tempDir = mkdtempSync(join(tmpdir(), "memmy-opencode-db-source-"));
  const workspacePath = join(tempDir, "project");
  const databasePath = join(tempDir, "opencode.db");

  mkdirSync(join(workspacePath, ".git"), { recursive: true });
  const db = new DatabaseSync(databasePath);
  try {
    const fixtureSql = readFileSync(join(import.meta.dirname, "__fixtures__", "opencode", "state.sql"), "utf8")
      .replaceAll('"$WORKSPACE_PATH"', JSON.stringify(workspacePath))
      .replaceAll("$WORKSPACE_PATH", workspacePath.replaceAll("'", "''"));
    db.exec(fixtureSql);
  } finally {
    db.close();
  }

  return { workspacePath, databasePath };
}

const STRUCTURED_OUTPUT = { verified: true, result: "The configuration was verified and documented." };
const OPENCODE_QUERY = "Inspect the configuration and report the verified result.";
interface OpencodeTerminalCase {
  name: string;
  finish?: string;
  tool?: "host" | "provider" | "orphan" | "structured" | "structured-running";
  structured?: boolean;
  aborted?: boolean;
  noAgent?: boolean;
  expectCapture: boolean;
}
const OPENCODE_TERMINAL_CASES: readonly OpencodeTerminalCase[] = [
  { name: "plain-final", finish: "stop", expectCapture: true },
  { name: "unknown-interstep", finish: "unknown", expectCapture: false },
  { name: "host-tool-stop", finish: "stop", tool: "host", expectCapture: false },
  { name: "host-tool-calls", finish: "tool-calls", tool: "host", expectCapture: false },
  { name: "provider-tool-final", finish: "stop", tool: "provider", expectCapture: true },
  { name: "orphan-interrupted", finish: "stop", tool: "orphan", expectCapture: true },
  { name: "aborted-tool-only", tool: "host", aborted: true, expectCapture: true },
  { name: "unresolved-profile", finish: "stop", noAgent: true, expectCapture: false },
  { name: "structured-tool-running", finish: "tool-calls", tool: "structured-running", expectCapture: false },
  { name: "structured-result-not-persisted", finish: "tool-calls", tool: "structured", expectCapture: false },
  { name: "structured-final-tool-calls", finish: "tool-calls", tool: "structured", structured: true, expectCapture: true },
  { name: "structured-final-stop", finish: "stop", tool: "structured", structured: true, expectCapture: true },
  { name: "structured-final-unknown", finish: "unknown", tool: "structured", structured: true, expectCapture: true }
];

function writeOpencodeTerminalDatabase(
  path: string,
  entry: OpencodeTerminalCase
): void {
  const agent = entry.noAgent ? {} : { agent: "build" };
  const structuredTool = entry.tool === "structured" || entry.tool === "structured-running";
  const messages = [
    {
      id: "u",
      data: {
        role: "user",
        ...agent,
        time: { created: 4_070_944_800_000 },
        ...(structuredTool ? { format: { type: "json_schema", schema: { type: "object" } } } : {})
      }
    },
    {
      id: "a",
      data: {
        role: "assistant",
        parentID: "u",
        ...agent,
        ...("finish" in entry ? { finish: entry.finish } : {}),
        ...("structured" in entry && entry.structured ? { structured: STRUCTURED_OUTPUT } : {}),
        ...("aborted" in entry && entry.aborted
          ? { error: { name: "MessageAbortedError", data: { message: "The operation was aborted." } } }
          : {}),
        time: { created: 4_070_944_801_000, completed: 4_070_944_802_000 }
      }
    }
  ];
  const parts = [
    { id: "pu", messageId: "u", data: { type: "text", text: OPENCODE_QUERY } },
    ...(!entry.tool
      ? [{ id: "pa", messageId: "a", data: { type: "text", text: STRUCTURED_OUTPUT.result } }]
      : [{
        id: "pt",
        messageId: "a",
        data: {
          type: "tool",
          callID: "call1",
          tool: structuredTool ? "StructuredOutput" : "read",
          ...(entry.tool === "provider" ? { metadata: { providerExecuted: true } } : {}),
          state: entry.tool === "orphan"
            ? {
              status: "error",
              input: { path: "config" },
              error: "Tool execution interrupted",
              metadata: { interrupted: true }
            }
            : entry.tool === "structured-running"
              ? { status: "running", input: STRUCTURED_OUTPUT, time: { start: 4_070_944_801_000 } }
              : {
                status: "completed",
                input: structuredTool ? STRUCTURED_OUTPUT : { path: "config" },
                output: structuredTool ? "Structured output captured successfully." : "Configuration verified.",
                metadata: structuredTool ? { valid: true } : {}
              }
        }
      }])
  ];
  const db = new DatabaseSync(path);
  try {
    db.exec("CREATE TABLE session(id TEXT, parent_id TEXT, directory TEXT, agent TEXT, time_created INTEGER); CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE part(id TEXT, message_id TEXT, time_created INTEGER, data TEXT)");
    db.prepare("INSERT INTO session VALUES(?,?,?,?,?)").run(entry.name, null, null, "mutable-session-agent", 4_070_944_800_000);
    for (const [index, row] of messages.entries()) {
      db.prepare("INSERT INTO message VALUES(?,?,?,?)").run(row.id, entry.name, index, JSON.stringify(row.data));
    }
    for (const [index, row] of parts.entries()) {
      db.prepare("INSERT INTO part VALUES(?,?,?,?)").run(row.id, row.messageId, index, JSON.stringify(row.data));
    }
  } finally {
    db.close();
  }
}
