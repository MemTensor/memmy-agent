/** Adapter tests. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
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
  it("reads raw Cursor messages from state.vscdb as an async iterable", async () => {
    const workspace = createCursorWorkspaceFixture();

    const messages = await collect(readCursorVscdb(workspace.stateDbPath));

    expect(messages).toEqual([
      expect.objectContaining({
        messageId: "msg-user-1",
        conversationId: "conv-1",
        role: "user",
        content: expect.stringContaining("OPENAI_API_KEY"),
        createdAt: "2026-05-28T10:00:00.000Z"
      }),
      expect.objectContaining({
        messageId: "msg-assistant-1",
        conversationId: "conv-1",
        role: "assistant",
        content: "I can help with that.",
        createdAt: "2026-05-28T10:00:01.000Z"
      })
    ]);
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

  it("streams redacted ConversationMessage values and reports progress", async () => {
    const workspace = createCursorWorkspaceFixture();
    const progressPhases: string[] = [];
    const adapter = createCursorSourceAdapter({
      storageRoot: workspace.storageRoot
    });

    const messages = await collect(
      adapter.scan({
        onProgress: (progress) => progressPhases.push(progress.phase)
      })
    );

    expect(messages).toEqual([
      expect.objectContaining({
        messageId: "msg-user-1",
        sourceId: "cursor",
        conversationId: "conv-1",
        role: "user",
        content: "Please remember OPENAI_API_KEY=[REDACTED:openai_api_key]",
        workspacePath: workspace.projectPath,
        gitRoot: workspace.projectPath
      }),
      expect.objectContaining({
        messageId: "msg-assistant-1",
        sourceId: "cursor",
        conversationId: "conv-1",
        role: "assistant"
      })
    ]);
    expect(progressPhases).toEqual(expect.arrayContaining(["discover", "read", "redact", "emit", "done"]));
  });

  it("streams Cursor globalStorage composer bubble messages", async () => {
    const globalState = createCursorGlobalStateFixture();
    const adapter = createCursorSourceAdapter({
      storageRoot: globalState.storageRoot,
      globalStateDbPath: globalState.stateDbPath
    });

    const messages = await collect(adapter.scan({}));

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
      expect.objectContaining({
        messageId: "bubble-assistant-1",
        sourceId: "cursor",
        conversationId: "composer-1",
        role: "assistant",
        content: "I can help with the Cursor global storage format."
      })
    ]);
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
    JSON.stringify({ folder: `file://${projectPath}` }),
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

/**
 * Creates a fixture for the newer Cursor globalStorage.
 *
 * @returns Path to a test database containing only cursorDiskKV bubble messages.
 */
function createCursorGlobalStateFixture(): {
  storageRoot: string;
  stateDbPath: string;
} {
  tempDir = mkdtempSync(join(tmpdir(), "memmy-cursor-global-source-"));
  const storageRoot = join(tempDir, "workspaceStorage");
  const globalStoragePath = join(tempDir, "globalStorage");
  const stateDbPath = join(globalStoragePath, "state.vscdb");

  mkdirSync(storageRoot, { recursive: true });
  mkdirSync(globalStoragePath, { recursive: true });

  const db = new DatabaseSync(stateDbPath);
  try {
    db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    insertCursorBubble(db, {
      composerId: "composer-1",
      bubbleId: "bubble-user-1",
      type: 1,
      text: "Please remember OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCD",
      createdAt: "2026-06-01T09:04:35.523Z"
    });
    insertCursorBubble(db, {
      composerId: "composer-1",
      bubbleId: "bubble-thinking-1",
      type: 2,
      text: "",
      createdAt: "2026-06-01T09:04:56.862Z"
    });
    insertCursorBubble(db, {
      composerId: "composer-1",
      bubbleId: "bubble-assistant-1",
      type: 2,
      text: "I can help with the Cursor global storage format.",
      createdAt: "2026-06-01T09:04:57.329Z"
    });
  } finally {
    db.close();
  }

  return { storageRoot, stateDbPath };
}

/**
 * Writes a Cursor bubble fixture.
 *
 * @param db Test SQLite connection.
 * @param input Bubble fields.
 */
function insertCursorBubble(
  db: DatabaseSync,
  input: {
    /**
     * Field meaning:
     * - composerId: Cursor composer conversation id.
     */
    composerId: string;
    /**
     * Field meaning:
     * - bubbleId: id of a single Cursor bubble.
     */
    bubbleId: string;
    /**
     * Field meaning:
     * - type: Cursor bubble type; 1 is user, 2 is assistant.
     */
    type: 1 | 2;
    /**
     * Field meaning:
     * - text: visible text of the bubble.
     */
    text: string;
    /**
     * Field meaning:
     * - createdAt: bubble creation time.
     */
    createdAt: string;
  }
): void {
  db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
    `bubbleId:${input.composerId}:${input.bubbleId}`,
    JSON.stringify({
      _v: 3,
      type: input.type,
      bubbleId: input.bubbleId,
      text: input.text,
      createdAt: input.createdAt
    })
  );
}
