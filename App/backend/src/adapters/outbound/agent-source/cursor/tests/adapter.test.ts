/** Adapter tests. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { sourceTurnFailureReason, sourceTurnFromMessages } from "@memmy/agent-source-core";
import { createCursorSourceAdapter } from "../index.js";
import { readCursorVscdb } from "../vscdb-reader.js";
import { discoverCursorWorkspaces } from "../workspace-discovery.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("cursor source adapter", () => {
  it("stages one native turn per user bubble with tools paired by tool call id", async () => {
    const globalState = createCursorGlobalStateFixture();

    const messages = await collect(readCursorVscdb(globalState.stateDbPath));
    const turn = sourceTurnFromMessages(messages.filter((message) => message.rawMeta.sourceTurnId === "bubble-user-1"));

    expect(turn).toMatchObject({
      source: "cursor",
      conversationId: "composer-1",
      turnId: "bubble-user-1",
      completionEvidence: "assistant_text:bubble-assistant-1",
      startedAt: "2026-06-01T09:04:35.523Z",
      completedAt: "2026-06-01T09:04:57.329Z",
      answer: "I can help with the Cursor global storage format.",
      status: "succeeded"
    });
    expect(turn?.query).toBe("Please remember OPENAI_API_KEY=[REDACTED:openai_api_key]");
    expect(turn?.toolCalls).toEqual([
      expect.objectContaining({ id: "call-read-1", name: "read_file_v2", status: "completed", output: "file body" })
    ]);
  });

  it("keeps a turn without a closing assistant text unsubmitted so the scan can retry it", async () => {
    const globalState = createCursorGlobalStateFixture({ closingAssistantText: "" });

    const messages = await collect(readCursorVscdb(globalState.stateDbPath));

    expect(sourceTurnFromMessages(messages)).toBeNull();
    expect(sourceTurnFailureReason(messages)).toBe("turn_incomplete");
  });

  it("does not stage subagent chats", async () => {
    const globalState = createCursorGlobalStateFixture({ isSubagent: true });

    await expect(collect(readCursorVscdb(globalState.stateDbPath))).resolves.toEqual([]);
  });

  it("treats a workspace database without chat tables as an empty history", async () => {
    const workspace = createCursorWorkspaceFixture();

    await expect(collect(readCursorVscdb(workspace.stateDbPath))).resolves.toEqual([]);
  });

  it("discovers Cursor workspaces with workspace path and git root", async () => {
    const workspace = createCursorWorkspaceFixture();

    const discovered = await discoverCursorWorkspaces({
      storageRoot: workspace.storageRoot
    });

    expect(discovered).toEqual([
      expect.objectContaining({
        storageHash: "cursor-hash-1",
        workspacePath: workspace.projectPath,
        gitRoot: workspace.projectPath,
        stateDbPath: workspace.stateDbPath
      })
    ]);
  });

  it("treats a missing workspace storage directory as an empty history", async () => {
    const storageRoot = join(tmpdir(), `memmy-missing-cursor-${crypto.randomUUID()}`);

    await expect(discoverCursorWorkspaces({ storageRoot })).resolves.toEqual([]);
    await expect(collect(createCursorSourceAdapter({ storageRoot }).scan({}))).resolves.toEqual([]);
  });

  it("streams staged ConversationMessage values from globalStorage and reports progress", async () => {
    const globalState = createCursorGlobalStateFixture();
    const progressPhases: string[] = [];
    const adapter = createCursorSourceAdapter({
      storageRoot: globalState.storageRoot,
      globalStateDbPath: globalState.stateDbPath
    });

    const messages = await collect(adapter.scan({ onProgress: (progress) => progressPhases.push(progress.phase) }));

    expect(messages).toEqual([
      expect.objectContaining({
        messageId: "bubble-user-1",
        sourceId: "cursor",
        conversationId: "composer-1",
        role: "user",
        content: "Please remember OPENAI_API_KEY=[REDACTED:openai_api_key]",
        workspacePath: null,
        gitRoot: null
      }),
      expect.objectContaining({ messageId: "bubble-tool-1", sourceId: "cursor", role: "tool" }),
      expect.objectContaining({
        messageId: "bubble-assistant-1",
        sourceId: "cursor",
        conversationId: "composer-1",
        role: "assistant",
        content: "I can help with the Cursor global storage format."
      })
    ]);
    expect(messages.every((message) => message.rawMeta.sourceTurnState === "complete")).toBe(true);
    expect(progressPhases).toEqual(expect.arrayContaining(["discover", "read", "redact", "emit", "done"]));
  });
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];

  for await (const value of iterable) {
    values.push(value);
  }

  return values;
}

function createCursorWorkspaceFixture(): {
  storageRoot: string;
  projectPath: string;
  stateDbPath: string;
} {
  tempDir = mkdtempSync(join(tmpdir(), "memmy-cursor-source-"));
  const storageRoot = join(tempDir, "workspaceStorage");
  const storagePath = join(storageRoot, "cursor-hash-1");
  const projectPath = join(tempDir, "project");
  const stateDbPath = join(storagePath, "state.vscdb");

  mkdirSync(join(projectPath, ".git"), { recursive: true });
  mkdirSync(storagePath, { recursive: true });
  writeFileSync(
    join(storagePath, "workspace.json"),
    JSON.stringify({ folder: pathToFileURL(projectPath).href }),
    "utf8"
  );

  const db = new DatabaseSync(stateDbPath);
  try {
    db.exec(readFileSync(join(import.meta.dirname, "__fixtures__", "cursor", "state.sql"), "utf8"));
  } finally {
    db.close();
  }

  return { storageRoot, projectPath, stateDbPath };
}

/** Mirrors Cursor globalStorage: a composerHeaders row plus composerData and bubble rows. */
function createCursorGlobalStateFixture(options: { closingAssistantText?: string; isSubagent?: boolean } = {}): {
  storageRoot: string;
  stateDbPath: string;
} {
  tempDir = mkdtempSync(join(tmpdir(), "memmy-cursor-global-source-"));
  const storageRoot = join(tempDir, "workspaceStorage");
  const globalStoragePath = join(tempDir, "globalStorage");
  const stateDbPath = join(globalStoragePath, "state.vscdb");

  mkdirSync(storageRoot, { recursive: true });
  mkdirSync(globalStoragePath, { recursive: true });

  const bubbles = [
    {
      bubbleId: "bubble-user-1",
      type: 1 as const,
      text: "Please remember OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCD",
      createdAt: "2026-06-01T09:04:35.523Z",
      requestId: "generation-1"
    },
    { bubbleId: "bubble-thinking-1", type: 2 as const, text: "", createdAt: "2026-06-01T09:04:50.100Z" },
    {
      bubbleId: "bubble-tool-1",
      type: 2 as const,
      text: "",
      createdAt: "2026-06-01T09:04:52.000Z",
      toolFormerData: {
        toolCallId: "call-read-1",
        name: "read_file_v2",
        status: "completed",
        rawArgs: "{\"path\":\"/tmp/example.md\"}",
        result: "file body"
      }
    },
    {
      bubbleId: "bubble-assistant-1",
      type: 2 as const,
      text: options.closingAssistantText ?? "I can help with the Cursor global storage format.",
      createdAt: "2026-06-01T09:04:57.329Z"
    }
  ];

  const db = new DatabaseSync(stateDbPath);
  try {
    db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.exec("CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, isSubagent INTEGER, subagentTypeName TEXT)");
    db.prepare("INSERT INTO composerHeaders (composerId, isSubagent, subagentTypeName) VALUES (?, ?, ?)")
      .run("composer-1", options.isSubagent ? 1 : 0, options.isSubagent ? "explore" : "");
    db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
      "composerData:composer-1",
      JSON.stringify({
        composerId: "composer-1",
        fullConversationHeadersOnly: bubbles.map((bubble) => ({
          bubbleId: bubble.bubbleId,
          type: bubble.type,
          createdAt: bubble.createdAt
        }))
      })
    );
    for (const bubble of bubbles) {
      db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
        `bubbleId:composer-1:${bubble.bubbleId}`,
        JSON.stringify({ _v: 3, ...bubble })
      );
    }
  } finally {
    db.close();
  }

  return { storageRoot, stateDbPath };
}
