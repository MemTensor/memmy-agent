import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { selectSourceTurn } from "@memmy/agent-source-core";
import { readOpencodeDatabase } from "../src/agent-source/adapters/opencode/db-reader.js";

let directory: string | undefined;
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("OpenCode Memory SQLite reader", () => {
  it("captures completed StructuredOutput turns from the SQLite reader", async () => {
    directory = mkdtempSync(join(tmpdir(), "memmy-opencode-structured-"));
    for (const entry of OPENCODE_TERMINAL_CASES) {
      const databasePath = join(directory, `${entry.name}.sqlite`);
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
});

describe("OpenCode Memory SQLite reader (V2 schema)", () => {
  it("captures completed turns from session_v2/session_message and skips subagent branches", async () => {
    directory = mkdtempSync(join(tmpdir(), "memmy-opencode-v2-"));
    const databasePath = join(directory, "v2.sqlite");
    writeOpencodeV2Database(databasePath);
    const main = await selectSourceTurn(readOpencodeDatabase(databasePath), {
      conversationId: "ses_main",
      turnId: "u1"
    });
    expect(main.turn).toBeDefined();
    expect(main.turn?.query).toBe(OPENCODE_QUERY);
    expect(main.turn?.answer).toBe(STRUCTURED_OUTPUT.result);
    expect(main.turn?.profileId).toBe("build");
    expect(main.turn?.toolCalls[0]).toMatchObject({ name: "read", status: "completed" });
    expect(main.turn?.completionEvidence).toBe("assistant_completed:a2");
    const subagent = await selectSourceTurn(readOpencodeDatabase(databasePath), {
      conversationId: "ses_branch",
      turnId: "u2"
    });
    expect(subagent.turn).toBeNull();
  });

  it("leaves a turn whose last assistant never completed for a later attempt", async () => {
    directory = mkdtempSync(join(tmpdir(), "memmy-opencode-v2-open-"));
    const databasePath = join(directory, "v2-open.sqlite");
    writeOpencodeV2Database(databasePath, { openEnded: true });
    const result = await selectSourceTurn(readOpencodeDatabase(databasePath), {
      conversationId: "ses_main",
      turnId: "u1"
    });
    expect(result.turn).toBeNull();
    expect(result.reason).toBe("turn_incomplete");
  });
});

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
  const db = new Database(path);
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

/** Builds an OpenCode V2 database: `session_v2` + `session_message` with inline content. */
function writeOpencodeV2Database(path: string, options?: { openEnded?: boolean }): void {
  const rows: Array<{ id: string; sessionId: string; type: string; seq: number; data: unknown }> = [
    {
      id: "u1",
      sessionId: "ses_main",
      type: "user",
      seq: 1,
      data: { time: { created: 4_070_944_800_000 }, text: OPENCODE_QUERY, files: [], agents: [] }
    },
    {
      id: "a1",
      sessionId: "ses_main",
      type: "assistant",
      seq: 2,
      data: {
        agent: "build",
        time: { created: 4_070_944_801_000, completed: 4_070_944_801_500 },
        content: [
          {
            type: "tool",
            id: "call1",
            name: "read",
            state: { status: "completed", input: { path: "config" }, output: "Configuration verified." }
          }
        ]
      }
    },
    {
      id: "a2",
      sessionId: "ses_main",
      type: "assistant",
      seq: 3,
      data: {
        agent: "build",
        ...(options?.openEnded
          ? { time: { created: 4_070_944_801_600 } }
          : { time: { created: 4_070_944_801_600, completed: 4_070_944_802_000 } }),
        content: [{ type: "reasoning", text: "internal" }, { type: "text", text: STRUCTURED_OUTPUT.result }]
      }
    },
    { id: "i1", sessionId: "ses_main", type: "idle", seq: 4, data: {} },
    {
      id: "u2",
      sessionId: "ses_branch",
      type: "user",
      seq: 5,
      data: { time: { created: 4_070_944_803_000 }, text: "branch prompt", files: [], agents: [] }
    },
    {
      id: "a3",
      sessionId: "ses_branch",
      type: "assistant",
      seq: 6,
      data: {
        agent: "build",
        time: { created: 4_070_944_804_000, completed: 4_070_944_805_000 },
        content: [{ type: "text", text: "branch answer" }]
      }
    }
  ];
  const db = new Database(path);
  try {
    db.exec("CREATE TABLE session_v2(id TEXT, parent_id TEXT, directory TEXT, agent TEXT, revert TEXT, time_created INTEGER); CREATE TABLE session_message(id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT)");
    db.prepare("INSERT INTO session_v2 VALUES(?,?,?,?,?,?)").run("ses_main", null, "/work/project", "build", null, 4_070_944_800_000);
    db.prepare("INSERT INTO session_v2 VALUES(?,?,?,?,?,?)").run("ses_branch", "ses_main", "/work/project", "build", null, 4_070_944_801_000);
    for (const row of rows) {
      db.prepare("INSERT INTO session_message VALUES(?,?,?,?,?,?)")
        .run(row.id, row.sessionId, row.type, row.seq, row.seq, JSON.stringify(row.data));
    }
  } finally {
    db.close();
  }
}
