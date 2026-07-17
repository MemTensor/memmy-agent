/** Adapter tests. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
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
  it("reads real Opencode SQLite message and part schema", async () => {
    const fixture = createDatabaseFixture();

    const messages = await collect(readOpencodeDatabase(fixture.databasePath));

    expect(messages).toEqual([
      expect.objectContaining({
        messageId: "opencode-db-message-user",
        conversationId: "opencode-db-session-1",
        role: "user",
        content: "Please remember OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN",
        workspacePath: fixture.workspacePath,
        gitRoot: fixture.workspacePath
      }),
      expect.objectContaining({
        messageId: "opencode-db-message-assistant",
        role: "assistant",
        content: "Done from Opencode SQLite"
      })
    ]);
  });

  it("streams redacted SQLite messages when the real Opencode database exists", async () => {
    const fixture = createDatabaseFixture();
    const adapter = createOpencodeSourceAdapter({
      databasePath: fixture.databasePath
    });

    const messages = await collect(adapter.scan({}));

    expect(messages).toEqual([
      expect.objectContaining({
        sourceId: "opencode",
        content: "Please remember OPENAI_API_KEY=[REDACTED:openai_api_key]",
        workspacePath: fixture.workspacePath
      }),
      expect.objectContaining({ sourceId: "opencode", role: "assistant" })
    ]);
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
    db.exec(readFileSync(join(import.meta.dirname, "__fixtures__", "opencode", "state.sql"), "utf8").replaceAll("$WORKSPACE_PATH", workspacePath));
  } finally {
    db.close();
  }

  return { workspacePath, databasePath };
}
